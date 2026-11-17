import { memo, useState } from "react";
import { openWithSystem, saveFile } from "../platform/files";
import { findModel } from "../providers/registry";
import { attachToComposer, deleteMessage, editAndResend, forkChat, getKey, loadBlob, regenerate, selectVersion, setChatMode, toast, useApp } from "../state/store";
import { speak, stopSpeaking } from "../voice";
import type { BlobRef, Message, Part } from "../types";
import { extOf, formatBytes } from "../util/bytes";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { useBlobUrl } from "./useBlobUrl";

const TOOL_LABELS: Record<string, string> = {
  create_file: "Create file",
  create_spreadsheet: "Create spreadsheet",
  create_pdf: "Create PDF",
  create_document: "Create document",
  create_presentation: "Create presentation",
  generate_image: "Generate image",
  generate_video: "Generate video",
  fetch_url: "Fetch page",
  web_search: "Web search",
  web_fetch: "Read page",
  run_command: "Run command",
  read_file: "Read file",
  write_file: "Write file",
  list_directory: "List folder",
  search_apps: "Search apps",
  install_app: "Install app",
  open: "Open",
  save_generated_file: "Save to computer",
  take_screenshot: "Screenshot",
  computer_input: "Mouse & keyboard",
  update_plan: "Plan",
  ask_user: "Question",
  delegate: "Sub-agent",
  search_knowledge: "Search knowledge",
  remember: "Remember",
  forget: "Forget",
  run_javascript: "Run code",
  read_skill: "Read skill",
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/_/g, " ")}: ${m[2]}` : name;
}

function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const key of ["command", "filename", "path", "url", "query", "prompt", "target", "id", "keys", "text", "action"]) {
    if (typeof i[key] === "string") return i[key] as string;
  }
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s;
}

export async function saveBlob(ref: BlobRef) {
  const bytes = await loadBlob(ref.blobId);
  if (!bytes) return toast("That file is not on this device yet. Sync and try again.", "error");
  try {
    const where = await saveFile(bytes, ref.name, ref.mime);
    if (where) toast(where, "ok");
  } catch (e) {
    toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function openBlob(ref: BlobRef) {
  const bytes = await loadBlob(ref.blobId);
  if (!bytes) return toast("That file is not on this device yet.", "error");
  try {
    if (!(await openWithSystem(bytes, ref.name))) useApp.setState({ preview: ref });
  } catch (e) {
    toast(`Could not open: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export const PREVIEWABLE = /^(image\/|video\/|text\/|application\/(pdf|json|xml|sql))/;

function FileCard({ file }: { file: BlobRef }) {
  const canOpen = useApp.getState().settings && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return (
    <div className="file-card">
      <div className="file-icon">{extOf(file.name).slice(0, 4) || "file"}</div>
      <div className="grow">
        <div className="file-name" title={file.name}>{file.name}</div>
        <div className="file-sub">{formatBytes(file.size)}</div>
      </div>
      {PREVIEWABLE.test(file.mime) && (
        <button className="icon-btn" title="Preview" onClick={() => useApp.setState({ preview: file })}>
          <Icon.eye />
        </button>
      )}
      {canOpen && (
        <button className="icon-btn" title="Open with default app" onClick={() => void openBlob(file)}>
          <Icon.open />
        </button>
      )}
      <button className="icon-btn" title="Save" onClick={() => void saveBlob(file)}>
        <Icon.download />
      </button>
    </div>
  );
}

function MediaView({ file }: { file: BlobRef }) {
  const url = useBlobUrl(file.blobId, file.mime);
  if (url === null) return <div className="file-card"><div className="spinner" /> <span className="muted">Loading {file.name}</span></div>;
  if (url === "") return <FileCard file={file} />;
  return (
    <div>
      {file.mime.startsWith("video/") ? (
        <video className="media" src={url} controls playsInline preload="metadata" />
      ) : (
        <button className="media-btn" onClick={() => useApp.setState({ preview: file })} title="Open preview">
          <img className="media" src={url} alt={file.name} />
        </button>
      )}
      <div className="media-row">
        <button className="btn small" onClick={() => void saveBlob(file)}>
          <Icon.download /> Save
        </button>
        {file.mime.startsWith("image/") && (
          <>
            <button
              className="btn small"
              title="Change this picture with a prompt"
              onClick={async () => {
                if (await setChatMode("image")) attachToComposer([file]);
              }}
            >
              <Icon.edit /> Edit
            </button>
            <button
              className="btn small"
              title="Turn this picture into a video"
              onClick={async () => {
                if (await setChatMode("video")) attachToComposer([file]);
              }}
            >
              Animate
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function FileView({ file }: { file: BlobRef }) {
  return /^(image|video)\//.test(file.mime) ? <MediaView file={file} /> : <FileCard file={file} />;
}

function ToolImage({ file }: { file: BlobRef }) {
  const url = useBlobUrl(file.blobId, file.mime);
  if (!url) return null;
  return (
    <button className="media-btn" onClick={() => useApp.setState({ preview: file })}>
      <img className="media" src={url} alt={file.name} style={{ maxHeight: 220 }} />
    </button>
  );
}

function ToolCall({ part }: { part: Extract<Part, { type: "tool_call" }> }) {
  const working = part.status === "running" || (part.status === "pending" && !part.result);
  const badge =
    part.status === "error" ? <span className="badge err">failed</span> : part.status === "denied" ? <span className="badge err">declined</span> : part.status === "done" ? <span className="badge ok">done</span> : null;
  return (
    <details className="tool">
      <summary>
        {working ? <span className="spinner" /> : null}
        <span className="tool-name">{toolLabel(part.name)}</span>
        <span className="tool-sum">{toolSummary(part.input)}</span>
        {badge}
      </summary>
      <div className="tool-body">
        <div>
          <div className="tool-label">Input</div>
          <pre>{JSON.stringify(part.input ?? {}, null, 2)}</pre>
        </div>
        {part.result && (
          <div>
            <div className="tool-label">{part.result.isError ? "Error" : "Result"}</div>
            <pre>{part.result.text}</pre>
            {part.result.images?.map((img) => <ToolImage key={img.blobId} file={img} />)}
          </div>
        )}
      </div>
    </details>
  );
}

function PartView({ part, streaming }: { part: Part; streaming: boolean }) {
  const showThinking = useApp((s) => s.settings.showThinking);
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "thinking":
      if (!showThinking) return null;
      return (
        <details className="thinking">
          <summary>
            {streaming ? <span className="spinner" /> : null}
            {streaming ? "Thinking…" : "Thought process"}
          </summary>
          <div className="body">{part.text}</div>
        </details>
      );
    case "tool_call":
      return <ToolCall part={part} />;
    case "artifact":
      return <FileView file={part} />;
    default:
      return null;
  }
}

function AttachmentChip({ part }: { part: Extract<Part, { type: "attachment" }> }) {
  const isImage = part.mime.startsWith("image/");
  const url = useBlobUrl(isImage ? part.blobId : undefined, part.mime);
  return (
    <button className="chip" onClick={() => useApp.setState({ preview: part })} title={`${part.name} · ${formatBytes(part.size)}`}>
      {isImage && url ? <img src={url} alt="" /> : null}
      <span>{part.name}</span>
    </button>
  );
}

function Versions({ userId }: { userId: string }) {
  const versions = useApp((s) => s.active?.alternates?.[userId]);
  const settings = useApp((s) => s.settings);
  const [open, setOpen] = useState(false);
  if (!versions?.length) return null;
  return (
    <span className="pop-anchor versions">
      <button onClick={() => setOpen(!open)} title="Earlier answers to this message">
        {versions.length + 1} versions ▾
      </button>
      <button onClick={() => useApp.setState({ compareOpen: userId })} title="Show versions side by side">
        <Icon.compare />
      </button>
      {open && (
        <div className="popover" style={{ left: 0, bottom: 28, width: 300 }} onMouseLeave={() => setOpen(false)}>
          <div className="menu-head">Switch to an earlier answer</div>
          {versions.map((v, i) => {
            const m = v.messages.find((x) => x.role === "assistant");
            const name = m?.model ? (findModel(settings, m.model)?.model.name ?? m.model.modelId) : "Answer";
            const preview = v.messages.flatMap((x) => x.parts.map((p) => (p.type === "text" ? p.text : ""))).join(" ").slice(0, 80);
            return (
              <button key={v.id} className="menu-item" onClick={() => (setOpen(false), void selectVersion(userId, v.id))}>
                <span className="grow">
                  <b>{i + 1}. {name}</b>
                  <br />
                  <span className="muted" style={{ fontSize: 12.5 }}>{preview || "(no text)"}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

function RetryMenu({ onClose }: { onClose: () => void }) {
  const providers = useApp((s) => s.settings.providers);
  const favorites = useApp((s) => s.settings.favorites);
  const models = providers.flatMap((p) => p.models.filter((m) => m.kind === "chat").map((m) => ({ ref: { providerId: p.id, modelId: m.id }, name: m.name, provider: p.name })));
  const fav = models.filter((m) => favorites.includes(`${m.ref.providerId}::${m.ref.modelId}`));
  const list = (fav.length ? fav : models).slice(0, 12);
  return (
    <div className="popover" style={{ left: 0, bottom: 30, width: 280 }} onMouseLeave={onClose}>
      <div className="menu-head">Try again with</div>
      {list.map((m) => (
        <button key={`${m.ref.providerId}::${m.ref.modelId}`} className="menu-item" onClick={() => (onClose(), void regenerate(m.ref))}>
          <span className="grow">{m.name}</span>
          <span className="muted" style={{ fontSize: 12 }}>{m.provider}</span>
        </button>
      ))}
    </div>
  );
}

export function CompareView({ userId, answers, busy }: { userId: string; answers: Message[]; busy: boolean }) {
  const versions = useApp((s) => s.active?.alternates?.[userId]) ?? [];
  const settings = useApp((s) => s.settings);
  const nameOf = (msgs: Message[]) => {
    const m = msgs.find((x) => x.role === "assistant");
    return m?.model ? (findModel(settings, m.model)?.model.name ?? m.model.modelId) : "Answer";
  };
  const cols = [{ id: "current", messages: answers, current: true }, ...versions.map((v) => ({ id: v.id, messages: v.messages, current: false }))];
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="grow">Compare answers</b>
        <button className="btn small" onClick={() => useApp.setState({ compareOpen: null })}>Close</button>
      </div>
      <div className="compare-grid">
        {cols.map((col) => (
          <div key={col.id} className="compare-col">
            <div className="head">
              <span className="grow">{nameOf(col.messages)}</span>
              {col.current ? (
                <span className="badge ok">in use</span>
              ) : (
                <button className="btn small" disabled={busy} onClick={() => void selectVersion(userId, col.id)}>Use this</button>
              )}
            </div>
            {col.messages.map((m) => (
              <MessageView key={m.id} message={m} isLast={col.current} busy={busy && col.current} compact />
            ))}
            {!col.messages.length && <div className="spinner" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export const MessageView = memo(function MessageView({ message, isLast, busy, versionsFor, compact }: { message: Message; isLast: boolean; busy: boolean; versionsFor?: string; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const settings = useApp((s) => s.settings);
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const say = async () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    try {
      await speak(text, settings, getKey, () => setSpeaking(false));
    } catch (e) {
      setSpeaking(false);
      toast(String(e instanceof Error ? e.message : e), "error");
    }
  };

  if (message.role === "user") {
    const attachments = message.parts.filter((p): p is Extract<Part, { type: "attachment" }> => p.type === "attachment");
    return (
      <div className="msg user">
        {attachments.length > 0 && (
          <div className="chips">
            {attachments.map((a) => (
              <AttachmentChip key={a.blobId} part={a} />
            ))}
          </div>
        )}
        {editing ? (
          <form
            style={{ width: "min(100%, 620px)" }}
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("text") as string;
              setEditing(false);
              if (value.trim()) void editAndResend(message.id, value);
            }}
          >
            <textarea name="text" defaultValue={text} rows={Math.min(10, text.split("\n").length + 1)} autoFocus />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
              <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="btn small primary">Send</button>
            </div>
          </form>
        ) : (
          text && <div className="bubble">{text}</div>
        )}
        {!editing && (
          <div className="msg-actions">
            <button className="icon-btn" title="Copy" onClick={copy}>{copied ? <Icon.check /> : <Icon.copy />}</button>
            {!busy && (
              <button className="icon-btn" title="Edit and resend" onClick={() => setEditing(true)}>
                <Icon.edit />
              </button>
            )}
            {!busy && (
              <button className="icon-btn" title="Fork from here" onClick={() => void forkChat(message.id)}>
                <Icon.fork />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const streaming = busy && isLast;
  const found = findModel(settings, message.model);
  const modelName = found?.model.name ?? message.model?.modelId;
  const usage = message.usage;
  const done = !streaming && (message.stopReason === "end" || message.stopReason === "stopped" || !!message.error || (!!message.stopReason && message.stopReason !== "tool_use"));
  return (
    <div className="msg assistant">
      {message.parts.map((p, i) => (
        <PartView key={p.type === "tool_call" ? p.id : `${p.type}-${i}`} part={p} streaming={streaming && i === message.parts.length - 1} />
      ))}
      {streaming && message.parts.length === 0 && <div className="spinner" aria-label="Waiting for the model" />}
      {message.error && <div className="error-line">{message.error}</div>}
      {done && !compact && (
        <div className="msg-actions">
          {text && <button className="icon-btn" title="Copy" onClick={copy}>{copied ? <Icon.check /> : <Icon.copy />}</button>}
          {text && (
            <button className={`icon-btn ${speaking ? "on" : ""}`} title={speaking ? "Stop reading" : "Read aloud"} onClick={() => void say()}>
              <Icon.speaker />
            </button>
          )}
          {isLast && (
            <span className="pop-anchor">
              <button className="icon-btn" title="Try again" onClick={() => void regenerate()} onContextMenu={(e) => (e.preventDefault(), setRetry(true))}>
                <Icon.refresh />
              </button>
              <button className="icon-btn" title="Try again with another model" style={{ width: 18 }} onClick={() => setRetry(!retry)}>
                <Icon.chevron />
              </button>
              {retry && <RetryMenu onClose={() => setRetry(false)} />}
            </span>
          )}
          <button className="icon-btn" title="Fork from here" onClick={() => void forkChat(message.id)}>
            <Icon.fork />
          </button>
          <button className="icon-btn" title="Delete this message" onClick={() => void deleteMessage(message.id)}>
            <Icon.trash />
          </button>
          {versionsFor && <Versions userId={versionsFor} />}
          <span className="msg-meta">
            {modelName}
            {usage?.output != null ? ` · ${(usage.input ?? 0).toLocaleString()} in / ${usage.output.toLocaleString()} out` : ""}
            {message.stopReason === "stopped" ? " · stopped" : ""}
          </span>
        </div>
      )}
    </div>
  );
});
