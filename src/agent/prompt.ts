import { platform } from "../platform";
import { computerContext } from "../tools/computer";
import type { Tool } from "../tools/types";
import type { Agent, Conversation, MemoryItem, ModelRef, Project, Settings } from "../types";
import { customizationPrompt } from "./customize";

export interface PromptParts {
  settings: Settings;
  conv: Conversation;
  tools: Tool[];
  agent?: Agent;
  project?: Project;
  memories: MemoryItem[];
  /** full text of small knowledge collections */
  knowledgeText?: string;
  /** retrieved passages, for models that cannot search themselves */
  knowledgePassages?: string;
  knowledgeFiles: string[];
  skillsText: string;
  subagent?: boolean;
  /** the model answering: its own customization applies, else the global one */
  model?: ModelRef;
}

/** Stable across a day so provider-side prompt caches keep hitting. */
export function buildSystemPrompt(p: PromptParts): string {
  const { settings, conv, tools, agent, project } = p;
  const pf = platform();
  const device = pf.os === "ios" ? "an iPhone or iPad" : pf.os === "web" ? "a web browser" : `a ${pf.os} computer`;
  const sections: string[] = [];
  if (p.subagent) {
    sections.push(`You are a sub-agent working on one task for another assistant. Do the task thoroughly with your tools, then reply with only the result the other assistant needs (findings, data, a draft). Today is ${new Date().toISOString().slice(0, 10)}.`);
  } else {
    sections.push(`You are ${agent ? `"${agent.name}", an assistant` : "the assistant"} inside Meridian, a chat app the user runs on ${device}. Today is ${new Date().toISOString().slice(0, 10)}.`);
  }
  const names = new Set(tools.map((t) => t.spec.name));
  const hints: string[] = [];
  if (names.has("create_file")) {
    hints.push("When the user wants a deliverable (spreadsheet, document, PDF, slide deck, web page, data file), make the actual file with the file tools instead of pasting its contents, then say in a sentence what you made.");
  }
  if (names.has("generate_image") || names.has("generate_video")) hints.push("You can create and edit images, and create videos, with the generation tools when the user asks for them.");
  if (names.has("web_search")) hints.push("Use web_search for anything recent or uncertain and cite the pages you relied on.");
  if (names.has("update_plan")) hints.push("For multi-step work, show your plan with update_plan and keep it current.");
  if (names.has("delegate")) hints.push("For big jobs with independent parts, you may hand parts to sub-agents with delegate (several at once run in parallel).");
  if (names.has("browser")) {
    hints.push(
      "You have your own web browser (the browser tool), separate from the user's. Use it for pages that need JavaScript, clicking, forms or a sign-in; plain reading is cheaper with fetch_url. Keep the plan current while you browse (update_plan), one step per page or form.",
    );
  }
  if (names.has("computer")) hints.push("You can see and use the user's screen with the computer tool. Work in small steps and check each new screenshot; prefer the browser tool for web pages.");
  if (tools.some((t) => t.spec.name.startsWith("mcp__"))) hints.push("Tools whose names start with mcp__ come from connectors the user added; they reach the user's own accounts and services.");
  if (hints.length) sections.push(hints.join("\n"));
  if (conv.mode === "research") {
    sections.push(
      "Research mode is on. Treat the request as a research assignment: plan sub-questions with update_plan, run many searches from different angles, read the strongest primary sources, cross-check key facts, and finish with a structured, cited report (summary, findings, open questions, numbered sources). Prefer depth and accuracy over speed.",
    );
  }
  if (tools.some((t) => t.group === "computer")) sections.push(computerContext());
  if (conv.workFolder) sections.push(`The user gave you the folder ${conv.workFolder} to work in. You may read, create and change files inside it with the file tools without asking; ask before deleting anything.`);
  if (p.skillsText) sections.push(p.skillsText);
  sections.push(...customizationPrompt(settings, p.model));
  if (p.memories.length) {
    sections.push(
      `What you remember about the user (from earlier chats). Use it when relevant; do not recite it. ${names.has("remember") ? "Save new lasting facts with remember and remove wrong ones with forget (by id)." : ""}\n` +
        p.memories.map((m) => `- [${m.id}] ${m.text}`).join("\n"),
    );
  } else if (names.has("remember")) {
    sections.push("You have long-term memory. When the user shares a lasting preference or fact about themselves, save it with remember.");
  }
  if (project) {
    sections.push(`This chat belongs to the project "${project.name}".${project.instructions.trim() ? `\nProject instructions:\n${project.instructions.trim()}` : ""}`);
  }
  if (agent?.instructions.trim()) sections.push(`Your role and instructions:\n${agent.instructions.trim()}`);
  if (p.knowledgeFiles.length) {
    if (p.knowledgeText) sections.push(`Reference files provided by the user:\n<knowledge>\n${p.knowledgeText}\n</knowledge>`);
    else if (names.has("search_knowledge")) sections.push(`The user provided reference files (${p.knowledgeFiles.join(", ")}). Search them with search_knowledge when they may help.`);
    if (p.knowledgePassages) sections.push(`Passages from the user's reference files that may be relevant to the latest message:\n${p.knowledgePassages}`);
  }
  if (conv.systemPrompt?.trim()) sections.push(`Instructions for this chat:\n${conv.systemPrompt.trim()}`);
  return sections.filter(Boolean).join("\n\n");
}
