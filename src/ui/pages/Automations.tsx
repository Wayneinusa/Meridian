import { useEffect, useState } from "react";
import { describeSchedule } from "../../automations/schedule";
import { isRunning, runAutomation, upcoming } from "../../automations/runner";
import { platform } from "../../platform";
import { deleteItem, openChat, saveItem, toast, useApp } from "../../state/store";
import type { Automation, Schedule, Settings } from "../../types";
import { Icon } from "../icons";
import { Modal, ModelSelect } from "../Modal";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TEMPLATES: { name: string; prompt: string; schedule: Schedule }[] = [
  { name: "Morning briefing", prompt: "Give me a short morning briefing: today's top news in tech and world affairs (search the web), the weather where I live if you know it, and anything in my calendar and inbox that needs attention if those connectors are available.", schedule: { type: "daily", time: "07:30", days: [1, 2, 3, 4, 5] } },
  { name: "Weekly review", prompt: "Write my weekly review: summarise what I worked on in this week's chats, list open loops and suggest three priorities for next week.", schedule: { type: "weekly", time: "16:00", days: [5] } },
  { name: "Topic watch", prompt: "Search the web for the latest news about <topic> from the past day and summarise anything new and important, with links. If nothing new, say so in one line.", schedule: { type: "daily", time: "12:00" } },
];

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const time = "time" in value ? value.time : "09:00";
  const days = value.type === "weekly" || value.type === "daily" ? (value.days ?? []) : [];
  return (
    <div>
      <div className="row wrap">
        <select value={value.type} onChange={(e) => {
          const t = e.target.value as Schedule["type"];
          onChange(t === "once" ? { type: "once", at: Date.now() + 3600_000 } : t === "interval" ? { type: "interval", minutes: 60 } : t === "daily" ? { type: "daily", time } : t === "weekly" ? { type: "weekly", time, days: [1] } : { type: "monthly", time, day: 1 });
        }} style={{ width: "auto" }} aria-label="Repeat">
          <option value="once">Once</option>
          <option value="interval">Every…</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
        {value.type === "once" && <input type="datetime-local" value={toLocalInput(value.at)} onChange={(e) => onChange({ type: "once", at: new Date(e.target.value).getTime() })} style={{ width: "auto" }} />}
        {value.type === "interval" && (
          <>
            <input type="number" min={5} value={value.minutes} onChange={(e) => onChange({ type: "interval", minutes: Math.max(5, Number(e.target.value) || 60) })} style={{ width: 90 }} aria-label="Minutes" />
            <span className="hint">minutes</span>
          </>
        )}
        {(value.type === "daily" || value.type === "weekly" || value.type === "monthly") && (
          <input type="time" value={time} onChange={(e) => onChange({ ...value, time: e.target.value } as Schedule)} style={{ width: "auto" }} aria-label="Time" />
        )}
        {value.type === "monthly" && (
          <>
            <span className="hint">on day</span>
            <input type="number" min={1} max={31} value={value.day} onChange={(e) => onChange({ ...value, day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: 70 }} aria-label="Day of month" />
          </>
        )}
      </div>
      {(value.type === "daily" || value.type === "weekly") && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          {DAYS.map((d, i) => {
            const on = value.type === "daily" ? !days.length || days.includes(i) : days.includes(i);
            return (
              <button key={d} className={`chip-btn ${on ? "on" : ""}`} onClick={() => {
                const cur = value.type === "daily" && !days.length ? [0, 1, 2, 3, 4, 5, 6] : days;
                const next = on ? cur.filter((x) => x !== i) : [...cur, i].sort();
                onChange({ ...value, days: next } as Schedule);
              }}>
                {d}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Editor({ item, onClose }: { item: Partial<Automation>; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.lib.agents);
  const projects = useApp((s) => s.lib.projects);
  const [a, setA] = useState<Partial<Automation>>({
    enabled: true,
    output: "new-chat",
    notify: true,
    autoApprove: false,
    catchUp: true,
    runOn: settings.deviceId,
    schedule: { type: "daily", time: "08:00" },
    runs: [],
    ...item,
  });
  const up = (p: Partial<Automation>) => setA((x) => ({ ...x, ...p }));
  const save = async () => {
    if (!a.name?.trim() || !a.prompt?.trim()) return toast("Give the automation a name and instructions.", "error");
    await saveItem("automations", { ...a, name: a.name.trim(), prompt: a.prompt.trim() } as Automation);
    onClose();
  };
  const tools = { ...settings.tools, ...(a.tools ?? {}) };
  return (
    <Modal
      title={item.id ? "Edit automation" : "New automation"}
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
        <input type="text" value={a.name ?? ""} onChange={(e) => up({ name: e.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>What should the assistant do?</span>
        <textarea rows={5} value={a.prompt ?? ""} onChange={(e) => up({ prompt: e.target.value })} placeholder="e.g. Check my inbox for anything urgent and summarise it" />
      </label>
      <div className="field">
        <span className="hint">When</span>
        <ScheduleEditor value={a.schedule!} onChange={(schedule) => up({ schedule })} />
      </div>
      <div className="row wrap">
        <label className="field grow">
          <span>Agent</span>
          <select value={a.agentId ?? ""} onChange={(e) => up({ agentId: e.target.value || undefined })}>
            <option value="">None</option>
            {agents.map((x) => (
              <option key={x.id} value={x.id}>{x.emoji ?? "🤖"} {x.name}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Project</span>
          <select value={a.projectId ?? ""} onChange={(e) => up({ projectId: e.target.value || undefined })}>
            <option value="">None</option>
            {projects.map((x) => (
              <option key={x.id} value={x.id}>{x.emoji ?? "📁"} {x.name}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Model</span>
        <ModelSelect value={a.model} onChange={(model) => up({ model })} empty="The usual default" />
      </label>
      <label className="field">
        <span>Results</span>
        <select value={a.output} onChange={(e) => up({ output: e.target.value as Automation["output"] })}>
          <option value="new-chat">A new chat for each run</option>
          <option value="same-chat">Always the same chat</option>
        </select>
      </label>
      <div className="field">
        <span className="hint">Tools for this automation</span>
        <div className="row wrap" style={{ marginTop: 4 }}>
          {(["files", "media", "web", "connectors", "computer"] as (keyof Settings["tools"])[]).map((k) => (
            <button key={k} className={`chip-btn ${tools[k] ? "on" : ""}`} disabled={k === "computer" && !platform().desktop} onClick={() => up({ tools: { ...(a.tools ?? {}), [k]: !tools[k] } })}>
              {k === "files" ? "Files" : k === "media" ? "Images & video" : k === "web" ? "Web" : k === "connectors" ? "Connectors & plugins" : "Computer"}
            </button>
          ))}
        </div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={a.autoApprove} onChange={(e) => up({ autoApprove: e.target.checked })} />
        <span>Run tools without asking<small>You are usually away when automations run. Without this, actions that need approval (sending email, connector actions, computer actions) wait until you open the app.</small></span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={a.notify} onChange={(e) => up({ notify: e.target.checked })} />
        <span>Notify me when it finishes</span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={a.catchUp} onChange={(e) => up({ catchUp: e.target.checked })} />
        <span>Catch up on missed runs<small>If the app was closed at the scheduled time, run once when it opens.</small></span>
      </label>
      <label className="field">
        <span>Run on</span>
        <select value={a.runOn === "any" ? "any" : "this"} onChange={(e) => up({ runOn: e.target.value === "any" ? "any" : settings.deviceId })}>
          <option value="this">This device ({settings.deviceName})</option>
          <option value="any">Whichever of my devices is open</option>
        </select>
      </label>
    </Modal>
  );
}

export function AutomationsPage() {
  const items = useApp((s) => s.lib.automations);
  const settings = useApp((s) => s.settings);
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const desktop = platform().desktop;
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Automations</h1>
          <button className="btn primary" onClick={() => setEditing({})}>
            <Icon.plus /> New automation
          </button>
        </div>
        <p className="lead">
          Tasks the assistant does on a schedule, with your agents, projects, plugins and connectors. Each run is saved as a chat. They run while Meridian is open{desktop ? (settings.runInBackground ? " or in the tray" : "; turn on “Keep running when the window is closed” in Settings → General to run them in the background") : "; iPhone and iPad pause apps in the background, so missed runs happen when you next open the app"}.
        </p>
        {items.map((a) => {
          const next = upcoming(a);
          const last = a.runs[0];
          const elsewhere = a.runOn !== "any" && a.runOn !== settings.deviceId;
          return (
            <div className="card" key={a.id}>
              <div className="row">
                <div className="grow">
                  <h4>{a.name}</h4>
                  <div className="hint">
                    {describeSchedule(a.schedule)}
                    {a.enabled && next ? ` · next ${new Date(next).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : a.enabled ? " · no more runs" : " · paused"}
                    {elsewhere ? " · runs on another device" : ""}
                  </div>
                </div>
                <label className="switch" style={{ padding: 0 }}>
                  <input type="checkbox" checked={a.enabled} onChange={(e) => void saveItem("automations", { id: a.id, enabled: e.target.checked })} aria-label={`Enable ${a.name}`} />
                </label>
              </div>
              {last && (
                <div className={`note ${last.status === "error" ? "err" : ""}`} style={{ marginTop: 8 }}>
                  Last run {new Date(last.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}{last.device ? ` on ${last.device}` : ""}: {last.status === "ok" ? "done" : "failed"}. {last.summary?.slice(0, 160)}
                  {last.convId && (
                    <>
                      {" "}
                      <button className="link-btn" style={{ display: "inline", width: "auto", padding: 0 }} onClick={() => void openChat(last.convId!)}>Open</button>
                    </>
                  )}
                </div>
              )}
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button className="btn small primary" disabled={isRunning(a.id)} onClick={() => void runAutomation(a.id, true)}>
                  {isRunning(a.id) ? "Running…" : "Run now"}
                </button>
                <button className="btn small" onClick={() => setEditing(a)}>Edit</button>
                <button className="icon-btn" title={`Delete ${a.name}`} onClick={() => confirm(`Delete "${a.name}"? Its chats are kept.`) && void deleteItem("automations", a.id)}>
                  <Icon.trash />
                </button>
              </div>
            </div>
          );
        })}
        {!items.length && (
          <>
            <p className="hint">No automations yet. Start from a template:</p>
            <div className="grid">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="tile" onClick={() => setEditing({ name: t.name, prompt: t.prompt, schedule: t.schedule })}>
                  <span className="tile-emoji">⏰</span>
                  <b>{t.name}</b>
                  <span className="tile-desc">{describeSchedule(t.schedule)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {editing && <Editor item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
