import type { BlobRef, Message, ModelInfo, ModelParams, Part, ProviderConfig, Usage } from "../types";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BlobAccess {
  base64(blobId: string): Promise<string | null>;
  put(bytes: Uint8Array, mime: string, name: string): Promise<BlobRef>;
}

export interface ChatOptions {
  /** already resolved (global < per model < per chat) */
  params: ModelParams;
  webSearch: boolean;
  refusalFallback: boolean;
}

export interface ChatRequest {
  provider: ProviderConfig;
  apiKey: string;
  model: ModelInfo;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  options: ChatOptions;
  signal: AbortSignal;
  /** called with the full list of parts so far, every time something streams in */
  onUpdate: (parts: Part[]) => void;
  blobs: BlobAccess;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal" | "pause";

export interface ChatResult {
  parts: Part[];
  stop: StopKind;
  stopDetail?: string;
  usage?: Usage;
  raw?: Message["raw"];
  /** set when a different model than requested produced the answer */
  servedBy?: string;
  /** something the user should know about how this answer was made (shown under it) */
  notice?: string;
}

export interface ProviderAdapter {
  listModels(provider: ProviderConfig, apiKey: string): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The provider's own search (xAI's web_search / x_search, Anthropic's web search)
 * was refused for this request. The engine retries the step with Meridian's
 * search instead.
 */
export class NativeSearchUnavailable extends ProviderError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "NativeSearchUnavailable";
  }
}
