// Connectors: a Model Context Protocol client. Remote servers are reached over
// Streamable HTTP on every platform; local servers (a command that speaks MCP
// on stdin/stdout) run on desktop through the native shell.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, isTauri, platform } from "../platform";
import { httpFetch, readError } from "../platform/http";
import { getSecret, mcpTokenName } from "../platform/secrets";
import { sseEvents } from "../providers/common";
import type { BlobRef, McpServerConfig } from "../types";
import { base64ToBytes } from "../util/bytes";
import type { Tool, ToolContext, ToolOutput } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

interface Transport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId: string | null = null;
  negotiated: string | null = null;
  constructor(private url: string, private headers: Record<string, string>) {}

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    if (this.negotiated) h["MCP-Protocol-Version"] = this.negotiated;
    return h;
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await httpFetch(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The connector refused access (${res.status}). Check its access token in Settings → Connectors.`);
    }
    if (!res.ok) throw new Error(await readError(res));
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      for await (const ev of sseEvents(res, signal)) {
        let msg: RpcResponse;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (msg.id === id) return unwrap(msg);
      }
      throw new Error("The connector closed the stream without answering.");
    }
    return unwrap((await res.json()) as RpcResponse);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await httpFetch(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* nothing to drain */
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await httpFetch(this.url, { method: "DELETE", headers: this.baseHeaders() });
    } catch {
      /* best effort */
    }
  }
}

class StdioTransport implements Transport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private unlisten: UnlistenFn | null = null;
  constructor(private cfg: McpServerConfig) {}

  async start(): Promise<void> {
    this.unlisten = await listen<{ id: string; line?: string; closed?: boolean; stderr?: string }>("mcp-stdio", (event) => {
      const p = event.payload;
      if (p.id !== this.cfg.id) return;
      if (p.closed) {
        for (const w of this.pending.values()) w.reject(new Error(`The connector process exited.${p.stderr ? ` ${p.stderr.slice(-400)}` : ""}`));
        this.pending.clear();
        return;
      }
      if (!p.line) return;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(p.line);
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const w = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        try {
          w.resolve(unwrap(msg));
        } catch (e) {
          w.reject(e as Error);
        }
      }
    });
    await invoke("mcp_stdio_start", { id: this.cfg.id, command: this.cfg.command, args: this.cfg.args ?? [], env: this.cfg.env ?? {} });
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The connector did not answer "${method}" within 120 seconds.`));
      }, 120_000);
      const finish = <T,>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
      invoke("mcp_stdio_send", { id: this.cfg.id, line: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await invoke("mcp_stdio_send", { id: this.cfg.id, line: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }

  async close(): Promise<void> {
    this.unlisten?.();
    try {
      await invoke("mcp_stdio_stop", { id: this.cfg.id });
    } catch {
      /* already gone */
    }
  }
}

function unwrap(msg: RpcResponse): unknown {
  if (msg.error) throw new Error(msg.error.message || `Connector error ${msg.error.code}`);
  return msg.result;
}

export class McpClient {
  private transport: Transport | null = null;
  tools: McpToolInfo[] = [];
  serverName = "";

  constructor(public readonly cfg: McpServerConfig) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.cfg.transport === "stdio") {
      if (!isTauri || !platform().desktop) throw new Error("Local (command) connectors only run in the desktop app.");
      if (!this.cfg.command) throw new Error("No command configured.");
      const t = new StdioTransport(this.cfg);
      await t.start();
      this.transport = t;
    } else {
      if (!this.cfg.url) throw new Error("No URL configured.");
      const headers: Record<string, string> = { ...(this.cfg.headers ?? {}) };
      const token = await getSecret(mcpTokenName(this.cfg.id));
      if (token) headers.Authorization = `Bearer ${token}`;
      this.transport = new HttpTransport(this.cfg.url, headers);
    }
    const init = (await this.transport.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Meridian", version: "0.1.0" } },
      signal,
    )) as { protocolVersion?: string; serverInfo?: { name?: string } };
    if (this.transport instanceof HttpTransport) this.transport.negotiated = init.protocolVersion ?? PROTOCOL_VERSION;
    this.serverName = init.serverInfo?.name ?? this.cfg.name;
    await this.transport.notify("notifications/initialized");

    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.transport.request("tools/list", cursor ? { cursor } : {}, signal)) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  async call(name: string, args: unknown, ctx: ToolContext): Promise<ToolOutput> {
    if (!this.transport) throw new Error("Connector is not connected.");
    const res = (await this.transport.request("tools/call", { name, arguments: args ?? {} }, ctx.signal)) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const texts: string[] = [];
    const images: BlobRef[] = [];
    for (const c of res.content ?? []) {
      if (c.type === "text" && c.text) texts.push(c.text);
      else if (c.type === "image" && c.data) {
        images.push(await ctx.saveBlob(base64ToBytes(c.data), c.mimeType ?? "image/png", `connector-image-${images.length + 1}.${(c.mimeType ?? "image/png").split("/")[1]}`));
      } else if (c.type === "resource" && c.resource) {
        texts.push(c.resource.text ?? `[resource ${c.resource.uri ?? ""}]`);
      } else if (c.type === "resource_link") {
        texts.push(`[link] ${(c as { uri?: string }).uri ?? ""}`);
      }
    }
    if (!texts.length && res.structuredContent !== undefined) texts.push(JSON.stringify(res.structuredContent, null, 2));
    return { text: texts.join("\n\n") || "(no output)", isError: res.isError === true, images: images.length ? images : undefined };
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "server";
}

export interface ConnectorStatus {
  state: "idle" | "connecting" | "ready" | "error";
  error?: string;
  tools: McpToolInfo[];
}

/** Keeps one live client per enabled connector and exposes their tools to the agent. */
class McpManager {
  private clients = new Map<string, { key: string; client: McpClient; ready: Promise<void> }>();
  status = new Map<string, ConnectorStatus>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  private ensure(cfg: McpServerConfig): { client: McpClient; ready: Promise<void> } {
    const key = JSON.stringify([cfg.transport, cfg.url, cfg.headers, cfg.command, cfg.args, cfg.env, cfg.hasToken]);
    const existing = this.clients.get(cfg.id);
    if (existing && existing.key === key) return existing;
    if (existing) void existing.client.close();
    const client = new McpClient(cfg);
    this.status.set(cfg.id, { state: "connecting", tools: [] });
    this.emit();
    const ready = client.connect().then(
      () => {
        this.status.set(cfg.id, { state: "ready", tools: client.tools });
        this.emit();
      },
      (e) => {
        this.status.set(cfg.id, { state: "error", error: e instanceof Error ? e.message : String(e), tools: [] });
        this.clients.delete(cfg.id);
        this.emit();
      },
    );
    const entry = { key, client, ready };
    this.clients.set(cfg.id, entry);
    return entry;
  }

  /** Drop the cached connection so the next use reconnects (after editing a connector). */
  async reset(id: string): Promise<void> {
    const e = this.clients.get(id);
    this.clients.delete(id);
    this.status.delete(id);
    if (e) await e.client.close();
    this.emit();
  }

  async connect(cfg: McpServerConfig): Promise<ConnectorStatus> {
    await this.reset(cfg.id);
    await this.ensure(cfg).ready;
    return this.status.get(cfg.id) ?? { state: "error", error: "unknown", tools: [] };
  }

  async tools(servers: McpServerConfig[]): Promise<Tool[]> {
    const out: Tool[] = [];
    const used = new Set<string>();
    await Promise.all(
      servers
        .filter((s) => s.enabled)
        .map(async (cfg) => {
          const { client, ready } = this.ensure(cfg);
          await ready;
          if (this.status.get(cfg.id)?.state !== "ready") return;
          for (const t of client.tools) {
            let name = `mcp__${slug(cfg.name)}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
            while (used.has(name)) name = name.slice(0, 60) + "_" + used.size;
            used.add(name);
            out.push({
              group: "connectors",
              title: `${cfg.name}: ${t.annotations?.title ?? t.name}`,
              spec: {
                name,
                description: `[${cfg.name} connector] ${t.description ?? t.name}`.slice(0, 1024),
                inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
              },
              // connector tools reach outside services: ask unless the user trusts this connector
              needsApproval: () => !cfg.trusted,
              summarize: (i) => `${cfg.name} → ${t.name}(${JSON.stringify(i).slice(0, 160)})`,
              run: (input, ctx) => client.call(t.name, input, ctx),
            });
          }
        }),
    );
    return out.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }
}

export const mcpManager = new McpManager();
