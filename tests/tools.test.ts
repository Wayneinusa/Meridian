import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildGeminiBody, geminiSchema } from "../src/providers/gemini";
import { buildOpenAIBody, guessOpenAIModel } from "../src/providers/openai";
import { clean, paramUnsupportedReason, resolveParams, supportedParams } from "../src/providers/params";
import type { ChatRequest } from "../src/providers/types";
import { extractText } from "../src/tools/extract";
import { buildDocx, buildPdf, buildPptx, buildXlsx } from "../src/tools/files";
import { parseMarkdown } from "../src/tools/markdown";
import { validateInput } from "../src/tools/validate";
import { htmlToText } from "../src/tools/web";
import type { ModelInfo, ProviderConfig, Settings } from "../src/types";
import { utf8 } from "../src/util/bytes";

const MD = `# Report\n\nSome **bold** and *italic* text with a [link](https://example.com) and \`code\`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n---\n`;

describe("document builders", () => {
  it("parses markdown into blocks", () => {
    const b = parseMarkdown(MD);
    expect(b.map((x) => x.t)).toEqual(["heading", "para", "list", "list", "table", "quote", "code", "rule"]);
    const list = b[2] as Extract<(typeof b)[number], { t: "list" }>;
    expect(list.items[1].children[0].t).toBe("list");
  });

  it("writes a real xlsx with formulas that reads back", async () => {
    const bytes = await buildXlsx([{ name: "Budget", rows: [["Item", "Cost"], ["A", 10], ["B", 5.5], ["Total", "=SUM(B2:B3)"]] }]);
    expect(utf8.decode(bytes.slice(0, 2))).toBe("PK");
    const sheet = utf8.decode(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain("<f>SUM(B2:B3)</f>");
    const back = await extractText(bytes, "budget.xlsx", "");
    expect(back.text).toContain('[sheet "Budget"]');
    expect(back.text).toContain("A,10");
    expect(back.text).toContain("=SUM(B2:B3)");
  });

  it("writes a PDF", async () => {
    const bytes = await buildPdf(MD, { title: "Report" });
    expect(utf8.decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(3000);
  });

  it("writes a docx containing the text", async () => {
    const bytes = await buildDocx(MD);
    const xml = utf8.decode(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain("Report");
    expect(xml).toContain("quoted");
    expect(xml).toContain("<w:tbl>");
  });

  it("writes a pptx that reads back", async () => {
    const bytes = await buildPptx(
      [{ title: "Kickoff", subtitle: "Q1" }, { title: "Agenda", bullets: ["Intro", "Plan"], notes: "say hi" }, { title: "Data", table: [["a", "b"], [1, 2]] }],
      { title: "Kickoff" },
    );
    const files = unzipSync(bytes);
    expect(Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(3);
    const back = await extractText(bytes, "deck.pptx", "");
    expect(back.text).toContain("Agenda");
    expect(back.text).toContain("Plan");
  });
});

describe("helpers", () => {
  it("validates tool input", () => {
    const schema = { type: "object", properties: { filename: { type: "string" }, n: { type: "integer" }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } } }, required: ["filename"] };
    expect(validateInput(schema, { filename: "a", n: 2, rows: [["x", 1, null]] })).toBeNull();
    expect(validateInput(schema, { n: 2 })).toMatch(/filename is required/);
    expect(validateInput(schema, { filename: "a", n: "2" })).toMatch(/n should be integer/);
    expect(validateInput(schema, { filename: "a", rows: [[{}]] })).toMatch(/rows\[0\]\[0\]/);
    expect(validateInput(schema, { __invalid_json: "{" })).toMatch(/not valid JSON/);
  });

  it("turns html into text", () => {
    const t = htmlToText('<html><head><style>x{}</style></head><body><h1>Hi</h1><script>bad()</script><p>A &amp; B <a href="https://x.y/z">link</a></p></body></html>');
    expect(t).toBe("Hi\nA & B link (https://x.y/z)");
  });

  it("reduces schemas for Gemini", () => {
    expect(geminiSchema({ $schema: "x", type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"], default: "q" }, b: { type: "array" } }, required: ["a"] })).toEqual({
      type: "object",
      properties: { a: { type: "string", nullable: true }, b: { type: "array", items: { type: "string" } } },
      required: ["a"],
    });
  });
});

describe("model parameters", () => {
  const model: ModelInfo = { id: "m", name: "m", kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: true } };
  const req = (kind: ProviderConfig["kind"], params: ChatRequest["options"]["params"]): ChatRequest =>
    ({
      provider: { id: "p", kind, name: "p", baseUrl: "https://x", enabled: true, models: [] },
      apiKey: "k",
      model,
      system: "sys",
      messages: [],
      tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } } }],
      options: { params, webSearch: false, refusalFallback: false },
    }) as unknown as ChatRequest;
  const all = { temperature: 0.3, topP: 0.9, topK: 40, minP: 0.05, frequencyPenalty: 0.5, presencePenalty: -0.5, repetitionPenalty: 1.1, seed: 7, maxTokens: 500, stop: ["END"], effort: "max" as const, verbosity: "low" as const, responseFormat: "json" as const, toolChoice: "required" as const, parallelToolCalls: false, logitBias: { "5": -100 }, serviceTier: "flex", extraBody: { custom_flag: true } };

  it("maps every parameter for OpenAI", () => {
    const b = buildOpenAIBody(req("openai", all), []);
    expect(b).toMatchObject({ temperature: 0.3, top_p: 0.9, frequency_penalty: 0.5, presence_penalty: -0.5, seed: 7, max_completion_tokens: 500, stop: ["END"], reasoning_effort: "high", verbosity: "low", response_format: { type: "json_object" }, tool_choice: "required", parallel_tool_calls: false, logit_bias: { "5": -100 }, service_tier: "flex", custom_flag: true });
    expect(b).not.toHaveProperty("top_k");
    expect(b).not.toHaveProperty("max_tokens");
  });

  it("maps local-model parameters for compatible servers", () => {
    const b = buildOpenAIBody(req("openai-compatible", all), []);
    expect(b).toMatchObject({ top_k: 40, min_p: 0.05, repetition_penalty: 1.1, max_tokens: 500 });
    expect(b).not.toHaveProperty("verbosity");
    expect(b).not.toHaveProperty("stream_options");
  });

  it("maps parameters for Gemini", () => {
    const b = buildGeminiBody(req("gemini", { ...all, thinkingBudget: 2048 }), []);
    expect(b.generationConfig).toMatchObject({ temperature: 0.3, topP: 0.9, topK: 40, maxOutputTokens: 500, stopSequences: ["END"], seed: 7, frequencyPenalty: 0.5, presencePenalty: -0.5, responseMimeType: "application/json", thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } });
    expect(b.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(b).toMatchObject({ custom_flag: true });
  });

  it("sends nothing for unset parameters", () => {
    const b = buildOpenAIBody(req("openai", {}), []);
    expect(Object.keys(b).sort()).toEqual(["messages", "model", "stream", "stream_options", "tools"]);
    expect(buildGeminiBody(req("gemini", {}), []).generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } });
  });

  it("layers scopes and reports unsupported parameters", () => {
    const settings = { params: { temperature: 1, topP: 0.5 }, modelParams: { "p::m": { temperature: 0.2 } } } as unknown as Settings;
    expect(resolveParams(settings, { providerId: "p", modelId: "m" }, { params: { topP: 0.1, effort: "auto" } })).toEqual({ temperature: 0.2, topP: 0.1 });
    expect(clean({ temperature: undefined, stop: [], extraBody: {} })).toEqual({});
    expect(paramUnsupportedReason("temperature", "anthropic")).toMatch(/no longer accepts/);
    expect(paramUnsupportedReason("temperature", "openai")).toBeNull();
    expect(supportedParams(all, "anthropic")).toEqual({ maxTokens: 500, stop: ["END"], effort: "max", toolChoice: "required", parallelToolCalls: false, extraBody: { custom_flag: true } });
  });

  it("classifies models from provider listings", () => {
    const openai = { id: "openai", kind: "openai", name: "", baseUrl: "", enabled: true, models: [] } as ProviderConfig;
    expect(guessOpenAIModel(openai, { id: "text-embedding-3-large" })).toBeNull();
    expect(guessOpenAIModel(openai, { id: "gpt-image-1" })?.kind).toBe("image");
    expect(guessOpenAIModel(openai, { id: "sora-2" })?.kind).toBe("video");
    expect(guessOpenAIModel(openai, { id: "gpt-4o" })?.caps).toMatchObject({ vision: true, pdf: true, tools: true });
    const or = guessOpenAIModel({ ...openai, kind: "openai-compatible" }, { id: "x/y", name: "Y", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] });
    expect(or).toMatchObject({ name: "Y", caps: { vision: false, tools: true, thinking: true } });
  });
});
