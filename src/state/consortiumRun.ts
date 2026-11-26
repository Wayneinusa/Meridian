// Runs a consortium inside a chat: each member speaks through its own hidden
// sub-chat (its model, role, agent and tools); what it says is posted into the
// chat as a member message. Controls: notes from the user, stop a member,
// force the vote.
import { currentRef, contextOf, runTurn, type EngineHost } from "../agent/engine";
import { runConsortium, type ConsortiumIO } from "../agent/consortium";
import type { Tool } from "../tools/types";
import type { BlobRef, Conversation, ConsortiumConfig, ConsortiumMember, Message, Part } from "../types";
import { uid } from "../types";

export interface RunControl {
  notes: string[];
  stopped: Set<string>;
  forced: boolean;
  controllers: Map<string, AbortController>;
  main: AbortController;
}

const runs = new Map<string, RunControl>();
export const runControl = (convId: string) => runs.get(convId);

/** The user's message while a consortium works: an instruction for the members. */
export function addNote(convId: string, text: string): boolean {
  const r = runs.get(convId);
  if (!r) return false;
  r.notes.push(text);
  return true;
}

export function stopMember(convId: string, memberId: string) {
  const r = runs.get(convId);
  if (!r) return;
  r.stopped.add(memberId);
  r.controllers.get(memberId)?.abort();
}

/** Skip what is left of planning, work and review and go straight to a vote. */
export function forceVote(convId: string) {
  const r = runs.get(convId);
  if (!r || r.forced) return;
  r.forced = true;
  for (const [id, c] of r.controllers) {
    c.abort();
    // fresh signals for the draft and vote that follow (stopped members stay stopped)
    if (!r.stopped.has(id)) r.controllers.set(id, linked(r.main.signal));
  }
}

function linked(parent: AbortSignal): AbortController {
  const c = new AbortController();
  if (parent.aborted) c.abort();
  else parent.addEventListener("abort", () => c.abort(), { once: true });
  return c;
}

interface Hooks {
  host: EngineHost;
  render(c: Conversation): void;
  saveSoon(c: Conversation): void;
  status(convId: string, memberId: string, status: string): void;
}

/** Shared scratchpad and questions between members, for one run. */
interface Pad {
  push(e: { by: string; text: string }): void;
  readonly length: number;
  map<T>(fn: (e: { by: string; text: string }) => T): T[];
}

function teamTools(cfg: ConsortiumConfig, me: ConsortiumMember, pad: Pad, ask: (to: ConsortiumMember, from: ConsortiumMember, q: string) => Promise<string>): Tool[] {
  return [
    {
      group: "files",
      title: "Team scratchpad",
      spec: {
        name: "scratchpad",
        description: "The consortium's shared scratchpad. action read: see everything the team wrote; action append: add notes, facts, drafts or data the others need.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["read", "append"] }, text: { type: "string" } }, required: ["action"] },
      },
      needsApproval: () => false,
      summarize: (i) => (i.action === "append" ? `Write to the team scratchpad: ${String(i.text ?? "").slice(0, 80)}` : "Read the team scratchpad"),
      async run(i) {
        if (i.action === "append" && typeof i.text === "string" && i.text.trim()) pad.push({ by: me.name, text: i.text.trim().slice(0, 8000) });
        return { text: pad.length ? pad.map((e) => `[${e.by}] ${e.text}`).join("\n\n") : "(the scratchpad is empty)" };
      },
    },
    {
      group: "files",
      title: "Ask a teammate",
      spec: {
        name: "ask_member",
        description: `Ask another member of the consortium a question and get their answer. Members: ${cfg.members.filter((m) => m.id !== me.id).map((m) => `${m.name} (${m.role})`).join(", ")}.`,
        inputSchema: { type: "object", properties: { member: { type: "string" }, question: { type: "string" } }, required: ["member", "question"] },
      },
      needsApproval: () => false,
      summarize: (i) => `Ask ${String(i.member)}: ${String(i.question).slice(0, 80)}`,
      async run(i) {
        const name = String(i.member ?? "").toLowerCase();
        const to = cfg.members.find((m) => m.id !== me.id && m.name.toLowerCase() === name) ?? cfg.members.find((m) => m.id !== me.id && m.name.toLowerCase().includes(name));
        if (!to) return { isError: true, text: `No member called ${String(i.member)}.` };
        return { text: await ask(to, me, String(i.question ?? "")) };
      },
    },
  ];
}

export async function runConsortiumTurn(c: Conversation, signal: AbortSignal, hooks: Hooks): Promise<void> {
  const cfg = c.consortium;
  if (!cfg || cfg.members.length < 2) throw new Error("Set up the consortium first: Consortium → add at least two members.");
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
  const task = lastUser?.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim() ?? "";
  const files = (lastUser?.parts ?? []).filter((p): p is Extract<Part, { type: "attachment" }> => p.type === "attachment");
  if (!task) throw new Error("Give the consortium a task.");
  const run = uid("run");
  const main = new AbortController();
  signal.addEventListener("abort", () => main.abort(), { once: true });
  const control: RunControl = { notes: [], stopped: new Set(), forced: false, controllers: new Map(cfg.members.map((m) => [m.id, linked(main.signal)])), main };
  runs.set(c.id, control);
  const settings = hooks.host.settings();
  const { agent, project } = contextOf(hooks.host, c);
  const chatModel = currentRef(settings, c, agent, project);
  // the scratchpad lives on the chat, so the team panel shows it and it is saved
  c.scratchpad = [];
  const pad = {
    push(e: { by: string; text: string }) {
      c.scratchpad = [...(c.scratchpad ?? []), { ...e, at: Date.now() }];
      hooks.render(c);
      hooks.saveSoon(c);
    },
    get length() {
      return c.scratchpad?.length ?? 0;
    },
    map<T>(fn: (e: { by: string; text: string }) => T): T[] {
      return (c.scratchpad ?? []).map(fn);
    },
  };

  const speakIn = async (m: ConsortiumMember, system: string, prompt: string, opts: { tools: boolean; maxSteps: number; signal: AbortSignal; extraTools?: Tool[] }) => {
    const now = Date.now();
    const sub: Conversation = {
      id: `${c.id}~${m.id}~${uid("t")}`,
      title: m.name,
      createdAt: now,
      updatedAt: now,
      model: m.model ?? chatModel,
      agentId: m.agentId,
      projectId: c.projectId,
      workFolder: c.workFolder,
      systemPrompt: system,
      messages: [{ id: uid("m"), role: "user", createdAt: now, updatedAt: now, parts: [...files, { type: "text", text: prompt }] }],
      removed: {},
    };
    const subHost: EngineHost = {
      ...hooks.host,
      render: () => undefined,
      save: () => undefined,
      setBusy: (_id, note) => note && hooks.status(c.id, m.id, note),
      askPermission: (_id, tool, input, _call, preview) => hooks.host.askPermission(c.id, tool, input, undefined, preview),
      ask: (_id, q, o, multi) => hooks.host.ask(c.id, `${m.name} asks: ${q}`, o, multi),
    };
    await runTurn(subHost, sub, { signal: opts.signal, noTools: !opts.tools, maxSteps: opts.maxSteps, depth: 1, extraTools: opts.extraTools, skills: m.skills });
    const answers = sub.messages.filter((x) => x.role === "assistant");
    const last = answers[answers.length - 1];
    const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim() ?? "";
    const made = answers.flatMap((x) => x.parts.filter((p): p is Extract<Part, { type: "artifact" }> => p.type === "artifact"));
    if (!text && last?.error) throw new Error(last.error);
    return { text, files: made as BlobRef[] };
  };

  const io: ConsortiumIO = {
    speak: speakIn,
    post: (tag, text, made = []) => {
      const member = cfg.members.find((m) => m.id === tag.id);
      const at = Math.max(Date.now(), (c.messages[c.messages.length - 1]?.createdAt ?? 0) + 1);
      const msg: Message = {
        id: uid("m"),
        role: "assistant",
        createdAt: at,
        updatedAt: at,
        model: member?.model ?? chatModel,
        member: { ...tag, run },
        parts: [{ type: "text", text }, ...made.map((f) => ({ type: "artifact" as const, origin: "tool" as const, ...f }))],
      };
      c.messages.push(msg);
      hooks.render(c);
      hooks.saveSoon(c);
    },
    setPlan: (items) => {
      c.plan = items;
      hooks.render(c);
    },
    status: (id, s) => hooks.status(c.id, id, s),
    takeNotes: () => control.notes.splice(0),
    stopped: () => control.stopped,
    forced: () => control.forced,
    signalFor: (id) => control.controllers.get(id)?.signal ?? main.signal,
    signal: main.signal,
  };

  const ask = async (to: ConsortiumMember, from: ConsortiumMember, q: string) => {
    hooks.status(c.id, to.id, `answering ${from.name}`);
    const r = await speakIn(to, `You are ${to.name} (${to.role}) in a consortium. A teammate asks you something; answer briefly and concretely.`, `Task: ${task}\n\n${from.name} asks: ${q}`, { tools: false, maxSteps: 1, signal: control.controllers.get(to.id)?.signal ?? main.signal });
    io.post({ id: to.id, name: to.name, emoji: to.emoji, phase: "work" }, `**${from.name} asked:** ${q}\n\n${r.text}`);
    return r.text || "(no answer)";
  };

  try {
    await runConsortium(task, cfg, io, (m) => teamTools(cfg, m, pad, ask));
  } finally {
    runs.delete(c.id);
  }
}
