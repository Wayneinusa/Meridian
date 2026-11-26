import { describe, expect, it } from "vitest";
import { cleanOverride, customizationPrompt, resolveCustomization } from "../src/agent/customize";
import { buildSystemPrompt } from "../src/agent/prompt";
import { defaultSettings } from "../src/state/defaults";
import type { Conversation, Settings } from "../src/types";

const grok = { providerId: "xai", modelId: "grok-4" };
const claude = { providerId: "anthropic", modelId: "claude-opus-5-5" };
const base = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  systemPrompt: "Use metric units.",
  customization: { style: "concise", about: "I live in Berlin." },
  ...over,
});

describe("per-model customization", () => {
  it("models without their own settings use Global", () => {
    const r = resolveCustomization(base(), claude);
    expect(r).toEqual({
      style: { id: "concise", text: expect.stringMatching(/concise/i), from: "global" },
      about: { text: "I live in Berlin.", from: "global" },
      instructions: { text: "Use metric units.", from: "global" },
    });
  });

  it("a model overrides only what it sets; the rest falls back to Global", () => {
    const s = base({ modelCustom: { "xai::grok-4": { style: "friendly" } } });
    const r = resolveCustomization(s, grok);
    expect(r.style).toMatchObject({ id: "friendly", from: "model" });
    expect(r.about).toEqual({ text: "I live in Berlin.", from: "global" });
    expect(r.instructions).toEqual({ text: "Use metric units.", from: "global" });
    // other models are not affected
    expect(resolveCustomization(s, claude).style.id).toBe("concise");
  });

  it("instructions replace the global ones, or are added after them", () => {
    const replace = resolveCustomization(base({ modelCustom: { "xai::grok-4": { instructions: "Be witty.", instructionsMode: "replace" } } }), grok);
    expect(replace.instructions).toEqual({ text: "Be witty.", from: "model" });
    const add = resolveCustomization(base({ modelCustom: { "xai::grok-4": { instructions: "Be witty.", instructionsMode: "add" } } }), grok);
    expect(add.instructions).toEqual({ text: "Use metric units.\n\nBe witty.", from: "both" });
    // an empty own text with replace means "no instructions" for this model (on purpose)
    expect(resolveCustomization(base({ modelCustom: { "xai::grok-4": { instructions: "", instructionsMode: "replace" } } }), grok).instructions.text).toBe("");
  });

  it("a custom style uses the user's words", () => {
    const r = resolveCustomization(base({ modelCustom: { "xai::grok-4": { style: "custom", styleText: "Talk like a pirate." } } }), grok);
    expect(r.style).toEqual({ id: "custom", text: "Talk like a pirate.", from: "model" });
  });

  it("the system prompt carries the resolved customization", () => {
    const s = base({ modelCustom: { "xai::grok-4": { about: "I am a sailor.", instructions: "Answer in French.", instructionsMode: "replace" } } });
    const conv = { id: "c", title: "", createdAt: 1, updatedAt: 1, messages: [] } as unknown as Conversation;
    const forGrok = buildSystemPrompt({ settings: s, conv, tools: [], memories: [], knowledgeFiles: [], skillsText: "", model: grok });
    expect(forGrok).toContain("About the user:\nI am a sailor.");
    expect(forGrok).toContain("standing instructions:\nAnswer in French.");
    expect(forGrok).not.toContain("metric");
    const forClaude = buildSystemPrompt({ settings: s, conv, tools: [], memories: [], knowledgeFiles: [], skillsText: "", model: claude });
    expect(forClaude).toContain("Use metric units.");
    expect(forClaude).toContain("I live in Berlin.");
    expect(forClaude).toMatch(/Response style: Be concise/);
  });

  it("older settings (instructions only) keep working", () => {
    const s = { ...defaultSettings(), systemPrompt: "Be brief." };
    expect(customizationPrompt(s, claude)).toEqual(["The user's standing instructions:\nBe brief."]);
  });

  it("clearing every field removes the override (Use Global)", () => {
    expect(cleanOverride({ style: undefined, about: undefined, instructions: undefined })).toBeUndefined();
    expect(cleanOverride({ instructions: "x" })).toEqual({ instructions: "x", instructionsMode: "replace" });
  });
});
