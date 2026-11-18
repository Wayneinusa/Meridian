import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveKV, OneDriveKV } from "../src/storage/cloudkv";
import type { KV } from "../src/storage/kv";
import { MemoryKV } from "../src/storage/kv";
import { Repo } from "../src/storage/repo";
import { emptySyncState, syncWithRemote } from "../src/storage/sync";
import type { Conversation } from "../src/types";
import { utf8 } from "../src/util/bytes";

afterEach(() => vi.unstubAllGlobals());

const conv = (id: string, text: string, t: number): Conversation => ({
  id,
  title: id,
  createdAt: t,
  updatedAt: t,
  messages: [{ id: `m-${id}-${t}`, role: "user", createdAt: t, updatedAt: t, parts: [{ type: "text", text }] }],
  removed: {},
});

async function repo() {
  const r = new Repo(new MemoryKV());
  await r.init();
  return r;
}

const bytesOf = async (body: unknown): Promise<Uint8Array> => (body instanceof Uint8Array ? body : typeof body === "string" ? utf8.encode(body) : new Uint8Array(await new Response(body as BodyInit).arrayBuffer()));

/** A tiny Microsoft Graph: files under the app folder, addressed by path. */
function fakeGraph() {
  const files = new Map<string, { data: Uint8Array; mtime: number }>();
  let clock = 1000;
  const base = "https://graph.test/approot";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    const rest = decodeURIComponent(url.slice(base.length));
    const method = init.method ?? "GET";
    const m = /^:\/(.*?):(\/content|\/children.*)?$/.exec(rest) ?? (rest.startsWith("/children") ? ["", "", "/children"] : null);
    if (!m) return new Response("bad", { status: 400 });
    const path = m[1];
    if (m[2] === "/content" && method === "PUT") {
      files.set(path, { data: await bytesOf(init.body), mtime: clock++ });
      return Response.json({ name: path });
    }
    if (m[2] === "/content") {
      const f = files.get(path);
      return f ? new Response(f.data as BodyInit) : new Response("", { status: 404 });
    }
    if (method === "DELETE") return new Response(null, { status: files.delete(path) ? 204 : 404 });
    const prefix = path ? `${path}/` : "";
    const value = [...files.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([k, f]) => ({ name: k.slice(prefix.length), size: f.data.length, lastModifiedDateTime: new Date(f.mtime).toISOString(), file: {} }));
    if (!value.length && path) return new Response("", { status: 404 });
    return Response.json({ value });
  });
  return { files, kv: () => new OneDriveKV(async () => "tok", base) };
}

/** A tiny Google Drive v3 with folders, multipart uploads and media downloads. */
function fakeDrive() {
  type F = { id: string; name: string; parent: string; folder: boolean; data: Uint8Array; modifiedTime: string; createdTime: number };
  const files: F[] = [];
  let n = 0;
  const make = (name: string, parent: string, folder: boolean, data = new Uint8Array()): F => {
    const f = { id: `id${++n}`, name, parent, folder, data, modifiedTime: new Date(1000 + n).toISOString(), createdTime: n };
    files.push(f);
    return f;
  };
  const meta = (f: F) => ({ id: f.id, name: f.name, size: String(f.data.length), modifiedTime: f.modifiedTime });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname === "/drive/v3/files" && method === "GET") {
      const q = u.searchParams.get("q")!;
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const name = /name='([^']+)'/.exec(q)?.[1];
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const list = files.filter((f) => f.parent === parent && (name ? f.name === name : true) && f.folder === wantFolder).sort((a, b) => a.createdTime - b.createdTime);
      return Response.json({ files: list.map(meta) });
    }
    if (u.pathname === "/drive/v3/files" && method === "POST") {
      const b = JSON.parse(init.body as string);
      return Response.json({ id: make(b.name, b.parents[0], true).id });
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      const raw = await bytesOf(init.body);
      const text = new TextDecoder("latin1").decode(raw);
      const boundary = /boundary=(\S+)/.exec(new Headers(init.headers).get("content-type")!)![1];
      const parts = text.split(`--${boundary}`);
      const metaJson = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
      const start = text.indexOf("\r\n\r\n", text.indexOf(parts[2])) + 4;
      const end = text.lastIndexOf(`\r\n--${boundary}--`);
      return Response.json(meta(make(metaJson.name, metaJson.parents[0], false, raw.slice(start, end))));
    }
    const id = u.pathname.split("/").pop()!;
    const f = files.find((x) => x.id === id);
    if (!f) return new Response("", { status: 404 });
    if (method === "PATCH") {
      f.data = await bytesOf(init.body);
      f.modifiedTime = new Date(5000 + ++n).toISOString();
      return Response.json(meta(f));
    }
    if (method === "DELETE") {
      files.splice(files.indexOf(f), 1);
      return new Response(null, { status: 204 });
    }
    return new Response(f.data as BodyInit);
  });
  return { files, kv: () => new GoogleDriveKV(async () => "tok", "Meridian", "https://www.googleapis.com/drive/v3", "https://www.googleapis.com/upload/drive/v3") };
}

async function twoDevices(makeKv: () => KV) {
  const a = await repo();
  const b = await repo();
  await a.save(conv("c1", "from the PC", 10));
  await b.save(conv("c2", "from the iPhone", 20));
  const sa = emptySyncState("cloud");
  const sb = emptySyncState("cloud");
  await syncWithRemote(a, makeKv(), sa);
  await syncWithRemote(b, makeKv(), sb);
  await syncWithRemote(a, makeKv(), sa);
  expect(a.list().map((m) => m.id).sort()).toEqual(["c1", "c2"]);
  expect(b.list().map((m) => m.id).sort()).toEqual(["c1", "c2"]);
  // both edit the same chat: the messages are merged, nothing is replaced
  const onA = (await a.get("c1"))!;
  onA.messages.push({ id: "m-a2", role: "user", createdAt: 30, updatedAt: 30, parts: [{ type: "text", text: "A again" }] });
  onA.updatedAt = 30;
  await a.save(onA);
  const onB = (await b.get("c1"))!;
  onB.messages.push({ id: "m-b2", role: "user", createdAt: 31, updatedAt: 31, parts: [{ type: "text", text: "B again" }] });
  onB.updatedAt = 31;
  await b.save(onB);
  await syncWithRemote(a, makeKv(), sa);
  await syncWithRemote(b, makeKv(), sb);
  await syncWithRemote(a, makeKv(), sa);
  expect((await a.get("c1"))!.messages.map((m) => m.id)).toEqual(["m-c1-10", "m-a2", "m-b2"]);
  expect((await b.get("c1"))!.messages.map((m) => m.id)).toEqual(["m-c1-10", "m-a2", "m-b2"]);
}

describe("cloud drive sync", () => {
  it("OneDrive: two devices end up with the same chats", async () => {
    const g = fakeGraph();
    await twoDevices(g.kv);
    expect([...g.files.keys()].some((k) => k.startsWith("conversations/"))).toBe(true);
  });

  it("Google Drive: two devices end up with the same chats, in one Meridian folder", async () => {
    const d = fakeDrive();
    await twoDevices(d.kv);
    expect(d.files.filter((f) => f.folder && f.name === "Meridian")).toHaveLength(1);
    expect(d.files.filter((f) => !f.folder && f.name.endsWith(".json")).length).toBeGreaterThanOrEqual(2);
  });
});
