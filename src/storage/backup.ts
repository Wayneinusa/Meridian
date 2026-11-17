// Backup files: a zip with one JSON file per conversation plus the files those
// conversations reference. Importing MERGES into what is already on the device
// - existing chats are never replaced or removed.
import { unzipSync, zipSync, type Zippable } from "fflate";
import { COLLECTIONS, type Conversation } from "../types";
import { blobRefsOfItem, libKey, normalizeItem, type Library } from "./library";
import { utf8 } from "../util/bytes";
import { blobRefsOf, mergeConversations, normalizeConversation, sameConversation } from "./merge";
import type { Repo } from "./repo";

export const BACKUP_EXT = "meridianbackup";

export interface BackupManifest {
  app: "meridian";
  format: 1;
  exportedAt: number;
  device: string;
  conversations: number;
  blobs: number;
  library?: number;
}

export interface ImportReport {
  added: number;
  merged: number;
  unchanged: number;
  blobsAdded: number;
  skipped: number;
  /** agents, projects, prompts, memories, plugins and automations added or updated */
  library: number;
}

export async function exportBackup(
  repo: Repo,
  opts: { includeFiles?: boolean; device?: string; only?: string[]; library?: Library } = {},
): Promise<Uint8Array> {
  const includeFiles = opts.includeFiles ?? true;
  const files: Zippable = {};
  const wanted = new Set<string>();
  let count = 0;
  for (const meta of repo.allMetas()) {
    if (meta.deletedAt) continue; // deletions are not part of a backup
    if (opts.only && !opts.only.includes(meta.id)) continue;
    const conv = await repo.get(meta.id);
    if (!conv) continue;
    files[`conversations/${conv.id}.json`] = utf8.encode(JSON.stringify(conv));
    count++;
    if (includeFiles) for (const ref of blobRefsOf(conv)) wanted.add(ref.blobId);
  }
  let libCount = 0;
  if (opts.library && !opts.only) {
    for (const c of COLLECTIONS) {
      for (const item of opts.library.all(c)) {
        if (item.deletedAt) continue;
        files[libKey(c, item.id)] = utf8.encode(JSON.stringify(item));
        libCount++;
        if (includeFiles) for (const ref of blobRefsOfItem(item)) wanted.add(ref.blobId);
      }
    }
  }
  let blobs = 0;
  for (const id of wanted) {
    const bytes = await repo.getBlob(id);
    if (!bytes) continue;
    files[`blobs/${id}`] = [bytes, { level: 0 }];
    blobs++;
  }
  const manifest: BackupManifest = {
    app: "meridian",
    format: 1,
    exportedAt: Date.now(),
    device: opts.device ?? "unknown",
    conversations: count,
    blobs,
    library: libCount,
  };
  files["manifest.json"] = utf8.encode(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

export function readManifest(zipBytes: Uint8Array): BackupManifest {
  const entries = unzipSync(zipBytes, { filter: (f) => f.name === "manifest.json" });
  const raw = entries["manifest.json"];
  if (!raw) throw new Error("This is not a Meridian backup (manifest.json is missing).");
  const m = JSON.parse(utf8.decode(raw)) as BackupManifest;
  if (m.app !== "meridian") throw new Error("This is not a Meridian backup.");
  if (m.format !== 1) throw new Error(`Backup format ${m.format} is newer than this app understands. Update the app first.`);
  return m;
}

export async function importBackup(repo: Repo, zipBytes: Uint8Array, library?: Library): Promise<ImportReport> {
  readManifest(zipBytes);
  const entries = unzipSync(zipBytes);
  const report: ImportReport = { added: 0, merged: 0, unchanged: 0, blobsAdded: 0, skipped: 0, library: 0 };

  const have = await repo.blobIds();
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith("blobs/")) continue;
    const id = name.slice("blobs/".length);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || have.has(id)) continue;
    await repo.kv.setBytes(`blobs/${id}`, bytes);
    report.blobsAdded++;
  }

  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith("conversations/") || !name.endsWith(".json")) continue;
    let incoming: Conversation | null = null;
    try {
      incoming = normalizeConversation(JSON.parse(utf8.decode(bytes)));
    } catch {
      incoming = null;
    }
    if (!incoming || incoming.deletedAt) {
      report.skipped++;
      continue;
    }
    const local = await repo.get(incoming.id);
    if (!local) {
      await repo.save(incoming);
      report.added++;
      continue;
    }
    if (local.deletedAt) {
      // Deleted here, present in the backup: the user is explicitly importing it, so bring it back.
      await repo.save({ ...incoming, updatedAt: Math.max(incoming.updatedAt, local.deletedAt + 1) });
      report.added++;
      continue;
    }
    const merged = mergeConversations(local, incoming);
    if (sameConversation(merged, local)) {
      report.unchanged++;
    } else {
      await repo.save(merged);
      report.merged++;
    }
  }
  if (library) {
    for (const [name, bytes] of Object.entries(entries)) {
      const m = /^library\/([a-z]+)\/[^/]+\.json$/.exec(name);
      if (!m || !COLLECTIONS.includes(m[1] as (typeof COLLECTIONS)[number])) continue;
      try {
        const item = normalizeItem(JSON.parse(utf8.decode(bytes)));
        if (item && !item.deletedAt && (await library.absorb(m[1] as (typeof COLLECTIONS)[number], item))) report.library++;
      } catch {
        report.skipped++;
      }
    }
  }
  await repo.flush();
  return report;
}
