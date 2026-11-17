// A tiny key/value-over-files abstraction. The same interface backs the local
// store (IndexedDB in a browser, the app data folder in the app), a sync
// folder (iCloud container / iCloud Drive / any folder), and tests.
import { createStore, del, get, keys, set, type UseStore } from "idb-keyval";
import { invoke, joinPath } from "../platform";
import { base64ToBytes, bytesToBase64, utf8 } from "../util/bytes";

export interface KVEntry {
  key: string;
  size?: number;
  mtime?: number;
}

export interface KV {
  getText(key: string): Promise<string | null>;
  setText(key: string, value: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
  setBytes(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  /** entries directly under `prefix` (which ends in "/") */
  list(prefix: string): Promise<KVEntry[]>;
}

export class MemoryKV implements KV {
  data = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  private clock = 1;
  async getText(key: string) {
    const v = this.data.get(key);
    return v ? utf8.decode(v) : null;
  }
  async setText(key: string, value: string) {
    await this.setBytes(key, utf8.encode(value));
  }
  async getBytes(key: string) {
    return this.data.get(key) ?? null;
  }
  async setBytes(key: string, value: Uint8Array) {
    this.data.set(key, value);
    this.mtimes.set(key, this.clock++);
  }
  async remove(key: string) {
    this.data.delete(key);
    this.mtimes.delete(key);
  }
  async list(prefix: string) {
    const out: KVEntry[] = [];
    for (const [key, v] of this.data) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
        out.push({ key, size: v.length, mtime: this.mtimes.get(key) });
      }
    }
    return out;
  }
}

export class IdbKV implements KV {
  private store: UseStore;
  constructor(name = "meridian") {
    this.store = createStore(name, "kv");
  }
  async getText(key: string) {
    const v = await get<string | Uint8Array>(key, this.store);
    if (v == null) return null;
    return typeof v === "string" ? v : utf8.decode(v);
  }
  async setText(key: string, value: string) {
    await set(key, value, this.store);
  }
  async getBytes(key: string) {
    const v = await get<string | Uint8Array>(key, this.store);
    if (v == null) return null;
    return typeof v === "string" ? utf8.encode(v) : v;
  }
  async setBytes(key: string, value: Uint8Array) {
    await set(key, value, this.store);
  }
  async remove(key: string) {
    await del(key, this.store);
  }
  async list(prefix: string) {
    const all = (await keys(this.store)) as string[];
    return all
      .filter((k) => typeof k === "string" && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((key) => ({ key }));
  }
}

interface NativeEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
}

/** Files under a directory on disk, through the app's native file commands. */
export class FsKV implements KV {
  constructor(public readonly baseDir: string) {}
  private path(key: string) {
    return joinPath(this.baseDir, ...key.split("/"));
  }
  async getText(key: string) {
    try {
      return await invoke<string>("fs_read_text", { path: this.path(key) });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async setText(key: string, value: string) {
    await invoke("fs_write_text", { path: this.path(key), content: value });
  }
  async getBytes(key: string) {
    try {
      const b64 = await invoke<string>("fs_read_b64", { path: this.path(key) });
      return base64ToBytes(b64);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
  async setBytes(key: string, value: Uint8Array) {
    await invoke("fs_write_b64", { path: this.path(key), data: bytesToBase64(value) });
  }
  async remove(key: string) {
    try {
      await invoke("fs_remove", { path: this.path(key) });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  async list(prefix: string) {
    const dir = this.path(prefix.replace(/\/$/, ""));
    let entries: NativeEntry[];
    try {
      entries = await invoke<NativeEntry[]>("fs_list", { path: dir });
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    return entries
      .filter((e) => !e.is_dir)
      .map((e) => ({ key: prefix + e.name, size: e.size, mtime: e.modified_ms }));
  }
}

function isNotFound(e: unknown): boolean {
  return /not found|no such file|cannot find|os error 2\b|os error 3\b/i.test(String(e));
}
