import { useEffect, useRef, useState } from "react";
import { loadBlob, openChat, useApp, type PermissionRequest, type QuestionRequest } from "../state/store";
import { formatBytes, utf8 } from "../util/bytes";
import { Icon } from "./icons";
import { saveBlob } from "./MessageView";
import { useBlobUrl } from "./useBlobUrl";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.slice(-3).map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

const RISK_NOTE: Record<string, string> = {
  computer: "This acts on your computer with your own permissions. Check it before allowing.",
  connectors: "This sends data to, or acts in, a service you connected.",
  web: "This contacts a web address that you did not type yourself.",
  browser: "The assistant's own browser (separate from yours) will do this on the web.",
};

/** The latest screenshot with where the action will land. */
function ActionPreview({ preview }: { preview: NonNullable<PermissionRequest["preview"]> }) {
  const url = useBlobUrl(preview.blobId, "image/png");
  if (!url) return null;
  return (
    <div className="action-preview" data-testid="action-preview">
      <img src={url} alt="Where the action will happen" />
      {preview.marks.map((m, i) => (
        <span key={i} className="action-mark" style={{ left: `${(m.x / preview.width) * 100}%`, top: `${(m.y / preview.height) * 100}%` }} title={m.label}>
          <span>{m.label}</span>
        </span>
      ))}
    </div>
  );
}

/** An approval request, shown inside the chat (not as a popup), with every choice visible. */
export function PermissionCard({ req }: { req: PermissionRequest }) {
  const showDetail = req.detail !== "{}" && !req.summary.includes(req.detail);
  return (
    <div className="perm-card" role="group" aria-label={`Allow ${req.title}?`}>
      <div className="perm-head">
        <Icon.alert />
        <b>Allow {req.title}?</b>
      </div>
      <div className="perm-cmd">{req.summary}</div>
      {showDetail && (
        <details>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Full details</summary>
          <div className="perm-cmd">{req.detail}</div>
        </details>
      )}
      {req.preview && <ActionPreview preview={req.preview} />}
      <p className="hint" style={{ margin: "6px 0 10px" }}>{RISK_NOTE[req.group] ?? "The assistant wants to run this tool."}</p>
      <div className="row wrap perm-actions">
        <button className="btn primary" autoFocus onClick={() => req.resolve("once")}>Allow once</button>
        {req.allowTask && (
          <button className="btn" onClick={() => req.resolve("task")} title="Don't ask again until this task ends (the next message asks again)">
            Allow for this task
          </button>
        )}
        <button className="btn" onClick={() => req.resolve("always")} title={`Stop asking for ${req.title}. You can undo this in Settings → Tools.`}>
          Always allow “{req.title}”
        </button>
        <button className="btn" onClick={() => req.resolve("deny")}>Don't allow</button>
      </div>
    </div>
  );
}

/** A question the assistant asked, answered right in the chat. */
export function QuestionCard({ q }: { q: QuestionRequest }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const submit = (answer: string) => answer.trim() && q.resolve(answer.trim());
  return (
    <div className="question-card" role="group" aria-label={q.question}>
      <div className="perm-head">
        <Icon.chat />
        <b>{q.question}</b>
      </div>
      {q.options.length > 0 && (
        <div className="question-opts">
          {q.options.map((o) =>
            q.multiple ? (
              <label key={o} className="switch">
                <input type="checkbox" checked={picked.includes(o)} onChange={(e) => setPicked(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))} />
                <span>{o}</span>
              </label>
            ) : (
              <button key={o} className="btn" onClick={() => submit(o)}>{o}</button>
            ),
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 10, alignItems: "flex-end" }}>
        <textarea
          rows={1}
          className="grow"
          placeholder={q.options.length ? "Or answer in your own words" : "Your answer"}
          aria-label="Your answer"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit([...picked, other.trim()].filter(Boolean).join("; "));
            }
          }}
          autoFocus={!q.options.length}
        />
        <button className="btn primary" disabled={!other.trim() && !(q.multiple && picked.length)} onClick={() => submit([...picked, other.trim()].filter(Boolean).join("; "))}>
          Answer
        </button>
        <button className="btn" onClick={() => q.resolve(null)}>Skip</button>
      </div>
    </div>
  );
}

/** Everything waiting for the user in this chat, at the end of the conversation. */
export function ChatPrompts({ convId }: { convId: string | null }) {
  const perms = useApp((s) => s.permissions);
  const questions = useApp((s) => s.questions);
  const mine = perms.filter((p) => p.convId === convId);
  const myQs = questions.filter((q) => q.convId === convId);
  const box = useRef<HTMLDivElement>(null);
  const key = [...mine, ...myQs].map((r) => r.id).join(",");
  useEffect(() => {
    // bring a new request into view, like the end of the conversation
    if (key) box.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [key]);
  if (!mine.length && !myQs.length) return null;
  return (
    <div className="chat-prompts" ref={box}>
      {mine.map((p) => (
        <PermissionCard key={p.id} req={p} />
      ))}
      {myQs.map((q) => (
        <QuestionCard key={q.id} q={q} />
      ))}
    </div>
  );
}

/** Another chat (or an automation) is waiting for an answer: offer to go there. */
export function WaitingElsewhere({ convId }: { convId: string | null }) {
  const perms = useApp((s) => s.permissions);
  const questions = useApp((s) => s.questions);
  const metas = useApp((s) => s.metas);
  const other = [...perms, ...questions].find((r) => r.convId !== convId);
  if (!other) return null;
  const title = metas.find((m) => m.id === other.convId)?.title ?? "Another chat";
  return (
    <div className="private-banner waiting-banner" role="status">
      “{title}” is waiting for your answer.{" "}
      <button onClick={() => void openChat(other.convId)}>Open it</button>
    </div>
  );
}

function TextPreview({ blobId, html }: { blobId: string; html: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [rendered, setRendered] = useState(html);
  useEffect(() => {
    let alive = true;
    void loadBlob(blobId).then((b) => alive && setText(b ? utf8.decode(b.length > 2_000_000 ? b.slice(0, 2_000_000) : b) : "(not on this device)"));
    return () => {
      alive = false;
    };
  }, [blobId]);
  if (text === null) return <div className="spinner" />;
  if (html) {
    return (
      <div style={{ alignSelf: "stretch", justifySelf: "stretch", display: "flex", flexDirection: "column" }}>
        <div className="seg" style={{ margin: 8, alignSelf: "center", width: 220 }}>
          <button className={rendered ? "sel" : ""} onClick={() => setRendered(true)}>Page</button>
          <button className={!rendered ? "sel" : ""} onClick={() => setRendered(false)}>Source</button>
        </div>
        {/* sandboxed: scripts may run, but with no access to the app, its storage or your keys */}
        {rendered ? <iframe title="Preview" sandbox="allow-scripts" srcDoc={text} /> : <pre>{text}</pre>}
      </div>
    );
  }
  return <pre>{text}</pre>;
}

export function PreviewDialog() {
  const file = useApp((s) => s.preview);
  const binary = !!file && /^(image\/|video\/|application\/pdf)/.test(file.mime);
  const url = useBlobUrl(binary ? file?.blobId : undefined, file?.mime ?? "");
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useApp.setState({ preview: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file]);
  if (!file) return null;
  const close = () => useApp.setState({ preview: null });

  let body: React.ReactNode;
  if (binary) {
    if (url === null) body = <div className="spinner" />;
    else if (url === "") body = <p className="muted">This file is not on this device yet. Sync and try again.</p>;
    else if (file.mime.startsWith("image/")) body = <img src={url} alt={file.name} />;
    else if (file.mime.startsWith("video/")) body = <video src={url} controls autoPlay playsInline />;
    else body = <iframe title={file.name} src={url} />;
  } else if (/^text\/|json|xml|sql|javascript|typescript|yaml/.test(file.mime)) {
    body = <TextPreview blobId={file.blobId} html={file.mime === "text/html"} />;
  } else {
    body = <p className="muted" style={{ padding: 24, textAlign: "center" }}>No preview for this file type. Save it and open it in its own app.</p>;
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={file.name}>
        <div className="modal-head">
          <h2 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{formatBytes(file.size)}</span>
          </h2>
          <button className="btn small" onClick={() => void saveBlob(file)}>
            <Icon.download /> Save
          </button>
          <button className="icon-btn" title="Close" onClick={close}>
            <Icon.x />
          </button>
        </div>
        <div className="preview-body">{body}</div>
      </div>
    </div>
  );
}


