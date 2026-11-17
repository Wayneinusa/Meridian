import { useEffect, useMemo, useRef, useState } from "react";
import { platform } from "../platform";
import { expandCommand, pluginCommands } from "../plugins/runtime";
import { findModel } from "../providers/registry";
import { attachFile, currentModelRef, getKey, send, setChatMedia, setChatMode, stop, toast, updateSettings, useApp } from "../state/store";
import type { MediaOptions, ModelRef, Part, Settings } from "../types";
import { record, speak, stopSpeaking, transcribe, type Recording } from "../voice";
import { Icon } from "./icons";
import { VariablesDialog, variablesOf } from "./pages/Prompts";
import { useBlobUrl } from "./useBlobUrl";

type Attachment = Extract<Part, { type: "attachment" }>;

function PendingChip({ part, onRemove }: { part: Attachment; onRemove: () => void }) {
  const isImage = part.mime.startsWith("image/");
  const url = useBlobUrl(isImage ? part.blobId : undefined, part.mime);
  return (
    <span className="chip">
      {isImage && url ? <img src={url} alt="" /> : null}
      <span>{part.name}</span>
      <button onClick={onRemove} aria-label={`Remove ${part.name}`}>×</button>
    </span>
  );
}

const TOOL_SWITCHES: { key: keyof Settings["tools"]; label: string; hint: string; desktopOnly?: boolean }[] = [
  { key: "files", label: "Create files", hint: "Spreadsheets, PDFs, Word, slides, code" },
  { key: "media", label: "Images and video", hint: "Uses the image and video models" },
  { key: "web", label: "Web", hint: "Search and read pages" },
  { key: "connectors", label: "Connectors & plugins", hint: "Tools from connectors and plugins" },
  { key: "computer", label: "Use my computer", hint: "Commands, files, apps. Asks before each action", desktopOnly: true },
];

interface SlashItem {
  key: string;
  name: string;
  description: string;
  body: string;
  source: string;
}

function CompareMenu({ selected, onChange, onClose }: { selected: ModelRef[]; onChange: (r: ModelRef[]) => void; onClose: () => void }) {
  const providers = useApp((s) => s.settings.providers);
  const current = useApp((s) => currentModelRef(s.active));
  const models = providers.flatMap((p) => (p.enabled ? p.models.filter((m) => m.kind === "chat").map((m) => ({ ref: { providerId: p.id, modelId: m.id }, name: m.name, provider: p.name })) : []));
  const key = (r: ModelRef) => `${r.providerId}::${r.modelId}`;
  return (
    <div className="popover" style={{ bottom: 44, left: 0, width: 320 }} onMouseLeave={onClose}>
      <div className="menu-head">Also ask (answers appear side by side)</div>
      {models
        .filter((m) => !current || key(m.ref) !== key(current))
        .slice(0, 40)
        .map((m) => {
          const on = selected.some((r) => key(r) === key(m.ref));
          return (
            <label key={key(m.ref)} className="switch" style={{ padding: "4px 10px" }}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? selected.filter((r) => key(r) !== key(m.ref)) : [...selected, m.ref].slice(0, 3))} />
              <span>
                {m.name}
                <small>{m.provider}</small>
              </span>
            </label>
          );
        })}
      {!models.length && <p className="hint" style={{ padding: 10 }}>Add more providers to compare models.</p>}
    </div>
  );
}

export function Composer() {
  const activeId = useApp((s) => s.activeId);
  const active = useApp((s) => s.active);
  const settings = useApp((s) => s.settings);
  const prompts = useApp((s) => s.lib.prompts);
  const plugins = useApp((s) => s.lib.plugins);
  const busyNote = useApp((s) => (s.activeId ? s.busy[s.activeId] : undefined));
  const busy = busyNote !== undefined;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [filling, setFilling] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [voiceMode, setVoiceMode] = useState<"off" | "listening" | "thinking" | "speaking">("off");
  const [level, setLevel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toolsWrap = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<{ on: boolean; rec?: Recording }>({ on: false });
  const found = findModel(settings, currentModelRef(active));
  const mode = found?.model.kind ?? "chat";
  const draftState = useApp((s) => s.draft);
  const media: MediaOptions = (active ? active.media : draftState.media) ?? {};
  const compare = settings.compareModels;
  const inbox = useApp((s) => s.composerInbox);

  useEffect(() => {
    if (!inbox.seq) return;
    setAttachments((a) => [...a, ...inbox.parts.filter((p) => !a.some((x) => x.blobId === p.blobId))]);
    if (inbox.text) setText(inbox.text);
    area.current?.focus();
  }, [inbox.seq]);

  useEffect(() => {
    setText(useApp.getState().composerInbox.text && !activeId ? (useApp.getState().composerInbox.text ?? "") : "");
    setAttachments([]);
    if (window.innerWidth > 860) area.current?.focus();
  }, [activeId]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (!toolsOpen) return;
    const close = (e: PointerEvent) => {
      if (!toolsWrap.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [toolsOpen]);

  // ---------- slash commands
  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    for (const p of prompts) if (p.command) items.push({ key: `p:${p.id}`, name: p.command, description: p.title, body: p.content, source: "Prompt" });
    for (const c of pluginCommands(plugins)) items.push({ key: `c:${c.plugin}:${c.name}`, name: c.name, description: c.description ?? "", body: c.body, source: c.plugin });
    for (const p of prompts) if (!p.command) items.push({ key: `t:${p.id}`, name: p.title.toLowerCase().replace(/\s+/g, "-"), description: p.title, body: p.content, source: "Prompt" });
    return items;
  }, [prompts, plugins]);
  const slash = /^\/([\w:-]*)$/.exec(text);
  const slashMatches = slash ? slashItems.filter((i) => i.name.toLowerCase().includes(slash[1].toLowerCase())).slice(0, 12) : [];
  useEffect(() => setSlashIndex(0), [slash?.[1]]);

  const useSlash = (item: SlashItem) => {
    if (variablesOf(item.body).length) {
      setText("");
      setFilling(item.body);
    } else setText(`/${item.name} `);
  };

  /** "/name rest" → the command's text with the rest filled in. */
  const expandSlash = (t: string): string => {
    const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(t);
    if (!m) return t;
    const item = slashItems.find((i) => i.name === m[1]);
    return item ? expandCommand(item.body, m[2] ?? "") : t;
  };

  const addFiles = async (files: Iterable<File>) => {
    for (const f of files) {
      setReading((n) => n + 1);
      try {
        const part = await attachFile(f);
        setAttachments((a) => [...a, part]);
      } catch (e) {
        toast(`Could not attach ${f.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setReading((n) => n - 1);
      }
    }
  };

  const submit = (override?: string) => {
    const body = expandSlash(override ?? text);
    if (busy || reading || (!body.trim() && !attachments.length)) return;
    const a = attachments;
    setText("");
    setAttachments([]);
    void send(body, a, { compare: mode === "chat" && compare.length ? compare : undefined });
  };

  // ---------- voice
  const dictate = async () => {
    if (recording) {
      const blob = await recording.stop();
      setRecording(null);
      try {
        const words = await transcribe(blob, settings, getKey);
        setText((t) => (t ? `${t} ${words}` : words));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
      }
      return;
    }
    try {
      setRecording(await record({ onLevel: setLevel }));
    } catch (e) {
      toast(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const listenOnce = async () => {
    if (!voiceRef.current.on) return;
    setVoiceMode("listening");
    try {
      voiceRef.current.rec = await record({
        untilSilence: true,
        onLevel: setLevel,
        onAutoStop: async (blob) => {
          if (!voiceRef.current.on) return;
          setVoiceMode("thinking");
          try {
            const words = await transcribe(blob, settings, getKey);
            if (!words.trim()) return void listenOnce();
            const before = useApp.getState().active?.messages.length ?? 0;
            await send(words, []);
            const conv = useApp.getState().active;
            const answer = conv?.messages.slice(before).reverse().find((m) => m.role === "assistant");
            const reply = answer?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
            if (!voiceRef.current.on) return;
            setVoiceMode("speaking");
            await speak(reply || "Done.", useApp.getState().settings, getKey, () => void listenOnce());
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e), "error");
            stopVoice();
          }
        },
      });
    } catch (e) {
      toast(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, "error");
      stopVoice();
    }
  };
  const startVoice = () => {
    voiceRef.current.on = true;
    void listenOnce();
  };
  const stopVoice = () => {
    voiceRef.current.on = false;
    voiceRef.current.rec?.cancel();
    stopSpeaking();
    stop();
    setVoiceMode("off");
  };

  const warnings: string[] = [];
  if (found) {
    if (!found.model.caps.vision && attachments.some((a) => a.mime.startsWith("image/"))) warnings.push(`${found.model.name} cannot see images.`);
    if (mode === "chat" && !found.model.caps.tools) warnings.push(`${found.model.name} cannot use tools, so file creation, media, web and computer actions are off for it.`);
  }
  const desktop = platform().desktop;
  const toolsOn = TOOL_SWITCHES.filter((t) => settings.tools[t.key] && (!t.desktopOnly || desktop)).length;

  return (
    <div className="composer-wrap">
      {(busy || warnings.length > 0 || voiceMode !== "off" || (mode === "chat" && compare.length > 0)) && (
        <div className="status-line">
          {voiceMode !== "off" ? (
            <>
              <span className="voice-dot" style={{ transform: `scale(${1 + Math.min(level * 8, 1.2)})` }} />
              <span>{voiceMode === "listening" ? "Listening…" : voiceMode === "thinking" ? "Thinking…" : "Speaking…"}</span>
              <button className="btn small" onClick={stopVoice}>End voice mode</button>
            </>
          ) : busy ? (
            <>
              <span className="spinner" />
              <span>{busyNote ? busyNote[0].toUpperCase() + busyNote.slice(1) : "Working"}…</span>
            </>
          ) : mode === "chat" && compare.length > 0 ? (
            <span>
              Comparing with {compare.map((r) => findModel(settings, r)?.model.name ?? r.modelId).join(", ")}{" "}
              <button className="link-btn" style={{ display: "inline", width: "auto", padding: 0 }} onClick={() => void updateSettings({ compareModels: [] })}>
                turn off
              </button>
            </span>
          ) : (
            <span>{warnings.join(" ")}</span>
          )}
        </div>
      )}
      <div
        className="composer pop-anchor"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
      >
        {slashMatches.length > 0 && (
          <div className="popover slash-menu" role="listbox" aria-label="Commands">
            {slashMatches.map((i, k) => (
              <button key={i.key} role="option" aria-selected={k === slashIndex} className={`menu-item ${k === slashIndex ? "sel" : ""}`} onMouseDown={(e) => (e.preventDefault(), useSlash(i))}>
                <b>/{i.name}</b>
                <span className="grow muted">{i.description}</span>
                <span className="badge">{i.source}</span>
              </button>
            ))}
          </div>
        )}
        {(attachments.length > 0 || reading > 0) && (
          <div className="chips">
            {attachments.map((a) => (
              <PendingChip key={a.blobId} part={a} onRemove={() => setAttachments((list) => list.filter((x) => x.blobId !== a.blobId))} />
            ))}
            {reading > 0 && (
              <span className="chip">
                <span className="spinner" /> <span>Reading…</span>
              </span>
            )}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          placeholder={
            !found
              ? "Add an API key in Settings to start"
              : mode === "image"
                ? attachments.some((a) => a.mime.startsWith("image/"))
                  ? `Describe the change to make (${found.model.name})`
                  : `Describe the image to create (${found.model.name})`
                : mode === "video"
                  ? attachments.some((a) => a.mime.startsWith("image/"))
                    ? `Describe how the image should move (${found.model.name})`
                    : `Describe the video to create (${found.model.name})`
                  : `Message ${found.model.name}  ·  / for prompts`
          }
          value={text}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (slashMatches.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + slashMatches.length) % slashMatches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                useSlash(slashMatches[slashIndex]);
                return;
              }
            }
            const touch = matchMedia("(pointer: coarse)").matches;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch && settings.appearance.sendOnEnter) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <button className="icon-btn" title="Attach files or photos" onClick={() => fileInput.current?.click()}>
            <Icon.clip />
          </button>
          <div className="pop-anchor" ref={toolsWrap}>
            <button className={`icon-btn ${toolsOn ? "on" : ""}`} title="Tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}>
              <Icon.tools />
            </button>
            {toolsOpen && (
              <div className="popover" style={{ bottom: 44, left: 0, width: 310 }}>
                <div className="menu-head">What the assistant may use</div>
                {TOOL_SWITCHES.map((t) => {
                  const unavailable = t.desktopOnly && !desktop;
                  return (
                    <label key={t.key} className="switch" style={{ padding: "6px 10px", opacity: unavailable ? 0.55 : 1 }}>
                      <input
                        type="checkbox"
                        disabled={unavailable}
                        checked={!unavailable && settings.tools[t.key]}
                        onChange={(e) => void updateSettings((s) => ({ tools: { ...s.tools, [t.key]: e.target.checked } }))}
                      />
                      <span>
                        {t.label}
                        <small>{unavailable ? "Desktop app only. Phones and tablets do not allow this." : t.hint}</small>
                      </span>
                    </label>
                  );
                })}
                <button className="menu-item" onClick={() => (setToolsOpen(false), useApp.setState({ settingsTab: "tools" }))}>
                  <Icon.gear /> Tool, plugin and connector settings
                </button>
              </div>
            )}
          </div>
          {mode === "chat" && (
            <span className="pop-anchor">
              <button className={`icon-btn ${compare.length ? "on" : ""}`} title="Compare models side by side" onClick={() => setCompareOpen(!compareOpen)}>
                <Icon.compare />
              </button>
              {compareOpen && <CompareMenu selected={compare} onChange={(r) => void updateSettings({ compareModels: r })} onClose={() => setCompareOpen(false)} />}
            </span>
          )}
          <div className="seg mode-seg" role="radiogroup" aria-label="What to create">
            {(["chat", "image", "video"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "sel" : ""} disabled={busy} onClick={() => void setChatMode(m)}>
                {m === "chat" ? "Chat" : m === "image" ? "Image" : "Video"}
              </button>
            ))}
          </div>
          {mode !== "chat" && (
            <div className="media-opts">
              <select aria-label="Aspect ratio" value={media.aspect ?? ""} onChange={(e) => void setChatMedia({ ...media, aspect: (e.target.value || undefined) as MediaOptions["aspect"] })}>
                <option value="">{mode === "video" ? "16:9" : "1:1"}</option>
                {(mode === "video" ? ["16:9", "9:16", "1:1"] : ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              {mode === "image" ? (
                <>
                  <select aria-label="Number of images" value={String(media.count ?? 1)} onChange={(e) => void setChatMedia({ ...media, count: Number(e.target.value) })}>
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>
                    ))}
                  </select>
                  <select aria-label="Quality" value={media.quality ?? ""} onChange={(e) => void setChatMedia({ ...media, quality: (e.target.value || undefined) as MediaOptions["quality"] })}>
                    <option value="">Default quality</option>
                    {["low", "medium", "high"].map((q) => (
                      <option key={q} value={q}>{q[0].toUpperCase() + q.slice(1)}</option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <select aria-label="Length" value={String(media.seconds ?? "")} onChange={(e) => void setChatMedia({ ...media, seconds: e.target.value ? Number(e.target.value) : undefined })}>
                    <option value="">Default length</option>
                    {[4, 5, 6, 8, 10, 12, 15].map((n) => (
                      <option key={n} value={n}>{n} s</option>
                    ))}
                  </select>
                  <select aria-label="Resolution" value={media.resolution ?? ""} onChange={(e) => void setChatMedia({ ...media, resolution: e.target.value || undefined })}>
                    <option value="">Default quality</option>
                    {["480p", "720p", "1080p"].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          <span className="grow" />
          <button className={`icon-btn ${recording ? "on rec" : ""}`} title={recording ? "Stop and transcribe" : "Dictate"} onClick={() => void dictate()} disabled={voiceMode !== "off"}>
            <Icon.mic />
          </button>
          {mode === "chat" && voiceMode === "off" && !busy && !text.trim() && !attachments.length ? (
            <button className="send" title="Voice mode: talk back and forth" onClick={startVoice}>
              <Icon.speaker />
            </button>
          ) : busy ? (
            <button className="send stop" title="Stop" onClick={() => (voiceMode !== "off" ? stopVoice() : stop())}>
              <Icon.stop />
            </button>
          ) : (
            <button className="send" title="Send" disabled={!!reading || (!text.trim() && !attachments.length)} onClick={() => submit()}>
              <Icon.send />
            </button>
          )}
        </div>
      </div>
      {filling && (
        <VariablesDialog
          text={filling}
          onDone={(t) => {
            setFilling(null);
            if (t) setText(t);
          }}
        />
      )}
    </div>
  );
}
