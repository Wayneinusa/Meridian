import { useRef, useState } from "react";
import { pluginsFromFile, pluginsFromUrl, fromJson, type PluginDraft } from "../plugins/import";
import { deleteItem, errText, galleryPlugins, installPlugin, saveItem, savePluginSetting, setPluginEnabled, toast, uninstallPlugin, updateSettings, useApp } from "../state/store";
import type { Plugin, PluginEngine } from "../types";
import { Icon } from "./icons";
import { Modal } from "./Modal";

function counts(p: PluginDraft | Plugin): string {
  const bits = [
    p.tools.length && `${p.tools.length} tool${p.tools.length > 1 ? "s" : ""}`,
    p.skills.length && `${p.skills.length} skill${p.skills.length > 1 ? "s" : ""}`,
    p.commands.length && `${p.commands.length} command${p.commands.length > 1 ? "s" : ""}`,
    p.agents.length && `${p.agents.length} agent${p.agents.length > 1 ? "s" : ""}`,
    p.mcpServers.length && `${p.mcpServers.length} connector${p.mcpServers.length > 1 ? "s" : ""}`,
    (p.engines?.length ?? 0) > 0 && `${p.engines!.length} image/video backend${p.engines!.length > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return bits.join(" · ") || "empty";
}

/** Which of a plugin's tools also act as Image / Video backends. */
function EnginesEditor({ p }: { p: Plugin }) {
  const engines = p.engines ?? [];
  const save = (next: PluginEngine[]) => void saveItem("plugins", { id: p.id, engines: next });
  const free = p.tools.filter((t) => !engines.some((e) => e.tool === t.name));
  if (!engines.length && !p.tools.length) return null;
  return (
    <div className="subcard" style={{ marginTop: 8 }}>
      <div className="hint" style={{ marginBottom: 6 }}>
        <b>Image / video backends.</b> These appear in the backend list in Image and Video mode, where you can make one the default.
      </div>
      {engines.map((e) => (
        <div className="model-row" key={e.id}>
          <span className="name">{e.name}</span>
          <span className="badge">{e.kind}</span>
          <span className="hint">{e.tool ? `tool ${e.tool}` : e.http ? "HTTP" : "code"}</span>
          <button className="icon-btn" title={`Stop using ${e.name} as a backend`} onClick={() => save(engines.filter((x) => x.id !== e.id))}>
            <Icon.x />
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          {free.slice(0, 8).map((t) => (
            <span key={t.name} className="row" style={{ gap: 4 }}>
              <button className="btn small" onClick={() => save([...engines, { id: `tool-${t.name}`, kind: "image", name: t.name.replace(/[_-]+/g, " "), tool: t.name }])}>Use {t.name} for images</button>
              <button className="btn small" onClick={() => save([...engines, { id: `tool-${t.name}-video`, kind: "video", name: t.name.replace(/[_-]+/g, " "), tool: t.name }])}>…for video</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PluginCard({ p }: { p: Plugin }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const missing = p.settings.filter((s) => s.required && !p.values[s.key]);
  return (
    <div className="card">
      <div className="row">
        <span style={{ fontSize: 22 }}>{p.emoji ?? "🧩"}</span>
        <div className="grow">
          <h4>
            {p.name} {p.version && <span className="badge">v{p.version}</span>} {missing.length > 0 && <span className="badge err">needs settings</span>}
          </h4>
          <div className="hint">{counts(p)}{p.author ? ` · by ${p.author}` : ""}</div>
        </div>
        <label className="switch" style={{ padding: 0 }}>
          <input type="checkbox" checked={p.enabled} onChange={(e) => void setPluginEnabled(p.id, e.target.checked)} aria-label={`Enable ${p.name}`} />
        </label>
        <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Less" : "Details"}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {p.description && <p className="hint" style={{ marginTop: 0 }}>{p.description}</p>}
          {p.settings.map((s) => (
            <label className="field" key={s.key}>
              <span>{s.label}{s.required ? " (required)" : ""}</span>
              <div className="row">
                <input
                  type={s.secret ? "password" : "text"}
                  placeholder={s.secret && p.values[s.key] ? "•••••••• saved" : (s.default ?? "")}
                  value={vals[s.key] ?? (s.secret ? "" : (p.values[s.key] ?? ""))}
                  onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}
                />
                <button className="btn" onClick={async () => { await savePluginSetting(p, s.key, vals[s.key] ?? "", !!s.secret); toast("Saved.", "ok"); }}>Save</button>
              </div>
              {s.help && <small className="hint">{s.help}</small>}
            </label>
          ))}
          {p.tools.length > 0 && <div className="hint"><b>Tools:</b> {p.tools.map((t) => t.name).join(", ")}</div>}
          <EnginesEditor p={p} />
          {p.skills.length > 0 && <div className="hint"><b>Skills:</b> {p.skills.map((t) => t.name).join(", ")}</div>}
          {p.commands.length > 0 && <div className="hint"><b>Commands:</b> {p.commands.map((t) => `/${t.name}`).join(", ")}</div>}
          {p.agents.length > 0 && <div className="hint"><b>Agents:</b> {p.agents.map((t) => t.name).join(", ")}</div>}
          {p.mcpServers.length > 0 && <div className="hint"><b>Connectors:</b> {p.mcpServers.map((t) => t.name).join(", ")}</div>}
          {p.sourceUrl && <div className="hint">From {p.sourceUrl}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            {p.sourceUrl && (
              <button className="btn small" onClick={async () => { try { for (const d of await pluginsFromUrl(p.sourceUrl!)) if (d.name === p.name) await installPlugin(d); toast(`${p.name} updated.`, "ok"); } catch (e) { toast(errText(e), "error"); } }}>
                <Icon.refresh /> Update
              </button>
            )}
            <button className="btn small danger" onClick={() => confirm(`Remove the plugin ${p.name}? Its agents are removed too.`) && void uninstallPlugin(p.id)}>Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChoosePlugins({ drafts, onClose }: { drafts: PluginDraft[]; onClose: () => void }) {
  const [picked, setPicked] = useState<number[]>(drafts.map((_, i) => i));
  const hasCode = drafts.some((d) => d.tools.some((t) => t.kind === "js") || d.mcpServers.some((m) => m.transport === "stdio"));
  return (
    <Modal
      title={drafts.length > 1 ? `${drafts.length} plugins found` : `Install ${drafts[0].name}?`}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!picked.length}
            onClick={async () => {
              for (const i of picked) await installPlugin(drafts[i]);
              toast(`Installed ${picked.length} plugin(s).`, "ok");
              onClose();
            }}
          >
            Install
          </button>
        </>
      }
    >
      {drafts.map((d, i) => (
        <label key={i} className="switch">
          <input type="checkbox" checked={picked.includes(i)} onChange={(e) => setPicked(e.target.checked ? [...picked, i] : picked.filter((x) => x !== i))} />
          <span>
            {d.emoji ?? "🧩"} {d.name}
            <small>{counts(d)}{d.description ? ` · ${d.description.slice(0, 160)}` : ""}</small>
          </span>
        </label>
      ))}
      {hasCode && <div className="note warn" style={{ marginTop: 8 }}>This includes code that runs when the assistant uses it (in a sandbox, with internet access) or local connector commands. Only install plugins from sources you trust.</div>}
    </Modal>
  );
}

export function PluginsTab() {
  const plugins = useApp((s) => s.lib.plugins);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [drafts, setDrafts] = useState<PluginDraft[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const gallery = galleryPlugins().filter((g) => !plugins.some((p) => p.name === g.name));
  const run = async (fn: () => Promise<PluginDraft[]>) => {
    setBusy(true);
    try {
      setDrafts(await fn());
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3>Plugins</h3>
      <p>
        Add abilities: tools that call web services, skills (packaged instructions the assistant loads when needed), slash commands, ready-made agents and connectors. Works with Claude plugins (a GitHub link or .zip), TypingMind plugins (.json, single- or multi-function), Meridian plugin JSON and skill files (SKILL.md). Plugins that make pictures or videos also become backends in Image and Video mode.
      </p>
      {plugins.map((p) => (
        <PluginCard key={p.id} p={p} />
      ))}
      {!plugins.length && <p className="hint">No plugins installed yet.</p>}

      <h4>Install</h4>
      <div className="card">
        <label className="field">
          <span>From a link (GitHub repository or folder, .zip or .json)</span>
          <div className="row">
            <input type="url" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn primary" disabled={!url.trim() || busy} onClick={() => void run(() => pluginsFromUrl(url))}>{busy ? "Loading…" : "Get"}</button>
          </div>
        </label>
        <div className="row wrap">
          <input
            ref={file}
            type="file"
            hidden
            accept=".zip,.plugin,.json,.md"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await run(async () => pluginsFromFile(f.name, new Uint8Array(await f.arrayBuffer())));
            }}
          />
          <button className="btn" onClick={() => file.current?.click()}><Icon.download /> From a file…</button>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>Paste plugin JSON</summary>
          <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"name": "My plugin", "tools": [...]}' style={{ marginTop: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }} />
          <button className="btn small" style={{ marginTop: 6 }} disabled={!paste.trim()} onClick={() => void run(async () => fromJson(paste))}>Read</button>
        </details>
      </div>

      {gallery.length > 0 && (
        <>
          <h4>Gallery</h4>
          <div className="grid">
            {gallery.map((g) => (
              <div key={g.name} className="tile">
                <span className="tile-emoji">{g.emoji}</span>
                <b>{g.name}</b>
                <span className="tile-desc">{g.description}</span>
                <div className="row">
                  <button className="btn small" onClick={async () => { await installPlugin(g); toast(`Installed ${g.name}.`, "ok"); }}>
                    <Icon.plus /> Install
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {drafts && <ChoosePlugins drafts={drafts} onClose={() => setDrafts(null)} />}
    </>
  );
}

export function MemoryTab() {
  const memories = useApp((s) => s.lib.memories);
  const enabled = useApp((s) => s.settings.memory);
  const [text, setText] = useState("");
  return (
    <>
      <h3>Memory</h3>
      <p>Facts the assistant keeps across chats (it saves them when you share lasting preferences or details, or when you ask it to remember). They sync with your other devices.</p>
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(e) => void updateSettings({ memory: e.target.checked })} />
        <span>Use memory<small>Off: nothing is read or saved. Private chats never save memories when this is off.</small></span>
      </label>
      <div className="row" style={{ margin: "8px 0 14px" }}>
        <input type="text" placeholder="Add something to remember, e.g. I live in Berlin" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={async (e) => e.key === "Enter" && text.trim() && (await saveItem("memories", { text: text.trim() }), setText(""))} />
        <button className="btn" disabled={!text.trim()} onClick={async () => { await saveItem("memories", { text: text.trim() }); setText(""); }}>Add</button>
      </div>
      {memories.map((m) => (
        <div className="list-row" key={m.id}>
          <input type="text" defaultValue={m.text} onBlur={(e) => e.target.value.trim() && e.target.value !== m.text && void saveItem("memories", { id: m.id, text: e.target.value.trim() })} aria-label="Memory" />
          <button className="icon-btn" title="Forget this" onClick={() => void deleteItem("memories", m.id)}>
            <Icon.trash />
          </button>
        </div>
      ))}
      {!memories.length && <p className="hint">Nothing remembered yet.</p>}
      {memories.length > 0 && (
        <button className="btn small danger" onClick={async () => { if (confirm("Forget everything?")) for (const m of memories) await deleteItem("memories", m.id); }}>
          Forget everything
        </button>
      )}
    </>
  );
}

