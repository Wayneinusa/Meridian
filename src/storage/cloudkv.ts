// Chat sync through Google Drive and OneDrive. Both implement the same small
// key/value interface as the iCloud / folder sync, so the merge logic (which
// never overwrites a chat, only combines) is shared.
//
//   OneDrive      the app's own folder (Apps/<app name>), through Microsoft Graph
//   Google Drive  a "Meridian" folder in My Drive that only this app can see
//                 (drive.file scope)
import { accessToken, deviceSignIn, forgetTokens, saveTokens, type DeviceCode, type OAuthTokens } from "../connectors/oauth";
import { httpFetch, readError } from "../platform/http";
import type { CloudSync } from "../types";
import { utf8 } from "../util/bytes";
import type { KV, KVEntry } from "./kv";

export const cloudTokenId = (provider: CloudSync["provider"]) => `sync.${provider}`;
export const CLOUD_NAMES: Record<CloudSync["provider"], string> = { google: "Google Drive", onedrive: "OneDrive" };

export const GOOGLE_SYNC_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
export const ONEDRIVE_SYNC_SCOPES = ["Files.ReadWrite.AppFolder", "User.Read", "offline_access"];

type Token = (force?: boolean) => Promise<string>;

function tokenFor(provider: CloudSync["provider"]): Token {
  return async (force = false) => {
    const t = await accessToken(cloudTokenId(provider), force);
    if (!t) throw new Error(`Signed out of ${CLOUD_NAMES[provider]}. Sign in again in Settings → Sync & backup.`);
    return t;
  };
}

/** fetch with the bearer token; on 401 refresh once and retry */
async function authed(token: Token, url: string, init: RequestInit = {}): Promise<Response> {
  const go = async (t: string) => httpFetch(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${t}` } });
  let res = await go(await token());
  if (res.status === 401) res = await go(await token(true));
  return res;
}

async function fail(res: Response, what: string): Promise<never> {
  throw new Error(`${what}: ${await readError(res)}`);
}

// ---------------------------------------------------------------- OneDrive

const GRAPH = "https://graph.microsoft.com/v1.0/me/drive/special/approot";
const enc = (key: string) => key.split("/").filter(Boolean).map(encodeURIComponent).join("/");

export class OneDriveKV implements KV {
  constructor(private token: Token = tokenFor("onedrive"), private base = GRAPH) {}
  async getBytes(key: string) {
    const res = await authed(this.token, `${this.base}:/${enc(key)}:/content`);
    if (res.status === 404) return null;
    if (!res.ok) await fail(res, `OneDrive read ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async getText(key: string) {
    const b = await this.getBytes(key);
    return b ? utf8.decode(b) : null;
  }
  async setBytes(key: string, value: Uint8Array) {
    const res = await authed(this.token, `${this.base}:/${enc(key)}:/content`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: value as BodyInit });
    if (!res.ok) await fail(res, `OneDrive write ${key}`);
  }
  async setText(key: string, value: string) {
    await this.setBytes(key, utf8.encode(value));
  }
  async remove(key: string) {
    const res = await authed(this.token, `${this.base}:/${enc(key)}:`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) await fail(res, `OneDrive delete ${key}`);
  }
  async list(prefix: string): Promise<KVEntry[]> {
    const folder = enc(prefix);
    let url: string | undefined = `${this.base}${folder ? `:/${folder}:` : ""}/children?$select=name,size,lastModifiedDateTime,file&$top=1000`;
    const out: KVEntry[] = [];
    while (url) {
      const res = await authed(this.token, url);
      if (res.status === 404) return [];
      if (!res.ok) await fail(res, `OneDrive list ${prefix}`);
      const j = (await res.json()) as { value: { name: string; size?: number; lastModifiedDateTime?: string; file?: unknown }[]; "@odata.nextLink"?: string };
      for (const it of j.value ?? []) {
        if (!it.file) continue;
        out.push({ key: prefix + it.name, size: it.size, mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : undefined });
      }
      url = j["@odata.nextLink"];
    }
    return out;
  }
}

// ---------------------------------------------------------------- Google Drive

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  modifiedTime?: string;
}

export class GoogleDriveKV implements KV {
  private folders = new Map<string, string | null>();
  private listings = new Map<string, Map<string, DriveFile>>();
  constructor(private token: Token = tokenFor("google"), private rootName = "Meridian", private api = DRIVE, private upload = UPLOAD) {}

  private async findFolder(name: string, parent: string): Promise<string | null> {
    const query = `name='${q(name)}' and mimeType='${FOLDER}' and '${parent}' in parents and trashed=false`;
    const res = await authed(this.token, `${this.api}/files?q=${encodeURIComponent(query)}&orderBy=createdTime&fields=files(id)&pageSize=10&spaces=drive`);
    if (!res.ok) await fail(res, "Google Drive");
    const j = (await res.json()) as { files: { id: string }[] };
    // two devices may have created the folder at the same moment: always use the oldest
    return j.files?.[0]?.id ?? null;
  }

  private async makeFolder(name: string, parent: string): Promise<string> {
    const res = await authed(this.token, `${this.api}/files?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
    if (!res.ok) await fail(res, "Google Drive: creating a folder");
    return ((await res.json()) as { id: string }).id;
  }

  /** Drive id of a folder path ("" = the Meridian folder). */
  private async folder(path: string, create: boolean): Promise<string | null> {
    const key = path.replace(/\/+$/, "");
    if (this.folders.has(key) && (this.folders.get(key) || !create)) return this.folders.get(key)!;
    let parent: string;
    if (!key) {
      const id = (await this.findFolder(this.rootName, "root")) ?? (create ? await this.makeFolder(this.rootName, "root") : null);
      this.folders.set("", id);
      return id;
    }
    const up = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
    const name = key.slice(key.lastIndexOf("/") + 1);
    const p = await this.folder(up, create);
    if (!p) return null;
    parent = p;
    const id = (await this.findFolder(name, parent)) ?? (create ? await this.makeFolder(name, parent) : null);
    this.folders.set(key, id);
    return id;
  }

  private async listing(folderId: string): Promise<Map<string, DriveFile>> {
    const cached = this.listings.get(folderId);
    if (cached) return cached;
    const files = new Map<string, DriveFile>();
    let page: string | undefined;
    do {
      const query = `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER}'`;
      const res = await authed(this.token, `${this.api}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=1000&spaces=drive${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      if (!res.ok) await fail(res, "Google Drive list");
      const j = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
      for (const f of j.files ?? []) {
        const prev = files.get(f.name);
        // duplicates (two devices writing a new file at once): the newest wins
        if (!prev || Date.parse(f.modifiedTime ?? "") > Date.parse(prev.modifiedTime ?? "")) files.set(f.name, f);
      }
      page = j.nextPageToken;
    } while (page);
    this.listings.set(folderId, files);
    return files;
  }

  private split(key: string): { dir: string; name: string } {
    const i = key.lastIndexOf("/");
    return { dir: i < 0 ? "" : key.slice(0, i), name: key.slice(i + 1) };
  }

  async list(prefix: string): Promise<KVEntry[]> {
    const id = await this.folder(prefix, false);
    if (!id) return [];
    return [...(await this.listing(id)).values()].map((f) => ({ key: prefix + f.name, size: f.size ? Number(f.size) : undefined, mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined }));
  }

  async getBytes(key: string) {
    const { dir, name } = this.split(key);
    const id = await this.folder(dir, false);
    if (!id) return null;
    const f = (await this.listing(id)).get(name);
    if (!f) return null;
    const res = await authed(this.token, `${this.api}/files/${f.id}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) await fail(res, `Google Drive read ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getText(key: string) {
    const b = await this.getBytes(key);
    return b ? utf8.decode(b) : null;
  }

  async setBytes(key: string, value: Uint8Array) {
    const { dir, name } = this.split(key);
    const folderId = (await this.folder(dir, true))!;
    const files = await this.listing(folderId);
    const existing = files.get(name);
    let res: Response;
    if (existing) {
      res = await authed(this.token, `${this.upload}/files/${existing.id}?uploadType=media&fields=id,name,size,modifiedTime`, { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: value as BodyInit });
    } else {
      const boundary = `meridian${Math.random().toString(36).slice(2)}`;
      const head = utf8.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = utf8.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + value.length + tail.length);
      body.set(head, 0);
      body.set(value, head.length);
      body.set(tail, head.length + value.length);
      res = await authed(this.token, `${this.upload}/files?uploadType=multipart&fields=id,name,size,modifiedTime`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: body as BodyInit });
    }
    if (!res.ok) await fail(res, `Google Drive write ${key}`);
    const f = (await res.json()) as DriveFile;
    files.set(name, { ...f, name });
  }

  async setText(key: string, value: string) {
    await this.setBytes(key, utf8.encode(value));
  }

  async remove(key: string) {
    const { dir, name } = this.split(key);
    const id = await this.folder(dir, false);
    if (!id) return;
    const files = await this.listing(id);
    const f = files.get(name);
    if (!f) return;
    const res = await authed(this.token, `${this.api}/files/${f.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) await fail(res, `Google Drive delete ${key}`);
    files.delete(name);
  }
}

export function cloudKV(cfg: CloudSync): KV {
  return cfg.provider === "google" ? new GoogleDriveKV() : new OneDriveKV();
}

// ---------------------------------------------------------------- sign-in

export async function cloudSignIn(cfg: CloudSync, onCode: (c: DeviceCode) => void, signal?: AbortSignal): Promise<{ tokens: OAuthTokens; account: string }> {
  const google = cfg.provider === "google";
  const tenant = cfg.tenant?.trim() || "common";
  const tokens = await deviceSignIn({
    deviceEndpoint: google ? "https://oauth2.googleapis.com/device/code" : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
    tokenEndpoint: google ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: cfg.clientId.trim(),
    clientSecret: google ? cfg.clientSecret?.trim() || undefined : undefined,
    scopes: google ? GOOGLE_SYNC_SCOPES : ONEDRIVE_SYNC_SCOPES,
    onCode,
    signal,
  });
  await saveTokens(cloudTokenId(cfg.provider), tokens);
  let account = CLOUD_NAMES[cfg.provider];
  try {
    if (google) {
      const res = await httpFetch(`${DRIVE}/about?fields=user(displayName,emailAddress)`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const j = await res.json();
      account = j.user?.emailAddress ?? j.user?.displayName ?? account;
    } else {
      const res = await httpFetch("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const j = await res.json();
      account = j.mail ?? j.userPrincipalName ?? j.displayName ?? account;
    }
  } catch {
    /* the name is only for display */
  }
  return { tokens, account };
}

export const cloudSignOut = (provider: CloudSync["provider"]) => forgetTokens(cloudTokenId(provider));
