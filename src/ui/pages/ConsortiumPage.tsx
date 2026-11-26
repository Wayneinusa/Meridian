// The Consortium studio: a full page to build a team of agents.
//   Manual team     choose how many, then name, role, model and coordinator for each
//   Automatic team  describe the task; a strong model proposes the team to accept,
//                   edit or regenerate
//   Quick starts    presets fill the manual builder
// Then start it as a new chat, or save it to the chat you came from.
import { useMemo, useRef, useState } from "react";
import { modelOptions, type TeamRequest } from "../../agent/teamPlanner";
import { allProviders } from "../../providers/registry";
import { proposeTeam, setConsortium, setView, startConsortium, toast, useApp } from "../../state/store";
import type { ConsortiumConfig, ModelRef } from "../../types";
import { costEstimate, crossModelRefs, TeamBuilder, teamFrom, TEAMS } from "../Consortium";
import { Icon } from "../icons";
import { ModelSelect } from "../Modal";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ConsortiumPage({ edit }: { edit?: boolean }) {
  const settings = useApp((s) => s.settings);
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const current = edit ? (active ? active.consortium : draft.consortium) : undefined;
  const hasChat = edit && !!active && active.messages.length > 0;
  const [how, setHow] = useState<"manual" | "auto">("manual");
  const [cfg, setCfg] = useState<ConsortiumConfig>(current ?? teamFrom(TEAMS[0].members, [], TEAMS[0].style));
  const [task, setTask] = useState("");
  // automatic team
  const [req, setReq] = useState<Omit<TeamRequest, "task">>({ maxAgents: 4, providers: [], preferFast: false, style: "auto" });
  const [planner, setPlanner] = useState<ModelRef | undefined>(settings.defaultModel);
  const [proposed, setProposed] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [problem, setProblem] = useState("");
  const abort = useRef<AbortController | null>(null);
  const ready = useMemo(() => allProviders(settings).filter((p) => modelOptions([p]).length > 0), [settings]);
  const cross = crossModelRefs(settings.providers, 4);

  const propose = async () => {
    if (!task.trim()) {
      setProblem("Describe the task first: the planner builds the team for it.");
      return;
    }
    setThinking(true);
    setProblem("");
    abort.current = new AbortController();
    try {
      const p = await proposeTeam({ ...req, task }, planner, abort.current.signal);
      setCfg(p.config);
      setProposed(true);
    } catch (e) {
      if (!abort.current.signal.aborted) setProblem(errText(e));
    } finally {
      setThinking(false);
    }
  };

  const start = async () => {
    const bad = cfg.members.find((m) => !m.name.trim() || !m.role.trim());
    if (bad) return toast(`Give every member a name and a role (${bad.name || "unnamed member"}).`, "error");
    if (!task.trim()) return toast("Describe the task for the team.", "error");
    await startConsortium(cfg, task);
  };
  const saveToChat = () => {
    setConsortium(cfg);
    setView({ name: "chat" });
  };
  const showBuilder = how === "manual" || proposed;

  return (
    <div className="page consortium-studio" data-testid="consortium-studio">
      <div className="page-inner">
        <div className="page-head">
          <h1>Consortium</h1>
          {edit && (
            <button className="btn" onClick={() => setView({ name: "chat" })}>
              Back to the chat
            </button>
          )}
        </div>
        <p className="lead">
          Several AI agents take one task together. Each has its own role and its own model and provider. They either discuss and agree on a joint answer, or work at the same time as an execution crew and report what they did. You see everything and can step in at any time.
        </p>

        <div className="seg studio-seg" role="radiogroup" aria-label="How to build the team">
          <button role="radio" aria-checked={how === "manual"} className={how === "manual" ? "sel" : ""} onClick={() => setHow("manual")}>
            Manual team
          </button>
          <button role="radio" aria-checked={how === "auto"} className={how === "auto" ? "sel" : ""} onClick={() => setHow("auto")}>
            Automatic team
          </button>
        </div>

        {how === "manual" && (
          <section className="studio-section">
            <h3>Quick starts</h3>
            <div className="preset-grid">
              {TEAMS.map((t) => (
                <button key={t.name} className="preset-card" onClick={() => setCfg(teamFrom(t.members, [], t.style))} data-testid="preset">
                  <b>{t.name}</b>
                  <span className="hint">{t.hint}</span>
                  <span className="badge">{t.style === "execute" ? "Execution crew" : "Discuss and agree"} · {t.members.length}</span>
                </button>
              ))}
              <button className="preset-card" disabled={cross.length < 2} title={cross.length < 2 ? "Needs keys for at least two providers" : "Each member on a different provider's model"} onClick={() => setCfg(teamFrom(TEAMS[0].members, cross, "deliberate"))}>
                <b>Cross-model team</b>
                <span className="hint">The research team, each member on a different provider</span>
                <span className="badge">Discuss and agree · 4</span>
              </button>
            </div>
          </section>
        )}

        {how === "auto" && (
          <section className="studio-section card" data-testid="auto-team">
            <h3 style={{ marginTop: 0 }}>Describe the task; the team is designed for it</h3>
            <label className="field">
              <span>Task or goal</span>
              <textarea rows={4} aria-label="Task" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Reconcile this week's Airbnb payouts against our bookings, contact guests with open balances, and list anything that needs my decision." />
            </label>
            <div className="auto-constraints">
              <label className="field">
                <span>At most</span>
                <select aria-label="Maximum agents" value={req.maxAgents} onChange={(e) => setReq({ ...req, maxAgents: Number(e.target.value) })}>
                  {[2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>{n} agents</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>How the team works</span>
                <select aria-label="Team style" value={req.style} onChange={(e) => setReq({ ...req, style: e.target.value as TeamRequest["style"] })}>
                  <option value="auto">Let the planner decide</option>
                  <option value="deliberate">Discuss and agree</option>
                  <option value="execute">Execution crew</option>
                </select>
              </label>
              <label className="field">
                <span>Planner (a strong model works best)</span>
                <ModelSelect value={planner} onChange={setPlanner} empty="Default chat model" />
              </label>
            </div>
            <div className="field">
              <span className="muted" style={{ fontSize: 13 }}>Providers the team may use</span>
              <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                {ready.map((p) => {
                  const on = req.providers?.includes(p.id) ?? false;
                  return (
                    <button key={p.id} className={`chip-btn ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setReq({ ...req, providers: on ? req.providers!.filter((x) => x !== p.id) : [...(req.providers ?? []), p.id] })}>
                      {p.name}
                    </button>
                  );
                })}
                {!ready.length && <span className="hint">No provider with a chat model is ready yet.</span>}
                <span className="hint">{req.providers?.length ? "Only the selected ones." : "None selected: any of them."}</span>
              </div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={!!req.preferFast} onChange={(e) => setReq({ ...req, preferFast: e.target.checked })} />
              <span>
                Prefer fast, cheap models
                <small>A strong model only where a role needs deep reasoning.</small>
              </span>
            </label>
            <label className="field">
              <span>Anything else the planner should consider (optional)</span>
              <input aria-label="Planner notes" value={req.notes ?? ""} onChange={(e) => setReq({ ...req, notes: e.target.value })} placeholder="e.g. Must include a compliance check. Keep costs low." />
            </label>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn primary" disabled={thinking} onClick={() => void propose()}>
                {thinking ? "Designing the team…" : proposed ? "Regenerate" : "Propose a team"}
              </button>
              {thinking && (
                <button className="btn" onClick={() => abort.current?.abort()}>
                  Cancel
                </button>
              )}
            </div>
            {problem && (
              <div className="note err" role="alert" style={{ marginTop: 10 }}>
                {problem}
              </div>
            )}
            {proposed && cfg.rationale && (
              <div className="note" style={{ marginTop: 10 }} data-testid="rationale">
                <b>Proposed:</b> {cfg.members.length} agents, {cfg.style === "execute" ? "an execution crew" : "discuss and agree"}. {cfg.rationale} Edit anything below before you start.
              </div>
            )}
          </section>
        )}

        {showBuilder && (
          <section className="studio-section">
            <h3>How the team works</h3>
            <div className="style-cards" role="radiogroup" aria-label="How the team works">
              <button role="radio" aria-checked={cfg.style !== "execute"} className={`style-card ${cfg.style !== "execute" ? "sel" : ""}`} onClick={() => setCfg({ ...cfg, style: "deliberate" })}>
                <b>Discuss and agree</b>
                <span className="hint">Plan who does what, work in parallel, review each other, then draft and vote on one joint answer. Disagreement is shown, never hidden.</span>
              </button>
              <button role="radio" aria-checked={cfg.style === "execute"} className={`style-card ${cfg.style === "execute" ? "sel" : ""}`} onClick={() => setCfg({ ...cfg, style: "execute" })}>
                <b>Execution crew</b>
                <span className="hint">Each role does its job at the same time with its tools; members whose role is to audit or review check the results; the coordinator reports what was done. No voting.</span>
              </button>
            </div>
            <h3>Members</h3>
            <TeamBuilder cfg={cfg} onChange={setCfg} />
            <div className="row wrap" style={{ gap: 14, marginTop: 10 }}>
              {cfg.style !== "execute" ? (
                <label className="hint">
                  Vote rounds{" "}
                  <select value={cfg.rounds} onChange={(e) => setCfg({ ...cfg, rounds: Number(e.target.value) })} aria-label="Vote rounds">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="hint">
                  Fix pass after the audit{" "}
                  <select value={cfg.rounds > 1 ? "yes" : "no"} onChange={(e) => setCfg({ ...cfg, rounds: e.target.value === "yes" ? 2 : 1 })} aria-label="Fix pass">
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              )}
              <label className="hint">
                Tool steps per member{" "}
                <select value={cfg.workSteps} onChange={(e) => setCfg({ ...cfg, workSteps: Number(e.target.value) })} aria-label="Steps per member">
                  {[5, 10, 15, 25, 40].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <span className="hint">About {costEstimate(cfg)} model calls per task, plus tool steps.</span>
            </div>
          </section>
        )}

        {showBuilder && (
          <section className="studio-section card studio-go">
            {how === "manual" && (
              <label className="field">
                <span>Task for the team</span>
                <textarea rows={3} aria-label="Task for the team" value={task} onChange={(e) => setTask(e.target.value)} placeholder="What should the team do?" />
              </label>
            )}
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn primary" onClick={() => void start()}>
                <Icon.send /> Start the consortium
              </button>
              {edit && (
                <button className="btn" onClick={saveToChat} title={hasChat ? "Use this team for the next message in the chat" : "Use this team in the new chat"}>
                  {hasChat ? "Use in this chat" : "Use in the new chat"}
                </button>
              )}
              {edit && current && (
                <button className="btn" onClick={() => (setConsortium(undefined), setView({ name: "chat" }))}>
                  Turn consortium off
                </button>
              )}
            </div>
            <p className="hint" style={{ margin: "8px 0 0" }}>
              Start opens a new chat with this team and gives it the task. The team panel beside the chat shows each member's status and the shared scratchpad.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
