import { platform } from "../platform";
import { computerContext } from "../tools/computer";
import type { Tool } from "../tools/types";
import type { Conversation, Settings } from "../types";

/** Stable across a day so provider-side prompt caches keep hitting. */
export function buildSystemPrompt(settings: Settings, conv: Conversation, tools: Tool[]): string {
  const p = platform();
  const device = p.os === "ios" ? "an iPhone or iPad" : p.os === "web" ? "a web browser" : `a ${p.os} computer`;
  const sections: string[] = [
    `You are the assistant inside Meridian, a chat app the user runs on ${device}. Today is ${new Date().toISOString().slice(0, 10)}.`,
  ];
  const names = new Set(tools.map((t) => t.spec.name));
  const hints: string[] = [];
  if (names.has("create_file")) {
    hints.push(
      "When the user wants a deliverable (a spreadsheet, document, PDF, slide deck, web page, data file), make the actual file with the file tools instead of pasting its contents into the chat, then tell them in a sentence what you made.",
    );
  }
  if (names.has("generate_image") || names.has("generate_video")) {
    hints.push("You can produce images or video through the generation tools when the user asks for them.");
  }
  if (tools.some((t) => t.group === "connectors")) {
    hints.push("Tools whose names start with mcp__ come from connectors the user added; they reach the user's own accounts and services.");
  }
  if (hints.length) sections.push(hints.join("\n"));
  if (tools.some((t) => t.group === "computer")) sections.push(computerContext());
  if (settings.systemPrompt.trim()) sections.push(`The user's standing instructions:\n${settings.systemPrompt.trim()}`);
  if (conv.systemPrompt?.trim()) sections.push(`Instructions for this chat:\n${conv.systemPrompt.trim()}`);
  return sections.filter(Boolean).join("\n\n");
}
