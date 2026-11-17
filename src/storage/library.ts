// The library: agents, projects, prompts, memories, plugins and automations.
// One JSON file per item under library/<collection>/<id>.json. Deletes leave a
// tombstone so they reach other devices; the later edit of an item wins.
import { COLLECTIONS, uid, type BlobRef, type CollectionName, type CollectionTypes, type LibItem } from "../types";
import type { KV } from "./kv";

export const libKey = (c: CollectionName, id: string) => `library/${c}/${id}.json`;

export function mergeItems<T extends LibItem>(a: T, b: T): T {
  return b.updatedAt > a.updatedAt ? b : a;
}

export function sameItem(a: LibItem, b: LibItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every stored file an item points at (knowledge files and their extracted text). */
export function blobRefsOfItem(item: unknown): BlobRef[] {
  const out: BlobRef[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.blobId === "string" && typeof o.name === "string") out.push({ blobId: o.blobId, name: o.name, mime: String(o.mime ?? ""), size: Number(o.size ?? 0) });
    if (typeof o.textBlobId === "string") out.push({ blobId: o.textBlobId, name: `${String(o.name ?? "text")}.txt`, mime: "text/plain", size: 0 });
    for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
  };
  walk(item);
  return out;
}

export function normalizeItem(raw: unknown): LibItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<LibItem>;
  if (typeof o.id !== "string" || !o.id) return null;
  const updatedAt = typeof o.updatedAt === "number" ? o.updatedAt : 0;
  return { ...(raw as LibItem), createdAt: typeof o.createdAt === "number" ? o.createdAt : updatedAt, updatedAt };
}

export class Library {
  private items = new Map<CollectionName, Map<string, LibItem>>();
  private listeners = new Set<() => void>();
  private clock = 0;

  constructor(public readonly kv: KV) {
    for (const c of COLLECTIONS) this.items.set(c, new Map());
  }

  async init(): Promise<void> {
    for (const c of COLLECTIONS) {
      const map = this.items.get(c)!;
      map.clear();
      for (const e of await this.kv.list(`library/${c}/`)) {
        if (!e.key.endsWith(".json")) continue;
        try {
          const item = normalizeItem(JSON.parse((await this.kv.getText(e.key)) ?? "null"));
          if (item) map.set(item.id, item);
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Live items, newest first. */
  list<C extends CollectionName>(c: C): CollectionTypes[C][] {
    return [...this.items.get(c)!.values()].filter((i) => !i.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt) as CollectionTypes[C][];
  }

  /** Including tombstones. */
  all(c: CollectionName): LibItem[] {
    return [...this.items.get(c)!.values()];
  }

  get<C extends CollectionName>(c: C, id: string | undefined): CollectionTypes[C] | undefined {
    if (!id) return undefined;
    const item = this.items.get(c)!.get(id);
    return item && !item.deletedAt ? (item as CollectionTypes[C]) : undefined;
  }

  private stamp(prev?: number): number {
    this.clock = Math.max(Date.now(), this.clock + 1, (prev ?? 0) + 1);
    return this.clock;
  }

  /** Create or update. Fields not given keep their old values. */
  async put<C extends CollectionName>(c: C, item: Partial<CollectionTypes[C]> & { id?: string }): Promise<CollectionTypes[C]> {
    const prev = item.id ? this.items.get(c)!.get(item.id) : undefined;
    const now = this.stamp(prev?.updatedAt);
    const next = { ...(prev ?? {}), ...item, id: item.id ?? uid(c.slice(0, 2)), createdAt: prev?.createdAt ?? now, updatedAt: now } as CollectionTypes[C];
    delete (next as Partial<LibItem>).deletedAt;
    await this.write(c, next);
    return next;
  }

  async remove(c: CollectionName, id: string): Promise<void> {
    const prev = this.items.get(c)!.get(id);
    if (!prev || prev.deletedAt) return;
    const now = this.stamp(prev.updatedAt);
    await this.write(c, { id, createdAt: prev.createdAt, updatedAt: now, deletedAt: now });
  }

  /** Store an item exactly as given (used by sync and import). */
  async write(c: CollectionName, item: LibItem): Promise<void> {
    await this.kv.setText(libKey(c, item.id), JSON.stringify(item));
    this.items.get(c)!.set(item.id, item);
    this.emit();
  }

  /** Merge an item from elsewhere; returns true when the local copy changed. */
  async absorb(c: CollectionName, incoming: LibItem): Promise<boolean> {
    const local = this.items.get(c)!.get(incoming.id);
    const merged = local ? mergeItems(local, incoming) : incoming;
    if (local && sameItem(merged, local)) return false;
    await this.write(c, merged);
    return true;
  }
}
