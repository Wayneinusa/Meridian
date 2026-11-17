// Two-way sync between the on-device store and a folder: the app's iCloud
// container on iPhone/iPad, or any folder on a computer (point it at iCloud
// Drive on Windows and the same chats show up on your Apple devices).
//
// The folder holds exactly what a backup holds - conversations/<id>.json and
// blobs/<id> - and every write is a merge, so two devices editing at once
// never overwrite each other.
import { COLLECTIONS, type Conversation, type LibItem } from "../types";
import { blobRefsOfItem, libKey, normalizeItem, sameItem, type Library } from "./library";
import type { KV, KVEntry } from "./kv";
import { blobRefsOf, mergeConversations, normalizeConversation, sameConversation } from "./merge";
import { blobKey, convKey, type Repo } from "./repo";

export interface SyncState {
  /** identity of the remote this state belongs to */
  remoteId: string;
  /** remote file key -> "mtime:size" as last seen */
  seen: Record<string, string>;
  /** conversation id -> updatedAt as of the last time local and remote agreed */
  agreed: Record<string, number>;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  /** library items received / sent */
  libPulled: number;
  libPushed: number;
  blobsUp: number;
  blobsDown: number;
  errors: string[];
}

export function emptySyncState(remoteId: string): SyncState {
  return { remoteId, seen: {}, agreed: {} };
}

const stamp = (e: KVEntry) => `${e.mtime ?? 0}:${e.size ?? 0}`;

export async function syncWithRemote(repo: Repo, remote: KV, state: SyncState, library?: Library): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, pushed: 0, libPulled: 0, libPushed: 0, blobsUp: 0, blobsDown: 0, errors: [] };
  const touched = new Map<string, Conversation>();
  const touchedItems: LibItem[] = [];

  // 1. Read remote conversation files that changed since we last looked.
  const remoteFiles = (await remote.list("conversations/")).filter(
    (e) => e.key.endsWith(".json") && !basename(e.key).startsWith("."),
  );
  const remoteById = new Map<string, Conversation>();
  const remoteHasCanonical = new Set<string>();
  /** what the canonical conversations/<id>.json file itself holds (before folding in conflict copies) */
  const canonicalCopy = new Map<string, Conversation>();
  const strayKeys: string[] = [];

  for (const e of remoteFiles) {
    const idFromName = basename(e.key).replace(/\.json$/, "");
    const canonicalLooking = /^[A-Za-z0-9_-]+$/.test(idFromName);
    if (canonicalLooking) remoteHasCanonical.add(idFromName);
    const unchangedRemote = e.mtime !== undefined && state.seen[e.key] === stamp(e);
    if (unchangedRemote && canonicalLooking) {
      const meta = repo.meta(idFromName);
      if (meta && state.agreed[idFromName] === meta.updatedAt) continue; // nothing new on either side
    }
    let conv: Conversation | null = null;
    try {
      conv = normalizeConversation(JSON.parse((await remote.getText(e.key)) ?? "null"));
    } catch (err) {
      report.errors.push(`${e.key}: ${String(err)}`);
      continue;
    }
    if (!conv) continue;
    // iCloud writes "name 2.json" when two devices collide: fold those in too.
    if (e.key === convKey(conv.id)) canonicalCopy.set(conv.id, conv);
    else strayKeys.push(e.key);
    const prev = remoteById.get(conv.id);
    remoteById.set(conv.id, prev ? mergeConversations(prev, conv) : conv);
  }

  // 2. Merge remote -> local and write back whatever the remote is missing.
  for (const [id, theirs] of remoteById) {
    try {
      const mine = await repo.get(id);
      const merged = mine ? mergeConversations(mine, theirs) : theirs;
      if (!mine || !sameConversation(merged, mine)) {
        await repo.save(merged);
        report.pulled++;
      }
      const canonical = canonicalCopy.get(id);
      if (!canonical || !sameConversation(merged, canonical)) {
        await remote.setText(convKey(id), JSON.stringify(merged));
        report.pushed++;
      }
      state.agreed[id] = merged.updatedAt;
      touched.set(id, merged);
    } catch (err) {
      report.errors.push(`${id}: ${String(err)}`);
    }
  }
  for (const key of strayKeys) {
    try {
      await remote.remove(key);
    } catch {
      /* leave it, it will be merged again next time */
    }
  }

  // 3. Push local conversations the remote has not seen (or that changed since).
  for (const meta of repo.allMetas()) {
    if (touched.has(meta.id)) continue;
    if (remoteHasCanonical.has(meta.id) && state.agreed[meta.id] === meta.updatedAt) continue;
    try {
      const mine = await repo.get(meta.id);
      if (!mine) continue;
      let out = mine;
      if (remoteHasCanonical.has(meta.id)) {
        const theirs = normalizeConversation(JSON.parse((await remote.getText(convKey(meta.id))) ?? "null"));
        if (theirs) {
          out = mergeConversations(mine, theirs);
          if (!sameConversation(out, mine)) {
            await repo.save(out);
            report.pulled++;
          }
          if (sameConversation(out, theirs)) {
            state.agreed[meta.id] = out.updatedAt;
            touched.set(meta.id, out);
            continue;
          }
        }
      }
      await remote.setText(convKey(meta.id), JSON.stringify(out));
      report.pushed++;
      state.agreed[meta.id] = out.updatedAt;
      touched.set(meta.id, out);
    } catch (err) {
      report.errors.push(`${meta.id}: ${String(err)}`);
    }
  }

  // 3b. Library items: later edit wins, tombstones included.
  if (library) {
    for (const c of COLLECTIONS) {
      try {
        const remoteFiles = (await remote.list(`library/${c}/`)).filter((e) => e.key.endsWith(".json") && !basename(e.key).startsWith("."));
        const theirs = new Map<string, LibItem>();
        const strays: string[] = [];
        for (const e of remoteFiles) {
          const seenKey = `lib:${e.key}`;
          const id = basename(e.key).replace(/\.json$/, "");
          const local = library.all(c).find((i) => i.id === id);
          if (e.mtime !== undefined && state.seen[seenKey] === stamp(e) && local && state.agreed[`lib:${c}:${id}`] === local.updatedAt) {
            theirs.set(id, local);
            continue;
          }
          try {
            const item = normalizeItem(JSON.parse((await remote.getText(e.key)) ?? "null"));
            if (!item) continue;
            if (e.key !== libKey(c, item.id)) strays.push(e.key);
            const prev = theirs.get(item.id);
            theirs.set(item.id, prev && prev.updatedAt >= item.updatedAt ? prev : item);
          } catch (err) {
            report.errors.push(`${e.key}: ${String(err)}`);
          }
        }
        for (const [, item] of theirs) {
          if (await library.absorb(c, item)) {
            report.libPulled++;
            touchedItems.push(item);
          }
        }
        for (const mine of library.all(c)) {
          const there = theirs.get(mine.id);
          if (!there || !sameItem(there, mine) || !remoteFiles.some((e) => e.key === libKey(c, mine.id))) {
            if (!there || mine.updatedAt >= there.updatedAt) {
              await remote.setText(libKey(c, mine.id), JSON.stringify(mine));
              report.libPushed++;
              touchedItems.push(mine);
            }
          }
          state.agreed[`lib:${c}:${mine.id}`] = mine.updatedAt;
        }
        for (const key of strays) await remote.remove(key).catch(() => undefined);
        for (const e of await remote.list(`library/${c}/`)) state.seen[`lib:${e.key}`] = stamp(e);
      } catch (err) {
        report.errors.push(`library/${c}: ${String(err)}`);
      }
    }
  }

  // 4. Files referenced by the conversations and library items that moved.
  if (touched.size || touchedItems.length) {
    const remoteBlobs = new Set((await remote.list("blobs/")).map((e) => basename(e.key)));
    const localBlobs = await repo.blobIds();
    const refs = [...[...touched.values()].flatMap((conv) => blobRefsOf(conv)), ...touchedItems.flatMap((i) => blobRefsOfItem(i))];
    {
      for (const ref of refs) {
        try {
          const here = localBlobs.has(ref.blobId);
          const there = remoteBlobs.has(ref.blobId);
          if (here && !there) {
            const bytes = await repo.getBlob(ref.blobId);
            if (bytes) {
              await remote.setBytes(blobKey(ref.blobId), bytes);
              remoteBlobs.add(ref.blobId);
              report.blobsUp++;
            }
          } else if (!here && there) {
            const bytes = await remote.getBytes(blobKey(ref.blobId));
            if (bytes) {
              await repo.kv.setBytes(blobKey(ref.blobId), bytes);
              localBlobs.add(ref.blobId);
              report.blobsDown++;
            }
          }
        } catch (err) {
          report.errors.push(`file ${ref.name}: ${String(err)}`);
        }
      }
    }
  }

  // 5. Remember what the remote looks like now.
  const seen: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.seen)) if (k.startsWith("lib:")) seen[k] = v;
  for (const e of await remote.list("conversations/")) seen[e.key] = stamp(e);
  state.seen = seen;
  await repo.flush();
  return report;
}

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}
