// The agent loop, shared by chats, automations and sub-agents: build the
// context for a turn, stream the model's reply, run the tools it asks for
// (asking the user where needed) and repeat until it is done.
import { FULL_CONTEXT_CHARS, formatHits, indexFor, loadKnowledge } from "../knowledge";
import { platform } from "../platform";
import { pluginSkills, pluginTools, skillsPrompt } from "../plugins/runtime";
import { resolveParams, supportedParams } from "../providers/params";
import { adapterFor, findModel } from "../providers/registry";
import type { BlobAccess } from "../providers/types";
import type { Library } from "../storage/library";
import type { Repo } from "../storage/repo";
import { activeTools } from "../tools";
import { assistantTools } from "../tools/assistant";
import { runJavascript } from "../tools/code";
import { computerTools } from "../tools/computer";
import { extractText } from "../tools/extract";
import { createMedia } from "../tools/media";
import type { PermissionPreview, Tool, ToolContext } from "../tools/types";
import { validateInput } from "../tools/validate";
import { searchTool } from "../tools/web";
import type { Agent, BlobRef, Conversation, KnowledgeFile, Message, ModelRef, Part, PlanItem, Project, Settings, ToolResultData } from "../types";
import { uid } from "../types";
import { buildSystemPrompt } from "./prompt";

export interface EngineHost {
  settings(): Settings;
  library: Library;
  repo: Repo;
  blobs: BlobAccess;
  getKey(providerId: string): Promise<string>;
  getSecret(name: string): Promise<string | null>;
  /** extra tools from connectors (MCP) for this turn */
  connectorTools(settings: Settings): Promise<Tool[]>;
  render(c: Conversation): void;
  save(c: Conversation, soon?: boolean): void | Promise<void>;
  setBusy(convId: string, note: string | null): void;
  askPermission(convId: string, tool: Tool, input: Record<string, unknown>, callId?: string, preview?: PermissionPreview): Promise<"deny" | "once" | "always" | "task">;
  ask(convId: string, question: string, options: string[], multiple: boolean): Promise<string | null>;
  allowAlways(toolName: string): Promise<void>;
  notice(text: string): void;
}

export interface TurnOptions {
  signal: AbortSignal;
  /** run every tool without asking (automations the user set up that way) */
  autoApprove?: boolean;
  /** no tools at all (compare mode) */
  noTools?: boolean;
  maxSteps?: number;
  /** sub-agent nesting level */
  depth?: number;
  /** model override for this turn */
  model?: ModelRef;
  /** extra tools for this turn only (consortium: shared scratchpad, asking another member) */
  extraTools?: Tool[];
  onAssistant?: (id: string) => void;
}

export function currentRef(settings: Settings, conv: Conversation, agent?: Agent, project?: Project): ModelRef | undefined {
  const candidates = [conv.model, agent?.model, project?.model, settings.defaultModel];
  for (const ref of candidates) if (findModel(settings, ref)) return ref;
  for (const p of settings.providers) {
    if (!p.enabled) continue;
    const m = p.models.find((x) => x.kind === "chat");
    if (m) return { providerId: p.id, modelId: m.id };
  }
  return undefined;
}

export function contextOf(host: EngineHost, conv: Conversation): { agent?: Agent; project?: Project } {
  const project = host.library.get("projects", conv.projectId);
  const agent = host.library.get("agents", conv.agentId) ?? host.library.get("agents", project?.agentId);
  return { agent, project };
}

function nextTime(c: Conversation): number {
  const last = c.messages[c.messages.length - 1];
  return Math.max(Date.now(), (last?.createdAt ?? 0) + 1);
}

function touch(c: Conversation) {
  c.updatedAt = Math.max(Date.now(), c.updatedAt + 1);
}

export function patchMessage(host: EngineHost, c: Conversation, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) {
  const i = c.messages.findIndex((m) => m.id === messageId);
  if (i < 0) return;
  const old = c.messages[i];
  const p = typeof patch === "function" ? patch(old) : patch;
  c.messages[i] = { ...old, ...p, updatedAt: Math.max(Date.now(), old.updatedAt + 1) };
  touch(c);
  host.render(c);
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Screenshots pile up fast in a computer-use task. Keep the newest few as
 * images; older ones are replaced by a note, so the context stays small.
 */
export function withRecentScreenshots(messages: Message[], keep: number): Message[] {
  let seen = 0;
  let changed = false;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "assistant") continue;
    let touched = false;
    const parts = [...m.parts].reverse().map((p) => {
      if (p.type !== "tool_call" || !p.result?.images?.length || (p.name !== "computer" && p.name !== "browser")) return p;
      if (seen < keep) {
        seen++;
        return p;
      }
      touched = true;
      return { ...p, result: { ...p.result, images: undefined, text: `${p.result.text} [older screenshot omitted]` } };
    });
    if (touched) {
      changed = true;
      out[i] = { ...m, parts: parts.reverse() };
    }
  }
  return changed ? out : messages;
}

/** Paths the user has handed over for this chat: tools inside it run without asking. */
function insideFolder(path: unknown, folder: string): boolean {
  if (typeof path !== "string" || !path) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = norm(path);
  const f = norm(folder);
  return (p === f || p.startsWith(f + "/")) && !p.split("/").includes("..");
}

/**
 * Claude on Anthropic's API, and Grok on xAI's, search the web themselves
 * (better results, cited; Grok can also search X). Others use Meridian's search tool.
 */
function hostedSearch(settings: Settings, c: Conversation, agent: Agent | undefined, provider: { kind: string; baseUrl: string; signedIn?: boolean }): boolean {
  const web = (agent?.tools?.web ?? settings.tools.web) || c.mode === "research";
  if (!web || !settings.webSearch) return false;
  if (provider.kind === "anthropic") return /api\.anthropic\.com/.test(provider.baseUrl || "https://api.anthropic.com");
  if (provider.kind === "xai") return !!provider.signedIn || /api\.x\.ai/.test(provider.baseUrl || "https://api.x.ai/v1");
  return false;
}

async function assembleTools(host: EngineHost, c: Conversation, settings: Settings, model: { caps: { tools: boolean } }, agent: Agent | undefined, knowledge: KnowledgeFile[], fullKnowledge: boolean, depth: number, hosted: boolean): Promise<Tool[]> {
  if (!model.caps.tools) return [];
  const switches = { ...settings.tools, ...(agent?.tools ?? {}) };
  if (c.mode === "research") switches.web = true;
  const eff: Settings = { ...settings, tools: switches };
  const tools: Tool[] = [];
  tools.push(...(await activeTools(eff, model as never)).filter((t) => t.group !== "connectors"));
  if (switches.connectors) tools.push(...(await host.connectorTools(eff)));
  // a work folder gives file access to that folder even with computer access off
  if (c.workFolder && platform().desktop && !switches.computer) {
    tools.push(...computerTools().filter((t) => ["read_file", "write_file", "list_directory", "save_generated_file", "open"].includes(t.spec.name)));
  }
  if (c.workFolder) {
    for (const t of tools) {
      if (t.group !== "computer") continue;
      const orig = t.needsApproval;
      const folder = c.workFolder;
      const idx = tools.indexOf(t);
      tools[idx] = { ...t, needsApproval: (i, ctx) => (insideFolder(i.path ?? i.folder ?? i.cwd, folder) && t.spec.name !== "run_command" ? false : orig(i, ctx)) };
    }
  }
  if (switches.web && !hosted) tools.push(searchTool(host.getSecret));
  tools.push(...pluginTools(host.library.list("plugins"), host.getSecret));
  tools.push(runJavascript);
  tools.push(
    ...assistantTools({
      memory: settings.memory && agent?.memory !== false,
      knowledge,
      knowledgeSearch: !fullKnowledge,
      subagents: settings.subagents && depth === 0,
    }),
  );
  // the same name twice would be rejected by providers
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.spec.name) ? false : (seen.add(t.spec.name), true)));
}

export async function runTurn(host: EngineHost, c: Conversation, opts: TurnOptions): Promise<void> {
  const depth = opts.depth ?? 0;
  let maxSteps = Math.max(1, opts.maxSteps ?? (c.mode === "research" ? Math.max(host.settings().maxAgentSteps, 80) : host.settings().maxAgentSteps));
  let assistantId: string | null = null;
  /** tools the user allowed "for this task" on an approval card: they stop asking until the turn ends */
  const taskAllowed = new Set<string>();
  try {
    for (let step = 0; ; step++) {
      const settings = host.settings();
      const { agent, project } = contextOf(host, c);
      const ref = opts.model ?? currentRef(settings, c, agent, project);
      const found = findModel(settings, ref);
      if (!found) throw new Error("No model is selected. Add an API key in Settings → Providers & keys and pick a model.");
      const { provider, model } = found;
      if (model.kind !== "chat") {
        await mediaTurn(host, c, ref!, model.kind, opts.signal, (id) => {
          assistantId = id;
          opts.onAssistant?.(id);
        });
        return;
      }
      const apiKey = await host.getKey(provider.id);
      if (!apiKey && provider.kind !== "openai-compatible" && !provider.signedIn) throw new Error(`No API key for ${provider.name}. Add one in Settings → Providers & keys.`);

      if (!model.caps.pdf) {
        for (const m of c.messages) {
          for (const p of m.parts) {
            if (p.type === "attachment" && p.mime === "application/pdf" && p.extractedText === undefined) {
              host.setBusy(c.id, `reading ${p.name}`);
              const bytes = await host.repo.getBlob(p.blobId);
              const ex = bytes ? await extractText(bytes, p.name, p.mime) : { text: null, truncated: false };
              p.extractedText = ex.text ?? "";
            }
          }
        }
      }

      host.setBusy(c.id, step === 0 ? "" : "thinking");
      // knowledge: small collections go in whole; large ones are searched
      const knowledge = [...(project?.knowledge ?? []), ...(agent?.knowledge ?? [])];
      const loadText = async (id: string) => {
        const b = await host.repo.getBlob(id);
        return b ? new TextDecoder().decode(b) : null;
      };
      let knowledgeText: string | undefined;
      let knowledgePassages: string | undefined;
      let full = false;
      if (knowledge.length) {
        const k = await loadKnowledge(knowledge, loadText);
        if (k.totalChars <= FULL_CONTEXT_CHARS) {
          full = true;
          knowledgeText = k.files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join("\n");
        } else if (!model.caps.tools) {
          const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
          const q = lastUser?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
          knowledgePassages = formatHits(indexFor(k).search(q, 6));
        }
      }
      const hosted = !opts.noTools && hostedSearch(settings, c, agent, provider);
      const tools = opts.noTools ? [] : [...(await assembleTools(host, c, settings, model, agent, knowledge, full, depth, hosted)), ...(model.caps.tools ? (opts.extraTools ?? []) : [])];
      const memories = settings.memory && agent?.memory !== false ? host.library.list("memories").filter((m) => !m.projectId || m.projectId === c.projectId).slice(0, 200) : [];
      const system = buildSystemPrompt({
        settings,
        conv: c,
        tools,
        agent,
        project,
        memories,
        knowledgeText,
        knowledgePassages,
        knowledgeFiles: knowledge.map((f) => f.name),
        skillsText: opts.noTools ? "" : skillsPrompt(pluginSkills(host.library.list("plugins"))),
        subagent: depth > 0,
      });
      const params = supportedParams({ ...resolveParams(settings, ref, c), ...(agent?.params ?? {}), ...(c.params ?? {}) }, provider.kind, model);
      // a task on the screen or in the browser takes many small steps: give it the computer-use budget
      if (!opts.maxSteps && tools.some((t) => t.spec.name === "computer" || t.spec.name === "browser")) maxSteps = Math.max(maxSteps, settings.computerUse?.maxSteps ?? 80);
      // a consortium's inner discussion stays out of later turns; its final answer is the reply
      const visible = c.messages.some((m) => m.member && m.member.phase !== "final") ? c.messages.filter((m) => !m.member || m.member.phase === "final") : c.messages;
      let history = withRecentScreenshots(visible, settings.computerUse?.keepScreenshots ?? 3);
      if (params.contextMessages && history.length > params.contextMessages) {
        let start = history.length - params.contextMessages;
        while (start > 0 && history[start].role !== "user") start--;
        history = history.slice(start);
      }
      const sendHistory = history.slice();

      const now = nextTime(c);
      const assistant: Message = { id: uid("m"), role: "assistant", createdAt: now, updatedAt: now, parts: [], model: ref };
      assistantId = assistant.id;
      opts.onAssistant?.(assistant.id);
      c.messages.push(assistant);
      host.render(c);

      const result = await adapterFor(provider.kind).chat({
        provider,
        apiKey,
        model,
        system,
        messages: sendHistory,
        tools: tools.map((t) => t.spec),
        options: { params, webSearch: hosted, refusalFallback: settings.refusalFallback },
        signal: opts.signal,
        onUpdate: (parts) => {
          patchMessage(host, c, assistant.id, { parts });
          void host.save(c, true);
        },
        blobs: host.blobs,
      });

      patchMessage(host, c, assistant.id, {
        parts: result.parts,
        raw: result.raw,
        usage: result.usage,
        stopReason: result.stop,
        error: result.stop === "refusal" || result.stop === "max_tokens" ? result.stopDetail : undefined,
        model: result.servedBy ? { providerId: provider.id, modelId: result.servedBy } : ref,
      });
      void host.save(c, true);

      if (result.stop === "pause") continue;
      const calls = result.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call" && !p.server);
      if (result.stop === "refusal" || result.stop === "max_tokens") {
        for (const call of calls) {
          patchMessage(host, c, assistant.id, (m) => ({
            parts: m.parts.map((p) => (p.type === "tool_call" && p.id === call.id ? { ...p, status: "error" as const, result: { text: "Not run: the model's turn was cut off before this call was complete.", isError: true } } : p)),
          }));
        }
        return;
      }
      if (!calls.length) return;

      // run the calls; sub-agents may run side by side, everything else one at a time
      const runOne = async (call: Extract<Part, { type: "tool_call" }>) => {
        const tool = tools.find((t) => t.spec.name === call.name);
        const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>;
        let res: ToolResultData;
        let artifacts: BlobRef[] = [];
        const setCall = (patch: Partial<Extract<Part, { type: "tool_call" }>>) =>
          patchMessage(host, c, assistant.id, (m) => ({ parts: m.parts.map((p) => (p.type === "tool_call" && p.id === call.id ? { ...p, ...patch } : p)) }));
        if (!tool) {
          res = { text: `There is no tool named "${call.name}".`, isError: true };
        } else {
          const invalid = validateInput(tool.spec.inputSchema, call.input);
          const ctx = toolContext(host, c, opts, depth);
          if (invalid) {
            res = { text: `Invalid input: ${invalid}. Fix the arguments and call the tool again.`, isError: true };
          } else {
            let allowed = true;
            const s = host.settings();
            const pre = opts.autoApprove || s.alwaysAllow.includes(tool.spec.name) || taskAllowed.has(tool.spec.name) || (tool.group === "computer" && s.autoApproveComputer);
            if (tool.needsApproval(input, ctx) && !pre) {
              host.setBusy(c.id, "waiting for your OK");
              const preview = tool.preview ? await tool.preview(input, ctx).catch(() => undefined) : undefined;
              const decision = await host.askPermission(c.id, tool, input, call.id, preview);
              if (decision === "always") await host.allowAlways(tool.spec.name);
              if (decision === "task") taskAllowed.add(tool.spec.name);
              allowed = decision !== "deny";
            }
            if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (!allowed) {
              setCall({ status: "denied", result: { text: "The user declined to run this tool.", isError: true } });
              return;
            }
            setCall({ status: "running" });
            host.setBusy(c.id, tool.title);
            try {
              const out = await tool.run(input, ctx);
              res = { text: out.text, isError: out.isError, images: out.images };
              artifacts = out.artifacts ?? [];
            } catch (e) {
              if (isAbort(e) || opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
              res = { text: `The tool failed: ${errText(e)}`, isError: true };
            }
          }
        }
        patchMessage(host, c, assistant.id, (m) => {
          const parts: Part[] = [];
          for (const p of m.parts) {
            if (p.type === "tool_call" && p.id === call.id) {
              parts.push({ ...p, status: res.isError ? "error" : "done", result: res });
              for (const a of artifacts) parts.push({ type: "artifact", origin: "tool", toolCallId: call.id, ...a });
            } else parts.push(p);
          }
          return { parts };
        });
        void host.save(c, true);
      };
      const parallel = calls.filter((x) => x.name === "delegate");
      for (const call of calls.filter((x) => x.name !== "delegate")) {
        if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
        await runOne(call);
      }
      if (parallel.length) await Promise.all(parallel.map(runOne));

      if (step + 1 >= maxSteps) {
        patchMessage(host, c, assistant.id, { error: `Stopped after ${maxSteps} tool steps. Say "continue" to keep going, or raise the limit in Settings → General.` });
        return;
      }
    }
  } catch (e) {
    const stopped = isAbort(e) || opts.signal.aborted;
    if (assistantId) {
      patchMessage(host, c, assistantId, (m) => ({
        parts: m.parts.map((p) =>
          p.type === "tool_call" && !p.server && (p.status === "pending" || p.status === "running") ? { ...p, status: "error" as const, result: { text: "Stopped before this finished.", isError: true } } : p,
        ),
        stopReason: stopped ? "stopped" : "error",
        error: stopped ? undefined : errText(e),
      }));
    }
    if (!stopped && !assistantId) throw e;
  } finally {
    if (assistantId) {
      const m = c.messages.find((x) => x.id === assistantId);
      if (m && !m.parts.length && !m.error) {
        c.messages = c.messages.filter((x) => x.id !== assistantId);
        c.removed[assistantId] = Date.now();
        host.render(c);
      }
    }
  }
}

function toolContext(host: EngineHost, c: Conversation, opts: TurnOptions, depth: number): ToolContext {
  return {
    conversationId: c.id,
    signal: opts.signal,
    settings: host.settings(),
    saveBlob: (bytes, mime, name) => host.repo.putBlob(bytes, mime, name),
    loadBlob: (id) => host.repo.getBlob(id),
    files: () =>
      c.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "attachment" || p.type === "artifact" ? [{ blobId: p.blobId, name: p.name, mime: p.mime, size: p.size, kind: p.type }] : []))),
    userText: () =>
      c.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")))
        .join("\n"),
    trustedUrls: () => {
      const urls = new Set<string>();
      for (const m of c.messages) {
        for (const p of m.parts) {
          if (p.type === "tool_call" && (p.name === "web_search" || p.name === "web_fetch") && p.result) {
            for (const u of p.result.text.match(/https?:\/\/[^\s)"'<>]+/g) ?? []) urls.add(u);
          }
        }
      }
      return urls;
    },
    getKey: host.getKey,
    progress: (note) => host.setBusy(c.id, note),
    library: host.library,
    conversation: () => c,
    loadText: async (id) => {
      const b = await host.repo.getBlob(id);
      return b ? new TextDecoder().decode(b) : null;
    },
    setPlan: (steps: PlanItem[]) => {
      c.plan = steps;
      touch(c);
      host.render(c);
    },
    ask: (q, o, m) => (opts.autoApprove ? Promise.resolve(o[0] ?? "Use your best judgement.") : host.ask(c.id, q, o, m)),
    runSubagent: (task, label) => runSubagent(host, c, task, label, opts, depth),
  };
}

/** A sub-agent: same model and tools, its own fresh context, returns only its final text. */
async function runSubagent(host: EngineHost, parent: Conversation, task: string, label: string, opts: TurnOptions, depth: number): Promise<string> {
  const now = Date.now();
  const sub: Conversation = {
    id: `${parent.id}~${uid("s")}`,
    title: label,
    createdAt: now,
    updatedAt: now,
    model: parent.model,
    agentId: parent.agentId,
    projectId: parent.projectId,
    workFolder: parent.workFolder,
    messages: [{ id: uid("m"), role: "user", createdAt: now, updatedAt: now, parts: [{ type: "text", text: task }] }],
    removed: {},
  };
  const subHost: EngineHost = {
    ...host,
    render: () => undefined,
    save: () => undefined,
    setBusy: (_id, note) => note && host.setBusy(parent.id, `${label}: ${note}`),
    askPermission: (_id, tool, input, _call, preview) => host.askPermission(parent.id, tool, input, undefined, preview),
    ask: (_id, q, o, m) => host.ask(parent.id, q, o, m),
  };
  await runTurn(subHost, sub, { ...opts, depth: depth + 1, maxSteps: 25, onAssistant: undefined });
  const last = [...sub.messages].reverse().find((m) => m.role === "assistant");
  const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
  const files = sub.messages.flatMap((m) => m.parts.filter((p) => p.type === "artifact").map((p) => (p as BlobRef).name));
  if (last?.error && !text) return `The sub-agent stopped with an error: ${last.error}`;
  return `${text || "(the sub-agent returned no text)"}${files.length ? `\n\n[Files it created: ${files.join(", ")}]` : ""}`;
}

/** A turn in a chat whose model is an image or video model: the last message is the prompt. */
async function mediaTurn(host: EngineHost, c: Conversation, ref: ModelRef, kind: "image" | "video", signal: AbortSignal, onId: (id: string) => void) {
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  const prompt = lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
  const inputs = lastUser.parts.filter((p): p is Extract<Part, { type: "attachment" }> => p.type === "attachment" && p.mime.startsWith("image/"));
  if (!prompt) throw new Error(kind === "image" ? "Describe the picture you want." : "Describe the video you want.");
  const now = nextTime(c);
  const assistant: Message = { id: uid("m"), role: "assistant", createdAt: now, updatedAt: now, parts: [], model: ref };
  onId(assistant.id);
  c.messages.push(assistant);
  host.render(c);
  host.setBusy(c.id, kind === "image" ? (inputs.length ? "editing image" : "creating image") : "starting video");
  const { refs } = await createMedia(
    { kind, prompt, inputs, options: c.media, model: ref },
    { settings: host.settings(), getKey: host.getKey, loadBlob: (id) => host.repo.getBlob(id), saveBlob: (b, m, n) => host.repo.putBlob(b, m, n), signal, progress: (note) => host.setBusy(c.id, note) },
  );
  patchMessage(host, c, assistant.id, { parts: refs.map((r) => ({ type: "artifact" as const, origin: "model" as const, ...r })), stopReason: "end" });
}

/** Ask the model for a short chat title (cheap: no tools, few tokens). */
export async function suggestTitle(host: EngineHost, c: Conversation, signal: AbortSignal): Promise<string | null> {
  const settings = host.settings();
  const { agent, project } = contextOf(host, c);
  const ref = currentRef(settings, c, agent, project);
  const found = findModel(settings, ref);
  if (!found || found.model.kind !== "chat") return null;
  const firstUser = c.messages.find((m) => m.role === "user");
  const firstReply = c.messages.find((m) => m.role === "assistant");
  const text = (m?: Message) => (m?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "").slice(0, 1500);
  const r = await adapterFor(found.provider.kind).chat({
    provider: found.provider,
    apiKey: await host.getKey(found.provider.id),
    model: { ...found.model, caps: { ...found.model.caps, tools: false } },
    system: "You name conversations. Reply with a title of 2 to 6 words, no quotes, no punctuation at the end.",
    messages: [{ id: "t", role: "user", createdAt: 0, updatedAt: 0, parts: [{ type: "text", text: `User: ${text(firstUser)}\n\nAssistant: ${text(firstReply)}\n\nTitle:` }] }],
    tools: [],
    options: { params: { maxTokens: 400, effort: "low" }, webSearch: false, refusalFallback: false },
    signal,
    onUpdate: () => undefined,
    blobs: host.blobs,
  });
  const title = r.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim().split("\n")[0].replace(/^["'#*\s]+|["'.*\s]+$/g, "");
  return title && title.length <= 80 ? title : null;
}
