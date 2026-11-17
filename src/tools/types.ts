import type { ToolSpec } from "../providers/types";
import type { BlobRef, Part, Settings } from "../types";

export type ToolGroup = "files" | "media" | "web" | "computer" | "connectors";

export interface ToolOutput {
  text: string;
  isError?: boolean;
  /** files to show under the tool call (saved to the conversation) */
  artifacts?: BlobRef[];
  /** pictures the model should look at (screenshots) */
  images?: BlobRef[];
}

export interface ToolContext {
  conversationId: string;
  signal: AbortSignal;
  settings: Settings;
  saveBlob(bytes: Uint8Array, mime: string, name: string): Promise<BlobRef>;
  loadBlob(blobId: string): Promise<Uint8Array | null>;
  /** files generated or attached so far in this conversation */
  files(): (BlobRef & { kind: Part["type"] })[];
  /** everything the user typed in this conversation */
  userText(): string;
  getKey(providerId: string): Promise<string>;
  progress(note: string): void;
}

export interface Tool {
  spec: ToolSpec;
  group: ToolGroup;
  /** label for the UI */
  title: string;
  /** true when the user has to approve this particular call */
  needsApproval(input: Record<string, unknown>, ctx: ToolContext): boolean;
  /** one-line human description of what this call will do, for the approval prompt */
  summarize(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
