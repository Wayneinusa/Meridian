// Core data model. Everything in here is plain JSON so it can be written to
// disk, synced through a folder (iCloud Drive) and packed into backups.

export type ProviderKind = "anthropic" | "openai" | "gemini" | "openai-compatible";

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
  messages: Message[];
  /** message id -> time it was removed (regenerate / edit), so merges do not resurrect it */
  removed: Record<string, number>;
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
}

export type McpTransport = "http" | "stdio";

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
