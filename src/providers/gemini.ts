// Google Gemini (Generative Language API): streaming chat, tools, thinking,
// images and PDFs in, images out on the models that draw.
import { httpFetch, readError } from "../platform/http";
import type { ModelInfo, Part } from "../types";
import { uid } from "../types";
import { base64ToBytes } from "../util/bytes";
import { clientToolCalls, resultOf, sseEvents, trimSlash, userItems } from "./common";
import { ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StopKind } from "./types";

type Json = Record<string, unknown>;

const SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "properties", "required", "items",
  "minItems", "maxItems", "minimum", "maximum", "anyOf", "minLength", "maxLength", "pattern",
]);

/** Gemini accepts a subset of JSON Schema; strip what it rejects. */
export function geminiSchema(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      const props: Json = {};
      for (const [pk, pv] of Object.entries(v as Json)) {
        const c = geminiSchema(pv);
        if (c) props[pk] = c;
      }
      out.properties = props;
    } else if (k === "items") {
      out.items = geminiSchema(v) ?? { type: "string" };
    } else if (k === "anyOf" && Array.isArray(v)) {
      out.anyOf = v.map((x) => geminiSchema(x)).filter(Boolean);
    } else if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (v.includes("null")) out.nullable = true;
    } else {
      out[k] = v;
    }
  }
  if (!out.type && out.properties) out.type = "object";
  if (!out.type && !out.anyOf) out.type = "string";
  if (out.type === "object" && (!out.properties || !Object.keys(out.properties as Json).length)) {
    delete out.properties;
    delete out.required;
  }
  if (out.type === "array" && !out.items) out.items = { type: "string" };
  return out;
}

async function toContents(req: ChatRequest): Promise<Json[]> {
  const out: Json[] = [];
  for (const m of req.messages) {
    if (m.role === "user") {
      const parts: Json[] = [];
      for (const item of await userItems(m, req.model.caps, req.blobs)) {
        if (item.kind === "text") parts.push({ text: item.text });
        else if (item.kind === "image") parts.push({ inlineData: { mimeType: item.mime, data: item.b64 } });
        else parts.push({ inlineData: { mimeType: "application/pdf", data: item.b64 } });
      }
      if (parts.length) out.push({ role: "user", parts });
      continue;
    }
    const parts: Json[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && (p.text || p.sig)) parts.push(withSig({ text: p.text }, p.sig));
      else if (p.type === "tool_call" && !p.server) parts.push(withSig({ functionCall: { name: p.name, args: p.input ?? {} } }, p.sig));
      else if (p.type === "artifact" && p.origin === "model" && p.mime.startsWith("image/")) {
        const b64 = await req.blobs.base64(p.blobId);
        if (b64) parts.push(withSig({ inlineData: { mimeType: p.mime, data: b64 } }, p.sig));
      }
    }
    if (!parts.length) continue;
    out.push({ role: "model", parts });
    const calls = clientToolCalls(m);
    if (calls.length) {
      const responses: Json[] = [];
      for (const c of calls) {
        const r = resultOf(c);
        responses.push({ functionResponse: { name: c.name, response: r.isError ? { error: r.text } : { result: r.text || "(no output)" } } });
      }
      if (req.model.caps.vision) {
        for (const c of calls) {
          for (const img of c.result?.images ?? []) {
            const b64 = await req.blobs.base64(img.blobId);
            if (b64) responses.push({ inlineData: { mimeType: img.mime, data: b64 } });
          }
        }
      }
      out.push({ role: "user", parts: responses });
    }
  }
  return out;
}

function withSig(part: Json, sig?: string): Json {
  return sig ? { ...part, thoughtSignature: sig } : part;
}

export function buildGeminiBody(req: ChatRequest, contents: Json[]): Json {
  const p = req.options.params;
  const body: Json = { contents };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const parameters = geminiSchema(t.inputSchema);
          const hasProps = parameters?.properties && Object.keys(parameters.properties as Json).length > 0;
          return { name: t.name, description: t.description, ...(hasProps ? { parameters } : {}) };
        }),
      },
    ];
    if (p.toolChoice) {
      const mode = p.toolChoice === "none" ? "NONE" : p.toolChoice === "required" ? "ANY" : "AUTO";
      body.toolConfig = { functionCallingConfig: { mode } };
    }
  }
  const gen: Json = {};
  if (p.temperature !== undefined) gen.temperature = p.temperature;
  if (p.topP !== undefined) gen.topP = p.topP;
  if (p.topK !== undefined) gen.topK = p.topK;
  if (p.maxTokens !== undefined) gen.maxOutputTokens = p.maxTokens;
  if (p.stop?.length) gen.stopSequences = p.stop;
  if (p.seed !== undefined) gen.seed = p.seed;
  if (p.frequencyPenalty !== undefined) gen.frequencyPenalty = p.frequencyPenalty;
  if (p.presencePenalty !== undefined) gen.presencePenalty = p.presencePenalty;
  if (p.responseFormat === "json") gen.responseMimeType = "application/json";
  if (req.model.caps.thinking) {
    const thinkingConfig: Json = { includeThoughts: true };
    if (p.thinkingBudget !== undefined) thinkingConfig.thinkingBudget = p.thinkingBudget;
    gen.thinkingConfig = thinkingConfig;
  }
  if (req.model.caps.imageOutput) gen.responseModalities = ["TEXT", "IMAGE"];
  if (Object.keys(gen).length) body.generationConfig = gen;
  return { ...body, ...(p.extraBody ?? {}) };
}

const NOT_CHAT = /embed|aqa|tts|audio|live|robotics|computer-use/i;

export const geminiAdapter: ProviderAdapter = {
  async listModels(provider, apiKey) {
    const out: ModelInfo[] = [];
    let pageToken = "";
    do {
      const url = `${trimSlash(provider.baseUrl)}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const res = await httpFetch(url, { headers: { "x-goog-api-key": apiKey } });
      if (!res.ok) throw new ProviderError(await readError(res), res.status);
      const json = (await res.json()) as { models?: Json[]; nextPageToken?: string };
      for (const m of json.models ?? []) {
        const id = String(m.name ?? "").replace(/^models\//, "");
        const methods = (m.supportedGenerationMethods as string[] | undefined) ?? [];
        if (!id || NOT_CHAT.test(id)) continue;
        let kind: ModelInfo["kind"] | null = null;
        if (/veo/.test(id) || methods.includes("predictLongRunning")) kind = "video";
        else if (/imagen/.test(id)) kind = "image";
        else if (methods.includes("generateContent")) kind = "chat";
        if (!kind) continue;
        const draws = kind === "chat" && /image/.test(id);
        out.push({
          id,
          name: typeof m.displayName === "string" && m.displayName ? m.displayName : id,
          kind,
          caps: {
            vision: kind === "chat",
            pdf: kind === "chat" && !draws,
            tools: kind === "chat" && !draws && !/gemma/.test(id),
            thinking: m.thinking === true || (kind === "chat" && !draws && /gemini-(2\.5|[3-9])/.test(id)),
            imageOutput: draws,
          },
          maxOutput: typeof m.outputTokenLimit === "number" ? m.outputTokenLimit : undefined,
          contextWindow: typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
        });
      }
      pageToken = json.nextPageToken ?? "";
    } while (pageToken);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = buildGeminiBody(req, await toContents(req));
    const url = `${trimSlash(req.provider.baseUrl)}/models/${encodeURIComponent(req.model.id)}:streamGenerateContent?alt=sse`;
    const res = await httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": req.apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new ProviderError(await readError(res), res.status);

    const parts: Part[] = [];
    let finish = "";
    let blockReason = "";
    let usage: ChatResult["usage"];
    let images = 0;

    for await (const ev of sseEvents(res, req.signal)) {
      let chunk: Json;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(((chunk.error as Json).message as string) ?? JSON.stringify(chunk.error));
      const u = chunk.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined;
      if (u) usage = { input: u.promptTokenCount, output: u.candidatesTokenCount, cacheRead: u.cachedContentTokenCount };
      const fb = chunk.promptFeedback as { blockReason?: string } | undefined;
      if (fb?.blockReason) blockReason = fb.blockReason;
      const cand = (chunk.candidates as Json[] | undefined)?.[0];
      if (!cand) continue;
      if (typeof cand.finishReason === "string") finish = cand.finishReason;
      for (const gp of ((cand.content as Json | undefined)?.parts as Json[] | undefined) ?? []) {
        const sig = typeof gp.thoughtSignature === "string" ? gp.thoughtSignature : undefined;
        const last = parts[parts.length - 1];
        if (typeof gp.text === "string") {
          if (gp.thought === true) {
            if (last?.type === "thinking") last.text += gp.text;
            else if (gp.text) parts.push({ type: "thinking", text: gp.text });
          } else if (last?.type === "text" && !last.sig) {
            last.text += gp.text;
            if (sig) last.sig = sig;
          } else if (gp.text || sig) {
            parts.push({ type: "text", text: gp.text, sig });
          }
        } else if (gp.functionCall) {
          const fc = gp.functionCall as { name: string; args?: unknown; id?: string };
          parts.push({ type: "tool_call", id: fc.id || uid("call_"), name: fc.name, input: fc.args ?? {}, status: "pending", sig });
        } else if (gp.inlineData) {
          const d = gp.inlineData as { mimeType: string; data: string };
          const ext = d.mimeType.split("/")[1] ?? "png";
          const ref = await req.blobs.put(base64ToBytes(d.data), d.mimeType, `image-${++images}.${ext}`);
          parts.push({ type: "artifact", origin: "model", ...ref, sig });
        }
      }
      req.onUpdate(parts.map((p) => ({ ...p })));
    }

    const hasCalls = parts.some((p) => p.type === "tool_call");
    let stop: StopKind = hasCalls ? "tool_use" : "end";
    let stopDetail: string | undefined;
    if (finish === "MAX_TOKENS") {
      stop = "max_tokens";
      stopDetail = "The reply hit the output limit and was cut off.";
    } else if (blockReason || /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/.test(finish)) {
      stop = "refusal";
      stopDetail = `Gemini stopped this reply (${blockReason || finish}).`;
    } else if (finish === "MALFORMED_FUNCTION_CALL") {
      stopDetail = "The model produced a malformed tool call. Try again.";
    }
    return { parts, stop, stopDetail, usage };
  },
};
