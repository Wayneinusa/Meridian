// Collaborative multi-agent consortium: several agents (any mix of models)
// take one task together and reach a conclusion in the open.
//
//   plan     each member proposes how to split the work and which part it takes
//   assign   the coordinator merges the proposals into one assignment per member
//   work     members work on their parts in parallel, with their tools, a shared
//            scratchpad and the ability to ask each other questions
//   review   each member reviews the others' contributions
//   draft    the coordinator drafts a joint answer
//   vote     everyone votes AGREE / DISAGREE with a reason; the draft is revised
//            for up to N rounds
//   final    consensus, a clear majority (dissent shown), or the separate positions
//            when there is no agreement - never a forced one
//
// An execution crew (style "execute") skips the debate: the coordinator hands
// each role a concrete job, everyone works at the same time, members whose role
// is to check (auditor, reviewer, QA) audit the results, one fix pass follows
// if they found problems, and the coordinator reports what was done.
//
// Every message is posted to the chat as it happens. The user can add
// instructions, stop a member or force the vote (or the report) at any time.
import type { BlobRef, ConsortiumConfig, ConsortiumMember, ConsortiumPhase, MemberTag, PlanItem } from "../types";
import type { Tool } from "../tools/types";

export interface SpeakOptions {
  /** may the member use its tools (work phase) */
  tools: boolean;
  maxSteps: number;
  signal: AbortSignal;
  extraTools?: Tool[];
}

export interface Spoken {
  text: string;
  files: BlobRef[];
}

export interface ConsortiumIO {
  /** one turn of one member: the system prompt carries its role */
  speak(member: ConsortiumMember, system: string, prompt: string, opts: SpeakOptions): Promise<Spoken>;
  /** add a visible message to the chat */
  post(tag: Omit<MemberTag, "run">, text: string, files?: BlobRef[]): void;
  setPlan(items: PlanItem[]): void;
  status(memberId: string, status: string): void;
  /** instructions the user typed since the last call */
  takeNotes(): string[];
  /** members the user stopped */
  stopped(): Set<string>;
  /** the user asked to vote now */
  forced(): boolean;
  /** aborts when the whole run stops; per member, also when that member is stopped or the vote is forced */
  signalFor(memberId: string): AbortSignal;
  signal: AbortSignal;
}

export interface ConsortiumResult {
  outcome: "consensus" | "majority" | "no agreement" | "completed" | "partial";
  agree: number;
  voters: number;
  final: string;
}

const CLIP = 2400;
const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const label = (m: ConsortiumMember) => `${m.emoji ? `${m.emoji} ` : ""}${m.name}`;

export function memberSystem(m: ConsortiumMember, cfg: ConsortiumConfig): string {
  const team = cfg.members.map((x) => `- ${x.name}: ${x.role}${x.id === cfg.coordinatorId ? " (coordinator)" : ""}`).join("\n");
  return [
    `You are ${m.name}, one member of a consortium of ${cfg.members.length} AI agents working together on one task for the user.`,
    `Your role: ${m.role}.`,
    `The team:\n${team}`,
    cfg.style === "execute"
      ? "This is an operational crew working at the same time. Act, don't debate: do your role's job with your tools, report concrete results (what you did, what you found, what is still open), and coordinate through the shared scratchpad. Ask a teammate only when you are blocked. No greetings."
      : "Work as a real colleague: be specific, build on good ideas, and say plainly when you think someone is wrong. Never pretend to agree. Keep messages focused; no greetings.",
  ].join("\n\n");
}

/** Members whose job is to check the others' work (auditor, reviewer, QA…). */
export const isChecker = (m: ConsortiumMember) => /audit|review|check|verif|\bqa\b|quality|inspect|critic|compliance/i.test(`${m.name} ${m.role}`);

/** Find {"assignments":[...]} in the coordinator's answer; tolerant of prose around it. */
export function parseAssignments(text: string, members: ConsortiumMember[]): Map<string, string> {
  const out = new Map<string, string>();
  const block = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!block) return out;
  try {
    const j = JSON.parse(block) as { assignments?: { member?: string; part?: string }[] };
    for (const a of j.assignments ?? []) {
      const name = String(a.member ?? "").toLowerCase().trim();
      const m = members.find((x) => x.name.toLowerCase() === name) ?? members.find((x) => name && (x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase())));
      if (m && a.part) out.set(m.id, String(a.part).trim());
    }
  } catch {
    /* not JSON: fall back to each member's own proposal */
  }
  return out;
}

/** "AGREE …" / "DISAGREE: …" on the first line. */
export function parseVote(text: string): { vote: "agree" | "disagree"; reason: string } {
  const t = text.trim();
  const first = t.split("\n")[0].replace(/^[*_#>\s-]+/, "");
  const disagree = /^(disagree|object|no\b|reject)/i.test(first);
  const agree = !disagree && /^(agree|yes\b|approve|accept)/i.test(first);
  const reason = t.replace(/^[*_#>\s-]*(dis)?agree[d]?/i, "").replace(/^[*_:.\-–—!\s]+/, "").trim();
  return { vote: agree ? "agree" : "disagree", reason: reason || (agree ? "Agrees." : "Disagrees.") };
}

interface Turn {
  name: string;
  phase: ConsortiumPhase;
  text: string;
}

export async function runConsortium(task: string, cfg: ConsortiumConfig, io: ConsortiumIO, makeTools?: (member: ConsortiumMember) => Tool[]): Promise<ConsortiumResult> {
  const members = cfg.members.slice(0, 6);
  if (members.length < 2) throw new Error("A consortium needs at least two members.");
  if (cfg.style === "execute") return runCrew(task, { ...cfg, members }, io, makeTools);
  const notes: string[] = [];
  const log: Turn[] = [];
  const active = () => members.filter((m) => !io.stopped().has(m.id));
  const coordinator = () => active().find((m) => m.id === cfg.coordinatorId) ?? active()[0];
  const system = new Map(members.map((m) => [m.id, memberSystem(m, cfg)]));

  const context = (opts: { include?: ConsortiumPhase[]; exclude?: string } = {}) => {
    for (const n of io.takeNotes()) notes.push(n);
    const parts = [`Task from the user:\n${task}`];
    if (notes.length) parts.push(`Instructions the user added during the discussion (follow them):\n${notes.map((n) => `- ${n}`).join("\n")}`);
    const shown = log.filter((t) => (!opts.include || opts.include.includes(t.phase)) && t.name !== opts.exclude);
    if (shown.length) parts.push(`The discussion so far:\n${shown.map((t) => `--- ${t.name} (${t.phase}):\n${clip(t.text)}`).join("\n\n")}`);
    return parts.join("\n\n");
  };

  const say = async (m: ConsortiumMember, phase: ConsortiumPhase, prompt: string, opts: Partial<SpeakOptions> & { tag?: Partial<MemberTag> } = {}): Promise<Spoken | null> => {
    const signal = io.signalFor(m.id);
    if (signal.aborted || io.signal.aborted) return null;
    io.status(m.id, phase === "work" ? "working" : phase === "review" ? "reviewing" : phase === "vote" ? "voting" : "thinking");
    try {
      const r = await io.speak(m, system.get(m.id)!, prompt, { tools: opts.tools ?? false, maxSteps: opts.maxSteps ?? 1, signal, extraTools: opts.extraTools });
      const text = r.text.trim() || "(no answer)";
      log.push({ name: m.name, phase, text });
      io.post({ id: m.id, name: m.name, emoji: m.emoji, phase, ...(opts.tag ?? {}) }, text, r.files);
      io.status(m.id, "waiting");
      return { text, files: r.files };
    } catch (e) {
      if (io.signal.aborted) throw e;
      io.status(m.id, io.stopped().has(m.id) ? "stopped" : "waiting");
      if (signal.aborted) return null; // stopped, or the vote was forced
      const msg = `Could not answer: ${e instanceof Error ? e.message : String(e)}`;
      io.post({ id: m.id, name: m.name, emoji: m.emoji, phase }, msg);
      return null;
    }
  };

  // ---- 1. plan: proposals in turn, each seeing the earlier ones
  const proposals = new Map<string, string>();
  for (const m of members) {
    if (io.forced() || io.stopped().has(m.id)) continue;
    const r = await say(
      m,
      "plan",
      `${context({ include: ["plan"] })}\n\nPropose how the team should divide this task, and which part you should take given your role. React to the proposals above if there are any. At most 120 words: a few bullet points, then a line "I take: …".`,
    );
    if (r) proposals.set(m.id, /I take:\s*(.+)/i.exec(r.text)?.[1]?.trim() ?? r.text.split("\n").find((l) => l.trim())!.slice(0, 200));
  }

  // ---- 2. assign: one part per member, shown in the plan checklist
  let parts = new Map<string, string>();
  const coord = coordinator();
  if (!io.forced() && coord) {
    const names = active().map((m) => m.name).join(", ");
    const r = await say(
      coord,
      "assign",
      `${context({ include: ["plan"] })}\n\nYou coordinate. Assign exactly one part to each of: ${names}. Avoid overlap; cover the whole task. Reply with a short sentence, then JSON only, like {"assignments":[{"member":"Name","part":"…"}]}.`,
    );
    if (r) parts = parseAssignments(r.text, active());
  }
  for (const m of active()) if (!parts.has(m.id)) parts.set(m.id, proposals.get(m.id) ?? `Your part of the task as ${m.role}.`);
  const plan = (status: (m: ConsortiumMember) => PlanItem["status"]) => io.setPlan(active().map((m) => ({ text: `${label(m)}: ${parts.get(m.id)}`, status: status(m) })));
  plan(() => "pending");

  // ---- 3. work: in parallel, with tools, a shared scratchpad and questions to each other
  const contributions = new Map<string, string>();
  if (!io.forced()) {
    const done = new Set<string>();
    plan(() => "in_progress");
    await Promise.all(
      active().map(async (m) => {
        const r = await say(
          m,
          "work",
          `${context({ include: ["assign"] })}\n\nYour part: ${parts.get(m.id)}\n\nDo your part now, thoroughly, using your tools where useful. Put facts and drafts the others need in the shared scratchpad. If you need something from a teammate, ask them with ask_member. End with your contribution, ready for the others to review.`,
          { tools: true, maxSteps: cfg.workSteps, extraTools: makeTools?.(m) },
        );
        if (r) contributions.set(m.id, r.text);
        done.add(m.id);
        plan((x) => (done.has(x.id) ? "done" : "in_progress"));
      }),
    );
  }

  // ---- 4. review: everyone reviews the others
  if (!io.forced() && contributions.size > 1) {
    await Promise.all(
      active()
        .filter((m) => contributions.has(m.id))
        .map((m) =>
          say(
            m,
            "review",
            `${context({ include: ["work"], exclude: m.name })}\n\nReview your teammates' contributions above. Name concrete errors, gaps and disagreements (whose, and why), and what you agree with. At most 200 words. End with a line "POSITION: <your one-sentence position on the answer>".`,
          ),
        ),
    );
  }

  // ---- 5. draft and vote, revised for up to N rounds
  const rounds = io.forced() ? 1 : Math.min(Math.max(cfg.rounds, 1), 5);
  let draft = "";
  let votes: { m: ConsortiumMember; vote: "agree" | "disagree"; reason: string }[] = [];
  for (let round = 1; round <= rounds; round++) {
    const c = coordinator();
    if (!c) break;
    const objections = votes.filter((v) => v.vote === "disagree").map((v) => `- ${v.m.name}: ${v.reason}`).join("\n");
    const d = await say(
      c,
      "draft",
      round === 1
        ? `${context({ include: ["work", "review"] })}\n\nYou coordinate. Write the team's joint answer to the task, combining the contributions and resolving the reviews. Where the team truly disagrees, say so instead of hiding it.`
        : `${context({ include: ["work", "review"] })}\n\nThe previous draft:\n${clip(draft, 6000)}\n\nObjections:\n${objections}\n\nRevise the joint answer to address the objections where they are right; keep what was agreed.`,
      { tag: { round } },
    );
    if (!d) break;
    draft = d.text;
    votes = [];
    await Promise.all(
      active().map(async (m) => {
        const signal = io.signal;
        if (signal.aborted) return;
        io.status(m.id, "voting");
        try {
          const r = await io.speak(m, system.get(m.id)!, `${context({ include: ["review"] })}\n\nThe draft joint answer (round ${round}):\n${clip(draft, 6000)}\n\nVote. First line exactly AGREE or DISAGREE. Then one or two sentences: why, and if you disagree, what must change.`, { tools: false, maxSteps: 1, signal });
          const v = parseVote(r.text);
          votes.push({ m, ...v });
          log.push({ name: m.name, phase: "vote", text: r.text });
          io.post({ id: m.id, name: m.name, emoji: m.emoji, phase: "vote", vote: v.vote, round }, r.text.trim());
          io.status(m.id, v.vote === "agree" ? "agrees" : "disagrees");
        } catch (e) {
          if (signal.aborted) throw e;
          io.status(m.id, "waiting");
        }
      }),
    );
    if (votes.length && votes.every((v) => v.vote === "agree")) break;
  }

  // ---- 6. the final answer, faithful to the vote
  const agree = votes.filter((v) => v.vote === "agree").length;
  const voters = votes.length;
  const outcome: ConsortiumResult["outcome"] = voters && agree === voters ? "consensus" : agree > voters / 2 ? "majority" : "no agreement";
  const c = coordinator();
  const dissent = votes.filter((v) => v.vote === "disagree").map((v) => `- ${v.m.name}: ${v.reason}`).join("\n");
  const instruction =
    outcome === "consensus"
      ? "Everyone agreed. Present the joint answer to the user, clean and complete."
      : outcome === "majority"
        ? "A majority agreed. Present the majority's answer, then a short section \"Dissent\" that states each dissenting view fairly and in its own terms."
        : "The team did NOT reach agreement. Do not invent a consensus. Present the main positions side by side (who holds each, the strongest argument for it), what they agree on, and what would settle the disagreement.";
  let final = draft;
  if (c && !io.signal.aborted) {
    io.status(c.id, "writing the answer");
    const r = await io.speak(c, system.get(c.id)!, `${context({ include: ["review", "vote"] })}\n\nThe latest draft:\n${clip(draft, 8000)}\n\nVotes: ${agree} of ${voters} agree.${dissent ? `\nDissent:\n${dissent}` : ""}\n\n${instruction} Write it for the user (they saw the discussion, so don't retell it).`, { tools: false, maxSteps: 1, signal: io.signal });
    final = r.text.trim() || draft;
    io.status(c.id, "done");
  }
  const tally = votes.map((v) => `${v.m.name} ${v.vote === "agree" ? "✓" : "✗"}`).join(" · ");
  const label2 = outcome === "consensus" ? `Consensus (${agree} of ${voters})` : outcome === "majority" ? `Majority (${agree} of ${voters} agree)` : `No agreement (${agree} of ${voters} agree)`;
  io.post({ id: c?.id ?? "coordinator", name: c?.name ?? "Coordinator", emoji: c?.emoji, phase: "final", outcome: `${label2}${tally ? ` — ${tally}` : ""}` }, final);
  for (const m of members) if (!io.stopped().has(m.id)) io.status(m.id, "done");
  return { outcome, agree, voters, final };
}

// ---------------------------------------------------------------- execution crew

export async function runCrew(task: string, cfg: ConsortiumConfig, io: ConsortiumIO, makeTools?: (member: ConsortiumMember) => Tool[]): Promise<ConsortiumResult> {
  const members = cfg.members;
  const notes: string[] = [];
  const log: Turn[] = [];
  const active = () => members.filter((m) => !io.stopped().has(m.id));
  const coordinator = () => active().find((m) => m.id === cfg.coordinatorId) ?? active()[0];
  const system = new Map(members.map((m) => [m.id, memberSystem(m, cfg)]));
  const context = (include: ConsortiumPhase[], exclude?: string) => {
    for (const n of io.takeNotes()) notes.push(n);
    const parts = [`Task from the user:\n${task}`];
    if (notes.length) parts.push(`Instructions the user added while the crew worked (follow them):\n${notes.map((n) => `- ${n}`).join("\n")}`);
    const shown = log.filter((t) => include.includes(t.phase) && t.name !== exclude);
    if (shown.length) parts.push(`So far:\n${shown.map((t) => `--- ${t.name} (${t.phase}):\n${clip(t.text)}`).join("\n\n")}`);
    return parts.join("\n\n");
  };
  const say = async (m: ConsortiumMember, phase: ConsortiumPhase, prompt: string, opts: Partial<SpeakOptions> = {}): Promise<Spoken | null> => {
    const signal = io.signalFor(m.id);
    if (signal.aborted || io.signal.aborted) return null;
    io.status(m.id, phase === "work" ? "working" : phase === "review" ? "auditing" : "planning");
    try {
      const r = await io.speak(m, system.get(m.id)!, prompt, { tools: opts.tools ?? false, maxSteps: opts.maxSteps ?? 1, signal, extraTools: opts.extraTools });
      const text = r.text.trim() || "(no answer)";
      log.push({ name: m.name, phase, text });
      io.post({ id: m.id, name: m.name, emoji: m.emoji, phase }, text, r.files);
      io.status(m.id, "waiting");
      return { text, files: r.files };
    } catch (e) {
      if (io.signal.aborted) throw e;
      io.status(m.id, io.stopped().has(m.id) ? "stopped" : "waiting");
      if (signal.aborted) return null;
      io.post({ id: m.id, name: m.name, emoji: m.emoji, phase }, `Could not finish: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  // ---- 1. assign: one concrete job per role, done at the same time
  const checkers = () => {
    const c = active().filter(isChecker);
    return c.length === active().length ? [] : c;
  };
  const workers = () => active().filter((m) => !checkers().includes(m));
  let jobs = new Map<string, string>();
  const coord = coordinator();
  if (!io.forced() && coord) {
    const r = await say(
      coord,
      "assign",
      `${context([])}\n\nYou lead this crew. Give each of these members one concrete job that fits their role, to be done at the same time, so that together they complete the task: ${workers().map((m) => `${m.name} (${m.role})`).join(", ")}.${checkers().length ? ` ${checkers().map((m) => m.name).join(" and ")} will audit the results afterwards; do not assign them work now.` : ""} Reply with one sentence, then JSON only, like {"assignments":[{"member":"Name","part":"…"}]}.`,
    );
    if (r) jobs = parseAssignments(r.text, workers());
  }
  for (const m of workers()) if (!jobs.has(m.id)) jobs.set(m.id, `Do what your role covers: ${m.role}.`);
  const statusOf = new Map<string, PlanItem["status"]>();
  const plan = () =>
    io.setPlan([
      ...workers().map((m) => ({ text: `${label(m)}: ${jobs.get(m.id)}`, status: statusOf.get(m.id) ?? ("pending" as const) })),
      ...checkers().map((m) => ({ text: `${label(m)}: audit the results`, status: statusOf.get(m.id) ?? ("pending" as const) })),
    ]);
  plan();

  // ---- 2. work: everyone at once
  const results = new Map<string, string>();
  const work = async (m: ConsortiumMember, prompt: string) => {
    statusOf.set(m.id, "in_progress");
    plan();
    const r = await say(m, "work", prompt, { tools: true, maxSteps: cfg.workSteps, extraTools: makeTools?.(m) });
    if (r) results.set(m.id, r.text);
    statusOf.set(m.id, r ? "done" : "pending");
    plan();
  };
  if (!io.forced()) {
    await Promise.all(
      workers().map((m) =>
        work(
          m,
          `${context(["assign"])}\n\nYour job: ${jobs.get(m.id)}\n\nDo it now with your tools. Record facts others need in the shared scratchpad as you go. Finish with a short report: what you did, the result, anything still open.`,
        ),
      ),
    );
  }

  // ---- 3. audit, then one fix pass for what the auditors flagged
  let issues = false;
  if (!io.forced() && checkers().length && results.size) {
    const audits = await Promise.all(
      checkers().map(async (m) => {
        statusOf.set(m.id, "in_progress");
        plan();
        const r = await say(
          m,
          "review",
          `${context(["work"])}\n\nAudit the crew's results against the task. Check facts, numbers and anything that could go wrong; use your tools to verify where you can. First line exactly PASS or ISSUES. Then list each problem as "- <member>: <what to fix>".`,
          { tools: true, maxSteps: Math.max(3, Math.round(cfg.workSteps / 2)), extraTools: makeTools?.(m) },
        );
        statusOf.set(m.id, "done");
        plan();
        return r?.text ?? "";
      }),
    );
    const flagged = audits.filter((a) => /^\W*issues/i.test(a.trim()));
    issues = flagged.length > 0;
    if (issues && cfg.rounds > 1 && !io.forced()) {
      const findings = flagged.join("\n\n");
      const named = workers().filter((m) => results.has(m.id) && new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(findings));
      await Promise.all(
        (named.length ? named : workers().filter((m) => results.has(m.id))).map((m) =>
          work(m, `${context(["work"], undefined)}\n\nThe audit found:\n${clip(findings, 4000)}\n\nFix what concerns your job (${jobs.get(m.id)}). Report what you changed.`),
        ),
      );
      issues = false;
    }
  }

  // ---- 4. the report
  const done = workers().filter((m) => results.has(m.id)).length;
  const total = workers().length;
  const outcome: ConsortiumResult["outcome"] = done === total && !issues && !io.forced() ? "completed" : "partial";
  const c = coordinator();
  let final = [...results.entries()].map(([id, t]) => `**${members.find((m) => m.id === id)?.name}:** ${t}`).join("\n\n");
  if (c && !io.signal.aborted) {
    io.status(c.id, "writing the report");
    const r = await io.speak(
      c,
      system.get(c.id)!,
      `${context(["work", "review"])}\n\nWrite the crew's report for the user: the outcome first, then what each role did and found, then anything still open or needing the user's decision. ${outcome === "partial" ? "Not everything was finished: say plainly what is missing." : ""} Don't retell the discussion.`,
      { tools: false, maxSteps: 1, signal: io.signal },
    );
    final = r.text.trim() || final;
    io.status(c.id, "done");
  }
  const audit = checkers().length ? (issues ? " · audit found issues" : " · audit passed") : "";
  io.post({ id: c?.id ?? "coordinator", name: c?.name ?? "Coordinator", emoji: c?.emoji, phase: "final", outcome: `${outcome === "completed" ? "Crew finished" : "Crew partly finished"} — ${done} of ${total} jobs done${audit}` }, final);
  for (const m of members) if (!io.stopped().has(m.id)) io.status(m.id, "done");
  return { outcome, agree: done, voters: total, final };
}
