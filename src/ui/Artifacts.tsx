import { useApp } from "../state/store";
import type { BlobRef } from "../types";
import { Icon } from "./icons";
import { FileView } from "./MessageView";

/** Every file in the open chat: what you attached and what the assistant made. */
export function ArtifactsPanel() {
  const active = useApp((s) => s.active);
  const made: BlobRef[] = [];
  const attached: BlobRef[] = [];
  for (const m of active?.messages ?? []) {
    for (const p of m.parts) {
      if (p.type === "artifact") made.push(p);
      else if (p.type === "attachment") attached.push(p);
    }
  }
  return (
    <aside className="artifacts-panel" aria-label="Files in this chat">
      <div className="modal-head">
        <h2>Files</h2>
        <button className="icon-btn" title="Close" onClick={() => useApp.setState({ artifactsOpen: false })}>
          <Icon.x />
        </button>
      </div>
      <div className="sheet-body" style={{ display: "grid", gap: 8, alignContent: "start" }}>
        <div className="section-title" style={{ margin: "4px 0" }}>Made in this chat ({made.length})</div>
        {[...made].reverse().map((f) => (
          <FileView key={f.blobId} file={f} />
        ))}
        {!made.length && <p className="hint">Files the assistant creates (documents, spreadsheets, images, videos) collect here.</p>}
        <div className="section-title" style={{ margin: "12px 0 4px" }}>Attached ({attached.length})</div>
        {attached.map((f) => (
          <FileView key={f.blobId} file={f} />
        ))}
      </div>
    </aside>
  );
}
