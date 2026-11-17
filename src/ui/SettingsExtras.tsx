import { useEffect, useState } from "react";
import { platform } from "../platform";
import { deleteSecret, getSecret, setSecret } from "../platform/secrets";
import { toast, updateSettings, useApp } from "../state/store";
import type { Settings } from "../types";
import { pickStt } from "../voice";

const SEARCH: { id: Settings["search"]["provider"]; name: string; key?: string; help: string }[] = [
  { id: "auto", name: "Automatic", help: "Uses a keyed service below if you saved one, otherwise DuckDuckGo." },
  { id: "duckduckgo", name: "DuckDuckGo", help: "Free, no key. Results can be thinner than paid services." },
  { id: "brave", name: "Brave Search", key: "brave", help: "Independent index. Key from api-dashboard.search.brave.com." },
  { id: "tavily", name: "Tavily", key: "tavily", help: "Search built for AI agents. Key from tavily.com." },
  { id: "exa", name: "Exa", key: "exa", help: "Neural search with page text. Key from exa.ai." },
  { id: "searxng", name: "SearXNG (self-hosted)", help: "Your own SearXNG server with the JSON format enabled." },
];

export function SearchKeys() {
  const search = useApp((s) => s.settings.search);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    void (async () => {
      const out: Record<string, boolean> = {};
      for (const s of SEARCH) if (s.key) out[s.key] = !!(await getSecret(`search.${s.key}`));
      setSaved(out);
    })();
  }, []);
  const current = SEARCH.find((s) => s.id === search.provider) ?? SEARCH[0];
  return (
    <div className="card">
      <p className="hint" style={{ marginTop: 0 }}>Claude on Anthropic's API uses its own web search. Other models use the service chosen here.</p>
      <label className="field">
        <span>Search service</span>
        <select value={search.provider} onChange={(e) => void updateSettings((s) => ({ search: { ...s.search, provider: e.target.value as Settings["search"]["provider"] } }))}>
          {SEARCH.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <small className="hint">{current.help}</small>
      </label>
      {SEARCH.filter((s) => s.key).map((s) => (
        <label className="field" key={s.key}>
          <span>{s.name} key {saved[s.key!] ? <span className="badge ok">saved</span> : null}</span>
          <div className="row">
            <input type="password" autoComplete="off" placeholder={saved[s.key!] ? "•••••••• saved — type to replace" : "Optional"} value={vals[s.key!] ?? ""} onChange={(e) => setVals({ ...vals, [s.key!]: e.target.value })} />
            <button
              className="btn"
              onClick={async () => {
                const v = (vals[s.key!] ?? "").trim();
                if (v) await setSecret(`search.${s.key}`, v);
                else await deleteSecret(`search.${s.key}`);
                setSaved({ ...saved, [s.key!]: !!v });
                setVals({ ...vals, [s.key!]: "" });
                toast(v ? `${s.name} key saved.` : `${s.name} key removed.`, "ok");
              }}
            >
              {(vals[s.key!] ?? "").trim() ? "Save" : "Clear"}
            </button>
          </div>
        </label>
      ))}
      <label className="field">
        <span>SearXNG address</span>
        <input type="url" defaultValue={search.searxngUrl ?? ""} placeholder="https://search.example.com" onBlur={(e) => void updateSettings((s) => ({ search: { ...s.search, searxngUrl: e.target.value.trim() || undefined } }))} />
      </label>
    </div>
  );
}

export function GeneralExtras() {
  const settings = useApp((s) => s.settings);
  const set = (patch: Partial<Settings>) => void updateSettings(patch);
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const load = () => setVoices(speechSynthesis.getVoices().map((v) => v.name));
    load();
    speechSynthesis.onvoiceschanged = load;
  }, []);
  const ttsProviders = settings.providers.filter((p) => p.hasKey && (p.kind === "openai" || p.kind === "xai"));
  const tts = settings.voice.ttsModel;
  const stt = pickStt(settings);
  return (
    <>
      <h4>Appearance</h4>
      <div className="card">
        <label className="field">
          <span>Text size: {settings.appearance.fontSize}px</span>
          <input type="range" min={13} max={20} value={settings.appearance.fontSize} onChange={(e) => set({ appearance: { ...settings.appearance, fontSize: Number(e.target.value) } })} />
        </label>
        <label className="field">
          <span>Chat width</span>
          <select value={settings.appearance.width} onChange={(e) => set({ appearance: { ...settings.appearance, width: e.target.value as "normal" | "wide" } })}>
            <option value="normal">Comfortable</option>
            <option value="wide">Wide</option>
          </select>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.appearance.sendOnEnter} onChange={(e) => set({ appearance: { ...settings.appearance, sendOnEnter: e.target.checked } })} />
          <span>Enter sends the message<small>Off: Enter makes a new line; Ctrl/⌘+Enter sends.</small></span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.autoTitle} onChange={(e) => set({ autoTitle: e.target.checked })} />
          <span>Name chats automatically<small>After the first answer, the model suggests a short title.</small></span>
        </label>
      </div>

      <h4>Voice</h4>
      <div className="card">
        <p className="hint" style={{ marginTop: 0 }}>
          Dictation and voice mode transcribe with {stt ? <b>{stt.provider.name} ({stt.model})</b> : "a speech-to-text service once you add an OpenAI, Groq, xAI or Gemini key"}.
        </p>
        <label className="field">
          <span>Read answers aloud with</span>
          <select
            value={tts ? `${tts.providerId}::${tts.modelId}` : ""}
            onChange={(e) => {
              const [providerId, modelId] = e.target.value.split("::");
              set({ voice: { ...settings.voice, ttsModel: e.target.value ? { providerId, modelId } : undefined, voiceName: undefined } });
            }}
          >
            <option value="">This device's voice</option>
            {ttsProviders.map((p) => (
              <option key={p.id} value={`${p.id}::${p.kind === "xai" ? "tts" : "gpt-4o-mini-tts"}`}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Voice</span>
          {tts ? (
            <select value={settings.voice.voiceName ?? ""} onChange={(e) => set({ voice: { ...settings.voice, voiceName: e.target.value || undefined } })}>
              <option value="">Default</option>
              {(settings.providers.find((p) => p.id === tts.providerId)?.kind === "xai" ? ["eve", "ara", "rex", "sal", "leo"] : ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          ) : (
            <select value={settings.voice.voiceName ?? ""} onChange={(e) => set({ voice: { ...settings.voice, voiceName: e.target.value || undefined } })}>
              <option value="">Default</option>
              {voices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )}
        </label>
      </div>

      <h4>Notifications{platform().desktop ? " and background" : ""}</h4>
      <div className="card">
        <label className="switch">
          <input type="checkbox" checked={settings.notifications} onChange={(e) => set({ notifications: e.target.checked })} />
          <span>Notify me<small>When an answer finishes while the app is in the background, when the assistant has a question, and when automations run.</small></span>
        </label>
        {platform().desktop && (
          <label className="switch">
            <input type="checkbox" checked={settings.runInBackground} onChange={(e) => set({ runInBackground: e.target.checked })} />
            <span>Keep running when the window is closed<small>Stays in the tray so automations run on time. Quit from the tray icon.</small></span>
          </label>
        )}
        <label className="field">
          <span>This device's name (shown in automations)</span>
          <input type="text" defaultValue={settings.deviceName} onBlur={(e) => e.target.value.trim() && set({ deviceName: e.target.value.trim() })} />
        </label>
      </div>
      <h4>About</h4>
      <div className="card">
        <div className="muted" data-testid="app-version">
          Meridian {__APP_VERSION__}
          {__APP_BUILD__ ? ` · build ${__APP_BUILD__}` : ""}
        </div>
      </div>
    </>
  );
}
