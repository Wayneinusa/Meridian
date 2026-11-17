// Runs automations on time while the app is open (and, on desktop, while it
// sits in the tray). Each run is an ordinary chat the user can open later.
import { runTurn, type EngineHost } from "../agent/engine";
import { notify } from "../platform/notify";
import { emptyConversation } from "../storage/merge";
import { adoptConversation, errText, host, library, liveConversation, onReady, repo, saveItem, scheduleSync, setConversationBusy, toast, useApp } from "../state/store";
import type { Automation, AutomationRun, Conversation } from "../types";
import { uid } from "../types";
import { lastDue, nextRun } from "./schedule";

const running = new Set<string>();

export function upcoming(a: Automation, now = Date.now()): number | null {
  return a.enabled ? nextRun(a.schedule, Math.max(now, a.lastRunAt ?? 0), a.createdAt) : null;
}

function mine(a: Automation): boolean {
  const s = useApp.getState().settings;
  return a.runOn === "any" || a.runOn === s.deviceId;
}

/** Is a run due now? (a scheduled time passed since the last run) */
export function due(a: Automation, now: number): boolean {
  if (!a.enabled) return false;
  const last = lastDue(a.schedule, now, a.createdAt);
  if (last == null) return false;
  if (a.lastRunAt && a.lastRunAt >= last) return false;
  // without catch-up, only runs whose time is within the last 10 minutes count
  return a.catchUp || now - last < 10 * 60_000;
}

export async function runAutomation(id: string, manual = false): Promise<AutomationRun | null> {
  const a = library.get("automations", id);
  if (!a || running.has(id)) return null;
  running.add(id);
  const started = Date.now();
  // record the start first so other devices (and a restart) do not run it twice
  await saveItem("automations", { id, lastRunAt: started });
  let conv: Conversation | undefined;
  let run: AutomationRun;
  try {
    if (a.output === "same-chat" && a.convId) conv = liveConversation(a.convId) ?? (await repo.get(a.convId)) ?? undefined;
    if (!conv || conv.deletedAt) {
      conv = emptyConversation(uid("c"), started);
      conv.title = `${a.name} · ${new Date(started).toLocaleDateString([], { month: "short", day: "numeric" })}`;
      conv.agentId = a.agentId;
      conv.projectId = a.projectId;
      conv.model = a.model;
    }
    const at = Math.max(started, (conv.messages.at(-1)?.createdAt ?? 0) + 1);
    conv.messages.push({ id: uid("m"), role: "user", createdAt: at, updatedAt: at, parts: [{ type: "text", text: `${a.prompt}\n\n(Automation "${a.name}", ${manual ? "run by hand" : "scheduled run"} at ${new Date(started).toLocaleString()}.)` }] });
    conv.updatedAt = at;
    await adoptConversation(conv);
    const c = conv;
    const abort = new AbortController();
    const settingsOverride: EngineHost = a.tools ? { ...host, settings: () => ({ ...host.settings(), tools: { ...host.settings().tools, ...a.tools } }) } : host;
    setConversationBusy(c.id, "automation");
    try {
      await runTurn(settingsOverride, c, { signal: abort.signal, autoApprove: a.autoApprove });
    } finally {
      setConversationBusy(c.id, null);
    }
    await adoptConversation(c);
    const last = [...c.messages].reverse().find((m) => m.role === "assistant");
    const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim() ?? "";
    run = { at: started, status: last?.error ? "error" : "ok", convId: c.id, summary: (last?.error ?? text).slice(0, 300), device: useApp.getState().settings.deviceName };
  } catch (e) {
    run = { at: started, status: "error", convId: conv?.id, summary: errText(e), device: useApp.getState().settings.deviceName };
  } finally {
    running.delete(id);
  }
  const fresh = library.get("automations", id);
  await saveItem("automations", { id, lastRunAt: started, runs: [run, ...(fresh?.runs ?? [])].slice(0, 30), convId: a.output === "same-chat" ? (run.convId ?? a.convId) : a.convId });
  if (a.notify && useApp.getState().settings.notifications) void notify(`${a.name} ${run.status === "ok" ? "finished" : "failed"}`, run.summary || "");
  if (manual) toast(`${a.name}: ${run.status === "ok" ? "done" : "failed"}`, run.status === "ok" ? "ok" : "error");
  scheduleSync();
  return run;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function tick(now = Date.now()) {
  for (const a of library.list("automations")) {
    if (mine(a) && due(a, now) && !running.has(a.id)) void runAutomation(a.id);
  }
}

export function startAutomations() {
  if (timer) return;
  onReady(() => {
    // give sync a moment so runs done on another device are known first
    setTimeout(() => tick(), 8000);
    timer = setInterval(() => tick(), 30_000);
  });
}

export const isRunning = (id: string) => running.has(id);
