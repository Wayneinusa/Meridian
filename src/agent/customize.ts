// Customization (like "Customize Grok"): a response style, what the model
// should know about the user, and standing instructions.
//
// Global settings apply to every model. A model can override any of the three;
// whatever it leaves unset falls back to the global value. Instructions can
// replace the global ones or be added after them.
import type { Customization, ModelCustomization, ModelRef, Settings, StyleId } from "../types";
import { modelKey } from "../types";

export const STYLES: { id: StyleId; name: string; prompt: string }[] = [
  { id: "default", name: "Default", prompt: "" },
  { id: "concise", name: "Concise", prompt: "Be concise: give the answer first, in as few words as it takes; skip preambles, recaps and filler." },
  { id: "explanatory", name: "Explanatory", prompt: "Explain thoroughly: build up from the basics, give the reasoning behind each point, and use examples." },
  { id: "formal", name: "Formal", prompt: "Write in a formal, professional register: precise wording, no slang, no emoji." },
  { id: "friendly", name: "Friendly", prompt: "Be warm, relaxed and conversational, as a knowledgeable friend would be." },
  { id: "socratic", name: "Socratic", prompt: "Teach Socratically: guide the user with questions and hints so they reach the answer themselves, unless they ask for it directly." },
  { id: "custom", name: "Custom", prompt: "" },
];

export const styleName = (id: StyleId | undefined) => STYLES.find((s) => s.id === (id ?? "default"))?.name ?? "Default";

/** The global customization (standing instructions live in settings.systemPrompt, as before). */
export function globalCustomization(settings: Settings): Customization {
  return { ...(settings.customization ?? {}), instructions: settings.systemPrompt };
}

export function modelCustomization(settings: Settings, ref: ModelRef | undefined): ModelCustomization | undefined {
  const c = ref ? settings.modelCustom?.[modelKey(ref)] : undefined;
  return c && hasOverride(c) ? c : undefined;
}

/** true when the entry overrides at least one thing */
export function hasOverride(c: ModelCustomization | undefined): boolean {
  if (!c) return false;
  return c.style !== undefined || c.about !== undefined || c.instructions !== undefined;
}

export type Source = "global" | "model" | "both";

export interface Resolved {
  style: { id: StyleId; text: string; from: Source };
  about: { text: string; from: Source };
  instructions: { text: string; from: Source };
}

function styleText(c: Customization): string {
  if (c.style === "custom") return (c.styleText ?? "").trim();
  return STYLES.find((s) => s.id === (c.style ?? "default"))?.prompt ?? "";
}

/** What a model actually gets: its own settings where it has them, the global ones elsewhere. */
export function resolveCustomization(settings: Settings, ref: ModelRef | undefined): Resolved {
  const g = globalCustomization(settings);
  const m = modelCustomization(settings, ref);
  const style = m?.style !== undefined ? { id: m.style, text: styleText(m), from: "model" as const } : { id: g.style ?? "default", text: styleText(g), from: "global" as const };
  const about = m?.about !== undefined ? { text: m.about.trim(), from: "model" as const } : { text: (g.about ?? "").trim(), from: "global" as const };
  const own = m?.instructions?.trim() ?? "";
  const shared = (g.instructions ?? "").trim();
  let instructions: Resolved["instructions"];
  if (m?.instructions === undefined) instructions = { text: shared, from: "global" };
  else if (m.instructionsMode === "add") instructions = { text: [shared, own].filter(Boolean).join("\n\n"), from: "both" };
  else instructions = { text: own, from: "model" };
  return { style, about, instructions };
}

/** The system prompt sections for a model's customization. */
export function customizationPrompt(settings: Settings, ref: ModelRef | undefined): string[] {
  const r = resolveCustomization(settings, ref);
  const out: string[] = [];
  if (r.about.text) out.push(`About the user:\n${r.about.text}`);
  if (r.instructions.text) out.push(`The user's standing instructions:\n${r.instructions.text}`);
  if (r.style.text) out.push(`Response style: ${r.style.text}`);
  return out;
}

/** Remove fields set to undefined; drop the entry when nothing is left. */
export function cleanOverride(c: ModelCustomization): ModelCustomization | undefined {
  const out: ModelCustomization = {};
  if (c.style !== undefined) out.style = c.style;
  if (c.style === "custom" && c.styleText !== undefined) out.styleText = c.styleText;
  if (c.about !== undefined) out.about = c.about;
  if (c.instructions !== undefined) {
    out.instructions = c.instructions;
    out.instructionsMode = c.instructionsMode ?? "replace";
  }
  return hasOverride(out) ? out : undefined;
}
