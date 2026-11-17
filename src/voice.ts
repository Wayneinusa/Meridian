// Voice: dictation (record, then transcribe with a speech-to-text model or the
// browser's own recogniser), read-aloud (a text-to-speech model or the
// device voice), and hands-free voice mode (listen until silence, send, speak
// the answer, listen again).
import { httpFetch, readError } from "./platform/http";
import { trimSlash } from "./providers/common";
import type { ProviderConfig, Settings } from "./types";
import { bytesToBase64 } from "./util/bytes";

type KeyFn = (providerId: string) => Promise<string>;

interface Pick {
  provider: ProviderConfig;
  model: string;
}

function withKey(settings: Settings, pred: (p: ProviderConfig) => boolean): ProviderConfig | undefined {
  return settings.providers.find((p) => p.enabled && p.hasKey && pred(p));
}

export function pickStt(settings: Settings): Pick | null {
  const chosen = settings.voice.sttModel;
  if (chosen) {
    const p = settings.providers.find((x) => x.id === chosen.providerId);
    if (p) return { provider: p, model: chosen.modelId };
  }
  const openai = withKey(settings, (p) => p.kind === "openai");
  if (openai) return { provider: openai, model: "gpt-4o-mini-transcribe" };
  const groq = withKey(settings, (p) => /groq\.com/.test(p.baseUrl));
  if (groq) return { provider: groq, model: "whisper-large-v3-turbo" };
  const xai = withKey(settings, (p) => p.kind === "xai");
  if (xai) return { provider: xai, model: "stt" };
  const gemini = withKey(settings, (p) => p.kind === "gemini");
  if (gemini) return { provider: gemini, model: gemini.models.find((m) => /flash/.test(m.id) && m.kind === "chat")?.id ?? "gemini-2.5-flash" };
  return null;
}

export function pickTts(settings: Settings): Pick | null {
  const chosen = settings.voice.ttsModel;
  if (chosen) {
    const p = settings.providers.find((x) => x.id === chosen.providerId);
    if (p) return { provider: p, model: chosen.modelId };
  }
  return null;
}

export async function transcribe(audio: Blob, settings: Settings, getKey: KeyFn, signal?: AbortSignal): Promise<string> {
  const pick = pickStt(settings);
  if (!pick) throw new Error("No speech-to-text service: add an OpenAI, Groq, xAI or Gemini key, or use your keyboard's dictation.");
  const key = await getKey(pick.provider.id);
  const base = trimSlash(pick.provider.baseUrl);
  const ext = audio.type.includes("mp4") || audio.type.includes("aac") ? "m4a" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("wav") ? "wav" : "webm";
  if (pick.provider.kind === "gemini") {
    const data = bytesToBase64(new Uint8Array(await audio.arrayBuffer()));
    const res = await httpFetch(`${base}/models/${encodeURIComponent(pick.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: audio.type.split(";")[0] || "audio/webm", data } }, { text: "Transcribe this audio exactly. Reply with the transcript only." }] }] }),
      signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const j = await res.json();
    return (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
  }
  const form = new FormData();
  if (pick.provider.kind !== "xai") form.set("model", pick.model);
  form.append("file", audio, `speech.${ext}`);
  const res = await httpFetch(`${base}${pick.provider.kind === "xai" ? "/stt" : "/audio/transcriptions"}`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal });
  if (!res.ok) throw new Error(await readError(res));
  const j = await res.json();
  return String(j.text ?? "").trim();
}

// ---------------------------------------------------------------- speaking

let current: { stop(): void } | null = null;

export function stopSpeaking() {
  current?.stop();
  current = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Text to read aloud: drop code, tables and markdown symbols. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/^\|.*\|$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 4000);
}

export async function speak(text: string, settings: Settings, getKey: KeyFn, onEnd?: () => void): Promise<void> {
  stopSpeaking();
  const clean = speakable(text);
  if (!clean) return onEnd?.();
  const pick = pickTts(settings);
  if (pick && (pick.provider.kind === "openai" || pick.provider.kind === "xai" || pick.provider.kind === "openai-compatible")) {
    const key = await getKey(pick.provider.id);
    const base = trimSlash(pick.provider.baseUrl);
    const res =
      pick.provider.kind === "xai"
        ? await httpFetch(`${base}/tts`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ text: clean, voice_id: settings.voice.voiceName || "eve", language: "auto", output_format: { codec: "mp3" } }) })
        : await httpFetch(`${base}/audio/speech`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: pick.model, voice: settings.voice.voiceName || "alloy", input: clean, response_format: "mp3" }) });
    if (!res.ok) throw new Error(await readError(res));
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: "audio/mpeg" }));
    const audio = new Audio(url);
    current = {
      stop: () => {
        audio.pause();
        URL.revokeObjectURL(url);
      },
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      onEnd?.();
    };
    await audio.play();
    return;
  }
  if (typeof speechSynthesis === "undefined") throw new Error("This device has no built-in voice. Choose a text-to-speech model in Settings → General.");
  const u = new SpeechSynthesisUtterance(clean);
  const voice = speechSynthesis.getVoices().find((v) => v.name === settings.voice.voiceName);
  if (voice) u.voice = voice;
  u.onend = () => onEnd?.();
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- recording

export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
}

/** Record from the microphone. With `untilSilence`, stops by itself after a pause in speech. */
export async function record(opts: { untilSilence?: boolean; onLevel?: (level: number) => void; onAutoStop?: (blob: Blob) => void } = {}): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  let raf = 0;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let heard = false;
  let quietSince = Date.now();
  const started = Date.now();
  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  const done = () =>
    new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        cleanup();
        resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      };
      if (rec.state !== "inactive") rec.stop();
      else resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    });
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const level = Math.sqrt(sum / buf.length);
    opts.onLevel?.(level);
    if (level > 0.04) {
      heard = true;
      quietSince = Date.now();
    }
    if (opts.untilSilence && ((heard && Date.now() - quietSince > 1300) || Date.now() - started > 60_000)) {
      void done().then((b) => opts.onAutoStop?.(b));
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop: done,
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      cleanup();
    },
  };
}
