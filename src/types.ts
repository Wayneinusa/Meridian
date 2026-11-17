// Core data model. Everything in here is plain JSON so it can be written to
// disk, synced through a folder (iCloud Drive) and packed into backups.

export type ProviderKind = "anthropic" | "openai" | "gemini" | "xai" | "openai-compatible";

export interface ModelCaps {
  /** accepts image input */
  vision: boolean;
  /** accepts PDF input natively */
  pdf: boolean;
  /** supports function/tool calling */
  tools: boolean;
  /** exposes reasoning / thinking */
  thinking: boolean;
  /** can return images inline in a chat reply */
  imageOutput?: boolean;
  /** provider-hosted web search is available */
  webSearch?: boolean;
}

export type ModelKind = "chat" | "image" | "video";

export interface ModelInfo {
  id: string;
  name: string;
  kind: ModelKind;
  caps: ModelCaps;
  maxOutput?: number;
  contextWindow?: number;
  /** reasoning-effort levels the provider reports for this model */
  efforts?: string[];
  /** how thinking is switched on for this model (Anthropic) */
  thinkingMode?: "adaptive" | "budget" | "none";
  /** capabilities were edited by hand; do not overwrite on refresh */
  userEdited?: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: ModelInfo[];
  /** set once a key has been stored in the OS keychain (the key itself never lives here) */
  hasKey?: boolean;
  /** extra HTTP headers sent with every request (non-secret) */
  headers?: Record<string, string>;
}

/** Options for image and video generation. Unset fields use the model's default. */
export interface MediaOptions {
  aspect?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
  /** images per request (1-4) */
  count?: number;
  /** video length in seconds */
  seconds?: number;
  /** e.g. "720p", "1080p" for video, "1k"/"2k" or "standard"/"hd" for images */
  resolution?: string;
  quality?: "auto" | "low" | "medium" | "high";
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface BlobRef {
  blobId: string;
  name: string;
  mime: string;
  size: number;
}

export type Part =
  | { type: "text"; text: string; sig?: string }
  | { type: "thinking"; text: string }
  | (BlobRef & {
      type: "attachment";
      /** text pulled out of the document on this device, used when the model cannot read the file natively */
      extractedText?: string;
    })
  | (BlobRef & {
      type: "artifact";
      /** "model": returned inline by the model. "tool": produced by a tool call. */
      origin: "model" | "tool";
      toolCallId?: string;
      sig?: string;
    })
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      /** provider-hosted tool (web search, ...): never executed locally */
      server?: boolean;
      status: "pending" | "running" | "done" | "error" | "denied";
      result?: ToolResultData;
      sig?: string;
    };

export interface ToolResultData {
  text: string;
  isError?: boolean;
  images?: BlobRef[];
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  updatedAt: number;
  parts: Part[];
  model?: ModelRef;
  usage?: Usage;
  stopReason?: string;
  error?: string;
  /**
   * Provider-native content of an assistant turn, replayed verbatim to the same
   * provider (Claude requires thinking blocks to come back unchanged).
   */
  raw?: { kind: ProviderKind; content: unknown };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** tombstone: the chat was deleted at this time (kept so sync can propagate it) */
  deletedAt?: number;
  pinned?: boolean;
  model?: ModelRef;
  systemPrompt?: string;
  /** parameter overrides for this chat only */
  params?: ModelParams;
  /** options for image / video generation in this chat */
  media?: MediaOptions;
  /** the chat model to return to after switching to image or video mode */
  chatModel?: ModelRef;
  projectId?: string;
  agentId?: string;
  archived?: boolean;
  tags?: string[];
  /** desktop: folder the assistant may work in for this chat */
  workFolder?: string;
  /** "research" runs a multi-step web research agent */
  mode?: "chat" | "research";
  /** earlier answers to a question: user message id -> versions (regenerate / compare keep them here) */
  alternates?: Record<string, TurnVersion[]>;
  /** the assistant's working plan (shown as a checklist) */
  plan?: PlanItem[];
  forkedFrom?: { convId: string; messageId: string };
  messages: Message[];
  /** message id -> time it was removed (regenerate / edit), so merges do not resurrect it */
  removed: Record<string, number>;
}

export interface TurnVersion {
  id: string;
  createdAt: number;
  messages: Message[];
}

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface ConvMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  pinned?: boolean;
  preview?: string;
  messageCount: number;
  projectId?: string;
  agentId?: string;
  archived?: boolean;
  tags?: string[];
}

export type McpTransport = "http" | "sse" | "stdio";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** http */
  url?: string;
  /** set when a bearer token is stored in the keychain */
  hasToken?: boolean;
  headers?: Record<string, string>;
  /** stdio (desktop only) */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** run this connector's tools without asking each time */
  trusted?: boolean;
  /** added by a plugin; removed with it */
  pluginId?: string;
  /** OAuth sign-in (tokens live in the keychain) */
  oauth?: { clientId?: string; authorized?: boolean; scope?: string };
  /** catalog entry this came from */
  catalogId?: string;
}

export type Effort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Generation parameters. Every field is optional: unset means "let the
 * provider use its own default", and nothing is sent for it.
 */
export interface ModelParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  /** maximum length of one reply, in tokens */
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  /** reasoning effort */
  effort?: Effort;
  /** fixed thinking-token budget, for models that take one */
  thinkingBudget?: number;
  /** answer length preference, for models that take one */
  verbosity?: "low" | "medium" | "high";
  responseFormat?: "text" | "json";
  toolChoice?: "auto" | "none" | "required";
  parallelToolCalls?: boolean;
  /** token id -> bias (-100..100) */
  logitBias?: Record<string, number>;
  serviceTier?: string;
  /** faster output at a higher price, on models that offer it */
  speed?: "standard" | "fast";
  /** only send the most recent N messages (saves tokens on long chats) */
  contextMessages?: number;
  /** raw fields merged into the request body last, for anything not listed above */
  extraBody?: Record<string, unknown>;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  providers: ProviderConfig[];
  defaultModel?: ModelRef;
  imageModel?: ModelRef;
  videoModel?: ModelRef;
  systemPrompt: string;
  /** parameter defaults for every chat */
  params: ModelParams;
  /** parameter presets per model (key: providerId::modelId) */
  modelParams: Record<string, ModelParams>;
  showThinking: boolean;
  webSearch: boolean;
  refusalFallback: boolean;
  tools: {
    files: boolean;
    media: boolean;
    web: boolean;
    computer: boolean;
    connectors: boolean;
  };
  /** never ask before running computer tools. Dangerous; off by default. */
  autoApproveComputer: boolean;
  /** tool names the user chose "always allow" for */
  alwaysAllow: string[];
  mcpServers: McpServerConfig[];
  sync: {
    /** iOS / macOS: use the app's iCloud container */
    icloud: boolean;
    /** any platform with a file system: sync through this folder (e.g. iCloud Drive on Windows) */
    folder?: string;
    auto: boolean;
  };
  maxAgentSteps: number;
  /** long-term memory across chats */
  memory: boolean;
  /** let the assistant hand sub-tasks to sub-agents */
  subagents: boolean;
  /** web search used by models without their own hosted search */
  search: { provider: "auto" | "duckduckgo" | "brave" | "tavily" | "exa" | "searxng"; searxngUrl?: string };
  /** name new chats with the model after the first answer */
  autoTitle: boolean;
  appearance: { fontSize: number; width: "normal" | "wide"; sendOnEnter: boolean };
  voice: {
    /** speech-to-text model (OpenAI, Groq, xAI or Gemini); system dictation when unset */
    sttModel?: ModelRef;
    /** text-to-speech model; the device voice when unset */
    ttsModel?: ModelRef;
    voiceName?: string;
    /** read every answer aloud */
    autoSpeak: boolean;
  };
  notifications: boolean;
  /** desktop: keep running in the tray when the window is closed (for automations) */
  runInBackground: boolean;
  /** identifies this device to automations ("run on this device") */
  deviceId: string;
  deviceName: string;
  /** price per million tokens, for the usage page: key providerId::modelId */
  prices: Record<string, { input: number; output: number }>;
  favorites: string[];
  /** models used by Compare */
  compareModels: ModelRef[];
  /** OAuth apps the user registered for Google / Microsoft connectors */
  oauthApps: { google?: { clientId: string }; microsoft?: { clientId: string; tenant?: string } };
}

export function modelKey(ref: ModelRef | undefined): string {
  return ref ? `${ref.providerId}::${ref.modelId}` : "";
}

export function uid(prefix = ""): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += b.toString(16).padStart(2, "0");
  return prefix + s;
}

// ---------------------------------------------------------------- library
// Items the user builds up over time. Each is one JSON file, synced and backed
// up like chats; when two devices edit the same item the later edit wins.

export interface LibItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface KnowledgeFile extends BlobRef {
  /** extracted text, stored as its own blob */
  textBlobId?: string;
  chars?: number;
  addedAt: number;
}

export interface Agent extends LibItem {
  name: string;
  emoji?: string;
  description?: string;
  instructions: string;
  model?: ModelRef;
  params?: ModelParams;
  /** tool switches that differ from the global ones */
  tools?: Partial<Settings["tools"]>;
  knowledge: KnowledgeFile[];
  starters: string[];
  /** read and write long-term memory */
  memory?: boolean;
  /** text-to-speech voice for this agent */
  voice?: string;
  pluginId?: string;
}

export interface Project extends LibItem {
  name: string;
  emoji?: string;
  instructions: string;
  knowledge: KnowledgeFile[];
  agentId?: string;
  model?: ModelRef;
  /** desktop: default work folder for chats in this project */
  workFolder?: string;
}

export interface PromptItem extends LibItem {
  title: string;
  /** may contain {{variables}} the user fills in */
  content: string;
  /** slash command name, without the slash */
  command?: string;
  description?: string;
  pluginId?: string;
}

export interface MemoryItem extends LibItem {
  text: string;
  /** conversation it came from */
  source?: string;
  projectId?: string;
}

export interface PluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: "http" | "js";
  /** HTTP tool: {{arg}} and {{settings.KEY}} are filled in */
  http?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: string;
    /** dot path into the JSON response to return, e.g. "data.items" */
    resultPath?: string;
  };
  /** JavaScript tool: body of an async function (args, settings, fetchJson) => result */
  code?: string;
  /** ask before each call (default: only for non-GET HTTP tools) */
  confirm?: boolean;
}

export interface PluginSkill {
  name: string;
  description: string;
  body: string;
  /** extra files shipped with the skill: relative path -> text */
  files?: Record<string, string>;
}

export interface PluginCommand {
  name: string;
  description?: string;
  body: string;
  argumentHint?: string;
}

export interface PluginAgentDef {
  name: string;
  description?: string;
  instructions: string;
  emoji?: string;
  model?: string;
}

export interface PluginSettingDef {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
  default?: string;
}

export interface Plugin extends LibItem {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  emoji?: string;
  source: "gallery" | "url" | "file" | "paste";
  sourceUrl?: string;
  enabled: boolean;
  tools: PluginTool[];
  skills: PluginSkill[];
  commands: PluginCommand[];
  agents: PluginAgentDef[];
  mcpServers: Omit<McpServerConfig, "enabled">[];
  settings: PluginSettingDef[];
  /** non-secret setting values (secrets live in the keychain) */
  values: Record<string, string>;
}

export type Schedule =
  | { type: "once"; at: number }
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string; days?: number[] }
  | { type: "weekly"; time: string; days: number[] }
  | { type: "monthly"; time: string; day: number };

export interface AutomationRun {
  at: number;
  status: "ok" | "error" | "skipped";
  convId?: string;
  summary?: string;
  device?: string;
}

export interface Automation extends LibItem {
  name: string;
  enabled: boolean;
  prompt: string;
  agentId?: string;
  projectId?: string;
  model?: ModelRef;
  schedule: Schedule;
  /** each run in a new chat, or always in the same one */
  output: "new-chat" | "same-chat";
  convId?: string;
  notify: boolean;
  /** run tools without asking (the user is usually away when an automation runs) */
  autoApprove: boolean;
  tools?: Partial<Settings["tools"]>;
  /** device id that runs it ("any" = whichever device is open first) */
  runOn: string;
  /** when a run was missed (app closed), run it once when the app opens */
  catchUp: boolean;
  lastRunAt?: number;
  runs: AutomationRun[];
}

export type CollectionName = "agents" | "projects" | "prompts" | "memories" | "plugins" | "automations";

export interface CollectionTypes {
  agents: Agent;
  projects: Project;
  prompts: PromptItem;
  memories: MemoryItem;
  plugins: Plugin;
  automations: Automation;
}

export const COLLECTIONS: CollectionName[] = ["agents", "projects", "prompts", "memories", "plugins", "automations"];
