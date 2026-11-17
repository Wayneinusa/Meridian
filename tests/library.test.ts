import { describe, expect, it } from "vitest";
import { exportBackup, importBackup, readManifest } from "../src/storage/backup";
import { MemoryKV } from "../src/storage/kv";
import { Library } from "../src/storage/library";
import { mergeConversations } from "../src/storage/merge";
import { Repo } from "../src/storage/repo";
import { emptySyncState, syncWithRemote } from "../src/storage/sync";
import type { Conversation } from "../src/types";

async function device() {
  const kv = new MemoryKV();
  const repo = new Repo(kv);
  await repo.init();
  const lib = new Library(kv);
  await lib.init();
  return { kv, repo, lib };
}

describe("library", () => {
  it("creates, updates and deletes with tombstones", async () => {
    const { lib, kv } = await device();
    const a = await lib.put("agents", { name: "Editor", instructions: "Fix grammar", knowledge: [], starters: [] });
    const b = await lib.put("agents", { id: a.id, name: "Copy editor" });
    expect(b.instructions).toBe("Fix grammar");
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    await lib.remove("agents", a.id);
    expect(lib.list("agents")).toHaveLength(0);
    expect(lib.all("agents")[0].deletedAt).toBeTruthy();
    const reloaded = new Library(kv);
    await reloaded.init();
    expect(reloaded.all("agents")).toHaveLength(1);
    expect(reloaded.list("agents")).toHaveLength(0);
  });

  it("syncs between devices: later edit wins, deletes propagate, files travel", async () => {
    const cloud = new MemoryKV();
    const pc = await device();
    const phone = await device();
    const s1 = emptySyncState("cloud");
    const s2 = emptySyncState("cloud");
    const file = await pc.repo.putBlob(new Uint8Array([1, 2, 3]), "text/plain", "notes.txt");
    const proj = await pc.lib.put("projects", { name: "Launch", instructions: "Be brief", knowledge: [{ ...file, addedAt: 1 }] });
    await pc.lib.put("prompts", { title: "Summarize", content: "Summarize {{text}}", command: "sum" });
    expect(await syncWithRemote(pc.repo, cloud, s1, pc.lib)).toMatchObject({ libPushed: 2, blobsUp: 1, errors: [] });
    expect(await syncWithRemote(phone.repo, cloud, s2, phone.lib)).toMatchObject({ libPulled: 2, blobsDown: 1 });
    expect(phone.lib.list("projects")[0].name).toBe("Launch");
    expect(Array.from((await phone.repo.getBlob(file.blobId))!)).toEqual([1, 2, 3]);

    await phone.lib.put("projects", { id: proj.id, name: "Launch v2" });
    await pc.lib.remove("prompts", pc.lib.list("prompts")[0].id);
    await syncWithRemote(phone.repo, cloud, s2, phone.lib);
    await syncWithRemote(pc.repo, cloud, s1, pc.lib);
    await syncWithRemote(phone.repo, cloud, s2, phone.lib);
    for (const d of [pc, phone]) {
      expect(d.lib.list("projects")[0].name).toBe("Launch v2");
      expect(d.lib.list("prompts")).toHaveLength(0);
    }
    // quiet sync does nothing
    expect(await syncWithRemote(pc.repo, cloud, s1, pc.lib)).toMatchObject({ libPulled: 0, libPushed: 0 });
  });

  it("backs up and restores library items without replacing newer local ones", async () => {
    const src = await device();
    await src.lib.put("memories", { text: "Prefers metric units" });
    const agent = await src.lib.put("agents", { name: "Coach", instructions: "Encourage", knowledge: [], starters: ["Plan my week"] });
    const zip = await exportBackup(src.repo, { library: src.lib });
    expect(readManifest(zip).library).toBe(2);
    const dst = await device();
    const newer = await dst.lib.put("agents", { id: agent.id, name: "Coach (edited here)", instructions: "x", knowledge: [], starters: [] });
    const r = await importBackup(dst.repo, zip, dst.lib);
    expect(r.library).toBe(1);
    expect(dst.lib.get("agents", agent.id)!.name).toBe(newer.name);
    expect(dst.lib.list("memories")[0].text).toBe("Prefers metric units");
  });

  it("keeps earlier answer versions from both devices", () => {
    const base: Conversation = { id: "c", title: "t", createdAt: 1, updatedAt: 1, messages: [], removed: {} };
    const v = (id: string, at: number) => ({ id, createdAt: at, messages: [] });
    const a = { ...base, updatedAt: 5, alternates: { u1: [v("x", 2)] } };
    const b = { ...base, updatedAt: 6, alternates: { u1: [v("y", 3)], u2: [v("z", 4)] } };
    const m = mergeConversations(a, b);
    expect(m.alternates!.u1.map((x) => x.id)).toEqual(["x", "y"]);
    expect(m.alternates!.u2).toHaveLength(1);
  });
});
