// OpenAI and everything that speaks the OpenAI Chat Completions dialect:
// OpenRouter, Ollama, LM Studio, Groq, Mistral, xAI, DeepSeek, Together, vLLM...
import { isTauri } from "../platform";
import { httpFetch, readError } from "../platform/http";
import type { ModelInfo, Part, ProviderConfig } from "../types";
import { uid } from "../types";
import { base64ToBytes } from "../util/bytes";
import { clientToolCalls, resultOf, sseEvents, trimSlash, userItems } from "./common";
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StopKind } from "./types";

type Json = Record<string, unknown>;

function headers(provider: ProviderConfig, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (/openrouter\.ai/.test(provider.baseUrl)) h["X-Title"] = "Meridian";
  Object.assign(h, provider.headers ?? {});
  // Local servers (Ollama, LM Studio) refuse browser origins they do not know.
  // In the app, an empty Origin makes the native HTTP client send no Origin at all.
  if (isTauri && provider.kind === "openai-compatible") h.Origin = "";
  return h;
}

const NOT_CHAT = /embed|whisper|tts|audio|realtime|moderation|transcri|rerank|davinci-00|babbage|guard|speech|computer-use/i;

const VIDEO_ID = /sora|video|veo|kling|wan-?2|hailuo|seedance|luma-ray|runway|pika|ltx-?video|mochi/;
const IMAGE_ID = /dall-e|gpt-image|chatgpt-image|image-gen|imagen|flux|stable-diffusion|sdxl|sd3|recraft|ideogram|seedream|hidream|qwen-image|playground-v|kandinsky|imagine-image|grok-[\d.]+-image|(^|[-_/])image([-_.]|$)/;

/** chat / image / video from a model id alone */
export function classifyMediaId(lower: string): ModelInfo["kind"] {
  if (VIDEO_ID.test(lower)) return "video";
  if (IMAGE_ID.test(lower)) return "image";
  return "chat";
}

export function guessOpenAIModel(provider: ProviderConfig, raw: Json): ModelInfo | null {
  const id = String(raw.id ?? "");
  if (!id || NOT_CHAT.test(id)) return null;
  const official = provider.kind === "openai" || provider.kind === "xai";
  const arch = raw.architecture as { input_modalities?: string[]; output_modalities?: string[] } | undefined;
  const supported = raw.supported_parameters as string[] | undefined;
  const lower = id.toLowerCase();

  let kind: ModelInfo["kind"] = classifyMediaId(lower);
  if (arch?.output_modalities && !arch.output_modalities.includes("text")) {
    kind = arch.output_modalities.includes("video") ? "video" : arch.output_modalities.includes("image") ? "image" : kind;
  }

  const vision = arch?.input_modalities
    ? arch.input_modalities.includes("image")
    : kind === "image"
    ? /gpt-image|imagine-image|grok-[\d.]+-image|kontext|edit|seedream|qwen-image/.test(lower)
    : kind === "video"
    ? /sora|veo|imagine-video|kling|wan|seedance|hailuo/.test(lower)
    : /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|gpt-6|^o[1-9]|chatgpt|vision|llava|gemma-?3|qwen.*vl|pixtral|claude|gemini|grok-[3-9]|grok.*vision|llama-?[34]\.\d.*vision|llama-4|minicpm|moondream|phi-?[34].*vision|mistral-(small|medium|large)-(3|2[5-9])/.test(lower);
  const thinking = supported
    ? supported.includes("reasoning") || supported.includes("include_reasoning")
    : /^o[1-9]|gpt-5|gpt-6|reason|think|deepseek-r|qwq|magistral|grok-[4-9]/.test(lower);
  const tools = kind !== "chat" ? false : supported ? supported.includes("tools") : !/instruct|base$|completion/.test(lower);

  return {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    kind,
    caps: {
      vision,
      pdf: kind !== "chat" ? false : arch?.input_modalities ? arch.input_modalities.includes("file") : provider.kind === "openai" && vision,
      tools,
      thinking,
      imageOutput: !!arch?.output_modalities?.includes("image") && kind === "chat",
    },
    contextWindow: typeof raw.context_length === "number" ? raw.context_length : undefined,
  };
}

async function toMessages(req: ChatRequest): Promise<Json[]> {
  const out: Json[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "user") {
      const content: Json[] = [];
      for (const item of await userItems(m, req.model.caps, req.blobs)) {
        if (item.kind === "text") content.push({ type: "text", text: item.text });
        else if (item.kind === "image") content.push({ type: "image_url", image_url: { url: `data:${item.mime};base64,${item.b64}` } });
        else content.push({ type: "file", file: { filename: item.name, file_data: `data:application/pdf;base64,${item.b64}` } });
      }
      if (!content.length) continue;
      const onlyText = content.every((c) => c.type === "text");
      out.push({ role: "user", content: onlyText ? content.map((c) => c.text).join("\n\n") : content });
      continue;
    }
    const text = m.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
    const calls = clientToolCalls(m);
    if (!text.trim() && !calls.length) continue;
    const msg: Json = { role: "assistant", content: text || null };
    if (calls.length) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      }));
    }
    out.push(msg);
    const followUp: Json[] = [];
    for (const c of calls) {
      const r = resultOf(c);
      out.push({ role: "tool", tool_call_id: c.id, content: (r.isError ? "Error: " : "") + (r.text || "(no output)") });
      // tool messages are text only here, so pictures a tool produced go in a user turn right after
      if (req.model.caps.vision) {
        for (const img of r.images ?? []) {
          const b64 = await req.blobs.base64(img.blobId);
          if (b64) followUp.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${b64}` } });
        }
      }
    }
    if (followUp.length) out.push({ role: "user", content: [{ type: "text", text: "Image output of the tool call(s) above:" }, ...followUp] });
  }
  return out;
}

export function buildOpenAIBody(req: ChatRequest, messages: Json[]): Json {
  const p = req.options.params;
  const official = req.provider.kind === "openai";
  const xai = req.provider.kind === "xai";
  const body: Json = { model: req.model.id, messages, stream: true };
  if (official || xai || /openrouter\.ai/.test(req.provider.baseUrl)) body.stream_options = { include_usage: true };
  // gateways (OpenRouter) only return pictures from image-output models when asked to
  if (req.model.caps.imageOutput) body.modalities = ["image", "text"];
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (p.toolChoice) body.tool_choice = p.toolChoice;
    if (p.parallelToolCalls !== undefined) body.parallel_tool_calls = p.parallelToolCalls;
  }
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty;
  if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.stop?.length) body.stop = p.stop;
  if (p.logitBias && Object.keys(p.logitBias).length) body.logit_bias = p.logitBias;
  if (p.responseFormat === "json") body.response_format = { type: "json_object" };
  if (p.maxTokens !== undefined) body[official ? "max_completion_tokens" : "max_tokens"] = p.maxTokens;
  // xAI only accepts reasoning_effort on its mini reasoning models
  if (p.effort && p.effort !== "auto" && req.model.caps.thinking && (!xai || /mini/.test(req.model.id))) {
    // this dialect knows low / medium / high
    body.reasoning_effort = p.effort === "xhigh" || p.effort === "max" ? "high" : p.effort;
  }
  if (official || xai) {
    if (official && p.verbosity) body.verbosity = p.verbosity;
    if (official && p.serviceTier) body.service_tier = p.serviceTier;
  } else {
    if (p.topK !== undefined) body.top_k = p.topK;
    if (p.minP !== undefined) body.min_p = p.minP;
    if (p.repetitionPenalty !== undefined) body.repetition_penalty = p.repetitionPenalty;
  }
  return { ...body, ...(p.extraBody ?? {}) };
}

export const openaiAdapter: ProviderAdapter = {
  async listModels(provider, apiKey) {
    const res = await httpFetch(`${trimSlash(provider.baseUrl)}/models`, { headers: headers(provider, apiKey) });
    if (!res.ok) throw new ProviderError(await readError(res), res.status);
    const json = (await res.json()) as { data?: Json[]; models?: Json[] };
    const list = json.data ?? json.models ?? [];
    return list
      .map((m) => guessOpenAIModel(provider, m))
      .filter((m): m is ModelInfo => !!m)
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = buildOpenAIBody(req, await toMessages(req));
    const res = await httpFetch(`${trimSlash(req.provider.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: headers(req.provider, req.apiKey),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new ProviderError(await readError(res), res.status);

    let text = "";
    let thinking = "";
    const calls: { id: string; name: string; args: string }[] = [];
    let finish = "";
    let usage: ChatResult["usage"];
    const images: Part[] = [];

    const snapshot = (final: boolean): Part[] => {
      const parts: Part[] = [];
      if (thinking) parts.push({ type: "thinking", text: thinking });
      if (text) parts.push({ type: "text", text });
      parts.push(...images);
      for (const c of calls) {
        if (!c.name) continue;
        parts.push({ type: "tool_call", id: c.id, name: c.name, input: parseArgs(c.args, final), status: "pending" });
      }
      return parts;
    };

    for await (const ev of sseEvents(res, req.signal)) {
      if (ev.data === "[DONE]") break;
      let chunk: Json;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) {
        const e = chunk.error as { message?: string };
        throw new ProviderError(e.message ?? JSON.stringify(chunk.error));
      }
      const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
      if (u) usage = { input: u.prompt_tokens, output: u.completion_tokens, cacheRead: u.prompt_tokens_details?.cached_tokens };
      const choice = (chunk.choices as Json[] | undefined)?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Json;
      if (typeof delta.content === "string") text += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string") thinking += r;
      for (const tc of (delta.tool_calls as Json[] | undefined) ?? []) {
        const index = typeof tc.index === "number" ? tc.index : calls.length;
        const fn = (tc.function ?? {}) as { name?: string; arguments?: string };
        calls[index] ??= { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id) calls[index].id = tc.id;
        if (fn.name) calls[index].name += fn.name;
        if (fn.arguments) calls[index].args += fn.arguments;
      }
      // some gateways return generated images on the message delta
      for (const img of (delta.images as { image_url?: { url?: string } }[] | undefined) ?? []) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img.image_url?.url ?? "");
        if (m) {
          const ref = await req.blobs.put(base64ToBytes(m[2]), m[1], `image-${images.length + 1}.${m[1].split("/")[1] ?? "png"}`);
          images.push({ type: "artifact", origin: "model", ...ref });
        }
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
      req.onUpdate(snapshot(false));
    }

    for (const c of calls) if (c && !c.id) c.id = uid("call_");
    const parts = snapshot(true);
    const hasCalls = parts.some((p) => p.type === "tool_call");
    let stop: StopKind = hasCalls ? "tool_use" : "end";
    let stopDetail: string | undefined;
    if (finish === "length") {
      stop = "max_tokens";
      stopDetail = "The reply hit the output limit and was cut off.";
    } else if (finish === "content_filter") {
      stop = "refusal";
      stopDetail = "The provider's content filter stopped this reply.";
    }
    return { parts, stop, stopDetail, usage };
  },
};

function parseArgs(args: string, final: boolean): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    // while streaming this is expected; at the end it means the model wrote broken JSON
    return final ? { __invalid_json: args } : { __partial: args };
  }
}
