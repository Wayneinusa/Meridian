// Skills: browse, install (SKILL.md, a folder, a zip, a GitHub link), create,
// edit, and choose where each one is used.
import { useMemo, useRef, useState } from "react";
import { skillFromMarkdownFile, skillMissing, skillsFromFiles, skillsFromUrl, skillsFromZip, skillZip, slug, toSkillMd, type SkillDraft } from "../../skills/skills";
import { deleteItem, installSkills, saveItem, toast, useApp } from "../../state/store";
import type { Skill } from "../../types";
import { Icon } from "../icons";
import { Modal } from "../Modal";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const AVAILABILITY: { id: Skill["availability"]; label: string; hint: string }[] = [
  { id: "everywhere", label: "Everywhere", hint: "Offered in every chat; the model loads it when a task fits" },
  { id: "assigned", label: "Only where assigned", hint: "Only for the agents, projects and consortium members you give it to" },
  { id: "off", label: "Off", hint: "Installed but not used" },
];

const TOOL_GROUPS = ["web", "files", "media", "browser", "computer", "connectors"];

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SkillEditor({ skill, onClose }: { skill: Partial<Skill>; onClose: () => void }) {
  const [s, setS] = useState<Partial<Skill>>({ availability: "assigned", files: {}, ...skill });
  const [newFile, setNewFile] = useState("");
  const save = async () => {
    if (!s.name?.trim() || !s.description?.trim() || !s.body?.trim()) return toast("A skill needs a name, a description (when to use it) and instructions.", "error");
    await saveItem("skills", { source: "created", ...s, name: s.name.trim(), description: s.description.trim() } as Skill);
    onClose();
  };
  const files = s.files ?? {};
  return (
    <Modal
      title={skill.id ? `Edit ${skill.name}` : "New skill"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input aria-label="Skill name" value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="e.g. Weekly report" autoFocus />
        {s.name && <small className="hint">Use it on demand with /{slug(s.name)} in the message box.</small>}
      </label>
      <label className="field">
        <span>Description: what it does and when to use it (the model sees only this until it loads the skill)</span>
        <textarea aria-label="Skill description" rows={2} value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} placeholder="e.g. Writes the weekly status report from the team's notes. Use when asked for a weekly report or summary." />
      </label>
      <label className="field">
        <span>Instructions (Markdown)</span>
        <textarea aria-label="Skill instructions" rows={10} className="mono" value={s.body ?? ""} onChange={(e) => setS({ ...s, body: e.target.value })} placeholder={"# Weekly report\n\n1. Read the notes…\n2. …"} />
      </label>
      <label className="field">
        <span>Where it is used</span>
        <select aria-label="Availability" value={s.availability} onChange={(e) => setS({ ...s, availability: e.target.value as Skill["availability"] })}>
          {AVAILABILITY.map((a) => (
            <option key={a.id} value={a.id}>{a.label}: {a.hint}</option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="muted" style={{ fontSize: 13 }}>Needs these tools</span>
        <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
          {TOOL_GROUPS.map((g) => {
            const on = s.requiresTools?.includes(g) ?? false;
            return (
              <button key={g} className={`chip-btn ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setS({ ...s, requiresTools: on ? s.requiresTools!.filter((x) => x !== g) : [...(s.requiresTools ?? []), g] })}>
                {g}
              </button>
            );
          })}
        </div>
      </div>
      <label className="field">
        <span>Needs these connectors (comma-separated, e.g. notion, linear)</span>
        <input aria-label="Required connectors" value={(s.requiresConnectors ?? []).join(", ")} onChange={(e) => setS({ ...s, requiresConnectors: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
      </label>
      <div className="field">
        <span className="muted" style={{ fontSize: 13 }}>Files that come with the skill (templates, examples, reference). The model reads them with read_skill when the instructions say so.</span>
        {Object.entries(files).map(([path, text]) => (
          <details key={path} className="skill-file">
            <summary className="row">
              <span className="grow mono">{path}</span>
              <button
                className="icon-btn"
                title={`Remove ${path}`}
                onClick={(e) => {
                  e.preventDefault();
                  const next = { ...files };
                  delete next[path];
                  setS({ ...s, files: next });
                }}
              >
                <Icon.x />
              </button>
            </summary>
            <textarea rows={6} className="mono" value={text} onChange={(e) => setS({ ...s, files: { ...files, [path]: e.target.value } })} />
          </details>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <input aria-label="New file name" value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="e.g. templates/report.md" />
          <button className="btn small" disabled={!newFile.trim() || newFile.trim() in files} onClick={() => (setS({ ...s, files: { ...files, [newFile.trim()]: "" } }), setNewFile(""))}>
            Add file
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SkillsPage() {
  const skills = useApp((s) => s.lib.skills);
  const plugins = useApp((s) => s.lib.plugins);
  const agents = useApp((s) => s.lib.agents);
  const projects = useApp((s) => s.lib.projects);
  const settings = useApp((s) => s.settings);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Partial<Skill> | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const folderIn = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const mine = useMemo(() => skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)), [skills, q]);
  const fromPlugins = plugins.filter((p) => p.skills.length).flatMap((p) => p.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).map((s) => ({ ...s, plugin: p })));

  const install = async (drafts: SkillDraft[], source: Skill["source"], sourceUrl?: string) => {
    if (!drafts.length) return toast("No SKILL.md found there.", "error");
    const n = await installSkills(drafts, source, sourceUrl);
    toast(`Installed ${n.added} skill${n.added === 1 ? "" : "s"}${n.updated ? `, updated ${n.updated}` : ""}. Choose where each one is used below.`, "ok");
  };
  const fromFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const all = [...list];
      if (all.length === 1 && /\.zip$/i.test(all[0].name)) await install(skillsFromZip(new Uint8Array(await all[0].arrayBuffer())), "zip");
      else if (all.length === 1 && /\.md$/i.test(all[0].name)) await install([skillFromMarkdownFile(all[0].name, await all[0].text())], "file");
      else {
        // a folder: every SKILL.md in it, with the text files beside it
        const files: Record<string, string> = {};
        for (const f of all) {
          const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
          if (f.size < 1_500_000 && (/\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|ts|py|sh|rb|sql)$/i.test(path))) files[path] = await f.text();
        }
        await install(skillsFromFiles(files), "folder");
      }
    } catch (e) {
      toast(`Could not install: ${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const fromLink = async () => {
    if (!link.trim()) return;
    setBusy(true);
    try {
      await install(await skillsFromUrl(link), /github\.com/.test(link) ? "github" : "url", link.trim());
      setLink("");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const usedBy = (id: string) => [...agents.filter((a) => a.skills?.includes(id)).map((a) => a.name), ...projects.filter((p) => p.skills?.includes(id)).map((p) => `${p.name} (project)`)];

  return (
    <div className="page" data-testid="skills-page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Skills</h1>
          <button className="btn primary" onClick={() => setEditing({})}>
            <Icon.plus /> New skill
          </button>
        </div>
        <p className="lead">
          Reusable instructions (and files) an assistant loads when a task calls for them, in the SKILL.md format Claude uses. Only a skill's name and description are given to the model up front; it reads the rest when it uses the skill. Type /skill-name in a message to use one on purpose.
        </p>
        <div className="card skills-install">
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" disabled={busy} onClick={() => fileIn.current?.click()}>
              <Icon.file /> SKILL.md or .zip
            </button>
            <button className="btn" disabled={busy} onClick={() => folderIn.current?.click()}>
              <Icon.folder /> A folder
            </button>
            <input className="grow" aria-label="Skill link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="GitHub repository, folder or SKILL.md link, or a zip address" onKeyDown={(e) => e.key === "Enter" && void fromLink()} />
            <button className="btn" disabled={busy || !link.trim()} onClick={() => void fromLink()}>
              {busy ? "Installing…" : "Install"}
            </button>
          </div>
          <input ref={fileIn} type="file" accept=".md,.zip,text/markdown,application/zip" hidden onChange={(e) => (void fromFiles(e.target.files), (e.target.value = ""))} />
          <input ref={folderIn} type="file" hidden multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => (void fromFiles(e.target.files), (e.target.value = ""))} />
          <p className="hint" style={{ margin: "8px 0 0" }}>
            A repository with several skills installs all of them. Installing a skill with the same name again updates it and keeps where it is used.
          </p>
        </div>
        <input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} style={{ margin: "12px 0" }} />
        <div className="grid">
          {mine.map((s) => {
            const missing = skillMissing(s, settings.tools, settings.mcpServers, plugins);
            const used = usedBy(s.id);
            return (
              <div key={s.id} className="tile skill-tile" data-testid="skill-tile">
                <div className="row">
                  <b className="grow">{s.name}</b>
                  <span className="badge">{s.source === "created" ? "yours" : s.source}</span>
                </div>
                <p className="hint" style={{ margin: "4px 0" }}>{s.description}</p>
                <div className="row wrap" style={{ gap: 6 }}>
                  <select aria-label={`Where ${s.name} is used`} value={s.availability} onChange={(e) => void saveItem("skills", { id: s.id, availability: e.target.value as Skill["availability"] })}>
                    {AVAILABILITY.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                  <span className="hint mono">/{slug(s.name)}</span>
                </div>
                {s.availability === "assigned" && <p className="hint" style={{ margin: "4px 0 0" }}>{used.length ? `Given to: ${used.join(", ")}` : "Not given to any agent or project yet (consortium members can have it too)."}</p>}
                {missing.length > 0 && <p className="hint warn-text" style={{ margin: "4px 0 0" }}>Not offered until fixed: {missing.join("; ")}.</p>}
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn small" onClick={() => setEditing(s)}>Edit</button>
                  <button className="btn small" title="Download as a zip (SKILL.md and its files)" onClick={() => download(skillZip(s), `${slug(s.name)}.zip`, "application/zip")}>Export</button>
                  <button className="btn small" title="Copy SKILL.md" onClick={() => void navigator.clipboard?.writeText(toSkillMd(s)).then(() => toast("SKILL.md copied.", "ok"))}>Copy</button>
                  <span className="grow" />
                  <button className="icon-btn" title={`Delete ${s.name}`} onClick={() => confirm(`Delete the skill "${s.name}"?`) && void deleteItem("skills", s.id)}>
                    <Icon.trash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {!mine.length && <p className="hint">{q ? "No skill matches." : "No skills yet. Create one, or install a SKILL.md, a folder, a zip or a GitHub link."}</p>}
        {fromPlugins.length > 0 && (
          <>
            <h3 style={{ marginTop: 22 }}>From plugins</h3>
            <p className="hint">Skills that come with installed plugins. They are offered everywhere while the plugin is on (Settings → Plugins).</p>
            <div className="grid">
              {fromPlugins.map((s) => (
                <div key={`${s.plugin.id}:${s.name}`} className="tile skill-tile">
                  <div className="row">
                    <b className="grow">{s.name}</b>
                    <span className="badge">{s.plugin.name}</span>
                  </div>
                  <p className="hint" style={{ margin: "4px 0" }}>{s.description}</p>
                  <span className="hint">{s.plugin.enabled ? "On" : "Plugin is off"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {editing && <SkillEditor skill={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Pick skills for an agent, a project or a consortium member. */
export function SkillPicker({ value, onChange, label = "Skills" }: { value?: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const skills = useApp((s) => s.lib.skills);
  const chosen = value ?? [];
  const usable = skills.filter((s) => s.availability !== "off");
  return (
    <div className="field skill-picker" data-testid="skill-picker">
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      {usable.length ? (
        <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
          {usable.map((s) => {
            const on = chosen.includes(s.id) || s.availability === "everywhere";
            return (
              <button
                key={s.id}
                className={`chip-btn ${on ? "on" : ""}`}
                aria-pressed={on}
                disabled={s.availability === "everywhere"}
                title={s.availability === "everywhere" ? "Available everywhere already" : s.description}
                onClick={() => onChange(chosen.includes(s.id) ? chosen.filter((x) => x !== s.id) : [...chosen, s.id])}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="hint">No skills yet (sidebar → Skills).</div>
      )}
    </div>
  );
}
