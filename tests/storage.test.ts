import { describe, expect, it } from "vitest";
import { exportBackup, importBackup, readManifest } from "../src/storage/backup";
import { MemoryKV } from "../src/storage/kv";
import { mergeConversations, sameConversation } from "../src/storage/merge";
import { Repo } from "../src/storage/repo";
import { emptySyncState, syncWithRemote } from "../src/storage/sync";
import type { Conversation, Message } from "../src/types";

const msg = (id: string, t: number, text: string, role: "user" | "assistant" = "user", updatedAt = t): Message => ({
  id,
  role,
  createdAt: t,
  updatedAt,
  parts: [{ type: "text", text }],
});
const conv = (id: string, updatedAt: number, messages: Message[], extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: "t-" + id,
  createdAt: 1,
  updatedAt,
  messages,
  removed: {},
  ...extra,
});
async function newRepo() {
  const r = new Repo(new MemoryKV());
  await r.init();
  return r;
}

describe("mergeConversations", () => {
  it("unions messages from both sides in time order", () => {
    const a = conv("c", 10, [msg("m1", 1, "hi"), msg("m2", 2, "from A")]);
    const b = conv("c", 20, [msg("m1", 1, "hi"), msg("m3", 3, "from B")], { title: "renamed" });
    const m = mergeConversations(a, b);
    expect(m.messages.map((x) => x.id)).toEqual(["m1", "m2", "m3"]);
    expect(m.title).toBe("renamed");
    expect(m.updatedAt).toBe(20);
  });

  it("is commutative and idempotent", () => {
    const a = conv("c", 10, [msg("m1", 1, "hi"), msg("m2", 2, "A")], { removed: { x: 5 } });
    const b = conv("c", 20, [msg("m1", 1, "hi edited", "user", 9), msg("m3", 3, "B")]);
    const ab = mergeConversations(a, b);
    const ba = mergeConversations(b, a);
    expect(sameConversation(ab, ba)).toBe(true);
    expect(sameConversation(mergeConversations(ab, a), ab)).toBe(true);
    expect((ab.messages[0].parts[0] as { text: string }).text).toBe("hi edited");
  });

  it("keeps removed messages removed", () => {
    const a = conv("c", 10, [msg("m1", 1, "q"), msg("m2", 2, "old answer", "assistant")]);
    const b = conv("c", 20, [msg("m1", 1, "q"), msg("m4", 4, "new answer", "assistant")], { removed: { m2: 15 } });
    expect(mergeConversations(a, b).messages.map((x) => x.id)).toEqual(["m1", "m4"]);
  });

  it("lets a delete win unless the other side was edited afterwards", () => {
    const live = conv("c", 10, [msg("m1", 1, "hi")]);
    const dead = conv("c", 20, [], { deletedAt: 20 });
    expect(mergeConversations(live, dead).deletedAt).toBe(20);
    const revived = conv("c", 30, [msg("m1", 1, "hi"), msg("m2", 25, "more")]);
    const m = mergeConversations(revived, dead);
    expect(m.deletedAt).toBeUndefined();
    expect(m.messages).toHaveLength(2);
  });
});

describe("backup", () => {
  it("round-trips conversations and files", async () => {
    const src = await newRepo();
    const ref = await src.putBlob(new Uint8Array([1, 2, 3]), "image/png", "a.png");
    const c = conv("c1", 10, [{ ...msg("m1", 1, "look"), parts: [{ type: "attachment", ...ref }] }]);
    await src.save(c);
    const zip = await exportBackup(src, { device: "pc" });
    expect(readManifest(zip)).toMatchObject({ conversations: 1, blobs: 1, device: "pc" });

    const dst = await newRepo();
    const r = await importBackup(dst, zip);
    expect(r).toMatchObject({ added: 1, merged: 0, blobsAdded: 1 });
    expect(Array.from((await dst.getBlob(ref.blobId))!)).toEqual([1, 2, 3]);
    expect(sameConversation((await dst.get("c1"))!, c)).toBe(true);
  });

  it("merges into existing chats without replacing them", async () => {
    const windows = await newRepo();
    await windows.save(conv("shared", 10, [msg("m1", 1, "hi"), msg("m2", 2, "typed on windows")]));
    await windows.save(conv("win-only", 5, [msg("w1", 1, "windows chat")]));
    const zip = await exportBackup(windows);

    const iphone = await newRepo();
    await iphone.save(conv("shared", 20, [msg("m1", 1, "hi"), msg("m3", 3, "typed on iphone")]));
    await iphone.save(conv("phone-only", 7, [msg("p1", 1, "phone chat")]));

    const r = await importBackup(iphone, zip);
    expect(r).toMatchObject({ added: 1, merged: 1, unchanged: 0 });
    expect(iphone.list().map((m) => m.id).sort()).toEqual(["phone-only", "shared", "win-only"]);
    expect((await iphone.get("shared"))!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect((await iphone.get("phone-only"))!.messages).toHaveLength(1);

    // importing the same file again changes nothing
    const again = await importBackup(iphone, zip);
    expect(again).toMatchObject({ added: 0, merged: 0, unchanged: 2, blobsAdded: 0 });
  });

  it("never deletes: tombstones are not exported, and a backup restores a chat deleted locally", async () => {
    const a = await newRepo();
    await a.save(conv("keep", 10, [msg("m1", 1, "hi")]));
    await a.save(conv("gone", 10, [msg("m1", 1, "bye")]));
    const before = await exportBackup(a);
    await a.delete("gone", 50);
    const after = await exportBackup(a);
    expect(readManifest(after).conversations).toBe(1);

    const b = await newRepo();
    await b.save(conv("gone", 10, [msg("m1", 1, "bye")]));
    await importBackup(b, after);
    expect(b.list().map((m) => m.id).sort()).toEqual(["gone", "keep"]);

    await importBackup(a, before);
    expect(a.list().map((m) => m.id).sort()).toEqual(["gone", "keep"]);
  });

  it("rejects files that are not backups", async () => {
    const r = await newRepo();
    await expect(importBackup(r, new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

describe("folder sync", () => {
  it("converges two devices through a shared folder", async () => {
    const cloud = new MemoryKV();
    const pc = await newRepo();
    const phone = await newRepo();
    const pcState = emptySyncState("cloud");
    const phoneState = emptySyncState("cloud");

    const ref = await pc.putBlob(new Uint8Array([9, 9]), "application/pdf", "doc.pdf");
    await pc.save(conv("a", 10, [{ ...msg("m1", 1, "from pc"), parts: [{ type: "attachment", ...ref }] }]));
    await phone.save(conv("b", 11, [msg("p1", 1, "from phone")]));

    expect(await syncWithRemote(pc, cloud, pcState)).toMatchObject({ pushed: 1, blobsUp: 1, errors: [] });
    expect(await syncWithRemote(phone, cloud, phoneState)).toMatchObject({ pulled: 1, pushed: 1, blobsDown: 1 });
    expect(await syncWithRemote(pc, cloud, pcState)).toMatchObject({ pulled: 1 });
    expect(pc.list().map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(phone.list().map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(Array.from((await phone.getBlob(ref.blobId))!)).toEqual([9, 9]);

    // quiet sync does no work
    expect(await syncWithRemote(pc, cloud, pcState)).toMatchObject({ pulled: 0, pushed: 0, blobsUp: 0, blobsDown: 0 });
    expect(await syncWithRemote(phone, cloud, phoneState)).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it("merges concurrent edits and propagates deletes", async () => {
    const cloud = new MemoryKV();
    const pc = await newRepo();
    const phone = await newRepo();
    const s1 = emptySyncState("cloud");
    const s2 = emptySyncState("cloud");
    await pc.save(conv("a", 10, [msg("m1", 1, "start")]));
    await syncWithRemote(pc, cloud, s1);
    await syncWithRemote(phone, cloud, s2);

    const onPc = (await pc.get("a"))!;
    await pc.save({ ...onPc, updatedAt: 20, messages: [...onPc.messages, msg("m2", 15, "pc edit")] });
    const onPhone = (await phone.get("a"))!;
    await phone.save({ ...onPhone, updatedAt: 21, messages: [...onPhone.messages, msg("m3", 16, "phone edit")] });

    await syncWithRemote(pc, cloud, s1);
    await syncWithRemote(phone, cloud, s2);
    await syncWithRemote(pc, cloud, s1);
    for (const r of [pc, phone]) expect((await r.get("a"))!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);

    await phone.delete("a", 100);
    await syncWithRemote(phone, cloud, s2);
    await syncWithRemote(pc, cloud, s1);
    expect(pc.list()).toHaveLength(0);
  });

  it("folds in iCloud conflict copies", async () => {
    const cloud = new MemoryKV();
    const pc = await newRepo();
    await cloud.setText("conversations/a.json", JSON.stringify(conv("a", 10, [msg("m1", 1, "one")])));
    await cloud.setText("conversations/a 2.json", JSON.stringify(conv("a", 12, [msg("m2", 2, "two")])));
    await syncWithRemote(pc, cloud, emptySyncState("cloud"));
    expect((await pc.get("a"))!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((await cloud.list("conversations/")).map((e) => e.key)).toEqual(["conversations/a.json"]);
    expect(JSON.parse((await cloud.getText("conversations/a.json"))!).messages).toHaveLength(2);
  });
});
