import { describe, expect, it } from "vitest";
import { parseAssignments, parseVote, runConsortium, type ConsortiumIO } from "../src/agent/consortium";
import type { BlobRef, ConsortiumConfig, ConsortiumMember, MemberTag, PlanItem } from "../src/types";

const members: ConsortiumMember[] = [
  { id: "a", name: "Ana", role: "researcher", emoji: "🔎" },
  { id: "b", name: "Bo", role: "skeptic", emoji: "🧐" },
  { id: "c", name: "Cy", role: "writer", emoji: "✍️" },
];
const cfg = (over: Partial<ConsortiumConfig> = {}): ConsortiumConfig => ({ members, coordinatorId: "c", rounds: 2, workSteps: 5, ...over });

type Script = (m: ConsortiumMember, prompt: string, n: { round: number }) => string;

function harness(script: Script, setup: (io: ConsortiumIO & { force(): void; stop(id: string): void; note(t: string): void }) => void = () => undefined) {
  const posts: { tag: Omit<MemberTag, "run">; text: string }[] = [];
  const prompts: { member: string; prompt: string; tools: boolean }[] = [];
  const plans: PlanItem[][] = [];
  const stopped = new Set<string>();
  const notes: string[] = [];
  let forced = false;
  const main = new AbortController();
  const ctrls = new Map(members.map((m) => [m.id, new AbortController()]));
  const state = { round: 0 };
  const io = {
    async speak(m: ConsortiumMember, system: string, prompt: string, o: { tools: boolean; signal: AbortSignal }) {
      expect(system).toContain(`You are ${m.name}`);
      if (o.signal.aborted) throw new DOMException("Aborted", "AbortError");
      prompts.push({ member: m.name, prompt, tools: o.tools });
      if (/draft joint answer \(round (\d)\)/.test(prompt)) state.round = Number(/round (\d)/.exec(prompt)![1]);
      await new Promise((r) => setTimeout(r, 1));
      if (o.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { text: script(m, prompt, state), files: [] as BlobRef[] };
    },
    post: (tag: Omit<MemberTag, "run">, text: string) => posts.push({ tag, text }),
    setPlan: (p: PlanItem[]) => plans.push(p),
    status: () => undefined,
    takeNotes: () => notes.splice(0),
    stopped: () => stopped,
    forced: () => forced,
    signalFor: (id: string) => ctrls.get(id)!.signal,
    signal: main.signal,
    force() {
      forced = true;
      for (const [id, c] of ctrls) {
        c.abort();
        ctrls.set(id, new AbortController());
      }
    },
    stop(id: string) {
      stopped.add(id);
      ctrls.get(id)!.abort();
    },
    note: (t: string) => void notes.push(t),
  };
  setup(io);
  return { io, posts, prompts, plans };
}

const agreeable: Script = (m, p) => {
  if (/Propose how the team/.test(p)) return `- split it\nI take: ${m.role} part`;
  if (/You coordinate\. Assign/.test(p)) return 'Here: {"assignments":[{"member":"Ana","part":"gather facts"},{"member":"bo","part":"check claims"},{"member":"Cy","part":"write it up"}]}';
  if (/Do your part now/.test(p)) return `${m.name}'s contribution`;
  if (/Review your teammates/.test(p)) return `Looks fine.\nPOSITION: agree with the plan`;
  if (/Write the team's joint answer/.test(p)) return "DRAFT ONE";
  if (/Vote\./.test(p)) return "AGREE\nGood.";
  return "FINAL ANSWER";
};

describe("consortium", () => {
  it("plans, assigns, works in parallel, reviews, votes and reaches consensus", async () => {
    const { io, posts, prompts, plans } = harness(agreeable);
    const r = await runConsortium("Compare heat pumps and gas boilers", cfg(), io);
    expect(r).toMatchObject({ outcome: "consensus", agree: 3, voters: 3, final: "FINAL ANSWER" });
    expect(posts.map((p) => p.tag.phase)).toEqual(["plan", "plan", "plan", "assign", "work", "work", "work", "review", "review", "review", "draft", "vote", "vote", "vote", "final"]);
    // planning is a conversation: later members see earlier proposals
    expect(prompts.find((p) => p.member === "Bo" && /Propose/.test(p.prompt))!.prompt).toContain("Ana (plan)");
    // the coordinator's assignments land in the plan checklist
    expect(plans[0].map((x) => x.text)).toEqual(["🔎 Ana: gather facts", "🧐 Bo: check claims", "✍️ Cy: write it up"]);
    expect(plans.at(-1)!.every((x) => x.status === "done")).toBe(true);
    // only the work phase gets tools
    expect(prompts.filter((p) => p.tools).map((p) => p.member).sort()).toEqual(["Ana", "Bo", "Cy"]);
    expect(prompts.find((p) => p.member === "Bo" && /Do your part/.test(p.prompt))!.prompt).toContain("Your part: check claims");
    // reviewers see the others' work, not their own
    const bosReview = prompts.find((p) => p.member === "Bo" && /Review your/.test(p.prompt))!.prompt;
    expect(bosReview).toContain("Ana's contribution");
    expect(bosReview).not.toContain("Bo's contribution");
    expect(posts.at(-1)!.tag.outcome).toBe("Consensus (3 of 3) — Ana ✓ · Bo ✓ · Cy ✓");
  });

  it("revises after objections, and reports disagreement instead of faking consensus", async () => {
    const stubborn: Script = (m, p, s) => {
      if (/Vote\./.test(p)) return m.name === "Bo" ? "DISAGREE: the costs are wrong" : m.name === "Ana" && s.round === 2 ? "DISAGREE: now it's too vague" : "AGREE";
      if (/Revise the joint answer/.test(p)) return "DRAFT TWO";
      return agreeable(m, p, s);
    };
    const { io, posts, prompts } = harness(stubborn);
    const r = await runConsortium("t", cfg({ rounds: 2 }), io);
    expect(prompts.find((p) => /Revise the joint answer/.test(p.prompt))!.prompt).toContain("- Bo: the costs are wrong");
    expect(posts.filter((p) => p.tag.phase === "draft").length).toBe(2);
    expect(r).toMatchObject({ outcome: "no agreement", agree: 1, voters: 3 });
    const finalPrompt = prompts.at(-1)!.prompt;
    expect(finalPrompt).toContain("did NOT reach agreement");
    expect(finalPrompt).toContain("Do not invent a consensus");
    expect(posts.at(-1)!.tag.outcome).toMatch(/^No agreement \(1 of 3 agree\)/);
  });

  it("a majority shows the dissent", async () => {
    const one: Script = (m, p, s) => (/Vote\./.test(p) ? (m.name === "Bo" ? "DISAGREE: too optimistic" : "AGREE") : agreeable(m, p, s));
    const { io, prompts } = harness(one);
    const r = await runConsortium("t", cfg({ rounds: 1 }), io);
    expect(r.outcome).toBe("majority");
    expect(prompts.at(-1)!.prompt).toContain('section "Dissent"');
  });

  it("the user can stop a member, add instructions and force the vote", async () => {
    let h!: Parameters<NonNullable<Parameters<typeof harness>[1]>>[0];
    const { io, posts, prompts } = harness(
      (m, p, s) => {
        // while the plan is discussed the user stops Ana and adds an instruction; at assignment they call the vote
        if (/Propose/.test(p) && m.name === "Bo") {
          h.stop("a");
          h.note("Keep it under 100 words");
        }
        if (/You coordinate\. Assign/.test(p)) h.force();
        return agreeable(m, p, s);
      },
      (x) => (h = x),
    );
    const r = await runConsortium("t", cfg(), io);
    expect(posts.some((p) => p.tag.name === "Ana" && p.tag.phase !== "plan")).toBe(false);
    expect(posts.some((p) => p.tag.phase === "work" || p.tag.phase === "review")).toBe(false);
    expect(posts.filter((p) => p.tag.phase === "vote").map((p) => p.tag.name).sort()).toEqual(["Bo", "Cy"]);
    expect(r.voters).toBe(2);
    expect(prompts.find((p) => /Write the team's joint answer/.test(p.prompt))!.prompt).toContain("Keep it under 100 words");
  });

  it("reads assignments and votes from loose model output", () => {
    const m = parseAssignments('Sure!\n```json\n{"assignments":[{"member":"ana","part":"x"},{"member":"Bo (skeptic)","part":"y"},{"member":"Zed","part":"z"}]}\n```', members);
    expect([...m.entries()]).toEqual([["a", "x"], ["b", "y"]]);
    expect(parseAssignments("no json here", members).size).toBe(0);
    expect(parseVote("**AGREE** — solid.")).toEqual({ vote: "agree", reason: "solid." });
    expect(parseVote("DISAGREE: costs wrong").vote).toBe("disagree");
    expect(parseVote("I think it's fine").vote).toBe("disagree");
  });

  it("needs two members", async () => {
    const { io } = harness(agreeable);
    await expect(runConsortium("t", cfg({ members: members.slice(0, 1) }), io)).rejects.toThrow(/at least two/);
  });
});

import { isChecker } from "../src/agent/consortium";
import { modelOptions, parseProposal, plannerPrompt } from "../src/agent/teamPlanner";
import type { ProviderConfig } from "../src/types";

describe("execution crew", () => {
  const crew: ConsortiumMember[] = [
    { id: "l", name: "Lead", role: "runs the operation", emoji: "🧭" },
    { id: "s", name: "Scout", role: "gathers the current facts" },
    { id: "r", name: "Reconciler", role: "matches payouts against bookings" },
    { id: "a", name: "Auditor", role: "audits the crew's results" },
  ];
  const crewCfg = (over: Partial<ConsortiumConfig> = {}): ConsortiumConfig => ({ members: crew, coordinatorId: "l", rounds: 2, workSteps: 8, style: "execute", ...over });

  function crewHarness(script: (name: string, prompt: string) => string) {
    const posts: { tag: Omit<MemberTag, "run">; text: string }[] = [];
    const prompts: { member: string; prompt: string; tools: boolean; order: number }[] = [];
    const plans: PlanItem[][] = [];
    let order = 0;
    const io: ConsortiumIO = {
      async speak(m, _system, prompt, o) {
        prompts.push({ member: m.name, prompt, tools: o.tools, order: order++ });
        await new Promise((r) => setTimeout(r, 1));
        return { text: script(m.name, prompt), files: [] };
      },
      post: (tag, text) => void posts.push({ tag, text }),
      setPlan: (p) => void plans.push(p),
      status: () => undefined,
      takeNotes: () => [],
      stopped: () => new Set(),
      forced: () => false,
      signalFor: () => new AbortController().signal,
      signal: new AbortController().signal,
    };
    return { io, posts, prompts, plans };
  }

  it("assigns jobs by role, works at once, audits, fixes what was flagged, and reports without a vote", async () => {
    const { io, posts, prompts, plans } = crewHarness((name, p) => {
      if (/You lead this crew/.test(p)) return 'Go: {"assignments":[{"member":"Lead","part":"track the run"},{"member":"Scout","part":"pull this week\'s bookings"},{"member":"Reconciler","part":"match payouts to bookings"}]}';
      if (/The audit found/.test(p)) return `${name} FIXED`;
      if (/Your job:/.test(p)) return `${name} DONE`;
      if (/Audit the crew/.test(p)) return "ISSUES\n- Reconciler: payout 1042 counted twice";
      if (/crew's report/.test(p)) return "REPORT: all reconciled";
      return "?";
    });
    const r = await runConsortium("Reconcile payouts", crewCfg(), io);
    expect(r.outcome).toBe("completed");
    // no planning debate, no votes
    expect(posts.some((x) => x.tag.phase === "plan" || x.tag.phase === "vote" || x.tag.phase === "draft")).toBe(false);
    // the auditor does not get a work job; it audits after the work
    const work = prompts.filter((x) => /Your job:/.test(x.prompt)).map((x) => x.member).sort();
    expect(work).toEqual(["Lead", "Reconciler", "Scout"]);
    const audit = prompts.find((x) => /Audit the crew/.test(x.prompt))!;
    expect(audit.member).toBe("Auditor");
    expect(audit.tools).toBe(true);
    expect(Math.min(...prompts.filter((x) => /Your job:/.test(x.prompt)).map((x) => x.order))).toBeLessThan(audit.order);
    // only the member the audit named fixes its work
    expect(prompts.filter((x) => /The audit found/.test(x.prompt)).map((x) => x.member)).toEqual(["Reconciler"]);
    expect(plans[0].map((x) => x.text)).toEqual(["🧭 Lead: track the run", "Scout: pull this week's bookings", "Reconciler: match payouts to bookings", "Auditor: audit the results"]);
    expect(posts.at(-1)!.tag.outcome).toBe("Crew finished — 3 of 3 jobs done · audit passed");
    expect(posts.at(-1)!.text).toBe("REPORT: all reconciled");
  });

  it("reports a partial result when a job fails and there is no fix pass", async () => {
    const { io, posts } = crewHarness((name, p) => {
      if (/You lead this crew/.test(p)) return "no json";
      if (/Your job:/.test(p)) {
        if (name === "Scout") throw new Error("site down");
        return `${name} DONE`;
      }
      if (/Audit the crew/.test(p)) return "ISSUES\n- Scout: nothing delivered";
      return "REPORT";
    });
    const r = await runConsortium("t", crewCfg({ rounds: 1 }), io);
    expect(r.outcome).toBe("partial");
    expect(posts.at(-1)!.tag.outcome).toBe("Crew partly finished — 2 of 3 jobs done · audit found issues");
    // without the coordinator's JSON, each member falls back to its role
    expect(posts.some((x) => x.tag.name === "Scout" && /Could not finish: site down/.test(x.text))).toBe(true);
  });

  it("knows which roles check the others", () => {
    expect(crew.filter(isChecker).map((m) => m.name)).toEqual(["Auditor"]);
    expect(isChecker({ id: "x", name: "QA", role: "tests things" })).toBe(true);
  });
});

describe("automatic teams", () => {
  const providers: ProviderConfig[] = [
    { id: "anthropic", kind: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", enabled: true, hasKey: true, models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", kind: "chat", caps: { vision: true, pdf: true, tools: true, thinking: true } }, { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", kind: "chat", caps: { vision: true, pdf: true, tools: true, thinking: false } }] },
    { id: "xai", kind: "xai", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", enabled: true, signedIn: true, models: [{ id: "grok-4", name: "Grok 4", kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: true } }, { id: "grok-imagine-image", name: "Imagine", kind: "image", caps: { vision: true, pdf: false, tools: false, thinking: false } }] },
    { id: "openai", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", enabled: true, models: [{ id: "gpt-4o", name: "GPT-4o", kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: false } }] },
  ];

  it("offers only ready chat models with tools, and respects the chosen providers", () => {
    expect(modelOptions(providers).map((m) => m.key)).toEqual(["anthropic::claude-opus-5-5", "anthropic::claude-haiku-5-5", "xai::grok-4"]);
    expect(modelOptions(providers, ["xai"]).map((m) => m.key)).toEqual(["xai::grok-4"]);
    expect(modelOptions(providers)[1].traits).toContain("fast, cheap");
  });

  it("asks for a team within the limits, listing the models by id", () => {
    const { prompt } = plannerPrompt({ task: "Run the weekly reconciliation", maxAgents: 3, preferFast: true, style: "auto" }, modelOptions(providers));
    expect(prompt).toContain("2 to 3 agents");
    expect(prompt).toContain("xai::grok-4");
    expect(prompt).toContain("Prefer fast, cheap models");
    expect(prompt).toMatch(/"execute" when the task is operational/);
  });

  it("turns the planner's answer into an editable team, fixing what it got wrong", () => {
    const text = 'Here you go:\n```json\n{"style":"execute","rationale":"Ops work needs a crew.","members":[{"name":"Scout","emoji":"🔭","role":"pulls bookings","model":"grok-4"},{"name":"Reconciler","role":"matches payouts","model":"anthropic::claude-haiku-5-5","coordinator":true},{"name":"Auditor","role":"checks figures","model":"gpt-9-unknown"},{"name":"Extra","role":"x"}]}\n```';
    const p = parseProposal(text, { task: "t", maxAgents: 3, style: "auto" }, modelOptions(providers), { providerId: "anthropic", modelId: "claude-opus-5-5" });
    expect(p.rationale).toBe("Ops work needs a crew.");
    expect(p.config.style).toBe("execute");
    expect(p.config.origin).toBe("auto");
    expect(p.config.members.map((m) => m.name)).toEqual(["Scout", "Reconciler", "Auditor"]);
    expect(p.config.members.map((m) => m.model?.modelId)).toEqual(["grok-4", "claude-haiku-5-5", "claude-opus-5-5"]);
    expect(p.config.coordinatorId).toBe(p.config.members[1].id);
  });

  it("the user's choice of style wins, and nonsense is reported", () => {
    const text = '{"style":"execute","members":[{"name":"A","role":"a"},{"name":"B","role":"b"}]}';
    expect(parseProposal(text, { task: "t", maxAgents: 4, style: "deliberate" }, modelOptions(providers)).config.style).toBe("deliberate");
    expect(() => parseProposal("I would suggest a team of experts.", { task: "t", maxAgents: 4 }, modelOptions(providers))).toThrow(/could not be read/);
    expect(() => parseProposal('{"members":[{"name":"Solo","role":"all"}]}', { task: "t", maxAgents: 4 }, modelOptions(providers))).toThrow(/fewer than two/);
  });
});
