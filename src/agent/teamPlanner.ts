// Automatic consortium teams: a strong model reads the task and the user's
// constraints, then proposes how many agents, what each one does, and which of
// the user's models fits each role. The user sees the proposal and can accept,
// edit or regenerate it before anything runs.
import { providerReady } from "../providers/backends";
import type { ConsortiumConfig, ConsortiumMember, ModelRef, ProviderConfig } from "../types";
import { modelKey, uid } from "../types";

export interface TeamRequest {
  task: string;
  /** 2-6 */
  maxAgents: number;
  /** only these provider ids (empty: any) */
  providers?: string[];
  preferFast?: boolean;
  /** auto: the planner decides between a discussion and an execution crew */
  style?: "auto" | "deliberate" | "execute";
  /** anything else the user wants considered */
  notes?: string;
}

export interface ModelOption {
  ref: ModelRef;
  key: string;
  name: string;
  provider: string;
  traits: string[];
}

const FAST = /mini|flash|haiku|fast|lite|nano|small|8b|turbo/i;
const STRONG = /opus|pro\b|-pro|ultra|large|grok-4|gpt-5(?!.*mini)|sonnet|reason|o3|o4/i;

/** Chat models that can use tools, from providers that are ready (and allowed). */
export function modelOptions(providers: ProviderConfig[], allowed: string[] = []): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of providers) {
    if (!p.enabled || (allowed.length && !allowed.includes(p.id))) continue;
    if (!providerReady(p) && p.kind !== "openai-compatible") continue;
    for (const m of p.models) {
      if (m.kind !== "chat" || !m.caps.tools) continue;
      const traits: string[] = [];
      if (FAST.test(m.id)) traits.push("fast, cheap");
      else if (STRONG.test(m.id)) traits.push("strong");
      if (m.caps.vision) traits.push("sees images");
      if (m.caps.thinking) traits.push("reasons");
      if (p.kind === "xai") traits.push("live web and X search");
      if (p.kind === "anthropic") traits.push("native web search");
      out.push({ ref: { providerId: p.id, modelId: m.id }, key: modelKey({ providerId: p.id, modelId: m.id }), name: m.name, provider: p.name, traits });
    }
  }
  return out.slice(0, 60);
}

export function plannerPrompt(req: TeamRequest, models: ModelOption[]): { system: string; prompt: string } {
  const max = Math.min(Math.max(req.maxAgents, 2), 6);
  const style =
    req.style === "execute"
      ? 'The user wants an execution crew ("execute").'
      : req.style === "deliberate"
        ? 'The user wants a discussion that ends in a joint answer ("deliberate").'
        : 'Choose "execute" when the task is operational (doing, checking, contacting, reconciling, fixing, monitoring: a crew that acts at the same time) and "deliberate" when it needs a considered joint answer (analysis, a decision, writing).';
  const system =
    "You design teams of AI agents. You know which kinds of specialist roles a task needs and keep teams small: every member must have a distinct job. Reply with JSON only.";
  const prompt = [
    `Task:\n${req.task.trim()}`,
    req.notes?.trim() ? `The user's notes:\n${req.notes.trim()}` : "",
    `Team size: 2 to ${max} agents. Use fewer when fewer will do.`,
    style,
    req.preferFast ? "Prefer fast, cheap models; use a strong one only for the coordinator or a role that needs deep reasoning." : "Match each role to the model that suits it best; mixing providers is good when their strengths differ.",
    `Models you may use (use the id exactly):\n${models.map((m) => `- ${m.key} — ${m.name} (${m.provider}${m.traits.length ? `; ${m.traits.join(", ")}` : ""})`).join("\n")}`,
    'Reply with JSON only, in this shape: {"style":"execute"|"deliberate","rationale":"one or two sentences on why this team","members":[{"name":"short name","emoji":"one emoji","role":"what this member does, specifically","model":"<id from the list>","coordinator":true|false}]}. Exactly one member is the coordinator: the one who leads and writes the result. For an execution crew, include an auditor role when mistakes would be costly.',
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

export interface Proposal {
  config: ConsortiumConfig;
  rationale: string;
}

function jsonBlock(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const src = fenced ?? text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The planner did not return a team.");
  return JSON.parse(src.slice(start, end + 1));
}

/** Turn the planner's reply into a team, keeping only models the user has and the limits they set. */
export function parseProposal(text: string, req: TeamRequest, models: ModelOption[], fallback?: ModelRef): Proposal {
  let raw: { style?: string; rationale?: string; members?: { name?: string; emoji?: string; role?: string; model?: string; coordinator?: boolean }[] };
  try {
    raw = jsonBlock(text) as typeof raw;
  } catch (e) {
    throw new Error(`The planner's answer could not be read as a team (${e instanceof Error ? e.message : String(e)}). Try Regenerate.`);
  }
  const max = Math.min(Math.max(req.maxAgents, 2), 6);
  const list = (raw.members ?? []).filter((m) => m && (m.name || m.role)).slice(0, max);
  if (list.length < 2) throw new Error("The planner proposed fewer than two members. Try Regenerate, or describe the task in more detail.");
  const pick = (want?: string): ModelRef | undefined => {
    const w = String(want ?? "").trim().toLowerCase();
    if (w) {
      const hit =
        models.find((m) => m.key.toLowerCase() === w) ??
        models.find((m) => m.ref.modelId.toLowerCase() === w) ??
        models.find((m) => w.includes(m.ref.modelId.toLowerCase()) || m.ref.modelId.toLowerCase().includes(w.split("::").pop() ?? w));
      if (hit) return hit.ref;
    }
    if (req.preferFast) {
      const fast = models.find((m) => m.traits.includes("fast, cheap"));
      if (fast) return fast.ref;
    }
    return fallback && models.some((m) => m.key === modelKey(fallback)) ? fallback : models[0]?.ref;
  };
  const seen = new Set<string>();
  const members: ConsortiumMember[] = list.map((m, i) => {
    let name = String(m.name ?? `Agent ${i + 1}`).trim().slice(0, 40) || `Agent ${i + 1}`;
    while (seen.has(name.toLowerCase())) name = `${name} ${i + 1}`;
    seen.add(name.toLowerCase());
    return { id: uid("mem"), name, emoji: String(m.emoji ?? "🤖").slice(0, 4), role: String(m.role ?? "contributes its expertise").trim().slice(0, 400), model: pick(m.model) };
  });
  const ci = list.findIndex((m) => m.coordinator === true);
  const style = req.style === "execute" || req.style === "deliberate" ? req.style : raw.style === "execute" ? "execute" : "deliberate";
  return {
    rationale: String(raw.rationale ?? "").trim(),
    config: { members, coordinatorId: members[Math.max(ci, 0)].id, rounds: style === "execute" ? 2 : 2, workSteps: 15, style, origin: "auto", rationale: String(raw.rationale ?? "").trim() || undefined },
  };
}
