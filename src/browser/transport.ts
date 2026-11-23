// A text WebSocket to the browser's debugging port. In the app it goes
// through the native side (the web view may not open sockets to localhost);
// in tests and the browser build it is the standard WebSocket.
import { isTauri } from "../platform";

export interface Socket {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export async function openSocket(url: string): Promise<Socket> {
  if (isTauri) {
    const { default: WebSocket } = await import("@tauri-apps/plugin-websocket");
    // screenshots arrive as one large message
    const ws = await WebSocket.connect(url, { maxMessageSize: 256 << 20, maxFrameSize: 256 << 20 });
    const listeners: ((t: string) => void)[] = [];
    const closers: (() => void)[] = [];
    ws.addListener((m) => {
      if (m.type === "Text") listeners.forEach((l) => l(m.data as string));
      else if (m.type === "Close") closers.forEach((c) => c());
    });
    return {
      send: (t) => void ws.send(t),
      onMessage: (cb) => listeners.push(cb),
      onClose: (cb) => closers.push(cb),
      close: () => void ws.disconnect().catch(() => undefined),
    };
  }
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`Could not connect to the browser at ${url}`));
  });
  return {
    send: (t) => ws.send(t),
    onMessage: (cb) => ws.addEventListener("message", (e) => cb(String(e.data))),
    onClose: (cb) => ws.addEventListener("close", () => cb()),
    close: () => ws.close(),
  };
}

/** JSON-RPC over the socket: both CDP and WebDriver BiDi number their commands and answer by id. */
export class Rpc {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners: ((msg: any) => void)[] = [];
  closed = false;

  constructor(private socket: Socket, private errorOf: (msg: any) => string | null) {
    socket.onMessage((text) => {
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        const err = this.errorOf(msg);
        if (err) p.reject(new Error(`${p.method}: ${err}`));
        else p.resolve(msg.result ?? {});
        return;
      }
      for (const l of this.listeners) l(msg);
    });
    socket.onClose(() => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("The browser closed."));
      this.pending.clear();
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser is closed. Open it again."));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: the browser did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.socket.send(JSON.stringify({ id, method, params, ...extra }));
    });
  }

  on(cb: (msg: any) => void): () => void {
    this.listeners.push(cb);
    return () => (this.listeners = this.listeners.filter((l) => l !== cb));
  }

  /** resolve on the first event that matches, or after the timeout (resolves null) */
  waitFor(match: (msg: any) => boolean, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (match(m)) {
          off();
          clearTimeout(t);
          resolve(m);
        }
      });
      const t = setTimeout(() => (off(), resolve(null)), timeoutMs);
    });
  }

  close() {
    this.socket.close();
  }
}
