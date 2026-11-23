// One browser per chat that uses it, launched on first use and kept open
// until the chat closes it (or the app quits). The browser runs with its own
// profile: the user's own browser, logins and history are never touched.
import { invoke, isTauri } from "../platform";
import type { Settings } from "../types";
import { BidiDriver, CdpDriver, type Driver } from "./drivers";
import type { RefInfo } from "./page";

export interface BrowserSession {
  driver: Driver;
  /** native process id (0 when not launched by the app) */
  pid: number;
  refs: Record<string, RefInfo>;
  url: string;
  title: string;
  /** the field typed into last, so pressing Enter there can be recognised as a submit */
  lastTyped?: number;
}

export interface BrowserView {
  url: string;
  title: string;
  /** data URL of the latest screenshot */
  image?: string;
  engine: Driver["kind"];
}

interface Status {
  chromium: string | null;
  chromium_version: string | null;
  firefox: string | null;
  platform: string;
}

const sessions = new Map<string, BrowserSession>();
const listeners = new Set<(convId: string, view: BrowserView | null) => void>();

export function onBrowserView(cb: (convId: string, view: BrowserView | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function emitView(convId: string, view: BrowserView | null) {
  for (const l of listeners) l(convId, view);
}

export const sessionOf = (convId: string) => sessions.get(convId);

export const browserStatus = () => invoke<Status>("browser_status");

/** Tests (and the browser build) plug in their own way to get a driver. */
type Factory = (settings: Settings) => Promise<{ driver: Driver; pid: number }>;
let factory: Factory | null = null;
export function setBrowserFactory(f: Factory | null) {
  factory = f;
}

export interface LaunchHelpers {
  ask(question: string, options: string[]): Promise<string | null>;
  progress(note: string): void;
}

async function launch(settings: Settings, help: LaunchHelpers): Promise<{ driver: Driver; pid: number }> {
  if (factory) return factory(settings);
  if (!isTauri) throw new Error("The browser agent needs the installed desktop app.");
  const engine = settings.browser?.engine ?? "chromium";
  const status = await browserStatus();
  if (engine === "firefox" && !status.firefox) {
    throw new Error("Firefox is not installed on this computer. Install it from mozilla.org, or switch the browser to Meridian's Chromium in Settings → Tools & computer → Browser.");
  }
  if (engine === "chromium" && !status.chromium) {
    const answer = await help.ask("Meridian's own browser (Chromium, about 150 MB) has to be downloaded once before the assistant can browse. Download it now?", ["Download", "Not now"]);
    if (answer !== "Download") throw new Error("The browser is not downloaded. The user can download it in Settings → Tools & computer → Browser.");
    const stop = await listenInstall(help.progress);
    try {
      await invoke<string>("browser_install_chromium");
    } finally {
      stop();
    }
  }
  help.progress("starting the browser");
  const launched = await invoke<{ id: number; ws_url: string }>("browser_launch", { kind: engine, exe: null, headless: !(settings.browser?.showWindow ?? true) });
  const driver = engine === "firefox" ? await BidiDriver.connect(launched.ws_url) : await CdpDriver.connect(launched.ws_url);
  return { driver, pid: launched.id };
}

export async function listenInstall(onNote: (note: string) => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ stage: string; done: number; total: number }>("browser-install", (e) => {
    const { stage, done, total } = e.payload;
    onNote(stage === "downloading" && total ? `downloading the browser ${Math.round((done / total) * 100)}%` : stage);
  });
}

export async function getSession(convId: string, settings: Settings, help: LaunchHelpers): Promise<BrowserSession> {
  const s = sessions.get(convId);
  if (s) return s;
  const { driver, pid } = await launch(settings, help);
  const session: BrowserSession = { driver, pid, refs: {}, url: "about:blank", title: "" };
  sessions.set(convId, session);
  return session;
}

export async function closeSession(convId: string) {
  const s = sessions.get(convId);
  if (!s) return;
  sessions.delete(convId);
  try {
    s.driver.close();
  } catch {
    /* already gone */
  }
  if (s.pid && isTauri) await invoke("browser_close", { id: s.pid }).catch(() => undefined);
  emitView(convId, null);
}

/** A broken connection (the user closed the window): forget it so the next call starts a new browser. */
export function dropSession(convId: string) {
  const s = sessions.get(convId);
  if (!s) return;
  sessions.delete(convId);
  if (s.pid && isTauri) void invoke("browser_close", { id: s.pid }).catch(() => undefined);
}
