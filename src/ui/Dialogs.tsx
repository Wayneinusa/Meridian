import { useEffect, useState } from "react";
import { loadBlob, useApp } from "../state/store";
import { formatBytes, utf8 } from "../util/bytes";
import { Icon } from "./icons";
import { saveBlob } from "./MessageView";
import { useBlobUrl } from "./useBlobUrl";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

const RISK_NOTE: Record<string, string> = {
  computer: "This acts on your computer with your own permissions. Check it before allowing.",
  connectors: "This sends data to, or acts in, a service you connected.",
  web: "This contacts a web address that you did not type yourself.",
};

export function PermissionDialog() {
  const req = useApp((s) => s.permission);
  if (!req) return null;
  const showDetail = req.detail !== "{}" && !req.summary.includes(req.detail);
  return (
    <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="modal narrow">
        <div className="modal-head">
          <h2 id="perm-title">Allow: {req.title}?</h2>
        </div>
        <div className="modal-body">
          <div className="perm-cmd">{req.summary}</div>
          {showDetail && (
            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Full details</summary>
              <div className="perm-cmd">{req.detail}</div>
            </details>
          )}
          <p className="hint" style={{ margin: "8px 0 0" }}>{RISK_NOTE[req.group] ?? "The assistant wants to run this tool."}</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => req.resolve("deny")}>Don't allow</button>
          <button className="btn" onClick={() => req.resolve("always")} title={`Stop asking for ${req.title}. You can undo this in Settings → Tools.`}>
            Always allow “{req.title}”
          </button>
          <button className="btn primary" autoFocus onClick={() => req.resolve("once")}>Allow once</button>
        </div>
      </div>
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

export function QuestionDialog() {
  const q = useApp((s) => s.question);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  useEffect(() => {
    setPicked([]);
    setOther("");
  }, [q?.id]);
  if (!q) return null;
  const submit = (answer: string) => answer.trim() && q.resolve(answer.trim());
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="q-title">
      <div className="modal narrow">
        <div className="modal-head">
          <h2 id="q-title">{q.question}</h2>
        </div>
        <div className="modal-body">
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
          <label className="field" style={{ marginTop: 12 }}>
            <span>{q.options.length ? "Or answer in your own words" : "Your answer"}</span>
            <textarea rows={2} value={other} onChange={(e) => setOther(e.target.value)} autoFocus={!q.options.length} />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => q.resolve(null)}>Skip</button>
          <button
            className="btn primary"
            disabled={!other.trim() && !(q.multiple && picked.length)}
            onClick={() => submit([...picked, other.trim()].filter(Boolean).join("; "))}
          >
            Answer
          </button>
        </div>
      </div>
    </div>
  );
}
