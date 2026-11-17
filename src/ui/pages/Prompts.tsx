import { useState } from "react";
import { pluginCommands } from "../../plugins/runtime";
import { attachToComposer, deleteItem, newChat, saveItem, toast, useApp } from "../../state/store";
import type { PromptItem } from "../../types";
import { Icon } from "../icons";
import { Modal } from "../Modal";

export function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w ]+?)\s*\}\}/g)].map((m) => m[1]))];
}

export function fillVariables(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w ]+?)\s*\}\}/g, (_m, k: string) => values[k] ?? "");
}

export function PromptEditor({ prompt, onClose }: { prompt: Partial<PromptItem>; onClose: () => void }) {
  const [p, setP] = useState<Partial<PromptItem>>(prompt);
  const save = async () => {
    if (!p.title?.trim() || !p.content?.trim()) return toast("A prompt needs a title and text.", "error");
    const command = p.command?.trim().replace(/^\//, "").replace(/\s+/g, "-").toLowerCase() || undefined;
    await saveItem("prompts", { ...p, title: p.title.trim(), command });
    onClose();
  };
  return (
    <Modal
      title={prompt.id ? "Edit prompt" : "New prompt"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Title</span>
        <input type="text" value={p.title ?? ""} onChange={(e) => setP({ ...p, title: e.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>Slash command (optional): type /{p.command || "name"} in the message box to use it</span>
        <input type="text" value={p.command ?? ""} placeholder="e.g. weekly-report" onChange={(e) => setP({ ...p, command: e.target.value })} />
      </label>
      <label className="field">
        <span>Prompt text. Use {"{{variable}}"} for blanks you fill in each time, and $ARGUMENTS for text typed after the command.</span>
        <textarea rows={8} value={p.content ?? ""} onChange={(e) => setP({ ...p, content: e.target.value })} />
      </label>
      {variablesOf(p.content ?? "").length > 0 && <p className="hint">Variables: {variablesOf(p.content ?? "").join(", ")}</p>}
    </Modal>
  );
}

export function VariablesDialog({ text, onDone }: { text: string; onDone: (filled: string | null) => void }) {
  const vars = variablesOf(text);
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <Modal
      narrow
      title="Fill in the prompt"
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn primary" onClick={() => onDone(fillVariables(text, values))}>Use prompt</button>
        </>
      }
    >
      {vars.map((v, i) => (
        <label className="field" key={v}>
          <span>{v}</span>
          <textarea rows={2} autoFocus={i === 0} value={values[v] ?? ""} onChange={(e) => setValues({ ...values, [v]: e.target.value })} />
        </label>
      ))}
    </Modal>
  );
}

export function PromptsPage() {
  const prompts = useApp((s) => s.lib.prompts);
  const plugins = useApp((s) => s.lib.plugins);
  const [editing, setEditing] = useState<Partial<PromptItem> | null>(null);
  const [q, setQ] = useState("");
  const [filling, setFilling] = useState<string | null>(null);
  const shown = prompts.filter((p) => !q || `${p.title} ${p.content} ${p.command ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const use = (text: string) => {
    if (variablesOf(text).length) setFilling(text);
    else {
      newChat();
      attachToComposer([], text);
    }
  };
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Prompts</h1>
          <button className="btn primary" onClick={() => setEditing({})}>
            <Icon.plus /> New prompt
          </button>
        </div>
        <p className="lead">Reusable prompts with fill-in blanks. Give one a command name and type / in any chat to insert it.</p>
        <input type="search" placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
        {shown.map((p) => (
          <div className="list-row" key={p.id}>
            <div className="grow">
              <div className="title">{p.title} {p.command && <span className="badge">/{p.command}</span>}</div>
              <div className="sub">{p.content}</div>
            </div>
            <button className="btn small primary" onClick={() => use(p.content)}>Use</button>
            <button className="btn small" onClick={() => setEditing(p)}>Edit</button>
            <button className="icon-btn" title={`Delete ${p.title}`} onClick={() => confirm(`Delete "${p.title}"?`) && void deleteItem("prompts", p.id)}>
              <Icon.trash />
            </button>
          </div>
        ))}
        {!shown.length && <p className="hint">{q ? "No prompts match." : "No saved prompts yet."}</p>}
        {pluginCommands(plugins).length > 0 && (
          <>
            <div className="section-title">Commands from plugins</div>
            {pluginCommands(plugins).map((c) => (
              <div className="list-row" key={`${c.plugin}/${c.name}`}>
                <div className="grow">
                  <div className="title">/{c.name} <span className="badge">{c.plugin}</span></div>
                  <div className="sub">{c.description ?? c.body}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {editing && <PromptEditor prompt={editing} onClose={() => setEditing(null)} />}
      {filling && (
        <VariablesDialog
          text={filling}
          onDone={(t) => {
            setFilling(null);
            if (t) {
              newChat();
              attachToComposer([], t);
            }
          }}
        />
      )}
    </div>
  );
}
