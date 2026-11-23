import { useState } from "react";
import { findModel } from "../providers/registry";
import { consortiumForceVote, consortiumStop, setConsortium, useApp } from "../state/store";
import type { ConsortiumConfig, ConsortiumMember, ConsortiumPhase, Message, ModelRef, ProviderConfig, Settings } from "../types";
import { uid } from "../types";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { FileView } from "./MessageView";
import { ModelSelect } from "./Modal";

type Seed = Omit<ConsortiumMember, "id"> & { coordinator?: boolean };

export const TEAMS: { name: string; hint: string; members: Seed[] }[] = [
  {
    name: "Research team",
    hint: "Find, analyse, challenge, write",
    members: [
      { emoji: "🔎", name: "Researcher", role: "finds the facts and the best sources and checks them" },
      { emoji: "📊", name: "Analyst", role: "works out implications, numbers and trade-offs" },
      { emoji: "🧐", name: "Critic", role: "looks for errors, weak evidence and missing perspectives" },
      { emoji: "✍️", name: "Writer", role: "turns the team's work into a clear, well-structured answer", coordinator: true },
    ],
  },
  {
    name: "Debate",
    hint: "For, against, and a fair judge",
    members: [
      { emoji: "👍", name: "Advocate", role: "builds the strongest honest case for" },
      { emoji: "👎", name: "Skeptic", role: "builds the strongest honest case against" },
      { emoji: "⚖️", name: "Judge", role: "weighs both sides fairly and decides what the evidence supports", coordinator: true },
    ],
  },
  {
    name: "Build & review",
    hint: "Design, make the files, check them",
    members: [
      { emoji: "🏗️", name: "Architect", role: "designs the approach and the structure of the result", coordinator: true },
      { emoji: "🛠️", name: "Builder", role: "does the hands-on work and creates the files" },
      { emoji: "🔍", name: "Reviewer", role: "checks quality, correctness and edge cases" },
    ],
  },
];

/** One chat model from each of up to `n` different providers that are ready: a cross-model team. */
export function crossModelRefs(providers: ProviderConfig[], n: number): ModelRef[] {
  const out: ModelRef[] = [];
  for (const p of providers) {
    if (!p.enabled || (!p.hasKey && !p.signedIn && p.kind !== "openai-compatible")) continue;
    const m = p.models.find((x) => x.kind === "chat" && x.caps.tools);
    if (m) out.push({ providerId: p.id, modelId: m.id });
    if (out.length >= n) break;
  }
  return out;
}

export function teamFrom(seeds: Seed[], models: ModelRef[] = []): ConsortiumConfig {
  const members = seeds.map((s, i) => ({ id: uid("mem"), name: s.name, role: s.role, emoji: s.emoji, model: models.length ? models[i % models.length] : undefined }));
  const coord = seeds.findIndex((s) => s.coordinator);
  return { members, coordinatorId: members[Math.max(coord, 0)].id, rounds: 2, workSteps: 15 };
}

const modelName = (settings: Settings, ref?: ModelRef) => (ref ? (findModel(settings, ref)?.model.name ?? ref.modelId) : "chat's model");

/** The header button: set up the team, turn consortium mode on or off. */
export function ConsortiumChip() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const cfg = active ? active.consortium : draft.consortium;
  const on = (active ? active.mode : draft.mode) === "consortium" && !!cfg;
  const [open, setOpen] = useState(false);
  return (
    <span className="pop-anchor">
      <button className={`chip-btn ${on ? "on" : ""}`} title="Several agents work on the task together and reach a conclusion" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon.agent /> Consortium{on ? ` · ${cfg!.members.length}` : ""}
      </button>
      {open && <ConsortiumSetup initial={cfg} on={on} onClose={() => setOpen(false)} />}
    </span>
  );
}

export function ConsortiumSetup({ initial, on, onClose }: { initial?: ConsortiumConfig; on: boolean; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.lib.agents);
  const [cfg, setCfg] = useState<ConsortiumConfig>(initial ?? teamFrom(TEAMS[0].members));
  const patch = (id: string, p: Partial<ConsortiumMember>) => setCfg({ ...cfg, members: cfg.members.map((m) => (m.id === id ? { ...m, ...p } : m)) });
  const cross = crossModelRefs(settings.providers, 4);
  return (
    <div className="popover consortium-setup" role="dialog" aria-label="Consortium">
      <div className="menu-head">Consortium: several agents, one task</div>
      <p className="hint" style={{ margin: "0 8px 8px" }}>
        They plan who does what, work in parallel, review each other, then vote on a joint answer. You see the whole discussion and can add instructions, stop an agent or call the vote.
      </p>
      <div className="row wrap" style={{ margin: "0 8px 8px", gap: 6 }}>
        {TEAMS.map((t) => (
          <button key={t.name} className="btn small" title={t.hint} onClick={() => setCfg(teamFrom(t.members))}>{t.name}</button>
        ))}
        <button className="btn small" disabled={cross.length < 2} title={cross.length < 2 ? "Needs keys for at least two providers" : "Each member on a different provider's model"} onClick={() => setCfg(teamFrom(TEAMS[0].members, cross))}>
          Cross-model team
        </button>
      </div>
      <div className="consortium-members">
        {cfg.members.map((m) => (
          <div key={m.id} className="consortium-member-edit" data-testid="member-row">
            <div className="row" style={{ gap: 6 }}>
              <input className="emoji-in" value={m.emoji ?? ""} onChange={(e) => patch(m.id, { emoji: e.target.value.slice(0, 4) })} aria-label="Emoji" />
              <input value={m.name} onChange={(e) => patch(m.id, { name: e.target.value })} aria-label="Member name" style={{ flex: "1 1 auto" }} />
              <label className="hint coord" title="Merges plans, drafts and writes the final answer">
                <input type="radio" name="coordinator" checked={cfg.coordinatorId === m.id} onChange={() => setCfg({ ...cfg, coordinatorId: m.id })} /> coordinator
              </label>
              <button className="icon-btn" title={`Remove ${m.name}`} disabled={cfg.members.length <= 2} onClick={() => setCfg({ ...cfg, members: cfg.members.filter((x) => x.id !== m.id), coordinatorId: cfg.coordinatorId === m.id ? cfg.members.find((x) => x.id !== m.id)!.id : cfg.coordinatorId })}>
                <Icon.x />
              </button>
            </div>
            <input value={m.role} onChange={(e) => patch(m.id, { role: e.target.value })} aria-label="Role" placeholder="Role: what this member is for" />
            <div className="row wrap" style={{ gap: 6 }}>
              <ModelSelect value={m.model} onChange={(r) => patch(m.id, { model: r })} empty="Model: the chat's model" />
              {agents.length > 0 && (
                <select value={m.agentId ?? ""} onChange={(e) => {
                  const a = agents.find((x) => x.id === e.target.value);
                  patch(m.id, a ? { agentId: a.id, name: a.name, emoji: a.emoji, role: a.description || m.role } : { agentId: undefined });
                }} aria-label="Saved agent">
                  <option value="">No saved agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.emoji ?? "🤖"} {a.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ margin: "8px", gap: 10 }}>
        <button className="btn small" disabled={cfg.members.length >= 6} onClick={() => setCfg({ ...cfg, members: [...cfg.members, { id: uid("mem"), name: `Agent ${cfg.members.length + 1}`, role: "contributes its own view", emoji: "🤖" }] })}>
          <Icon.plus /> Add member
        </button>
        <label className="hint">
          Vote rounds{" "}
          <select value={cfg.rounds} onChange={(e) => setCfg({ ...cfg, rounds: Number(e.target.value) })} aria-label="Vote rounds">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="hint">
          Steps per member{" "}
          <select value={cfg.workSteps} onChange={(e) => setCfg({ ...cfg, workSteps: Number(e.target.value) })} aria-label="Steps per member">
            {[5, 10, 15, 25, 40].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="hint" style={{ margin: "0 8px 8px" }}>
        Cost: roughly {cfg.members.length * 4 + cfg.rounds * (cfg.members.length + 1) + 2} model calls per task, plus tool steps while working.
      </div>
      <div className="row" style={{ margin: 8, gap: 8 }}>
        <button className="btn primary" onClick={() => (setConsortium(cfg), onClose())}>{on ? "Save team" : "Turn on consortium mode"}</button>
        {on && <button className="btn" onClick={() => (setConsortium(undefined), onClose())}>Turn off</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Above the message box: who is in the team and what each one is doing; stop one, or call the vote. */
export function ConsortiumBar() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => (s.activeId ? s.busy[s.activeId] !== undefined : false));
  const statuses = useApp((s) => (s.activeId ? s.consortium[s.activeId] : undefined));
  const cfg = active ? active.consortium : draft.consortium;
  const mode = active ? active.mode : draft.mode;
  if (mode !== "consortium" || !cfg) return null;
  return (
    <div className="consortium-bar" data-testid="consortium-bar">
      {cfg.members.map((m) => {
        const st = busy ? (statuses?.[m.id] ?? "waiting") : "ready";
        return (
          <span key={m.id} className={`member-chip st-${st.split(" ")[0]}`} title={`${m.role} · ${modelName(settings, m.model)}`}>
            <span>{m.emoji ?? "🤖"}</span>
            <b>{m.name}</b>
            {m.id === cfg.coordinatorId && <span className="muted">· coord.</span>}
            <span className="member-status">{st}</span>
            {busy && st !== "stopped" && st !== "done" && (
              <button className="icon-btn" title={`Stop ${m.name}`} aria-label={`Stop ${m.name}`} onClick={() => consortiumStop(m.id)}>
                <Icon.x />
              </button>
            )}
          </span>
        );
      })}
      {busy && (
        <button className="btn small" onClick={() => consortiumForceVote()} title="Skip the rest of the discussion and vote on a joint answer now">
          Force a vote
        </button>
      )}
    </div>
  );
}

const PHASE_TITLE: Record<ConsortiumPhase, string> = {
  plan: "Planning: who does what",
  assign: "Assignments",
  work: "Work",
  review: "Reviews",
  draft: "Draft",
  vote: "Votes",
  final: "Answer",
  note: "Your instruction",
};

/** The discussion of one consortium run, readable and collapsible. */
export function ConsortiumThread({ messages, running }: { messages: Message[]; running: boolean }) {
  const settings = useApp((s) => s.settings);
  const [open, setOpen] = useState(true);
  let last = "";
  return (
    <div className="consortium-thread" data-testid="consortium-thread">
      <button className="link-btn thread-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "▾" : "▸"} Consortium discussion · {messages.length} message{messages.length === 1 ? "" : "s"}
        {running && <span className="spinner" style={{ marginLeft: 8 }} />}
      </button>
      {open &&
        messages.map((m) => {
          const t = m.member!;
          const key = `${t.phase}${t.round ?? ""}`;
          const head = key !== last ? `${PHASE_TITLE[t.phase]}${t.round && (t.phase === "draft" || t.phase === "vote") ? ` (round ${t.round})` : ""}` : null;
          last = key;
          const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
          return (
            <div key={m.id}>
              {head && <div className="phase-head">{head}</div>}
              <div className={`member-msg phase-${t.phase}`} data-phase={t.phase}>
                <div className="member-head">
                  <span>{t.emoji ?? "🤖"}</span>
                  <b>{t.name}</b>
                  <span className="muted">{findModel(settings, m.model)?.model.name ?? ""}</span>
                  {t.vote && <span className={`badge ${t.vote === "agree" ? "ok" : "err"}`}>{t.vote === "agree" ? "agrees" : "disagrees"}</span>}
                </div>
                <Markdown text={text} />
                {m.parts.map((p) => (p.type === "artifact" ? <FileView key={p.blobId} file={p} /> : null))}
              </div>
            </div>
          );
        })}
    </div>
  );
}
