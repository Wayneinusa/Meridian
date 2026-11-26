import { useState } from "react";
import { findModel } from "../providers/registry";
import { consortiumForceVote, consortiumStop, setView, useApp } from "../state/store";
import type { ConsortiumConfig, ConsortiumMember, ConsortiumPhase, Message, ModelRef, ProviderConfig, Settings } from "../types";
import { uid } from "../types";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { FileView } from "./MessageView";
import { ModelSelect } from "./Modal";
import { SkillPicker } from "./pages/Skills";

type Seed = Omit<ConsortiumMember, "id"> & { coordinator?: boolean };

export interface TeamPreset {
  name: string;
  hint: string;
  style: "deliberate" | "execute";
  members: Seed[];
}

/** Quick starts: each fills in the team builder, where everything stays editable. */
export const TEAMS: TeamPreset[] = [
  {
    name: "Research team",
    hint: "Find, analyse, challenge, write",
    style: "deliberate",
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
    style: "deliberate",
    members: [
      { emoji: "👍", name: "Advocate", role: "builds the strongest honest case for" },
      { emoji: "👎", name: "Skeptic", role: "builds the strongest honest case against" },
      { emoji: "⚖️", name: "Judge", role: "weighs both sides fairly and decides what the evidence supports", coordinator: true },
    ],
  },
  {
    name: "Build & review",
    hint: "Design, make the files, check them",
    style: "deliberate",
    members: [
      { emoji: "🏗️", name: "Architect", role: "designs the approach and the structure of the result", coordinator: true },
      { emoji: "🛠️", name: "Builder", role: "does the hands-on work and creates the files" },
      { emoji: "🔍", name: "Reviewer", role: "checks quality, correctness and edge cases" },
    ],
  },
  {
    name: "Operations crew",
    hint: "Scout, reconcile, contact, audit: all at once",
    style: "execute",
    members: [
      { emoji: "🧭", name: "Lead", role: "runs the operation: splits the work, unblocks people, reports the outcome", coordinator: true },
      { emoji: "🔭", name: "Scout", role: "gathers the current facts: bookings, listings, messages, schedules, anything that changed" },
      { emoji: "🧮", name: "Reconciler", role: "matches records against each other (payments, invoices, bookings) and lists every mismatch with its amount" },
      { emoji: "💬", name: "Guest Contact", role: "drafts clear, friendly messages to guests or customers for every issue that needs one" },
      { emoji: "✅", name: "Auditor", role: "audits the crew's results: verifies figures and facts and flags anything wrong or missing" },
    ],
  },
  {
    name: "Incident response",
    hint: "Contain, find the cause, fix, communicate",
    style: "execute",
    members: [
      { emoji: "🚒", name: "Incident Lead", role: "coordinates the response, keeps the timeline and writes the incident report", coordinator: true },
      { emoji: "🔬", name: "Investigator", role: "finds the root cause from logs, data and recent changes" },
      { emoji: "🛠️", name: "Fixer", role: "contains the problem and prepares the fix or workaround" },
      { emoji: "📣", name: "Communicator", role: "writes status updates for users and stakeholders" },
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

export function teamFrom(seeds: Seed[], models: ModelRef[] = [], style: "deliberate" | "execute" = "deliberate"): ConsortiumConfig {
  const members = seeds.map((s, i) => ({ id: uid("mem"), name: s.name, role: s.role, emoji: s.emoji, model: models.length ? models[i % models.length] : undefined }));
  const coord = seeds.findIndex((s) => s.coordinator);
  return { members, coordinatorId: members[Math.max(coord, 0)].id, rounds: 2, workSteps: 15, style, origin: "preset" };
}

export const modelName = (settings: Settings, ref?: ModelRef) => (ref ? (findModel(settings, ref)?.model.name ?? ref.modelId) : "the chat's model");

/** Model calls a run takes, roughly (before tool steps). */
export function costEstimate(cfg: ConsortiumConfig): number {
  const n = cfg.members.length;
  return cfg.style === "execute" ? n + 3 : n * 4 + cfg.rounds * (n + 1) + 2;
}

/** The header button: opens the Consortium studio for this chat. */
export function ConsortiumChip() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const cfg = active ? active.consortium : draft.consortium;
  const on = (active ? active.mode : draft.mode) === "consortium" && !!cfg;
  return (
    <button className={`chip-btn ${on ? "on" : ""}`} title="Several agents work on the task together" onClick={() => setView({ name: "consortium", edit: true })}>
      <Icon.agent /> Consortium{on ? ` · ${cfg!.members.length}` : ""}
    </button>
  );
}

/** Edit a team: members in order, each with a name, role, model and optional saved agent. */
export function TeamBuilder({ cfg, onChange }: { cfg: ConsortiumConfig; onChange: (c: ConsortiumConfig) => void }) {
  const agents = useApp((s) => s.lib.agents);
  const skills = useApp((s) => s.lib.skills);
  const patch = (id: string, p: Partial<ConsortiumMember>) => onChange({ ...cfg, members: cfg.members.map((m) => (m.id === id ? { ...m, ...p } : m)) });
  const move = (i: number, d: number) => {
    const list = cfg.members.slice();
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    onChange({ ...cfg, members: list });
  };
  const setCount = (n: number) => {
    let list = cfg.members.slice(0, n);
    while (list.length < n) list = [...list, { id: uid("mem"), name: `Agent ${list.length + 1}`, role: "", emoji: "🤖" }];
    onChange({ ...cfg, members: list, coordinatorId: list.some((m) => m.id === cfg.coordinatorId) ? cfg.coordinatorId : list[0].id });
  };
  const remove = (id: string) => {
    const list = cfg.members.filter((x) => x.id !== id);
    onChange({ ...cfg, members: list, coordinatorId: cfg.coordinatorId === id ? list[0].id : cfg.coordinatorId });
  };
  return (
    <div className="team-builder">
      <div className="row wrap builder-head">
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">Number of agents</span>
          <select aria-label="Number of agents" value={cfg.members.length} onChange={(e) => setCount(Number(e.target.value))}>
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="grow" />
        <span className="hint">The coordinator leads, writes drafts and the final answer or report.</span>
      </div>
      <div className="member-grid">
        {cfg.members.map((m, i) => (
          <div key={m.id} className={`member-card ${cfg.coordinatorId === m.id ? "coord" : ""}`} data-testid="member-row">
            <div className="row" style={{ gap: 6 }}>
              <span className="member-no">{i + 1}</span>
              <input className="emoji-in" value={m.emoji ?? ""} onChange={(e) => patch(m.id, { emoji: e.target.value.slice(0, 4) })} aria-label="Emoji" />
              <input value={m.name} onChange={(e) => patch(m.id, { name: e.target.value })} aria-label="Member name" placeholder="Name" style={{ flex: "1 1 auto", minWidth: 0 }} />
              <button className="icon-btn" title="Move up" aria-label={`Move ${m.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="icon-btn" title="Move down" aria-label={`Move ${m.name} down`} disabled={i === cfg.members.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="icon-btn" title={`Remove ${m.name}`} aria-label={`Remove ${m.name}`} disabled={cfg.members.length <= 2} onClick={() => remove(m.id)}>
                <Icon.x />
              </button>
            </div>
            <label className="field" style={{ margin: 0 }}>
              <span>Role</span>
              <textarea rows={2} value={m.role} onChange={(e) => patch(m.id, { role: e.target.value })} aria-label="Role" placeholder="What this member does, specifically (e.g. reconciles payouts against bookings)" />
            </label>
            <div className="member-fields">
              <label className="field" style={{ margin: 0 }}>
                <span>Model and provider</span>
                <ModelSelect value={m.model} onChange={(r) => patch(m.id, { model: r })} empty="The chat's model" />
              </label>
              {agents.length > 0 && (
                <label className="field" style={{ margin: 0 }}>
                  <span>Saved agent (optional)</span>
                  <select
                    value={m.agentId ?? ""}
                    onChange={(e) => {
                      const a = agents.find((x) => x.id === e.target.value);
                      patch(m.id, a ? { agentId: a.id, name: a.name, emoji: a.emoji, role: m.role || a.description || "" } : { agentId: undefined });
                    }}
                    aria-label="Saved agent"
                  >
                    <option value="">None</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.emoji ?? "🤖"} {a.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {skills.length > 0 && <SkillPicker value={m.skills} onChange={(ids) => patch(m.id, { skills: ids })} label="Skills (optional)" />}
            <label className="hint coord-pick">
              <input type="radio" name="coordinator" checked={cfg.coordinatorId === m.id} onChange={() => onChange({ ...cfg, coordinatorId: m.id })} /> Coordinator
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Beside a consortium chat: the team, what each member is doing, the shared scratchpad, and the controls. */
export function TeamPanel() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => (s.activeId ? s.busy[s.activeId] !== undefined : false));
  const statuses = useApp((s) => (s.activeId ? s.consortium[s.activeId] : undefined));
  const allSkills = useApp((s) => s.lib.skills);
  const cfg = active ? active.consortium : draft.consortium;
  if (!cfg) return null;
  const crew = cfg.style === "execute";
  const pad = active?.scratchpad ?? [];
  return (
    <aside className="artifacts-panel team-panel" aria-label="Team" data-testid="team-panel">
      <div className="panel-head row">
        <b className="grow">Team · {crew ? "execution crew" : "discuss and agree"}</b>
        <button className="btn small" onClick={() => setView({ name: "consortium", edit: true })}>Edit team</button>
        <button className="icon-btn" title="Hide the team panel" onClick={() => useApp.setState({ teamOpen: false })}>
          <Icon.x />
        </button>
      </div>
      <div className="panel-body">
        {cfg.rationale && <p className="hint" style={{ marginTop: 0 }}>Why this team: {cfg.rationale}</p>}
        <ul className="team-list">
          {cfg.members.map((m) => {
            const st = busy ? (statuses?.[m.id] ?? "waiting") : "ready";
            return (
              <li key={m.id} className={`team-member st-${st.split(" ")[0]}`} data-testid="team-member">
                <div className="row" style={{ gap: 6 }}>
                  <span>{m.emoji ?? "🤖"}</span>
                  <b>{m.name}</b>
                  {m.id === cfg.coordinatorId && <span className="badge">coordinator</span>}
                  <span className="grow" />
                  <span className="member-status">{st}</span>
                  {busy && st !== "stopped" && st !== "done" && (
                    <button className="icon-btn" title={`Stop ${m.name}`} aria-label={`Stop ${m.name}`} onClick={() => consortiumStop(m.id)}>
                      <Icon.x />
                    </button>
                  )}
                </div>
                <div className="hint">{m.role || "(no role)"}</div>
                <div className="hint model-line">{modelName(settings, m.model)}</div>
                {m.skills?.length ? <div className="hint">Skills: {m.skills.map((id) => allSkills.find((x) => x.id === id)?.name).filter(Boolean).join(", ")}</div> : null}
              </li>
            );
          })}
        </ul>
        {busy && (
          <button className="btn small" onClick={() => consortiumForceVote()} title={crew ? "Stop the work now and have the coordinator report what was done" : "Skip the rest of the discussion and vote on a joint answer now"}>
            {crew ? "Report now" : "Force a vote"}
          </button>
        )}
        <h4 style={{ margin: "16px 0 6px" }}>Shared scratchpad</h4>
        {pad.length ? (
          <div className="scratchpad" data-testid="scratchpad">
            {pad.map((e, i) => (
              <div key={i} className="pad-entry">
                <b>{e.by}</b>
                <Markdown text={e.text} />
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">Notes, facts and drafts the members share appear here while they work.</p>
        )}
        <p className="hint">Type in the message box while the team works to add an instruction for everyone.</p>
      </div>
    </aside>
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

/** The coordinator's assignments as a list instead of the JSON it was asked for. */
export function readableAssignments(text: string): string {
  const block = /```(?:json)?\s*(\{[\s\S]*\})\s*```|(\{[\s\S]*"assignments"[\s\S]*\})/.exec(text);
  if (!block) return text;
  try {
    const j = JSON.parse(block[1] ?? block[2]) as { assignments?: { member?: string; part?: string }[] };
    if (!Array.isArray(j.assignments)) return text;
    const list = j.assignments.map((a) => `- **${a.member}:** ${a.part}`).join("\n");
    return `${text.replace(block[0], "").trim()}\n\n${list}`.trim();
  } catch {
    return text;
  }
}

/** The discussion of one consortium run, readable and collapsible. */
export function ConsortiumThread({ messages, running }: { messages: Message[]; running: boolean }) {
  const settings = useApp((s) => s.settings);
  const crew = !messages.some((m) => m.member?.phase === "plan" || m.member?.phase === "vote");
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
          const title = crew && t.phase === "review" ? "Audit" : crew && t.phase === "assign" ? "Jobs" : PHASE_TITLE[t.phase];
          const head = key !== last ? `${title}${t.round && (t.phase === "draft" || t.phase === "vote") ? ` (round ${t.round})` : ""}` : null;
          last = key;
          const raw = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
          const text = t.phase === "assign" ? readableAssignments(raw) : raw;
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
