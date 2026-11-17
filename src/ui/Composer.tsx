import { useEffect, useRef, useState } from "react";
import { platform } from "../platform";
import { findModel } from "../providers/registry";
import { attachFile, currentModelRef, send, setChatMedia, setChatMode, stop, toast, updateSettings, useApp } from "../state/store";
import type { MediaOptions, Part, Settings } from "../types";
import { Icon } from "./icons";
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
  { key: "media", label: "Images and video", hint: "Uses the media models from Settings" },
  { key: "web", label: "Web", hint: "Search and read pages" },
  { key: "connectors", label: "Connectors", hint: "Tools from the MCP servers you added" },
  { key: "computer", label: "Use my computer", hint: "Commands, files, apps. Asks before each action", desktopOnly: true },
];

export function Composer() {
  const activeId = useApp((s) => s.activeId);
  const active = useApp((s) => s.active);
  const settings = useApp((s) => s.settings);
  const busyNote = useApp((s) => (s.activeId ? s.busy[s.activeId] : undefined));
  useApp((s) => s.metas);
  const busy = busyNote !== undefined;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toolsWrap = useRef<HTMLDivElement>(null);
  const found = findModel(settings, currentModelRef(active));
  const mode = found?.model.kind ?? "chat";
  const draftState = useApp((s) => s.draft);
  const media: MediaOptions = (active ? active.media : draftState.media) ?? {};
  const inbox = useApp((s) => s.composerInbox);
  useEffect(() => {
    if (inbox.seq) setAttachments((a) => [...a, ...inbox.parts.filter((p) => !a.some((x) => x.blobId === p.blobId))]);
  }, [inbox.seq]);

  useEffect(() => {
    setText("");
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

  const submit = () => {
    if (busy || reading || (!text.trim() && !attachments.length)) return;
    const t = text;
    const a = attachments;
    setText("");
    setAttachments([]);
    void send(t, a);
  };

  const warnings: string[] = [];
  if (found) {
    if (!found.model.caps.vision && attachments.some((a) => a.mime.startsWith("image/"))) warnings.push(`${found.model.name} cannot see images.`);
    if (!found.model.caps.tools) warnings.push(`${found.model.name} cannot use tools, so file creation, media, web and computer actions are off for it.`);
  }
  const desktop = platform().desktop;
  const toolsOn = TOOL_SWITCHES.filter((t) => settings.tools[t.key] && (!t.desktopOnly || desktop)).length;

  return (
    <div className="composer-wrap">
      {(busy || warnings.length > 0) && (
        <div className="status-line">
          {busy ? (
            <>
              <span className="spinner" />
              <span>{busyNote ? busyNote[0].toUpperCase() + busyNote.slice(1) : "Working"}…</span>
            </>
          ) : (
            <span>{warnings.join(" ")}</span>
          )}
        </div>
      )}
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
      >
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
                  : `Message ${found.model.name}`
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
            // Enter sends on a keyboard; on touch keyboards Enter makes a new line
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
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
                <button
                  className="menu-item"
                  onClick={() => {
                    setToolsOpen(false);
                    useApp.setState({ settingsTab: "tools" });
                  }}
                >
                  <Icon.gear /> Tool and connector settings
                </button>
              </div>
            )}
          </div>
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
                <select aria-label="Number of images" value={String(media.count ?? 1)} onChange={(e) => void setChatMedia({ ...media, count: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>
                  ))}
                </select>
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
          {busy ? (
            <button className="send stop" title="Stop" onClick={() => stop()}>
              <Icon.stop />
            </button>
          ) : (
            <button className="send" title="Send" disabled={!!reading || (!text.trim() && !attachments.length)} onClick={submit}>
              <Icon.send />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
