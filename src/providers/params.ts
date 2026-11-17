// Which generation parameters each kind of provider understands, and how the
// three scopes (all chats < this model < this chat) combine.
import type { Conversation, ModelInfo, ModelParams, ModelRef, ProviderKind, Settings } from "../types";
import { modelKey } from "../types";

export type ParamKey = keyof ModelParams;

export interface ParamSpec {
  key: ParamKey;
  label: string;
  help: string;
  type: "number" | "integer" | "select" | "boolean" | "list" | "json";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  group: "Sampling" | "Length" | "Reasoning" | "Tools" | "Advanced";
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: "temperature", label: "Temperature", group: "Sampling", type: "number", min: 0, max: 2, step: 0.05, help: "Higher is more varied, lower is more focused and repeatable." },
  { key: "topP", label: "Top P", group: "Sampling", type: "number", min: 0, max: 1, step: 0.01, help: "Nucleus sampling: only consider tokens within this cumulative probability." },
  { key: "topK", label: "Top K", group: "Sampling", type: "integer", min: 1, max: 500, step: 1, help: "Only consider the K most likely tokens at each step." },
  { key: "minP", label: "Min P", group: "Sampling", type: "number", min: 0, max: 1, step: 0.01, help: "Drop tokens less likely than this fraction of the top token (local and OpenRouter models)." },
  { key: "frequencyPenalty", label: "Frequency penalty", group: "Sampling", type: "number", min: -2, max: 2, step: 0.05, help: "Positive values discourage repeating the same words in proportion to how often they appeared." },
  { key: "presencePenalty", label: "Presence penalty", group: "Sampling", type: "number", min: -2, max: 2, step: 0.05, help: "Positive values encourage moving on to new topics." },
  { key: "repetitionPenalty", label: "Repetition penalty", group: "Sampling", type: "number", min: 0, max: 2, step: 0.01, help: "Multiplicative repeat penalty used by local and OpenRouter models (1 = off)." },
  { key: "seed", label: "Seed", group: "Sampling", type: "integer", min: 0, max: 2147483647, step: 1, help: "Same seed and settings give (mostly) the same output." },
  { key: "maxTokens", label: "Max output tokens", group: "Length", type: "integer", min: 1, max: 1000000, step: 1, help: "Upper limit for the length of one reply." },
  { key: "stop", label: "Stop sequences", group: "Length", type: "list", help: "Generation stops when any of these strings is produced. One per line." },
  { key: "verbosity", label: "Verbosity", group: "Length", type: "select", options: opts("low", "medium", "high"), help: "How long answers should be, on models that offer this control." },
  { key: "contextMessages", label: "Context messages", group: "Length", type: "integer", min: 2, max: 1000, step: 1, help: "Only send the most recent N messages. Saves tokens on long chats; the model forgets older ones." },
  { key: "effort", label: "Reasoning effort", group: "Reasoning", type: "select", options: opts("low", "medium", "high", "xhigh", "max"), help: "How hard the model thinks before answering." },
  { key: "thinkingBudget", label: "Thinking budget (tokens)", group: "Reasoning", type: "integer", min: 0, max: 200000, step: 256, help: "Fixed number of tokens the model may spend thinking, on models that take a budget. 0 turns thinking off where allowed." },
  { key: "toolChoice", label: "Tool choice", group: "Tools", type: "select", options: [{ value: "auto", label: "Auto" }, { value: "none", label: "Never use tools" }, { value: "required", label: "Must use a tool" }], help: "Whether the model may, must not, or must call a tool." },
  { key: "parallelToolCalls", label: "Parallel tool calls", group: "Tools", type: "boolean", help: "Allow several tool calls in one step." },
  { key: "responseFormat", label: "Response format", group: "Advanced", type: "select", options: [{ value: "text", label: "Text" }, { value: "json", label: "JSON object" }], help: "Ask for a JSON object instead of prose." },
  { key: "speed", label: "Speed", group: "Advanced", type: "select", options: [{ value: "standard", label: "Standard" }, { value: "fast", label: "Fast (costs more)" }], help: "Faster output at premium pricing, on models that offer a fast mode." },
  { key: "serviceTier", label: "Service tier", group: "Advanced", type: "select", options: opts("auto", "default", "flex", "priority"), help: "Processing tier, where the provider offers more than one." },
  { key: "logitBias", label: "Logit bias", group: "Advanced", type: "json", help: 'JSON map of token id to bias from -100 to 100, e.g. {"1734": -100}.' },
  { key: "extraBody", label: "Extra request fields", group: "Advanced", type: "json", help: "JSON object merged into the request body last. Use it for any provider-specific option not listed here." },
];

function opts(...values: string[]) {
  return values.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
}

const SUPPORT: Record<ProviderKind, ParamKey[]> = {
  // Claude dropped temperature / top-p / top-k from its API; effort is the control there.
  anthropic: ["maxTokens", "stop", "effort", "thinkingBudget", "toolChoice", "parallelToolCalls", "speed", "extraBody"],
  openai: [
    "temperature", "topP", "frequencyPenalty", "presencePenalty", "seed", "maxTokens", "stop", "verbosity", "contextMessages",
    "effort", "toolChoice", "parallelToolCalls", "responseFormat", "serviceTier", "logitBias", "extraBody",
  ],
  "openai-compatible": [
    "temperature", "topP", "topK", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty", "seed", "maxTokens", "stop",
    "contextMessages", "effort", "toolChoice", "parallelToolCalls", "responseFormat", "logitBias", "extraBody",
  ],
  gemini: [
    "temperature", "topP", "topK", "frequencyPenalty", "presencePenalty", "seed", "maxTokens", "stop", "contextMessages",
    "thinkingBudget", "toolChoice", "responseFormat", "extraBody",
  ],
};

/** Why a parameter is not used with this model, or null when it is. */
export function paramUnsupportedReason(key: ParamKey, kind: ProviderKind, model?: ModelInfo): string | null {
  if (!SUPPORT[kind].includes(key)) {
    if (kind === "anthropic" && (key === "temperature" || key === "topP" || key === "topK")) {
      return "Claude's API no longer accepts sampling parameters. Use reasoning effort instead.";
    }
    if (kind === "anthropic" && key === "contextMessages") {
      return "Not used with Claude: its thinking must be replayed with the full history.";
    }
    return "Not offered by this provider. Ignored.";
  }
  if (kind === "anthropic" && model) {
    if (key === "thinkingBudget" && model.thinkingMode !== "budget") return "This Claude model thinks adaptively. Use reasoning effort.";
    if (key === "effort" && model.efforts && !model.efforts.length) return "This model has no effort control.";
  }
  if (key === "effort" && model && !model.caps.thinking && kind !== "anthropic") return "Only applies to reasoning models.";
  return null;
}

export function resolveParams(settings: Settings, ref: ModelRef | undefined, conv?: Pick<Conversation, "params">): ModelParams {
  return clean({ ...settings.params, ...(settings.modelParams[modelKey(ref)] ?? {}), ...(conv?.params ?? {}) });
}

/** Drop unset values so "default" really means "send nothing". */
export function clean(p: ModelParams): ModelParams {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (k === "effort" && v === "auto") continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length) continue;
    out[k] = v;
  }
  return out as ModelParams;
}

/** Parameters this provider will actually receive. */
export function supportedParams(p: ModelParams, kind: ProviderKind, model?: ModelInfo): ModelParams {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clean(p))) {
    if (!paramUnsupportedReason(k as ParamKey, kind, model)) out[k] = v;
  }
  return out as ModelParams;
}
