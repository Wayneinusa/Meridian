// Claude, through the official Anthropic SDK (streaming, tool use, thinking,
// PDFs and images, hosted web search, refusal fallbacks, prompt caching).
import Anthropic from "@anthropic-ai/sdk";
import { httpFetch } from "../platform/http";
import type { Message, ModelInfo, Part, ProviderConfig } from "../types";
import { clientToolCalls, resultOf, trimSlash, userItems } from "./common";
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StopKind } from "./types";

type Beta = Anthropic.Beta.Messages.BetaMessage;
type BetaBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const OFFICIAL = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that take `thinking: {type: "adaptive"}` (everything current except Haiku 4.5 and older). */
const ADAPTIVE = /claude-(fable|mythos)|claude-opus-(5|4-[678])|claude-sonnet-(5|4-6)|claude-haiku-5/;
/** Models that accept the dynamic-filtering web tools. */
const NEW_WEB_TOOLS = /claude-(fable|mythos)|claude-opus-(5|4-[678])|claude-sonnet-(5|4-6)/;
/** Models where a safety decline can be re-run server-side on another model. */
const FALLBACK_MODELS = /claude-fable-5-[12]|claude-opus-5|claude-sonnet-5-5/;

export const ANTHROPIC_DEFAULT_MODELS: ModelInfo[] = [
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-fable-5-2", "Claude Fable 5.2"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-haiku-5-5", "Claude Haiku 5.5"),
];

function model(id: string, name: string): ModelInfo {
  return {
    id,
    name,
    kind: "chat",
    caps: { vision: true, pdf: true, tools: true, thinking: true, webSearch: true },
    maxOutput: 128000,
    contextWindow: 1_000_000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    thinkingMode: "adaptive",
  };
}

function client(provider: ProviderConfig, apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: trimSlash(provider.baseUrl || OFFICIAL),
    fetch: httpFetch,
    maxRetries: 2,
    // This is a client app: the key is the user's own and stays on their device.
    dangerouslyAllowBrowser: true,
  });
}

function describe(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("Anthropic rejected the API key. Check it in Settings → Providers.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Not allowed: ${err.message}`, 403);
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Not found (is the model id right?): ${err.message}`, 404);
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("Rate limited by Anthropic. Wait a moment and try again.", 429);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new ProviderError(err.message, typeof err.status === "number" ? err.status : undefined);
  return new ProviderError(err instanceof Error ? err.message : String(err));
}

async function toParams(req: ChatRequest): Promise<{ messages: BetaParam[]; hasFallbackBlocks: boolean }> {
  const out: BetaParam[] = [];
  let hasFallbackBlocks = false;
  for (const m of req.messages) {
    if (m.role === "user") {
      const content: BetaBlockParam[] = [];
      for (const item of await userItems(m, req.model.caps, req.blobs)) {
        if (item.kind === "text") content.push({ type: "text", text: item.text });
        else if (item.kind === "image") {
          content.push({ type: "image", source: { type: "base64", media_type: item.mime as "image/png", data: item.b64 } });
        } else {
          content.push({ type: "document", title: item.name, source: { type: "base64", media_type: "application/pdf", data: item.b64 } });
        }
      }
      if (content.length) out.push({ role: "user", content });
      continue;
    }

    let content: BetaBlockParam[];
    if (m.raw?.kind === "anthropic" && Array.isArray(m.raw.content)) {
      // Replay exactly what Claude produced (thinking blocks must come back unchanged).
      content = m.raw.content as BetaBlockParam[];
      if (content.some((b) => (b as { type: string }).type === "fallback")) hasFallbackBlocks = true;
    } else {
      content = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) content.push({ type: "text", text: p.text });
        else if (p.type === "tool_call" && !p.server) content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
      }
    }
    if (!content.length) continue;
    out.push({ role: "assistant", content });

    const calls = clientToolCalls(m);
    if (calls.length) {
      // all results of one turn go back in a single user message
      const results: BetaBlockParam[] = [];
      for (const call of calls) {
        const r = resultOf(call);
        const blocks: Anthropic.Beta.Messages.BetaToolResultBlockParam["content"] = [{ type: "text", text: r.text || "(no output)" }];
        if (req.model.caps.vision) {
          for (const img of r.images ?? []) {
            const b64 = await req.blobs.base64(img.blobId);
            if (b64) blocks.push({ type: "image", source: { type: "base64", media_type: img.mime as "image/png", data: b64 } });
          }
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: blocks, is_error: r.isError || undefined });
      }
      out.push({ role: "user", content: results });
    }
  }
  return { messages: out, hasFallbackBlocks };
}

function summarizeServerResult(block: BetaBlock): { id: string; text: string; isError: boolean } | null {
  if (block.type === "web_search_tool_result") {
    const c = block.content;
    if (Array.isArray(c)) {
      return { id: block.tool_use_id, isError: false, text: c.map((r) => `${r.title}\n${r.url}`).join("\n\n") || "(no results)" };
    }
    return { id: block.tool_use_id, isError: true, text: `Search failed: ${(c as { error_code?: string }).error_code ?? "unknown error"}` };
  }
  if (block.type === "web_fetch_tool_result") {
    const c = block.content as { type: string; url?: string; error_code?: string };
    if (c.type === "web_fetch_result") return { id: block.tool_use_id, isError: false, text: `Fetched ${c.url ?? "page"}` };
    return { id: block.tool_use_id, isError: true, text: `Fetch failed: ${c.error_code ?? "unknown error"}` };
  }
  return null;
}

/** Map Claude's content blocks to the app's display parts. */
export function partsFromContent(content: BetaBlock[], streaming: boolean): Part[] {
  const parts: Part[] = [];
  const serverCalls = new Map<string, Extract<Part, { type: "tool_call" }>>();
  for (const block of content) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (block.thinking) parts.push({ type: "thinking", text: block.thinking });
        break;
      case "tool_use":
        parts.push({ type: "tool_call", id: block.id, name: block.name, input: block.input, status: "pending" });
        break;
      case "server_tool_use": {
        const p: Extract<Part, { type: "tool_call" }> = {
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: block.input,
          server: true,
          status: streaming ? "running" : "done",
        };
        serverCalls.set(block.id, p);
        parts.push(p);
        break;
      }
      default: {
        const r = summarizeServerResult(block);
        if (r) {
          const call = serverCalls.get(r.id);
          if (call) {
            call.status = r.isError ? "error" : "done";
            call.result = { text: r.text, isError: r.isError };
          }
        }
      }
    }
  }
  return parts;
}

function mapStop(message: Beta): { stop: StopKind; detail?: string } {
  switch (message.stop_reason) {
    case "tool_use":
      return { stop: "tool_use" };
    case "max_tokens":
      return { stop: "max_tokens", detail: "The reply hit the output limit and was cut off." };
    case "model_context_window_exceeded":
      return { stop: "max_tokens", detail: "This conversation no longer fits in the model's context window. Start a new chat or pick a model with a larger window." };
    case "pause_turn":
      return { stop: "pause" };
    case "refusal": {
      const d = message.stop_details;
      const why = d?.explanation || (d?.category ? `category: ${d.category}` : "");
      return { stop: "refusal", detail: `The model declined this request${why ? ` (${why})` : ""}.` };
    }
    default:
      return { stop: "end" };
  }
}

export const anthropicAdapter: ProviderAdapter = {
  async listModels(provider, apiKey) {
    const out: ModelInfo[] = [];
    try {
      for await (const m of client(provider, apiKey).models.list({ limit: 100 })) {
        const caps = m.capabilities;
        const efforts = caps?.effort?.supported
          ? (["low", "medium", "high", "xhigh", "max"] as const).filter((e) => caps.effort[e]?.supported)
          : [];
        out.push({
          id: m.id,
          name: m.display_name || m.id,
          kind: "chat",
          caps: {
            vision: caps ? caps.image_input.supported : true,
            pdf: caps ? caps.pdf_input.supported : true,
            tools: true,
            thinking: caps ? caps.thinking.supported : ADAPTIVE.test(m.id),
            webSearch: true,
          },
          maxOutput: m.max_tokens ?? undefined,
          contextWindow: m.max_input_tokens ?? undefined,
          efforts,
          thinkingMode: ADAPTIVE.test(m.id) ? "adaptive" : caps?.thinking.supported ? "budget" : "none",
        });
      }
    } catch (err) {
      throw describe(err);
    }
    return out;
  },

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { model, options } = req;
    const p = options.params;
    const effort = p.effort && p.effort !== "auto" ? p.effort : undefined;
    const { messages, hasFallbackBlocks } = await toParams(req);
    const official = trimSlash(req.provider.baseUrl || OFFICIAL) === OFFICIAL;
    const adaptive = model.thinkingMode ? model.thinkingMode === "adaptive" : ADAPTIVE.test(model.id);
    const useFallback = options.refusalFallback && official && FALLBACK_MODELS.test(model.id);

    const tools: Anthropic.Beta.Messages.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      // stream large inputs (file contents) as they are written; inputs are validated before a tool runs
      eager_input_streaming: true,
    }));
    if (options.webSearch && model.caps.webSearch && official) {
      if (NEW_WEB_TOOLS.test(model.id)) {
        tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 8 });
        tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 });
      } else {
        tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 8 });
      }
    }

    const betas: string[] = [];
    if (useFallback || hasFallbackBlocks) betas.push(FALLBACK_BETA);

    const params: Parameters<Anthropic["beta"]["messages"]["stream"]>[0] = {
      model: model.id,
      max_tokens: p.maxTokens ? Math.min(p.maxTokens, model.maxOutput ?? p.maxTokens) : Math.min(64000, model.maxOutput ?? 64000),
      messages,
      cache_control: { type: "ephemeral" },
      ...(req.system ? { system: req.system } : {}),
      ...(tools.length ? { tools } : {}),
      ...(adaptive ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(!adaptive && model.thinkingMode === "budget" && p.thinkingBudget
        ? { thinking: { type: "enabled", budget_tokens: Math.max(1024, p.thinkingBudget) } }
        : {}),
      ...(effort && (model.efforts?.length ? model.efforts.includes(effort) : adaptive) ? { output_config: { effort } } : {}),
      ...(p.stop?.length ? { stop_sequences: p.stop } : {}),
      ...(p.speed === "fast" ? { speed: "fast" as const } : {}),
      // Current Claude models only accept "auto" and "none" here; forcing a tool call is rejected by the API.
      ...(tools.length && (p.toolChoice === "none" || p.parallelToolCalls === false)
        ? {
            tool_choice:
              p.toolChoice === "none"
                ? { type: "none" as const }
                : { type: "auto" as const, disable_parallel_tool_use: true },
          }
        : {}),
      ...(betas.length ? { betas } : {}),
      ...(useFallback ? { fallbacks: "default" as const } : {}),
      // Claude's API no longer takes temperature / top-p / top-k (API version 2026-10-21); effort is the control.
      ...(p.extraBody ?? {}),
    };

    let message: Beta;
    try {
      const stream = client(req.provider, req.apiKey).beta.messages.stream(params, { signal: req.signal });
      stream.on("streamEvent", (_event, snapshot) => {
        req.onUpdate(partsFromContent(snapshot.content, true));
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (req.signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw describe(err);
    }

    const { stop, detail } = mapStop(message);
    return {
      parts: partsFromContent(message.content, false),
      stop,
      stopDetail: detail,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? undefined,
      },
      raw: { kind: "anthropic", content: message.content },
      servedBy: message.model && message.model !== model.id ? message.model : undefined,
    };
  },
};

/** Exposed for tests. */
export const _internal = { toParams };
export type { Message };
