// Tools about the conversation itself: knowledge search, memory, a visible
// plan, asking the user a question, and sub-agents.
import { formatHits, indexFor, loadKnowledge } from "../knowledge";
import type { KnowledgeFile, PlanItem } from "../types";
import type { Tool, ToolContext } from "./types";

export function knowledgeTool(files: KnowledgeFile[]): Tool {
  return {
    group: "files",
    title: "Search knowledge",
    spec: {
      name: "search_knowledge",
      description:
        `Search the reference files the user attached to this project or agent (${files.map((f) => f.name).join(", ").slice(0, 600)}). ` +
        "Returns the most relevant passages. Search before answering questions these files could answer, and quote or cite the file name.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for (keywords work best)" }, max_results: { type: "integer" } }, required: ["query"] },
    },
    needsApproval: () => false,
    summarize: (i) => `Search knowledge: ${String(i.query)}`,
    async run(input, ctx) {
      const k = await loadKnowledge(files, ctx.loadText);
      const hits = indexFor(k).search(String(input.query), Math.min(Math.max(Number(input.max_results) || 6, 1), 15));
      return { text: formatHits(hits) };
    },
  };
}

export const rememberTool: Tool = {
  group: "files",
  title: "Remember",
  spec: {
    name: "remember",
    description:
      "Save a durable fact about the user to long-term memory so future chats can use it (preferences, background, ongoing projects, how they like answers). " +
      "Only save things the user would expect you to remember; never secrets, passwords or one-off details. Keep each memory to one short sentence.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  needsApproval: () => false,
  summarize: (i) => `Remember: ${String(i.text)}`,
  async run(input, ctx) {
    const text = String(input.text).trim().slice(0, 500);
    if (!text) return { isError: true, text: "Nothing to remember." };
    const item = await ctx.library.put("memories", { text, source: ctx.conversationId, projectId: ctx.conversation().projectId });
    return { text: `Saved to memory (id ${item.id}).` };
  },
};

export const forgetTool: Tool = {
  group: "files",
  title: "Forget",
  spec: {
    name: "forget",
    description: "Delete a memory that is wrong or that the user asked you to forget. Use the id shown in the memory list.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  needsApproval: () => false,
  summarize: (i) => `Forget memory ${String(i.id)}`,
  async run(input, ctx) {
    const id = String(input.id);
    if (!ctx.library.get("memories", id)) return { isError: true, text: `No memory with id ${id}.` };
    await ctx.library.remove("memories", id);
    return { text: "Deleted." };
  },
};

export const planTool: Tool = {
  group: "files",
  title: "Update plan",
  spec: {
    name: "update_plan",
    description:
      "Show the user your working plan for a multi-step task as a checklist, and keep it current: call it at the start with all steps, then again as steps start and finish. " +
      "Use it for tasks with three or more steps; skip it for simple questions.",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "done"] } }, required: ["text", "status"] },
        },
      },
      required: ["steps"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Plan: ${(i.steps as PlanItem[]).length} steps`,
  async run(input, ctx) {
    const steps = (input.steps as PlanItem[]).slice(0, 30).map((s) => ({ text: String(s.text).slice(0, 200), status: s.status }));
    ctx.setPlan(steps);
    const done = steps.filter((s) => s.status === "done").length;
    return { text: `Plan updated (${done}/${steps.length} done).` };
  },
};

export const askUserTool: Tool = {
  group: "files",
  title: "Ask the user",
  spec: {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you cannot proceed well without their choice, offering 2-5 short options. The user can also type their own answer. " +
      "Do not use it for questions you can reasonably answer yourself.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, multiple: { type: "boolean", description: "allow several choices" } },
      required: ["question"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Question: ${String(i.question)}`,
  async run(input, ctx) {
    const answer = await ctx.ask(String(input.question), Array.isArray(input.options) ? input.options.map(String).slice(0, 6) : [], input.multiple === true);
    return answer === null ? { isError: true, text: "The user dismissed the question without answering." } : { text: `The user answered: ${answer}` };
  },
};

export const subagentTool: Tool = {
  group: "files",
  title: "Delegate to a sub-agent",
  spec: {
    name: "delegate",
    description:
      "Hand a self-contained sub-task to a sub-agent that works in its own fresh context with the same tools and returns only its final answer. " +
      "Use it for independent pieces of a larger job (researching one of several topics, reading one long document, drafting one section) so your own context stays focused. " +
      "Several delegate calls in the same turn run in parallel. Give complete instructions: the sub-agent cannot see this conversation.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "Full instructions for the sub-agent" }, label: { type: "string", description: "Short name shown to the user" } },
      required: ["task"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Sub-agent: ${String(i.label ?? i.task).slice(0, 80)}`,
  async run(input, ctx) {
    const result = await ctx.runSubagent(String(input.task), String(input.label ?? "sub-task"));
    return { text: result };
  },
};

export function assistantTools(ctx: { memory: boolean; knowledge: KnowledgeFile[]; knowledgeSearch: boolean; subagents: boolean }): Tool[] {
  const out: Tool[] = [planTool, askUserTool];
  if (ctx.knowledgeSearch && ctx.knowledge.length) out.push(knowledgeTool(ctx.knowledge));
  if (ctx.memory) out.push(rememberTool, forgetTool);
  if (ctx.subagents) out.push(subagentTool);
  return out;
}

export type { ToolContext };
