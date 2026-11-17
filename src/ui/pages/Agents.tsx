import { useRef, useState } from "react";
import { AGENT_TEMPLATES } from "../../plugins/gallery";
import { addAgentFromTemplate, deleteItem, errText, makeKnowledgeFile, newChat, saveItem, toast, useApp } from "../../state/store";
import type { Agent, Settings } from "../../types";
import { formatBytes } from "../../util/bytes";
import { Icon } from "../icons";
import { Modal, ModelSelect } from "../Modal";

const TOOL_LABELS: [keyof Settings["tools"], string][] = [
  ["files", "Create files"],
  ["media", "Images & video"],
  ["web", "Web search"],
  ["connectors", "Connectors & plugins"],
  ["computer", "Use the computer (desktop)"],
];

export function KnowledgeEditor({ files, onChange }: { files: Agent["knowledge"]; onChange: (f: Agent["knowledge"]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const total = files.reduce((n, f) => n + (f.chars ?? 0), 0);
  return (
    <div>
      {files.map((f) => (
        <div className="list-row" key={f.blobId}>
          <Icon.file />
          <div className="grow">
            <div className="title">{f.name}</div>
            <div className="sub">{formatBytes(f.size)} · {(f.chars ?? 0).toLocaleString()} characters of text</div>
          </div>
          <button className="icon-btn" title={`Remove ${f.name}`} onClick={() => onChange(files.filter((x) => x.blobId !== f.blobId))}>
            <Icon.x />
          </button>
        </div>
      ))}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          let next = files;
          for (const f of list) {
            setBusy((n) => n + 1);
            try {
              next = [...next, await makeKnowledgeFile(f)];
              onChange(next);
            } catch (err) {
              toast(errText(err), "error");
            } finally {
              setBusy((n) => n - 1);
            }
          }
        }}
      />
      <div className="row wrap">
        <button className="btn small" onClick={() => input.current?.click()} disabled={!!busy}>
          <Icon.plus /> {busy ? "Reading…" : "Add files"}
        </button>
        <span className="hint">
          PDF, Word, Excel, PowerPoint, text and code. {total > 60_000 ? "Large collection: the assistant searches it as needed." : total ? "Small enough to give the assistant in full." : ""}
        </span>
      </div>
    </div>
  );
}

export function AgentEditor({ agent, onClose }: { agent: Partial<Agent>; onClose: () => void }) {
  const [a, setA] = useState<Partial<Agent>>({ knowledge: [], starters: [], ...agent });
  const settings = useApp((s) => s.settings);
  const up = (p: Partial<Agent>) => setA((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!a.name?.trim()) return toast("Give the agent a name.", "error");
    await saveItem("agents", { ...a, name: a.name.trim(), instructions: a.instructions ?? "", knowledge: a.knowledge ?? [], starters: (a.starters ?? []).filter((s) => s.trim()) });
    onClose();
  };
  return (
    <Modal
      title={agent.id ? "Edit agent" : "New agent"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <div className="row">
        <label className="field">
          <span>Icon</span>
          <input className="emoji-input" type="text" value={a.emoji ?? ""} placeholder="🤖" onChange={(e) => up({ emoji: [...e.target.value].slice(-2).join("") })} />
        </label>
        <label className="field grow">
          <span>Name</span>
          <input type="text" value={a.name ?? ""} onChange={(e) => up({ name: e.target.value })} autoFocus />
        </label>
      </div>
      <label className="field">
        <span>Short description</span>
        <input type="text" value={a.description ?? ""} onChange={(e) => up({ description: e.target.value })} />
      </label>
      <label className="field">
        <span>Instructions (who it is and how it should work)</span>
        <textarea rows={7} value={a.instructions ?? ""} onChange={(e) => up({ instructions: e.target.value })} placeholder="You are a… Always… Never…" />
      </label>
      <label className="field">
        <span>Model</span>
        <ModelSelect value={a.model} onChange={(model) => up({ model })} empty="The chat's model" />
      </label>
      <div className="field">
        <span className="hint">Tools this agent may use</span>
        <div className="row wrap" style={{ marginTop: 4 }}>
          {TOOL_LABELS.map(([k, label]) => {
            const on = a.tools?.[k] ?? settings.tools[k];
            return (
              <button key={k} className={`chip-btn ${on ? "on" : ""}`} onClick={() => up({ tools: { ...(a.tools ?? {}), [k]: !on } })}>
                {on ? <Icon.check /> : null} {label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={a.memory !== false} onChange={(e) => up({ memory: e.target.checked })} />
        <span>Use long-term memory<small>Reads what it remembers about you and saves new facts.</small></span>
      </label>
      <div className="field">
        <span className="hint">Knowledge files</span>
        <KnowledgeEditor files={a.knowledge ?? []} onChange={(knowledge) => up({ knowledge })} />
      </div>
      <label className="field">
        <span>Conversation starters (one per line)</span>
        <textarea rows={3} value={(a.starters ?? []).join("\n")} onChange={(e) => up({ starters: e.target.value.split("\n") })} />
      </label>
    </Modal>
  );
}

export function AgentsPage() {
  const agents = useApp((s) => s.lib.agents);
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const mine = agents;
  const notAdded = AGENT_TEMPLATES.filter((t) => !agents.some((a) => a.name === t.name));
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Agents</h1>
          <button className="btn primary" onClick={() => setEditing({})}>
            <Icon.plus /> New agent
          </button>
        </div>
        <p className="lead">Assistants with their own instructions, model, tools, knowledge files and memory. Start a chat with one, or pick one inside any chat.</p>
        {mine.length > 0 && (
          <>
            <div className="section-title">Your agents</div>
            <div className="grid">
              {mine.map((a) => (
                <div key={a.id} className="tile">
                  <span className="tile-emoji">{a.emoji ?? "🤖"}</span>
                  <b>{a.name}</b>
                  <span className="tile-desc">{a.description || a.instructions.slice(0, 120)}</span>
                  <div className="row wrap">
                    <button className="btn small primary" onClick={() => newChat({ agentId: a.id })}>Chat</button>
                    <button className="btn small" onClick={() => setEditing(a)}>Edit</button>
                    <button
                      className="icon-btn"
                      title={`Delete ${a.name}`}
                      onClick={() => {
                        if (confirm(`Delete the agent "${a.name}"? Chats with it are kept.`)) void deleteItem("agents", a.id);
                      }}
                    >
                      <Icon.trash />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {notAdded.length > 0 && (
          <>
            <div className="section-title">Templates</div>
            <div className="grid">
              {notAdded.map((t) => (
                <div key={t.name} className="tile">
                  <span className="tile-emoji">{t.emoji}</span>
                  <b>{t.name}</b>
                  <span className="tile-desc">{t.description}</span>
                  <div className="row">
                    <button
                      className="btn small"
                      onClick={async () => {
                        const a = await addAgentFromTemplate(t);
                        toast(`Added ${a.name}.`, "ok");
                      }}
                    >
                      <Icon.plus /> Add
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {editing && <AgentEditor agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
