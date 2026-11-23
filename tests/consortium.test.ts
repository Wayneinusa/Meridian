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
