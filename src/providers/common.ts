import type { Message, ModelCaps, Part, ToolResultData } from "../types";
import { formatBytes } from "../util/bytes";
import type { BlobAccess } from "./types";

export type InputItem =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; b64: string }
  | { kind: "pdf"; name: string; b64: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Turn one attachment into what this particular model can actually take in. */
export async function attachmentToItem(
  part: Extract<Part, { type: "attachment" }>,
  caps: ModelCaps,
  blobs: BlobAccess,
): Promise<InputItem> {
  const label = `${part.name} (${part.mime || "unknown type"}, ${formatBytes(part.size)})`;
  if (IMAGE_MIMES.has(part.mime)) {
    if (caps.vision) {
      const b64 = await blobs.base64(part.blobId);
      if (b64) return { kind: "image", mime: part.mime, b64 };
      return { kind: "text", text: `[Image ${label} is not available on this device yet]` };
    }
    return { kind: "text", text: `[The user attached image ${label}, but the current model cannot see images.]` };
  }
  if (part.mime === "application/pdf" && caps.pdf) {
    const b64 = await blobs.base64(part.blobId);
    if (b64) return { kind: "pdf", name: part.name, b64 };
  }
  if (part.extractedText != null && part.extractedText !== "") {
    return { kind: "text", text: `<document name="${part.name}">\n${part.extractedText}\n</document>` };
  }
  return {
    kind: "text",
    text: `[The user attached ${label}. Its contents could not be read as text and the current model cannot open this file type directly.]`,
  };
}

export async function userItems(m: Message, caps: ModelCaps, blobs: BlobAccess): Promise<InputItem[]> {
  const files: InputItem[] = [];
  const texts: InputItem[] = [];
  for (const p of m.parts) {
    if (p.type === "attachment") files.push(await attachmentToItem(p, caps, blobs));
    else if (p.type === "text" && p.text) texts.push({ kind: "text", text: p.text });
  }
  // documents and images go first, the question last
  return [...files, ...texts];
}

export type ToolCallPart = Extract<Part, { type: "tool_call" }>;

export function clientToolCalls(m: Message): ToolCallPart[] {
  return m.parts.filter((p): p is ToolCallPart => p.type === "tool_call" && !p.server);
}

/** Every tool call sent to a model needs an answer, even one that was interrupted. */
export function resultOf(call: ToolCallPart): ToolResultData {
  if (call.result) return call.result;
  if (call.status === "denied") return { text: "The user declined to run this tool.", isError: true };
  return { text: "The tool call was interrupted before it produced a result.", isError: true };
}

export function joinText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Read a streaming response as server-sent events. */
export async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    const tail = parseBlock(buf);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function parseBlock(block: string): { event?: string; data: string } | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
