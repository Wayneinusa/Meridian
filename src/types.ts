// Core data model. Everything in here is plain JSON so it can be written to
// disk, synced through a folder (iCloud Drive) and packed into backups.

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "gemini"
  | "xai"
  | "openai-compatible"
  // image / video only (free or free-credit services)
  | "pollinations"
  | "horde"
  | "cloudflare"
  | "fal"
  | "runway"
  // a custom media endpoint described by request templates
  | "custom-media"
  // image / video engines that installed plugins provide (never stored in settings)
  | "plugin";

/**
 * A media endpoint described by templates, for self-hosted servers, free trials
 * and plugin engines. Placeholders: {{prompt}} {{model}} {{width}} {{height}}
 * {{aspect_ratio}} {{seconds}} {{count}} {{seed}} {{image}} (data URI of the first
 * input image) {{key}} (the provider key) and {{settings.KEY}} (plugin settings).
 */
export interface MediaHttpSpec {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  /** JSON body (POST) */
  body?: string;
  /** dot path to the result in the JSON response (a URL, data URI, base64 or list of them). Found automatically when empty. */
  resultPath?: string;
  /** for job APIs: dot path to the job id in the first response */
  jobIdPath?: string;
  /** for job APIs: URL to poll, with {{id}} */
  pollUrl?: string;
  /** dot path to the status in the poll response */
  statusPath?: string;
  /** status values that mean the job failed (regex) */
  failedPattern?: string;
}

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
  /** xAI: signed in with X (tokens are in the keychain, not here) */
  signedIn?: boolean;
  /** shown as "Signed in with X as …" */
  signedInAs?: string;
  /** Cloudflare: the account id that goes into the API address */
  accountId?: string;
  /** openai-compatible / custom: which video API the server speaks */
  videoApi?: "openai" | "xai" | "fal" | "template";
  /** custom-media: request templates */
  imageTemplate?: MediaHttpSpec;
  videoTemplate?: MediaHttpSpec;
  /** plugin engines: the plugin that provides them */
  pluginId?: string;
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
  /** how this answer was made, when the user should know (a fallback, another route) */
  notice?: string;
  /**
   * Provider-native content of an assistant turn, replayed verbatim to the same
   * provider (Claude requires thinking blocks to come back unchanged).
   */
  raw?: { kind: ProviderKind; content: unknown };
  /** a message from one member of a consortium (shown in the discussion thread) */
  member?: MemberTag;
}

export type ConsortiumPhase = "plan" | "assign" | "work" | "review" | "draft" | "vote" | "final" | "note";

export interface MemberTag {
  /** member id, or "coordinator-…" for the coordinator speaking as such */
  id: string;
  name: string;
  emoji?: string;
  phase: ConsortiumPhase;
  /** which consortium run this belongs to (one per task) */
  run: string;
  /** vote phase */
  vote?: "agree" | "disagree";
  round?: number;
  /** final message: "consensus" | "majority" | "no agreement", with the count */
  outcome?: string;
}

export interface ConsortiumMember {
  id: string;
  name: string;
  /** what this member is for: "researcher", "skeptic who checks every claim", ... */
  role: string;
  emoji?: string;
  /** its own model (cross-model consortium); the chat's model when unset */
  model?: ModelRef;
  /** a saved agent (its instructions, tools and knowledge come along) */
  agentId?: string;
}

export interface ConsortiumConfig {
  members: ConsortiumMember[];
  /** who merges plans and writes drafts and the final answer */
  coordinatorId: string;
  /** vote rounds before disagreement is reported (1-5) */
  rounds: number;
  /** tool steps each member may take while working on its part */
  workSteps: number;
  /**
   * deliberate (default): plan, work, review, then draft and vote on a joint answer.
   * execute: an operational crew; each role does its part at the same time, an
   * auditor (if any) checks, and the coordinator reports what was done. No vote.
   */
  style?: "deliberate" | "execute";
  /** how the team was made, and why (automatic teams) */
  origin?: "manual" | "auto" | "preset";
  rationale?: string;
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
  /** the image / video backend last used in this chat (switching modes comes back to it) */
  mediaModels?: { image?: ModelRef; video?: ModelRef };
  projectId?: string;
  agentId?: string;
  archived?: boolean;
  tags?: string[];
  /** desktop: folder the assistant may work in for this chat */
  workFolder?: string;
  /** "research" runs a multi-step web research agent */
  mode?: "chat" | "research" | "consortium";
  /** the team for consortium mode */
  consortium?: ConsortiumConfig;
  /** earlier answers to a question: user message id -> versions (regenerate / compare keep them here) */
  alternates?: Record<string, TurnVersion[]>;
  /** the assistant's working plan (shown as a checklist) */
  plan?: PlanItem[];
  /** the consortium's shared scratchpad (latest run) */
  scratchpad?: { by: string; text: string; at: number }[];
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
  /** the chat uses (or last used) a Grok model: listed in the Grok section */
  grok?: boolean;
  /** index format version (older indexes are rebuilt) */
  mv?: number;
}

export type McpTransport = "http" | "sse" | "stdio" | "native";

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

export interface CloudSync {
  provider: "google" | "onedrive";
  /** the OAuth app the user registered (see the README) */
  clientId: string;
  /** Google "TVs and Limited Input devices" clients come with a secret */
  clientSecret?: string;
  /** Microsoft: "common", "consumers" or a tenant id */
  tenant?: string;
  /** shown in Settings once signed in */
  account?: string;
}

export type StyleId = "default" | "concise" | "explanatory" | "formal" | "friendly" | "socratic" | "custom";

/** Response style, what the model should know about the user, and instructions. */
export interface Customization {
  style?: StyleId;
  /** the style in the user's words, when style is "custom" */
  styleText?: string;
  about?: string;
  instructions?: string;
}

/** A model's own customization: anything left undefined uses the global setting. */
export interface ModelCustomization extends Customization {
  /** replace: only this model's instructions; add: the global ones, then these */
  instructionsMode?: "replace" | "add";
}

export interface Settings {
  theme: "system" | "light" | "dark";
  providers: ProviderConfig[];
  defaultModel?: ModelRef;
  imageModel?: ModelRef;
  videoModel?: ModelRef;
  /** chats with a Grok model make images and video with Grok Imagine (unless the chat has its own pick). Default on. */
  grokImagine?: boolean;
  /** standing instructions for every model (the global customization's instructions) */
  systemPrompt: string;
  /** global style and "about me"; instructions are systemPrompt */
  customization?: Omit<Customization, "instructions">;
  /** per-model overrides (key: providerId::modelId); unset fields fall back to the global ones */
  modelCustom?: Record<string, ModelCustomization>;
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
    /** the assistant's own browser (desktop) */
    browser: boolean;
    connectors: boolean;
  };
  browser: {
    /** chromium: Meridian's own (downloaded once); firefox: the installed Firefox */
    engine: "chromium" | "firefox";
    /** show the browser window (off: it runs invisibly; the panel in the chat still shows it) */
    showWindow: boolean;
    /** rules: reading never asks, new sites / submits / passwords / downloads ask; each: every action asks */
    approval: "rules" | "each";
    /** sites the assistant may open without asking */
    allowSites: string[];
  };
  /** never ask before running computer tools. Dangerous; off by default. */
  autoApproveComputer: boolean;
  /** visual computer use (the computer tool) */
  computerUse: {
    /** each: every action asks (default); risky: typing, shortcuts and drags ask; auto: nothing asks */
    approval: "each" | "risky" | "auto";
    actionsPerMinute: number;
    /** step budget for a task that uses the computer */
    maxSteps: number;
    /** screenshots kept in the model's view (older ones are dropped to save tokens) */
    keepScreenshots: number;
  };
  /** tool names the user chose "always allow" for */
  alwaysAllow: string[];
  mcpServers: McpServerConfig[];
  sync: {
    /** iOS / macOS: use the app's iCloud container */
    icloud: boolean;
    /** any platform with a file system: sync through this folder (e.g. iCloud Drive on Windows) */
    folder?: string;
    /** sync through Google Drive or OneDrive as well (every platform) */
    cloud?: CloudSync;
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
  /** TypingMind: how the result is used ("respond_to_ai", "render_markdown", "render_html") */
  outputType?: string;
}

/** An image or video generator a plugin adds to the Image / Video backends. */
export interface PluginEngine {
  id: string;
  kind: "image" | "video";
  name: string;
  /** call one of the plugin's tools with { prompt, aspect_ratio, width, height, count, seconds, image } */
  tool?: string;
  /** or an HTTP template */
  http?: MediaHttpSpec;
  /** or JavaScript: body of an async function (args, settings, fetchJson) returning a URL, data URI or { url | images | video } */
  code?: string;
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
  /** image / video generators this plugin provides */
  engines?: PluginEngine[];
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
