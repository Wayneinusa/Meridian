import { useState } from "react";
import { platform } from "../../platform";
import { pickFolder } from "../../platform/files";
import { createProject, deleteItem, newChat, openChat, saveItem, setView, useApp } from "../../state/store";
import type { Project } from "../../types";
import { Icon } from "../icons";
import { ModelSelect } from "../Modal";
import { KnowledgeEditor } from "./Agents";
import { SkillPicker } from "./Skills";

export function ProjectsPage() {
  const projects = useApp((s) => s.lib.projects);
  const metas = useApp((s) => s.metas);
  const [name, setName] = useState("");
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Projects</h1>
        </div>
        <p className="lead">Group chats around a piece of work. Each project has its own instructions and reference files that every chat in it can use{platform().desktop ? ", and optionally a folder on this computer the assistant may work in" : ""}.</p>
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="text" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={async (e) => e.key === "Enter" && name.trim() && setView({ name: "project", id: (await createProject(name)).id })} />
          <button className="btn primary" disabled={!name.trim()} onClick={async () => setView({ name: "project", id: (await createProject(name)).id })}>
            <Icon.plus /> Create
          </button>
        </div>
        <div className="grid">
          {projects.map((p) => (
            <button key={p.id} className="tile" onClick={() => setView({ name: "project", id: p.id })}>
              <span className="tile-emoji">{p.emoji ?? "📁"}</span>
              <b>{p.name}</b>
              <span className="tile-desc">
                {metas.filter((m) => m.projectId === p.id).length} chats · {p.knowledge.length} files
                {p.instructions ? ` · ${p.instructions.slice(0, 60)}` : ""}
              </span>
            </button>
          ))}
        </div>
        {!projects.length && <p className="hint">No projects yet.</p>}
      </div>
    </div>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const project = useApp((s) => s.lib.projects.find((p) => p.id === id));
  const agents = useApp((s) => s.lib.agents);
  const allMetas = useApp((s) => s.metas);
  const metas = allMetas.filter((m) => m.projectId === id);
  if (!project) return <div className="page"><div className="page-inner"><p>This project no longer exists.</p></div></div>;
  const save = (patch: Partial<Project>) => void saveItem("projects", { id, ...patch });
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <input className="emoji-input" type="text" defaultValue={project.emoji ?? "📁"} onBlur={(e) => save({ emoji: [...e.target.value].slice(-2).join("") || undefined })} aria-label="Project icon" />
          <input type="text" defaultValue={project.name} onBlur={(e) => e.target.value.trim() && save({ name: e.target.value.trim() })} style={{ fontSize: 20, fontWeight: 650, flex: 1 }} aria-label="Project name" />
          <button className="btn primary" onClick={() => newChat({ projectId: id })}>
            <Icon.plus /> New chat in project
          </button>
        </div>
        <label className="field">
          <span>Project instructions</span>
          <textarea rows={4} defaultValue={project.instructions} placeholder="Background, goals, tone, rules every chat in this project should follow" onBlur={(e) => e.target.value !== project.instructions && save({ instructions: e.target.value })} />
        </label>
        <SkillPicker value={project.skills} onChange={(skills) => save({ skills })} label="Skills for chats in this project" />
        <div className="row wrap">
          <label className="field grow">
            <span>Default agent</span>
            <select value={project.agentId ?? ""} onChange={(e) => save({ agentId: e.target.value || undefined })}>
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.emoji ?? "🤖"} {a.name}</option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Default model</span>
            <ModelSelect value={project.model} onChange={(model) => save({ model })} empty="The usual default" />
          </label>
        </div>
        {platform().desktop && (
          <div className="field">
            <span className="hint">Work folder (the assistant may read and write files here without asking)</span>
            <div className="row">
              <input type="text" readOnly value={project.workFolder ?? ""} placeholder="None" />
              <button className="btn" onClick={async () => { const f = await pickFolder(); if (f) save({ workFolder: f }); }}>Choose…</button>
              {project.workFolder && <button className="btn" onClick={() => save({ workFolder: undefined })}>Clear</button>}
            </div>
          </div>
        )}
        <div className="section-title">Knowledge files</div>
        <KnowledgeEditor files={project.knowledge} onChange={(knowledge) => save({ knowledge })} />
        <div className="section-title">Chats</div>
        {metas.length === 0 && <p className="hint">No chats in this project yet.</p>}
        {metas.map((m) => (
          <button key={m.id} className="search-hit" onClick={() => void openChat(m.id)}>
            <b>{m.title}</b>
            <span>{m.preview}</span>
          </button>
        ))}
        <div className="section-title">Danger zone</div>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm(`Delete the project "${project.name}"? Its chats are kept and move back to the main list.`)) {
              void deleteItem("projects", id);
              setView({ name: "projects" });
            }
          }}
        >
          <Icon.trash /> Delete project
        </button>
      </div>
    </div>
  );
}
