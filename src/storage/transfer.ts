// Moving chats in and out: Markdown / HTML export of one chat, and import of
// the export files from ChatGPT, Claude.ai and TypingMind.
import { marked } from "marked";
import type { Conversation, Message, Part } from "../types";
import { uid } from "../types";

const textOf = (m: Message) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

export function chatToMarkdown(c: Conversation, modelName: (m: Message) => string | undefined = () => undefined): string {
  const lines = [`# ${c.title}`, "", `_${new Date(c.createdAt).toLocaleString()}_`, ""];
  for (const m of c.messages) {
    const who = m.role === "user" ? "You" : (modelName(m) ?? "Assistant");
    lines.push(`## ${who}`, "");
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) lines.push(p.text.trim(), "");
      else if (p.type === "attachment") lines.push(`📎 ${p.name}`, "");
      else if (p.type === "artifact") lines.push(`📄 ${p.name}`, "");
      else if (p.type === "tool_call") lines.push(`> 🔧 ${p.name}${p.result ? ` — ${p.result.isError ? "error" : "done"}` : ""}`, "");
    }
  }
  return lines.join("\n");
}

export function chatToHtml(c: Conversation, modelName?: (m: Message) => string | undefined): string {
  const body = marked.parse(chatToMarkdown(c, modelName), { async: false }) as string;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title>
<style>body{font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1e1d1a}h2{font-size:1rem;color:#6d6a63;border-top:1px solid #e2dfd7;padding-top:1rem}pre{background:#f1efe9;padding:.8rem;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Menlo,Consolas,monospace}table{border-collapse:collapse}td,th{border:1px solid #e2dfd7;padding:4px 8px}@media(prefers-color-scheme:dark){body{background:#191816;color:#edebe6}pre{background:#2a2825}}</style></head><body>${body}</body></html>`;
}

function conv(title: string, createdAt: number, messages: Message[]): Conversation {
  const updatedAt = messages.length ? Math.max(...messages.map((m) => m.updatedAt)) : createdAt;
  return { id: uid("c"), title: title || "Imported chat", createdAt, updatedAt, messages, removed: {} };
}

function msg(role: "user" | "assistant", text: string, at: number, extra: Part[] = []): Message {
  return { id: uid("m"), role, createdAt: at, updatedAt: at, parts: [...extra, { type: "text", text }] };
}

const toMs = (v: unknown, fallback: number): number => {
  if (typeof v === "number") return v < 1e12 ? Math.round(v * 1000) : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : fallback;
  }
  return fallback;
};

/** ChatGPT "Export data" → conversations.json (a message tree; we follow the visible branch). */
export function fromChatGPT(data: unknown): Conversation[] {
  const out: Conversation[] = [];
  for (const c of (Array.isArray(data) ? data : []) as Record<string, any>[]) {
    const mapping = c.mapping as Record<string, { message?: any; parent?: string | null; children?: string[] }> | undefined;
    if (!mapping) continue;
    let nodeId: string | null | undefined = c.current_node;
    const chain: any[] = [];
    while (nodeId && mapping[nodeId]) {
      if (mapping[nodeId].message) chain.unshift(mapping[nodeId].message);
      nodeId = mapping[nodeId].parent;
    }
    const created = toMs(c.create_time, Date.now());
    const messages: Message[] = [];
    let t = created;
    for (const m of chain) {
      const role = m.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      const parts = (m.content?.parts ?? []).filter((x: unknown) => typeof x === "string") as string[];
      const text = parts.join("\n").trim() || (typeof m.content?.text === "string" ? m.content.text : "");
      if (!text) continue;
      t = Math.max(t + 1, toMs(m.create_time, t + 1));
      messages.push(msg(role, text, t));
    }
    if (messages.length) out.push(conv(c.title, created, messages));
  }
  return out;
}

/** Claude.ai "Export data" → conversations.json. */
export function fromClaude(data: unknown): Conversation[] {
  const out: Conversation[] = [];
  for (const c of (Array.isArray(data) ? data : []) as Record<string, any>[]) {
    const list = c.chat_messages as any[] | undefined;
    if (!Array.isArray(list)) continue;
    const created = toMs(c.created_at, Date.now());
    let t = created;
    const messages: Message[] = [];
    for (const m of list) {
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      const text =
        (typeof m.text === "string" && m.text) ||
        (Array.isArray(m.content) ? m.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "");
      const files = [...(m.attachments ?? []), ...(m.files ?? [])].map((f: any) => f?.file_name).filter(Boolean);
      if (!text && !files.length) continue;
      t = Math.max(t + 1, toMs(m.created_at, t + 1));
      messages.push(msg(role, `${files.length ? `[attached: ${files.join(", ")}]\n\n` : ""}${text}`, t));
    }
    if (messages.length) out.push(conv(c.name ?? "Imported chat", created, messages));
  }
  return out;
}

/** TypingMind export (data.chats[].messages[]). */
export function fromTypingMind(data: any): Conversation[] {
  const chats = data?.data?.chats ?? data?.chats ?? [];
  const out: Conversation[] = [];
  for (const c of chats as any[]) {
    const created = toMs(c.createdAt, Date.now());
    let t = created;
    const messages: Message[] = [];
    for (const m of (c.messages ?? []) as any[]) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((x: any) => x?.text ?? "").join("\n") : "";
      if (!text.trim()) continue;
      t = Math.max(t + 1, toMs(m.createdAt, t + 1));
      messages.push(msg(m.role, text, t));
    }
    if (messages.length) out.push(conv(c.chatTitle ?? c.title ?? "Imported chat", created, messages));
  }
  return out;
}

export function detectAndImport(text: string): { source: string; chats: Conversation[] } {
  const data = JSON.parse(text);
  if (Array.isArray(data) && data[0]?.mapping) return { source: "ChatGPT", chats: fromChatGPT(data) };
  if (Array.isArray(data) && data[0]?.chat_messages) return { source: "Claude", chats: fromClaude(data) };
  if (data?.data?.chats || data?.chats) return { source: "TypingMind", chats: fromTypingMind(data) };
  throw new Error("This file is not a ChatGPT, Claude or TypingMind export (conversations.json).");
}
