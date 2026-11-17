// The on-device store: one JSON file per conversation, one file per blob
// (attachments and generated files), and a small index for the sidebar.
import type { BlobRef, Conversation, ConvMeta } from "../types";
import { uid } from "../types";
import type { KV } from "./kv";
import { metaOf, normalizeConversation } from "./merge";

export const convKey = (id: string) => `conversations/${id}.json`;
export const blobKey = (id: string) => `blobs/${id}`;
const INDEX_KEY = "index.json";

export class Repo {
  private metas = new Map<string, ConvMeta>();
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor(public readonly kv: KV) {}

  async init(): Promise<void> {
    this.metas.clear();
    let loaded = false;
    try {
      const raw = await this.kv.getText(INDEX_KEY);
      if (raw) {
        for (const m of JSON.parse(raw) as ConvMeta[]) this.metas.set(m.id, m);
        loaded = true;
      }
    } catch {
      loaded = false;
    }
    if (!loaded) await this.rebuildIndex();
  }

  /** Re-read every conversation file. Used when the index is missing or damaged. */
  async rebuildIndex(): Promise<void> {
    this.metas.clear();
    for (const e of await this.kv.list("conversations/")) {
      if (!e.key.endsWith(".json")) continue;
      try {
        const c = normalizeConversation(JSON.parse((await this.kv.getText(e.key)) ?? "null"));
        if (c) this.metas.set(c.id, metaOf(c));
      } catch {
        /* skip unreadable file */
      }
    }
    await this.writeIndexNow();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Live (not deleted) conversations, pinned first, newest first. */
  list(): ConvMeta[] {
    return [...this.metas.values()]
      .filter((m) => !m.deletedAt)
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }

  /** Including tombstones. */
  allMetas(): ConvMeta[] {
    return [...this.metas.values()];
  }

  meta(id: string): ConvMeta | undefined {
    return this.metas.get(id);
  }

  async get(id: string): Promise<Conversation | null> {
    const raw = await this.kv.getText(convKey(id));
    if (!raw) return null;
    try {
      return normalizeConversation(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(conv: Conversation): Promise<void> {
    await this.kv.setText(convKey(conv.id), JSON.stringify(conv));
    this.metas.set(conv.id, metaOf(conv));
    this.scheduleIndex();
    for (const fn of this.listeners) fn();
  }

  /** Delete = leave a tombstone so the deletion reaches other devices. */
  async delete(id: string, now = Date.now()): Promise<void> {
    const conv = await this.get(id);
    if (!conv) return;
    await this.save({
      id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: now,
      deletedAt: now,
      messages: [],
      removed: {},
    });
  }

  async putBlob(bytes: Uint8Array, mime: string, name: string): Promise<BlobRef> {
    const blobId = uid("b");
    await this.kv.setBytes(blobKey(blobId), bytes);
    return { blobId, name, mime, size: bytes.length };
  }

  getBlob(blobId: string): Promise<Uint8Array | null> {
    return this.kv.getBytes(blobKey(blobId));
  }

  async blobIds(): Promise<Set<string>> {
    return new Set((await this.kv.list("blobs/")).map((e) => e.key.slice("blobs/".length)));
  }

  private scheduleIndex() {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.writeIndexNow();
    }, 400);
  }

  async flush(): Promise<void> {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    await this.writeIndexNow();
  }

  private async writeIndexNow() {
    await this.kv.setText(INDEX_KEY, JSON.stringify([...this.metas.values()]));
  }
}
