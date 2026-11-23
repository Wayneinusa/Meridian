// Two ways to drive a browser, one interface:
//   Chromium  Chrome DevTools Protocol (CDP)
//   Firefox   WebDriver BiDi (the W3C standard Firefox speaks natively)
import { openSocket, Rpc, type Socket } from "./transport";

export interface Tab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface Driver {
  readonly kind: "chromium" | "firefox";
  navigate(url: string): Promise<void>;
  /** evaluate an expression that resolves to JSON text; returns the parsed value */
  evaluate<T>(expression: string): Promise<T>;
  click(x: number, y: number, opts?: { button?: "left" | "right"; count?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
  press(keys: string): Promise<void>;
  scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
  /** JPEG or PNG as base64, with its type */
  screenshot(): Promise<{ data: string; mime: string }>;
  back(): Promise<void>;
  tabs(): Promise<Tab[]>;
  newTab(url?: string): Promise<void>;
  switchTab(id: string): Promise<void>;
  /** answer HTTP authentication prompts with these credentials (undefined: cancel them) */
  setAuth(creds?: { username: string; password: string }): Promise<void>;
  close(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  text?: string;
  bidi: string;
}
const KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r", bidi: "" },
  tab: { key: "Tab", code: "Tab", vk: 9, bidi: "" },
  escape: { key: "Escape", code: "Escape", vk: 27, bidi: "" },
  esc: { key: "Escape", code: "Escape", vk: 27, bidi: "" },
  backspace: { key: "Backspace", code: "Backspace", vk: 8, bidi: "" },
  delete: { key: "Delete", code: "Delete", vk: 46, bidi: "" },
  space: { key: " ", code: "Space", vk: 32, text: " ", bidi: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38, bidi: "" },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40, bidi: "" },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, bidi: "" },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39, bidi: "" },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38, bidi: "" },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40, bidi: "" },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, bidi: "" },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39, bidi: "" },
  pageup: { key: "PageUp", code: "PageUp", vk: 33, bidi: "" },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34, bidi: "" },
  home: { key: "Home", code: "Home", vk: 36, bidi: "" },
  end: { key: "End", code: "End", vk: 35, bidi: "" },
};
const MODS: Record<string, { bit: number; def: KeyDef }> = {
  alt: { bit: 1, def: { key: "Alt", code: "AltLeft", vk: 18, bidi: "" } },
  ctrl: { bit: 2, def: { key: "Control", code: "ControlLeft", vk: 17, bidi: "" } },
  control: { bit: 2, def: { key: "Control", code: "ControlLeft", vk: 17, bidi: "" } },
  cmd: { bit: 4, def: { key: "Meta", code: "MetaLeft", vk: 91, bidi: "" } },
  meta: { bit: 4, def: { key: "Meta", code: "MetaLeft", vk: 91, bidi: "" } },
  shift: { bit: 8, def: { key: "Shift", code: "ShiftLeft", vk: 16, bidi: "" } },
};

/** "ctrl+a" -> modifiers and the main key */
export function parseKeys(combo: string): { mods: { bit: number; def: KeyDef }[]; key: KeyDef } {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const last = parts.pop() ?? "";
  const mods = parts.map((p) => {
    const m = MODS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}"`);
    return m;
  });
  const named = KEYS[last.toLowerCase()];
  if (named) return { mods, key: named };
  if ([...last].length !== 1) throw new Error(`Unknown key "${last}"`);
  const upper = last.toUpperCase();
  return { mods, key: { key: last, code: /[a-z]/i.test(last) ? `Key${upper}` : /\d/.test(last) ? `Digit${last}` : "", vk: upper.charCodeAt(0), text: last, bidi: last } };
}

const parseJson = (s: unknown) => (typeof s === "string" ? JSON.parse(s) : s);

// ---------------------------------------------------------------- Chromium (CDP)

export class CdpDriver implements Driver {
  readonly kind = "chromium" as const;
  private session = "";
  private target = "";
  private auth?: { username: string; password: string };
  private fetchOn = false;

  private constructor(private rpc: Rpc) {
    rpc.on((m) => void this.onEvent(m));
  }

  static async connect(wsUrl: string): Promise<CdpDriver> {
    return CdpDriver.over(await openSocket(wsUrl));
  }

  static async over(socket: Socket): Promise<CdpDriver> {
    const rpc = new Rpc(socket, (m) => (m.error ? (m.error.message ?? JSON.stringify(m.error)) : null));
    const d = new CdpDriver(rpc);
    const { targetInfos } = await rpc.call("Target.getTargets");
    const page = (targetInfos as { type: string; targetId: string }[]).find((t) => t.type === "page");
    const id = page?.targetId ?? (await rpc.call("Target.createTarget", { url: "about:blank" })).targetId;
    await d.attach(id);
    return d;
  }

  private send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.rpc.call<T>(method, params, { sessionId: this.session }, timeoutMs);
  }

  private async attach(targetId: string) {
    const { sessionId } = await this.rpc.call("Target.attachToTarget", { targetId, flatten: true });
    this.session = sessionId;
    this.target = targetId;
    this.fetchOn = false;
    await this.send("Page.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined);
    if (this.auth) await this.enableFetch();
  }

  private async enableFetch() {
    if (this.fetchOn) return;
    await this.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] });
    this.fetchOn = true;
  }

  private async onEvent(m: any) {
    if (m.sessionId !== this.session) return;
    if (m.method === "Fetch.requestPaused") await this.send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => undefined);
    else if (m.method === "Fetch.authRequired") {
      const response = this.auth ? { response: "ProvideCredentials", username: this.auth.username, password: this.auth.password } : { response: "CancelAuth" };
      await this.send("Fetch.continueWithAuth", { requestId: m.params.requestId, authChallengeResponse: response }).catch(() => undefined);
    }
  }

  async navigate(url: string) {
    const loaded = this.rpc.waitFor((m) => m.sessionId === this.session && (m.method === "Page.loadEventFired" || (m.method === "Page.lifecycleEvent" && m.params?.name === "networkAlmostIdle")), 30_000);
    const r = await this.send("Page.navigate", { url });
    if (r.errorText) throw new Error(`Could not open ${url}: ${r.errorText}`);
    await loaded;
    await sleep(300);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script error");
    return parseJson(r.result?.value) as T;
  }

  async click(x: number, y: number, opts: { button?: "left" | "right"; count?: number } = {}) {
    const button = opts.button ?? "left";
    const count = opts.count ?? 1;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let i = 1; i <= count; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
    }
    await sleep(250);
  }

  async insertText(text: string) {
    await this.send("Input.insertText", { text });
  }

  async press(keys: string) {
    const { mods, key } = parseKeys(keys);
    const modifiers = mods.reduce((a, m) => a | m.bit, 0);
    for (const m of mods) await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m.def.key, code: m.def.code, windowsVirtualKeyCode: m.def.vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: key.text && !modifiers ? "keyDown" : "rawKeyDown", key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, text: modifiers ? undefined : key.text, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers });
    for (const m of [...mods].reverse()) await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: m.def.key, code: m.def.code, windowsVirtualKeyCode: m.def.vk });
    await sleep(250);
  }

  async scroll(dx: number, dy: number, x = 400, y = 300) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    await sleep(300);
  }

  async screenshot() {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return { data: r.data as string, mime: "image/jpeg" };
  }

  async back() {
    const h = await this.send("Page.getNavigationHistory");
    const prev = h.entries?.[h.currentIndex - 1];
    if (!prev) throw new Error("There is no earlier page in this tab.");
    const loaded = this.rpc.waitFor((m) => m.sessionId === this.session && m.method === "Page.loadEventFired", 15_000);
    await this.send("Page.navigateToHistoryEntry", { entryId: prev.id });
    await loaded;
  }

  async tabs(): Promise<Tab[]> {
    const { targetInfos } = await this.rpc.call("Target.getTargets");
    return (targetInfos as { type: string; targetId: string; url: string; title: string }[])
      .filter((t) => t.type === "page")
      .map((t) => ({ id: t.targetId, url: t.url, title: t.title, active: t.targetId === this.target }));
  }

  async newTab(url = "about:blank") {
    const { targetId } = await this.rpc.call("Target.createTarget", { url: "about:blank" });
    await this.attach(targetId);
    if (url !== "about:blank") await this.navigate(url);
  }

  async switchTab(id: string) {
    await this.rpc.call("Target.activateTarget", { targetId: id });
    await this.attach(id);
  }

  async setAuth(creds?: { username: string; password: string }) {
    this.auth = creds;
    if (creds) await this.enableFetch();
  }

  close() {
    void this.rpc.call("Browser.close", {}, {}, 3000).catch(() => undefined);
    this.rpc.close();
  }
}

// ---------------------------------------------------------------- Firefox (WebDriver BiDi)

export class BidiDriver implements Driver {
  readonly kind = "firefox" as const;
  private context = "";
  private auth?: { username: string; password: string };
  private intercept = "";

  private constructor(private rpc: Rpc) {
    rpc.on((m) => void this.onEvent(m));
  }

  static async connect(wsUrl: string): Promise<BidiDriver> {
    return BidiDriver.over(await openSocket(wsUrl));
  }

  static async over(socket: Socket): Promise<BidiDriver> {
    const rpc = new Rpc(socket, (m) => (m.type === "error" || m.error ? `${m.error ?? "error"}: ${m.message ?? ""}`.trim() : null));
    const d = new BidiDriver(rpc);
    await rpc.call("session.new", { capabilities: {} });
    const tree = await rpc.call("browsingContext.getTree", {});
    d.context = tree.contexts?.[0]?.context ?? (await rpc.call("browsingContext.create", { type: "tab" })).context;
    await rpc.call("session.subscribe", { events: ["browsingContext.load", "network.authRequired"] });
    return d;
  }

  private async onEvent(m: any) {
    if (m.method === "network.authRequired" && m.params?.isBlocked) {
      const request = m.params.request?.request;
      const body = this.auth
        ? { request, action: "provideCredentials", credentials: { type: "password", username: this.auth.username, password: this.auth.password } }
        : { request, action: "cancel" };
      await this.rpc.call("network.continueWithAuth", body).catch(() => undefined);
    }
  }

  async navigate(url: string) {
    await this.rpc.call("browsingContext.navigate", { context: this.context, url, wait: "complete" }, {}, 45_000);
    await sleep(300);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.rpc.call("script.evaluate", { expression, target: { context: this.context }, awaitPromise: true, userActivation: true });
    if (r.type === "exception") throw new Error(r.exceptionDetails?.text ?? "script error");
    return parseJson(r.result?.value) as T;
  }

  private perform(actions: unknown[]) {
    return this.rpc.call("input.performActions", { context: this.context, actions });
  }

  async click(x: number, y: number, opts: { button?: "left" | "right"; count?: number } = {}) {
    const button = opts.button === "right" ? 2 : 0;
    const steps: unknown[] = [{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }];
    for (let i = 0; i < (opts.count ?? 1); i++) steps.push({ type: "pointerDown", button }, { type: "pointerUp", button });
    await this.perform([{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }]);
    await sleep(250);
  }

  async insertText(text: string) {
    const steps = [...text].flatMap((ch) => [{ type: "keyDown", value: ch }, { type: "keyUp", value: ch }]);
    await this.perform([{ type: "key", id: "keyboard", actions: steps }]);
  }

  async press(keys: string) {
    const { mods, key } = parseKeys(keys);
    const steps = [...mods.map((m) => ({ type: "keyDown", value: m.def.bidi })), { type: "keyDown", value: key.bidi }, { type: "keyUp", value: key.bidi }, ...[...mods].reverse().map((m) => ({ type: "keyUp", value: m.def.bidi }))];
    await this.perform([{ type: "key", id: "keyboard", actions: steps }]);
    await sleep(250);
  }

  async scroll(dx: number, dy: number, x = 400, y = 300) {
    await this.perform([{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: Math.round(x), y: Math.round(y), deltaX: Math.round(dx), deltaY: Math.round(dy) }] }]);
    await sleep(300);
  }

  async screenshot() {
    const r = await this.rpc.call("browsingContext.captureScreenshot", { context: this.context, format: { type: "image/jpeg", quality: 0.7 } });
    return { data: r.data as string, mime: "image/jpeg" };
  }

  async back() {
    await this.rpc.call("browsingContext.traverseHistory", { context: this.context, delta: -1 });
    await sleep(800);
  }

  async tabs(): Promise<Tab[]> {
    const tree = await this.rpc.call("browsingContext.getTree", { maxDepth: 0 });
    const out: Tab[] = [];
    for (const c of tree.contexts ?? []) {
      let title = "";
      try {
        const r = await this.rpc.call("script.evaluate", { expression: "document.title", target: { context: c.context }, awaitPromise: false });
        title = r.result?.value ?? "";
      } catch {
        /* a tab that is still loading */
      }
      out.push({ id: c.context, url: c.url, title, active: c.context === this.context });
    }
    return out;
  }

  async newTab(url = "about:blank") {
    const { context } = await this.rpc.call("browsingContext.create", { type: "tab" });
    this.context = context;
    if (url !== "about:blank") await this.navigate(url);
  }

  async switchTab(id: string) {
    await this.rpc.call("browsingContext.activate", { context: id });
    this.context = id;
  }

  async setAuth(creds?: { username: string; password: string }) {
    this.auth = creds;
    if (creds && !this.intercept) {
      const r = await this.rpc.call("network.addIntercept", { phases: ["authRequired"] });
      this.intercept = r.intercept;
    }
  }

  close() {
    void this.rpc.call("browser.close", {}, {}, 3000).catch(() => undefined);
    this.rpc.close();
  }
}
