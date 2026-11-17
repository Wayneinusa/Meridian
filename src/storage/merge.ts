// Merging two copies of the same conversation. This is what makes iCloud
// sync, folder sync and "import a backup" safe: nothing is ever replaced
// wholesale, the two copies are combined message by message.
import type { BlobRef, Conversation, ConvMeta, Message } from "../types";

export function emptyConversation(id: string, now: number): Conversation {
  return { id, title: "New chat", createdAt: now, updatedAt: now, messages: [], removed: {} };
}

/** Bring anything read from disk / a backup into the current shape. */
export function normalizeConversation(raw: unknown): Conversation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<Conversation>;
  if (typeof c.id !== "string" || !c.id) return null;
  const createdAt = num(c.createdAt) ?? num(c.updatedAt) ?? 0;
  const messages: Message[] = [];
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    if (!m || typeof m.id !== "string" || (m.role !== "user" && m.role !== "assistant")) continue;
    const created = num(m.createdAt) ?? createdAt;
    messages.push({ ...m, createdAt: created, updatedAt: num(m.updatedAt) ?? created, parts: Array.isArray(m.parts) ? m.parts : [] });
  }
  return {
    ...c,
    id: c.id,
    title: typeof c.title === "string" && c.title ? c.title : "Untitled chat",
    createdAt,
    updatedAt: num(c.updatedAt) ?? createdAt,
    messages,
    removed: c.removed && typeof c.removed === "object" ? { ...c.removed } : {},
  } as Conversation;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tombstone(c: Conversation, deletedAt: number): Conversation {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: deletedAt,
    deletedAt,
    messages: [],
    removed: {},
  };
}

/**
 * Combine two copies of one conversation.
 * - messages: union by id; when both sides have a message the later edit wins
 * - removed messages stay removed
 * - title / pin / model / system prompt come from the copy edited last
 * - a delete wins unless the other copy was edited after the delete
 */
export function mergeConversations(a: Conversation, b: Conversation): Conversation {
  if (a.id !== b.id) throw new Error("mergeConversations: different conversations");
  const delA = a.deletedAt ?? 0;
  const delB = b.deletedAt ?? 0;
  if (delA || delB) {
    const del = Math.max(delA, delB);
    const liveA = !delA && a.updatedAt > del;
    const liveB = !delB && b.updatedAt > del;
    if (!liveA && !liveB) return tombstone(a.updatedAt >= b.updatedAt ? a : b, del);
    if (liveA && !liveB) return a;
    if (liveB && !liveA) return b;
  }

  const newer = b.updatedAt > a.updatedAt ? b : a;
  const older = newer === a ? b : a;

  const removed: Record<string, number> = { ...older.removed };
  for (const [id, t] of Object.entries(newer.removed)) removed[id] = Math.max(removed[id] ?? 0, t);

  const byId = new Map<string, Message>();
  for (const m of older.messages) byId.set(m.id, m);
  for (const m of newer.messages) {
    const prev = byId.get(m.id);
    if (!prev || m.updatedAt >= prev.updatedAt) byId.set(m.id, m);
  }
  for (const id of Object.keys(removed)) byId.delete(id);

  const messages = [...byId.values()].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // earlier answers kept for the version switcher: union by version id
  let alternates: Conversation["alternates"];
  if (a.alternates || b.alternates) {
    alternates = {};
    for (const src of [older.alternates ?? {}, newer.alternates ?? {}]) {
      for (const [key, versions] of Object.entries(src)) {
        const list = (alternates[key] ??= []);
        for (const v of versions) if (!list.some((x) => x.id === v.id)) list.push(v);
        list.sort((x, y) => x.createdAt - y.createdAt);
      }
    }
  }

  const out: Conversation = {
    ...newer,
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    deletedAt: undefined,
    messages,
    removed,
  };
  if (alternates) out.alternates = alternates;
  return out;
}

/** Order-independent structural equality, used to skip needless writes. */
export function sameConversation(a: Conversation, b: Conversation): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        const x = (val as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = x;
      }
      return out;
    }
    return val;
  });
}

export function metaOf(c: Conversation): ConvMeta {
  let preview = "";
  for (let i = c.messages.length - 1; i >= 0 && !preview; i--) {
    for (const p of c.messages[i].parts) {
      if (p.type === "text" && p.text.trim()) {
        preview = p.text.trim().replace(/\s+/g, " ").slice(0, 140);
        break;
      }
    }
  }
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt,
    pinned: c.pinned,
    preview,
    messageCount: c.messages.length,
    projectId: c.projectId,
    agentId: c.agentId,
    archived: c.archived,
    tags: c.tags,
  };
}

/** Every file (attachment, generated artifact, tool screenshot) a conversation points at. */
export function blobRefsOf(c: Conversation): BlobRef[] {
  const out = new Map<string, BlobRef>();
  const all = [...c.messages, ...Object.values(c.alternates ?? {}).flatMap((vs) => vs.flatMap((v) => v.messages))];
  for (const m of all) {
    for (const p of m.parts) {
      if (p.type === "attachment" || p.type === "artifact") {
        out.set(p.blobId, { blobId: p.blobId, name: p.name, mime: p.mime, size: p.size });
      } else if (p.type === "tool_call" && p.result?.images) {
        for (const img of p.result.images) out.set(img.blobId, img);
      }
    }
  }
  return [...out.values()];
}
