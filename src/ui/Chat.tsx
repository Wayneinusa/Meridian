import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import { pickFolder } from "../platform/files";
import { exportChat, forkChat, keepPrivateChat, send, setChatAgent, setResearchMode, setView, setWorkFolder, useApp } from "../state/store";
import type { Message } from "../types";
import { ArtifactsPanel } from "./Artifacts";
import { Composer } from "./Composer";
import { Icon } from "./icons";
import { CompareView, MessageView } from "./MessageView";
import { ModelPicker } from "./ModelPicker";
import { ParamsPanel } from "./ParamsPanel";

const STARTERS = [
  { title: "Make a spreadsheet", text: "Create a monthly household budget spreadsheet with example categories and formulas for totals." },
  { title: "Write a document", text: "Write a one-page project proposal for a community garden and give it to me as a PDF." },
  { title: "Build a slide deck", text: "Create a 6-slide presentation introducing a new coffee brand, with speaker notes." },
  { title: "Research a topic", text: "Research the current state of solid-state batteries and give me a cited brief." },
];

function ChatMenu({ onClose }: { onClose: () => void }) {
  const active = useApp((s) => s.active);
  const desktop = platform().desktop;
  return (
    <div className="popover" style={{ right: 0, top: 42, width: 260 }} onMouseLeave={onClose}>
      <div className="menu-head">Export this chat</div>
      {(["md", "pdf", "docx", "html", "json"] as const).map((f) => (
        <button key={f} className="menu-item" disabled={!active} onClick={() => (onClose(), void exportChat(f))}>
          <Icon.download /> {f === "md" ? "Markdown" : f === "docx" ? "Word" : f.toUpperCase()}
        </button>
      ))}
      {active && active.messages.length > 0 && (
        <button className="menu-item" onClick={() => (onClose(), void forkChat(active.messages[active.messages.length - 1].id))}>
          <Icon.fork /> Fork into a new chat
        </button>
      )}
      {desktop && (
        <>
          <div className="menu-head">Work folder</div>
          <button
            className="menu-item"
            onClick={async () => {
              onClose();
              const f = await pickFolder();
              if (f) setWorkFolder(f);
            }}
          >
            <Icon.folder /> {active?.workFolder ? "Change folder…" : "Give the assistant a folder…"}
          </button>
          {active?.workFolder && (
            <button className="menu-item" onClick={() => (onClose(), setWorkFolder(undefined))}>
              <Icon.x /> Stop using {active.workFolder.split(/[\\/]/).pop()}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AgentChip() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const agents = useApp((s) => s.lib.agents);
  const [open, setOpen] = useState(false);
  const agentId = active ? active.agentId : draft.agentId;
  const agent = agents.find((a) => a.id === agentId);
  return (
    <span className="pop-anchor">
      <button className={`chip-btn ${agent ? "on" : ""}`} onClick={() => setOpen((x) => !x)} title="Choose an agent">
        <span>{agent?.emoji ?? "🤖"}</span> {agent ? agent.name : "Agent"}
      </button>
      {open && (
        <div className="popover" style={{ left: 0, top: 34, width: 260 }} onMouseLeave={() => setOpen(false)}>
          <button className={`menu-item ${!agent ? "sel" : ""}`} onClick={() => (setOpen(false), setChatAgent(undefined))}>No agent</button>
          {agents.map((a) => (
            <button key={a.id} className={`menu-item ${a.id === agentId ? "sel" : ""}`} onClick={() => (setOpen(false), setChatAgent(a.id))}>
              <span>{a.emoji ?? "🤖"}</span> <span className="grow">{a.name}</span>
            </button>
          ))}
          <button className="menu-item" onClick={() => (setOpen(false), setView({ name: "agents" }))}>
            <Icon.gear /> Manage agents
          </button>
        </div>
      )}
    </span>
  );
}

function Plan() {
  const plan = useApp((s) => s.active?.plan);
  const [open, setOpen] = useState(true);
  if (!plan?.length) return null;
  const done = plan.filter((p) => p.status === "done").length;
  return (
    <div className="plan">
      <button className="link-btn" style={{ padding: 0, color: "var(--text)" }} onClick={() => setOpen(!open)}>
        <b>Plan</b> · {done}/{plan.length} done {open ? "▾" : "▸"}
      </button>
      {open && (
        <ol>
          {plan.map((p, i) => (
            <li key={i} className={p.status}>
              {p.status === "in_progress" ? "▶ " : p.status === "done" ? "✓ " : ""}
              {p.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Group messages into turns so versions and compare views attach to the right question. */
function turns(messages: Message[]): { user?: Message; answers: Message[] }[] {
  const out: { user?: Message; answers: Message[] }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ user: m, answers: [] });
    else if (out.length) out[out.length - 1].answers.push(m);
    else out.push({ answers: [m] });
  }
  return out;
}

export function Chat() {
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const paramsOpen = useApp((s) => s.paramsOpen);
  const artifactsOpen = useApp((s) => s.artifactsOpen);
  const incognito = useApp((s) => s.incognito);
  const compareOpen = useApp((s) => s.compareOpen);
  const project = useApp((s) => s.lib.projects.find((p) => p.id === (s.active ? s.active.projectId : s.draft.projectId)));
  const agent = useApp((s) => s.lib.agents.find((a) => a.id === (s.active ? s.active.agentId : s.draft.agentId)));
  const busy = useApp((s) => (s.activeId ? s.busy[s.activeId] !== undefined : false));
  const hasParams = !!(active?.params && Object.keys(active.params).length) || !!active?.systemPrompt;
  const research = (active ? active.mode : draft.mode) === "research";
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [menu, setMenu] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [active?.id]);

  const messages = active?.messages ?? [];
  const groups = turns(messages);
  const starters = agent?.starters.length ? agent.starters.map((t) => ({ title: t, text: t })) : STARTERS;

  return (
    <main className="main">
      {incognito && (
        <div className="private-banner">
          Private chat: not saved or synced, and gone when you leave it.{" "}
          {active && <button onClick={() => void keepPrivateChat()}>Keep it</button>}
        </div>
      )}
      <header className="chat-header">
        {!sidebarOpen && (
          <button className="icon-btn" title="Show chats" onClick={() => useApp.setState({ sidebarOpen: true })}>
            <Icon.menu />
          </button>
        )}
        <div className="chat-title">
          {project && (
            <button className="link-btn" style={{ display: "inline", padding: 0, width: "auto" }} onClick={() => setView({ name: "project", id: project.id })}>
              {project.emoji ?? "📁"} {project.name} /{" "}
            </button>
          )}
          {active?.title ?? (agent ? agent.name : "New chat")}
        </div>
        <div className="header-chips hide-narrow">
          <AgentChip />
          <button className={`chip-btn ${research ? "on" : ""}`} title="Research mode: many searches, a cited report" onClick={() => setResearchMode(!research)}>
            <Icon.globe /> Research
          </button>
          {active?.workFolder && <span className="chip-btn on" title={active.workFolder}><Icon.folder /> {active.workFolder.split(/[\\/]/).pop()}</span>}
        </div>
        <ModelPicker />
        <button className={`icon-btn ${artifactsOpen ? "on" : ""}`} title="Files in this chat" onClick={() => useApp.setState({ artifactsOpen: !artifactsOpen })}>
          <Icon.file />
        </button>
        <button className={`icon-btn ${paramsOpen || hasParams ? "on" : ""}`} title="Model parameters" aria-pressed={paramsOpen} onClick={() => useApp.setState({ paramsOpen: !paramsOpen })}>
          <Icon.sliders />
        </button>
        <span className="pop-anchor">
          <button className="icon-btn" title="More" onClick={() => setMenu(!menu)}>
            <Icon.more />
          </button>
          {menu && <ChatMenu onClose={() => setMenu(false)} />}
        </span>
      </header>
      <div className="chat-body">
        <div className="chat-col">
          {messages.length === 0 ? (
            <div className="empty">
              <div>
                {agent ? (
                  <>
                    <div style={{ fontSize: 40 }}>{agent.emoji ?? "🤖"}</div>
                    <h1>{agent.name}</h1>
                    <p>{agent.description || "Ready when you are."}</p>
                  </>
                ) : (
                  <>
                    <h1>{incognito ? "Private chat" : research ? "What should I research?" : "What are we working on?"}</h1>
                    <p>Ask anything, attach documents and images, have files made for you, or switch to Image or Video below.</p>
                  </>
                )}
                <div className="header-chips show-narrow" style={{ justifyContent: "center", marginBottom: 14 }}>
                  <AgentChip />
                  <button className={`chip-btn ${research ? "on" : ""}`} onClick={() => setResearchMode(!research)}>
                    <Icon.globe /> Research
                  </button>
                </div>
                <div className="starters">
                  {starters.slice(0, 4).map((s) => (
                    <button key={s.title} className="starter" onClick={() => void send(s.text)}>
                      <b>{s.title}</b>
                      {s.text !== s.title && <span>{s.text}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div
              className="messages"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              <div className="messages-inner">
                <Plan />
                {groups.map((g, gi) => {
                  const isLastTurn = gi === groups.length - 1;
                  return (
                    <div key={g.user?.id ?? `t${gi}`} className="turn">
                      {g.user && <MessageView message={g.user} isLast={false} busy={busy} />}
                      {g.user && compareOpen === g.user.id && (active?.alternates?.[g.user.id]?.length ?? 0) > 0 ? (
                        <CompareView userId={g.user.id} answers={g.answers} busy={busy && isLastTurn} />
                      ) : (
                        g.answers.map((m, i) => (
                          <MessageView key={m.id} message={m} isLast={isLastTurn && i === g.answers.length - 1} busy={busy} versionsFor={i === g.answers.length - 1 ? g.user?.id : undefined} />
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <Composer />
        </div>
        {artifactsOpen && <ArtifactsPanel />}
      </div>
      {paramsOpen && <ParamsPanel />}
    </main>
  );
}
