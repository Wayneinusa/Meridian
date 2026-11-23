// App state: settings, chats, the library (agents, projects, prompts,
// memories, plugins, automations), sync and backup. The agent loop itself
// lives in agent/engine.ts; this file supplies it with UI hooks.
import { create } from "zustand";
import { contextOf, currentRef, runTurn, suggestTitle, type EngineHost } from "../agent/engine";
import { initPlatform, invoke, isTauri, joinPath, platform } from "../platform";
import { saveFile } from "../platform/files";
import { notify } from "../platform/notify";
import { deleteSecret, getSecret, providerKeyName, setSecret } from "../platform/secrets";
import { GALLERY } from "../plugins/gallery";
import type { PluginDraft } from "../plugins/import";
import { pluginSecretName } from "../plugins/runtime";
import { engineProviders, runPluginEngine } from "../plugins/engines";
import { pickDefaultMedia, setPluginEngineRunner } from "../providers/media";
import { adapterFor, allProviders, findModel, manualModel, mergeModelLists, setPluginProviders } from "../providers/registry";
import type { BlobAccess } from "../providers/types";
import { wakeModel, type WakeResult } from "../providers/wake";
import { BACKUP_EXT, exportBackup, importBackup } from "../storage/backup";
import { FsKV, IdbKV, type KV } from "../storage/kv";
import { Library } from "../storage/library";
import { blobRefsOf, emptyConversation } from "../storage/merge";
import { blobKey, Repo } from "../storage/repo";
import { emptySyncState, syncWithRemote, type SyncState } from "../storage/sync";
import { CLOUD_NAMES, cloudKV, cloudSignIn, cloudSignOut } from "../storage/cloudkv";
import { accessToken, type DeviceCode } from "../connectors/oauth";
import { accountFromTokens, signInWithX, signOutOfX, XAI_TOKEN_ID } from "../providers/xai";
import { chatToHtml, chatToMarkdown, detectAndImport } from "../storage/transfer";
import { extractText } from "../tools/extract";
import { buildDocx, buildPdf } from "../tools/files";
import { nativeTools } from "../connectors/native";
import { bankTools } from "../connectors/banks";
import { mcpManager } from "../tools/mcp";
import { mediaModelFor, noMediaModelMessage } from "../tools/media";
import type { PermissionPreview, Tool } from "../tools/types";
import { killComputerUse, rearmComputerUse } from "../tools/computer-use";
import { closeSession, onBrowserView, type BrowserView } from "../browser/session";
import type {
  Agent,
  BlobRef,
  CloudSync,
  CollectionName,
  CollectionTypes,
  Conversation,
  ConvMeta,
  KnowledgeFile,
  McpServerConfig,
  MediaOptions,
  Message,
  ModelParams,
  ModelRef,
  Part,
  Plugin,
  Project,
  Settings,
  TurnVersion,
} from "../types";
import { COLLECTIONS, uid } from "../types";
import { bytesToBase64, formatBytes, mimeFromName, safeFileName, utf8 } from "../util/bytes";
import { defaultSettings, migrateSettings } from "./defaults";

export interface PermissionRequest {
  id: string;
  convId: string;
  toolName: string;
  title: string;
  summary: string;
  detail: string;
  group: Tool["group"];
  /** the tool call this is for, so the card can sit next to it in the chat */
  callId?: string;
  /** computer use: the screenshot with where the action lands */
  preview?: PermissionPreview;
  /** offer "Allow for this task" (computer use, browser) */
  allowTask?: boolean;
  resolve(decision: "deny" | "once" | "always" | "task"): void;
}

export interface QuestionRequest {
  id: string;
  convId: string;
  question: string;
  options: string[];
  multiple: boolean;
  resolve(answer: string | null): void;
}

export interface Toast {
  id: string;
  kind: "info" | "ok" | "error";
  text: string;
}

export interface SyncStatus {
  state: "off" | "idle" | "syncing" | "error";
  target?: string;
  at?: number;
  message?: string;
}

export type View =
  | { name: "chat" }
  | { name: "agents" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "prompts" }
  | { name: "automations" }
  | { name: "usage" }
  | { name: "search" };

export type LibState = { [C in CollectionName]: CollectionTypes[C][] };

export interface Draft {
  model?: ModelRef;
  params?: ModelParams;
  media?: MediaOptions;
  chatModel?: ModelRef;
  mediaModels?: { image?: ModelRef; video?: ModelRef };
  agentId?: string;
  projectId?: string;
  mode?: "chat" | "research";
  workFolder?: string;
}

interface State {
  ready: boolean;
  settings: Settings;
  metas: ConvMeta[];
  activeId: string | null;
  active: Conversation | null;
  /** conversation id -> short status while it is generating */
  busy: Record<string, string>;
  /** approvals waiting for the user (shown inside the chat they belong to) */
  permissions: PermissionRequest[];
  /** questions the assistant asked (shown inside the chat) */
  questions: QuestionRequest[];
  toasts: Toast[];
  sync: SyncStatus;
  sidebarOpen: boolean;
  settingsTab: string | null;
  paramsOpen: boolean;
  preview: BlobRef | null;
  composerInbox: { parts: Extract<Part, { type: "attachment" }>[]; text?: string; seq: number };
  draft: Draft;
  view: View;
  lib: LibState;
  /** the open chat is private: never saved or synced */
  incognito: boolean;
  showArchived: boolean;
  /** user message id whose versions are shown side by side */
  compareOpen: string | null;
  artifactsOpen: boolean;
  /** the assistant's browser in each chat that used it (for the browser panel) */
  browserViews: Record<string, BrowserView>;
  browserOpen: boolean;
}

const emptyLib = (): LibState => ({ agents: [], projects: [], prompts: [], memories: [], plugins: [], automations: [] });

export const useApp = create<State>(() => ({
  ready: false,
  settings: defaultSettings(),
  metas: [],
  activeId: null,
  active: null,
  busy: {},
  permissions: [],
  questions: [],
  toasts: [],
  sync: { state: "off" },
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth > 860 : true,
  settingsTab: null,
  paramsOpen: false,
  preview: null,
  composerInbox: { parts: [], seq: 0 },
  draft: {},
  view: { name: "chat" },
  lib: emptyLib(),
  incognito: false,
  showArchived: false,
  compareOpen: null,
  artifactsOpen: false,
  browserViews: {},
  browserOpen: false,
}));

const set = useApp.setState;
const get = useApp.getState;

let kv: KV;
export let repo: Repo;
export let library: Library;
const live = new Map<string, Conversation>();
const privateIds = new Set<string>();
const aborts = new Map<string, AbortController>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const keyCache = new Map<string, string>();
const b64Cache = new Map<string, string>();

// ---------------------------------------------------------------- helpers

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = uid("t");
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 9000 : 4500);
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

function refreshMetas() {
  set({ metas: repo.list() });
}

function refreshLib() {
  const lib = emptyLib();
  for (const c of COLLECTIONS) (lib as Record<string, unknown>)[c] = library.list(c);
  // plugins that make images / videos show up as backends
  setPluginProviders(engineProviders(lib.plugins));
  set({ lib });
}

// the browser panel follows the assistant's browser
onBrowserView((convId, view) => {
  const views = { ...get().browserViews };
  if (view) views[convId] = view;
  else delete views[convId];
  // open the panel the first time a chat's browser shows a page
  const first = !!view && !get().browserViews[convId] && convId === get().activeId;
  set({ browserViews: views, ...(first ? { browserOpen: true } : {}) });
});

setPluginEngineRunner((req, kind) => runPluginEngine(req, kind, { plugins: () => library.list("plugins"), getSecret: async (n) => getSecret(n) }));

let renderQueued = false;
function render(id: string) {
  if (get().activeId !== id || renderQueued) return;
  renderQueued = true;
  const flush = () => {
    renderQueued = false;
    const c = live.get(get().activeId ?? "");
    if (c) set({ active: { ...c, messages: c.messages.slice() } });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function saveSoon(id: string, delay = 1200) {
  if (saveTimers.has(id) || privateIds.has(id)) return;
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      void saveNow(id);
    }, delay),
  );
}

async function saveNow(id: string) {
  const t = saveTimers.get(id);
  if (t) {
    clearTimeout(t);
    saveTimers.delete(id);
  }
  const c = live.get(id);
  if (!c || privateIds.has(id)) return;
  try {
    await repo.save(c);
    refreshMetas();
  } catch (e) {
    toast(`Could not save the chat: ${errText(e)}`, "error");
  }
}

function touch(c: Conversation) {
  c.updatedAt = Math.max(Date.now(), c.updatedAt + 1);
}

function nextMessageTime(c: Conversation): number {
  const last = c.messages[c.messages.length - 1];
  return Math.max(Date.now(), (last?.createdAt ?? 0) + 1);
}

function setBusy(id: string, note: string | null) {
  set((s) => {
    const busy = { ...s.busy };
    if (note === null) delete busy[id];
    else busy[id] = note;
    return { busy };
  });
}

export const getSecretValue = (name: string) => getSecret(name);

// ---------------------------------------------------------------- startup

const startupHooks: (() => void | Promise<void>)[] = [];
/** Modules that need to run after the stores are ready (automations, connectors) register here. */
export function onReady(fn: () => void | Promise<void>) {
  if (get().ready) void fn();
  else startupHooks.push(fn);
}

export async function init() {
  const p = await initPlatform();
  kv = isTauri && p.dataDir ? new FsKV(joinPath(p.dataDir, "store")) : new IdbKV();
  repo = new Repo(kv);
  library = new Library(kv);
  await Promise.all([repo.init(), library.init()]);
  let settings = defaultSettings();
  let fresh = true;
  try {
    const raw = await kv.getText("settings.json");
    if (raw) {
      settings = migrateSettings(JSON.parse(raw));
      fresh = false;
    }
  } catch {
    /* fall back to defaults */
  }
  if (!p.desktop) settings.tools.computer = false;
  if (!settings.deviceName) settings.deviceName = p.hostname || p.os;
  library.onChange(() => refreshLib());
  refreshLib();
  set({ settings, metas: repo.list(), ready: true, sync: { state: syncTarget(settings) ? "idle" : "off", target: syncTarget(settings)?.label } });
  applyTheme(settings.theme);
  applyAppearance(settings);
  if (fresh) await kv.setText("settings.json", JSON.stringify(settings));
  const first = repo.list().find((m) => !m.archived);
  if (first) await openChat(first.id);
  for (const fn of startupHooks.splice(0)) void fn();
  void syncNow(true);
  setInterval(() => {
    if (get().settings.sync.auto) void syncNow(true);
  }, 60_000);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && get().settings.sync.auto) void syncNow(true);
    });
  }
}

export function applyTheme(theme: Settings["theme"]) {
  if (typeof document === "undefined") return;
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function applyAppearance(s: Settings) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-size", `${s.appearance.fontSize}px`);
  document.documentElement.dataset.width = s.appearance.width;
}

export async function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  const cur = get().settings;
  const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
  set({ settings: next });
  if (next.theme !== cur.theme) applyTheme(next.theme);
  if (next.appearance !== cur.appearance) applyAppearance(next);
  const target = syncTarget(next);
  if (get().sync.target !== target?.label) set({ sync: { state: target ? "idle" : "off", target: target?.label } });
  await kv.setText("settings.json", JSON.stringify(next));
}

export function setView(view: View) {
  set({ view });
  if (typeof window !== "undefined" && window.innerWidth <= 860) set({ sidebarOpen: false });
}

// ---------------------------------------------------------------- providers & keys

export async function getKey(providerId: string): Promise<string> {
  let k = keyCache.get(providerId);
  if (k === undefined) {
    k = (await getSecret(providerKeyName(providerId))) ?? "";
    keyCache.set(providerId, k);
  }
  // Grok signed in with X and no key: the sign-in token works for xAI's image, video and voice APIs too
  if (!k) {
    const p = get().settings.providers.find((x) => x.id === providerId);
    if (p?.kind === "xai" && p.signedIn) return (await accessToken(XAI_TOKEN_ID)) ?? "";
  }
  return k;
}

/** Ctrl+Alt+Esc anywhere (desktop): stop every running task and block mouse/keyboard input at once. */
export function emergencyStop() {
  killComputerUse();
  for (const id of Object.keys(get().busy)) stop(id);
  toast("Stopped: computer use is blocked until you send a new message.", "info");
}

/** Sign in with X for Grok: in the browser (desktop) or with a code (any device). */
export async function signInGrok(providerId: string, mode: "browser" | "device", onCode?: (c: DeviceCode) => void, signal?: AbortSignal) {
  const tokens = await signInWithX(mode, onCode, signal);
  const who = accountFromTokens(tokens);
  await updateSettings((s) => ({ providers: s.providers.map((p) => (p.id === providerId ? { ...p, signedIn: true, signedInAs: who } : p)) }));
  try {
    await refreshModels(providerId);
  } catch (e) {
    toast(`Signed in, but the model list could not be loaded: ${errText(e)}`, "error");
  }
}

export async function signOutGrok(providerId: string) {
  await signOutOfX();
  await updateSettings((s) => ({ providers: s.providers.map((p) => (p.id === providerId ? { ...p, signedIn: false, signedInAs: undefined } : p)) }));
}

export async function saveProviderKey(providerId: string, key: string) {
  const trimmed = key.trim();
  if (trimmed) await setSecret(providerKeyName(providerId), trimmed);
  else await deleteSecret(providerKeyName(providerId));
  keyCache.set(providerId, trimmed);
  await updateSettings((s) => ({ providers: s.providers.map((p) => (p.id === providerId ? { ...p, hasKey: !!trimmed } : p)) }));
}

export async function refreshModels(providerId: string): Promise<number> {
  const provider = get().settings.providers.find((p) => p.id === providerId);
  if (!provider) return 0;
  const fresh = await adapterFor(provider.kind).listModels(provider, await getKey(providerId));
  await updateSettings((s) => ({
    providers: s.providers.map((p) => (p.id === providerId ? { ...p, models: mergeModelLists(p.models, fresh) } : p)),
  }));
  return fresh.length;
}

/** Add a model the provider does not list (for example one that is cold and needs waking up). */
export async function addManualModel(providerId: string, modelId: string, kind?: "chat" | "image" | "video") {
  const id = modelId.trim();
  if (!id) return;
  await updateSettings((s) => ({
    providers: s.providers.map((p) => (p.id !== providerId ? p : { ...p, models: [manualModel(id, kind), ...p.models.filter((m) => m.id !== id)] })),
  }));
}

export async function removeModel(providerId: string, modelId: string) {
  await updateSettings((s) => ({ providers: s.providers.map((p) => (p.id === providerId ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p)) }));
}

const wakes = new Map<string, AbortController>();

export async function wakeUp(providerId: string, modelId: string, onStatus: (note: string) => void): Promise<WakeResult> {
  const found = findModel(get().settings, { providerId, modelId });
  if (!found) throw new Error("That model is not in the list.");
  wakes.get(`${providerId}::${modelId}`)?.abort();
  const abort = new AbortController();
  wakes.set(`${providerId}::${modelId}`, abort);
  try {
    return await wakeModel(found.provider, await getKey(providerId), found.model, { signal: abort.signal, onStatus });
  } finally {
    wakes.delete(`${providerId}::${modelId}`);
  }
}

export function cancelWake(providerId: string, modelId: string) {
  wakes.get(`${providerId}::${modelId}`)?.abort();
}

export function currentModelRef(conv?: Conversation | null): ModelRef | undefined {
  const s = get().settings;
  if (conv) {
    const { agent, project } = contextOf(host, conv);
    return currentRef(s, conv, agent, project);
  }
  const d = get().draft;
  const agent = library?.get("agents", d.agentId);
  const project = library?.get("projects", d.projectId);
  const pseudo = { model: d.model } as Conversation;
  return currentRef(s, pseudo, agent, project);
}

export async function toggleFavorite(ref: ModelRef) {
  const key = `${ref.providerId}::${ref.modelId}`;
  await updateSettings((s) => ({ favorites: s.favorites.includes(key) ? s.favorites.filter((k) => k !== key) : [...s.favorites, key] }));
}

// ---------------------------------------------------------------- conversations

export async function openChat(id: string) {
  let c = live.get(id);
  if (!c) {
    const loaded = await repo.get(id);
    if (!loaded || loaded.deletedAt) return;
    c = loaded;
    live.set(id, c);
  }
  set({ activeId: id, active: { ...c, messages: c.messages.slice() }, paramsOpen: false, view: { name: "chat" }, incognito: privateIds.has(id), compareOpen: null });
  if (typeof window !== "undefined" && window.innerWidth <= 860) set({ sidebarOpen: false });
}

export function newChat(opts: { agentId?: string; projectId?: string; incognito?: boolean; mode?: "chat" | "research" } = {}) {
  const project = opts.projectId ? library.get("projects", opts.projectId) : undefined;
  set({
    activeId: null,
    active: null,
    paramsOpen: false,
    draft: { agentId: opts.agentId ?? project?.agentId, projectId: opts.projectId, mode: opts.mode, workFolder: project?.workFolder },
    view: { name: "chat" },
    incognito: !!opts.incognito,
    compareOpen: null,
  });
  if (typeof window !== "undefined" && window.innerWidth <= 860) set({ sidebarOpen: false });
}

function ensureConversation(): Conversation {
  const id = get().activeId;
  if (id && live.has(id)) return live.get(id)!;
  const c = emptyConversation(uid("c"), Date.now());
  const d = get().draft;
  c.model = d.model;
  c.params = d.params;
  c.media = d.media;
  c.chatModel = d.chatModel;
  c.mediaModels = d.mediaModels;
  c.agentId = d.agentId;
  c.projectId = d.projectId;
  c.mode = d.mode;
  c.workFolder = d.workFolder;
  if (!c.model) {
    const agent = library.get("agents", c.agentId);
    const project = library.get("projects", c.projectId);
    if (!agent?.model && !project?.model) c.model = currentModelRef(null);
  }
  if (get().incognito) privateIds.add(c.id);
  set({ draft: {} });
  live.set(c.id, c);
  set({ activeId: c.id, active: { ...c } });
  return c;
}

const setDraft = (patch: Partial<Draft>) => set((s) => ({ draft: { ...s.draft, ...patch } }));

/** Change something about the open chat (or the draft, when no chat exists yet). */
function patchChat(patch: Partial<Conversation>, draftPatch?: Partial<Draft>) {
  const c = live.get(get().activeId ?? "");
  if (!c) {
    setDraft((draftPatch ?? patch) as Partial<Draft>);
    return;
  }
  Object.assign(c, patch);
  touch(c);
  render(c.id);
  saveSoon(c.id, 300);
}

export async function setChatModel(ref: ModelRef) {
  const settings = get().settings;
  const kind = findModel(settings, ref)?.model.kind ?? "chat";
  const c = live.get(get().activeId ?? "");
  const current = currentModelRef(c ?? null);
  const curKind = findModel(settings, current)?.model.kind ?? "chat";
  if (!c) {
    const d = get().draft;
    setDraft({ model: ref, ...(kind !== "chat" && curKind === "chat" ? { chatModel: current } : {}), ...(kind !== "chat" ? { mediaModels: { ...d.mediaModels, [kind]: ref } } : {}) });
  } else {
    if (kind !== "chat" && curKind === "chat") c.chatModel = current;
    if (kind !== "chat") c.mediaModels = { ...c.mediaModels, [kind]: ref };
    c.model = ref;
    touch(c);
    render(c.id);
    await saveNow(c.id);
  }
  if (kind === "chat") await updateSettings({ defaultModel: ref });
  // the first image / video backend someone picks becomes the default; after that "Make default" changes it
  else if (kind === "image" && !findModel(settings, settings.imageModel)) await updateSettings({ imageModel: ref });
  else if (kind === "video" && !findModel(settings, settings.videoModel)) await updateSettings({ videoModel: ref });
}

/** The image / video backend new chats start with. */
export async function setDefaultMedia(kind: "image" | "video", ref: ModelRef | undefined) {
  await updateSettings(kind === "image" ? { imageModel: ref } : { videoModel: ref });
}

/** Chat / Image / Video switch in the composer. */
export async function setChatMode(mode: "chat" | "image" | "video"): Promise<boolean> {
  const settings = get().settings;
  const c = live.get(get().activeId ?? "");
  if (mode === "chat") {
    const back = (c ? c.chatModel : get().draft.chatModel) ?? settings.defaultModel;
    const ref = back && findModel(settings, back)?.model.kind === "chat" ? back : undefined;
    const fallback = ref ?? settings.providers.flatMap((p) => p.models.filter((m) => m.kind === "chat").map((m) => ({ providerId: p.id, modelId: m.id })))[0];
    if (!fallback) return false;
    await setChatModel(fallback);
    return true;
  }
  // already in this mode: keep the backend chosen for this chat
  if (findModel(settings, currentModelRef(c ?? null))?.model.kind === mode) return true;
  const remembered = (c ? c.mediaModels : get().draft.mediaModels)?.[mode];
  const ref = remembered && findModel(settings, remembered) ? remembered : mediaModelFor(settings, mode);
  if (!ref) {
    toast(noMediaModelMessage(mode), "error");
    return false;
  }
  await setChatModel(ref);
  return true;
}

export const setChatMedia = (media: MediaOptions) => patchChat({ media });
export const setChatParams = (params: ModelParams | undefined) => patchChat({ params: params && Object.keys(params).length ? params : undefined });
export const setChatSystemPrompt = (text: string) => patchChat({ systemPrompt: text || undefined });
export const setResearchMode = (on: boolean) => patchChat({ mode: on ? "research" : undefined }, { mode: on ? "research" : undefined });
export const setWorkFolder = (folder: string | undefined) => patchChat({ workFolder: folder });
export const setChatAgent = (agentId: string | undefined) => patchChat({ agentId });

/** Put files (or text) into the composer. */
export function attachToComposer(refs: BlobRef[], text?: string) {
  set((s) => ({
    composerInbox: { parts: refs.map((r) => ({ type: "attachment" as const, blobId: r.blobId, name: r.name, mime: r.mime, size: r.size })), text, seq: s.composerInbox.seq + 1 },
  }));
}

async function withConv(id: string, fn: (c: Conversation) => void | Promise<void>) {
  const c = live.get(id) ?? (await repo.get(id));
  if (!c) return;
  live.set(id, c);
  await fn(c);
  touch(c);
  render(id);
  await saveNow(id);
}

export const renameChat = (id: string, title: string) => withConv(id, (c) => void (c.title = title.trim() || "Untitled chat"));
export const togglePin = (id: string) => withConv(id, (c) => void (c.pinned = !c.pinned));
export const setArchived = (id: string, archived: boolean) => withConv(id, (c) => void (c.archived = archived || undefined));
export const moveToProject = (id: string, projectId: string | undefined) => withConv(id, (c) => void (c.projectId = projectId));
export const setTags = (id: string, tags: string[]) => withConv(id, (c) => void (c.tags = tags.length ? tags : undefined));

export async function deleteChat(id: string) {
  stop(id);
  void closeSession(id);
  const doomed = live.get(id) ?? (await repo.get(id));
  live.delete(id);
  if (privateIds.has(id)) {
    privateIds.delete(id);
  } else {
    await repo.delete(id);
    if (doomed) for (const ref of blobRefsOf(doomed)) await kv.remove(blobKey(ref.blobId)).catch(() => undefined);
  }
  refreshMetas();
  if (get().activeId === id) set({ activeId: null, active: null });
  scheduleSync();
}

/** Make the open private chat a normal saved chat. */
export async function keepPrivateChat() {
  const id = get().activeId;
  if (!id || !privateIds.has(id)) return;
  privateIds.delete(id);
  set({ incognito: false });
  await saveNow(id);
}

/** A new chat with the messages up to and including `messageId`. */
export async function forkChat(messageId: string) {
  const c = live.get(get().activeId ?? "");
  if (!c) return;
  const i = c.messages.findIndex((m) => m.id === messageId);
  if (i < 0) return;
  const now = Date.now();
  const fork = emptyConversation(uid("c"), now);
  Object.assign(fork, { title: `${c.title} (fork)`, model: c.model, params: c.params, agentId: c.agentId, projectId: c.projectId, systemPrompt: c.systemPrompt, workFolder: c.workFolder, forkedFrom: { convId: c.id, messageId } });
  fork.messages = c.messages.slice(0, i + 1).map((m, k) => ({ ...structuredClone(m), id: uid("m"), createdAt: now + k, updatedAt: now + k }));
  live.set(fork.id, fork);
  await repo.save(fork);
  refreshMetas();
  await openChat(fork.id);
  toast("Forked into a new chat.", "ok");
}

// ---------------------------------------------------------------- attachments

export async function attachFile(file: File): Promise<Extract<Part, { type: "attachment" }>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || mimeFromName(file.name);
  if (bytes.length > 30 * 1024 * 1024) toast(`${file.name} is ${formatBytes(bytes.length)}. Most providers reject requests above about 30 MB, so this may fail.`, "info");
  const ref = await repo.putBlob(bytes, mime, file.name || "file");
  const part: Extract<Part, { type: "attachment" }> = { type: "attachment", ...ref };
  if (!mime.startsWith("image/") && mime !== "application/pdf" && !mime.startsWith("video/") && !mime.startsWith("audio/")) {
    const ex = await extractText(bytes, file.name, mime);
    if (ex.text != null) part.extractedText = ex.text;
    if (ex.truncated) toast(`${file.name} is very long. Only the first part of its text will be sent to the model.`, "info");
    if (ex.note) toast(ex.note, "error");
  }
  return part;
}

/** A knowledge file: stored with its extracted text so it can be searched. */
export async function makeKnowledgeFile(file: File): Promise<KnowledgeFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || mimeFromName(file.name);
  const ref = await repo.putBlob(bytes, mime, file.name || "file");
  const ex = await extractText(bytes, file.name, mime);
  if (ex.text == null) throw new Error(`${file.name}: ${ex.note ?? "no readable text in this file"}`);
  const textRef = await repo.putBlob(utf8.encode(ex.text), "text/plain", `${file.name}.txt`);
  return { ...ref, textBlobId: textRef.blobId, chars: ex.text.length, addedAt: Date.now() };
}

const blobs: BlobAccess = {
  async base64(blobId) {
    const hit = b64Cache.get(blobId);
    if (hit) return hit;
    const bytes = await repo.getBlob(blobId);
    if (!bytes) return null;
    const b64 = bytesToBase64(bytes);
    b64Cache.set(blobId, b64);
    if (b64Cache.size > 24) b64Cache.delete(b64Cache.keys().next().value as string);
    return b64;
  },
  put: (bytes, mime, name) => repo.putBlob(bytes, mime, name),
};

// ---------------------------------------------------------------- engine host

function askPermission(convId: string, tool: Tool, input: Record<string, unknown>, callId?: string, preview?: PermissionPreview): Promise<"deny" | "once" | "always" | "task"> {
  return new Promise((resolve) => {
    const req: PermissionRequest = {
      id: uid("p"),
      convId,
      callId,
      preview,
      allowTask: !!tool.allowForTask,
      toolName: tool.spec.name,
      title: tool.title,
      summary: tool.summarize(input),
      detail: JSON.stringify(input, null, 2),
      group: tool.group,
      resolve: (d) => {
        set({ permissions: get().permissions.filter((x) => x.id !== req.id) });
        resolve(d);
      },
    };
    set({ permissions: [...get().permissions, req] });
    if (typeof document !== "undefined" && document.visibilityState === "hidden" && get().settings.notifications) void notify("Meridian needs your OK", `${tool.title}: ${req.summary}`.slice(0, 180));
  });
}

function askQuestion(convId: string, question: string, options: string[], multiple: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const req: QuestionRequest = {
      id: uid("q"),
      convId,
      question,
      options,
      multiple,
      resolve: (a) => {
        set({ questions: get().questions.filter((x) => x.id !== req.id) });
        resolve(a);
      },
    };
    set({ questions: [...get().questions, req] });
    if (document.visibilityState === "hidden" && get().settings.notifications) void notify("Meridian needs your answer", question);
  });
}

/** Connector servers: the user's own plus those that came with enabled plugins. */
export function allConnectors(settings: Settings): McpServerConfig[] {
  const fromPlugins = library
    ? library.list("plugins").flatMap((p) => p.mcpServers.map((m) => ({ ...m, enabled: p.enabled, pluginId: p.id, name: m.name })))
    : [];
  return [...settings.mcpServers, ...fromPlugins];
}

export const host: EngineHost = {
  settings: () => get().settings,
  get library() {
    return library;
  },
  get repo() {
    return repo;
  },
  blobs,
  getKey,
  getSecret: (name) => getSecret(name),
  connectorTools: async (settings) => {
    const all = allConnectors(settings);
    return [...(await mcpManager.tools(all.filter((c) => c.transport !== "native"))), ...(await nativeTools(all)), ...bankTools(all, (n) => getSecret(n))];
  },
  render: (c) => render(c.id),
  save: (c, soon) => (soon ? saveSoon(c.id, 3000) : saveNow(c.id)),
  setBusy,
  askPermission,
  ask: askQuestion,
  allowAlways: (name) => updateSettings((cur) => ({ alwaysAllow: [...new Set([...cur.alwaysAllow, name])] })),
  notice: (text) => toast(text, "info"),
};

// ---------------------------------------------------------------- sending

export async function send(text: string, attachments: Part[] = [], opts: { compare?: ModelRef[] } = {}) {
  rearmComputerUse();
  const trimmed = text.trim();
  if (!trimmed && !attachments.length) return;
  const c = ensureConversation();
  if (get().busy[c.id] !== undefined) return;
  const now = nextMessageTime(c);
  const parts: Part[] = [...attachments];
  if (trimmed) parts.push({ type: "text", text: trimmed });
  const userMsg: Message = { id: uid("m"), role: "user", createdAt: now, updatedAt: now, parts };
  c.messages.push(userMsg);
  if (c.messages.length === 1) {
    const base = trimmed || (attachments[0] as BlobRef | undefined)?.name || "New chat";
    c.title = base.split("\n")[0].slice(0, 60);
  }
  touch(c);
  render(c.id);
  await saveNow(c.id);
  if (opts.compare?.length) {
    set({ compareOpen: userMsg.id });
    await Promise.all([runAgent(c.id), ...opts.compare.map((ref) => runAlternate(c, userMsg.id, ref))]);
  } else {
    await runAgent(c.id);
  }
}

/** One extra answer to the same question from another model, kept as a version. */
async function runAlternate(c: Conversation, userMsgId: string, ref: ModelRef) {
  const idx = c.messages.findIndex((m) => m.id === userMsgId);
  const clone: Conversation = { ...structuredClone({ ...c, messages: c.messages.slice(0, idx + 1) }), model: ref };
  const abort = new AbortController();
  const key = `${c.id}|${ref.providerId}::${ref.modelId}`;
  aborts.set(key, abort);
  const versionId = uid("v");
  const update = () => {
    const msgs = clone.messages.slice(idx + 1);
    const list = (c.alternates ??= {})[userMsgId] ?? (c.alternates[userMsgId] = []);
    const existing = list.find((v) => v.id === versionId);
    if (existing) existing.messages = msgs;
    else list.push({ id: versionId, createdAt: Date.now(), messages: msgs });
    touch(c);
    render(c.id);
  };
  const altHost: EngineHost = { ...host, render: () => update(), save: () => undefined, setBusy: () => undefined };
  try {
    await runTurn(altHost, clone, { signal: abort.signal, noTools: true, model: ref });
  } catch (e) {
    const now = Date.now();
    clone.messages.push({ id: uid("m"), role: "assistant", createdAt: now, updatedAt: now, parts: [], model: ref, error: errText(e) });
  } finally {
    aborts.delete(key);
    update();
    await saveNow(c.id);
  }
}

export function stop(convId?: string | null) {
  const id = convId ?? get().activeId;
  if (!id) return;
  for (const [k, a] of aborts) if (k === id || k.startsWith(`${id}|`)) a.abort();
  // Stop also halts any mouse/keyboard action in flight; the next message re-arms it
  killComputerUse();
  for (const p of get().permissions.filter((x) => x.convId === id)) p.resolve("deny");
  for (const q of get().questions.filter((x) => x.convId === id)) q.resolve(null);
}

function lastUserIndex(c: Conversation): number {
  let i = c.messages.length - 1;
  while (i >= 0 && c.messages[i].role !== "user") i--;
  return i;
}

/** Keep the current answer as a version and ask again (optionally with another model). */
export async function regenerate(model?: ModelRef) {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  const i = lastUserIndex(c);
  if (i < 0) return;
  stashTurn(c, i);
  if (model) c.model = model;
  render(c.id);
  await runAgent(c.id);
}

/** Move the answer after user message i into the version list. */
function stashTurn(c: Conversation, i: number) {
  const userId = c.messages[i].id;
  const after = c.messages.slice(i + 1);
  if (after.length) {
    const list = ((c.alternates ??= {})[userId] ??= []);
    list.push({ id: uid("v"), createdAt: Date.now(), messages: after });
  }
  const now = Date.now();
  for (const m of after) c.removed[m.id] = now;
  c.messages = c.messages.slice(0, i + 1);
  touch(c);
}

/** Show an earlier version of the answer to user message `userId`. */
export async function selectVersion(userId: string, versionId: string) {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  const i = c.messages.findIndex((m) => m.id === userId);
  const list = c.alternates?.[userId];
  const chosen = list?.find((v) => v.id === versionId);
  if (i < 0 || !list || !chosen) return;
  // only the last turn can switch (later messages depend on it)
  if (c.messages.slice(i + 1).some((m) => m.role === "user")) {
    toast("Only the latest answer can be switched. Fork the chat to continue from an older one.", "info");
    return;
  }
  stashTurn(c, i);
  c.alternates![userId] = c.alternates![userId].filter((v) => v.id !== versionId);
  // fresh ids, so deletes of the old copies on other devices do not remove them
  const now = Date.now();
  c.messages.push(...chosen.messages.map((m, k) => ({ ...structuredClone(m), id: uid("m"), createdAt: now + k, updatedAt: now + k })));
  touch(c);
  render(c.id);
  await saveNow(c.id);
}

/** Replace a user message's text, keep the old exchange as a version, and answer again. */
export async function editAndResend(messageId: string, text: string) {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  const i = c.messages.findIndex((m) => m.id === messageId);
  if (i < 0 || c.messages[i].role !== "user") return;
  const old = c.messages[i];
  const now = Date.now();
  for (const m of c.messages.slice(i)) c.removed[m.id] = now;
  c.messages = c.messages.slice(0, i);
  const t = nextMessageTime(c);
  const parts: Part[] = [...old.parts.filter((p) => p.type === "attachment"), { type: "text", text: text.trim() }];
  c.messages.push({ id: uid("m"), role: "user", createdAt: t, updatedAt: t, parts });
  touch(c);
  render(c.id);
  await runAgent(c.id);
}

export async function deleteMessage(messageId: string) {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  c.messages = c.messages.filter((m) => m.id !== messageId);
  c.removed[messageId] = Date.now();
  touch(c);
  render(c.id);
  await saveNow(c.id);
}

async function runAgent(convId: string) {
  const c = live.get(convId);
  if (!c) return;
  const abort = new AbortController();
  aborts.set(convId, abort);
  setBusy(convId, "");
  const firstAnswer = c.messages.filter((m) => m.role === "assistant").length === 0;
  try {
    await runTurn(host, c, { signal: abort.signal });
  } catch (e) {
    if (!isAbort(e)) toast(errText(e), "error");
  } finally {
    aborts.delete(convId);
    setBusy(convId, null);
    await saveNow(convId);
    scheduleSync();
    if (document.visibilityState === "hidden" && get().settings.notifications && !abort.signal.aborted) {
      const last = [...c.messages].reverse().find((m) => m.role === "assistant");
      const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
      void notify(c.title, last?.error ?? (text || "Your answer is ready."));
    }
    if (firstAnswer && get().settings.autoTitle && !abort.signal.aborted) void autoTitle(c);
  }
}

async function autoTitle(c: Conversation) {
  try {
    const title = await suggestTitle(host, c, new AbortController().signal);
    if (title && live.get(c.id) === c) {
      c.title = title;
      touch(c);
      render(c.id);
      await saveNow(c.id);
    }
  } catch {
    /* keep the first-message title */
  }
}

// ---------------------------------------------------------------- library

export async function saveItem<C extends CollectionName>(c: C, item: Partial<CollectionTypes[C]> & { id?: string }): Promise<CollectionTypes[C]> {
  const saved = await library.put(c, item);
  scheduleSync();
  return saved;
}

export async function deleteItem(c: CollectionName, id: string) {
  await library.remove(c, id);
  scheduleSync();
}

export async function addAgentFromTemplate(t: { name: string; emoji?: string; description?: string; instructions: string }): Promise<Agent> {
  return saveItem("agents", { name: t.name, emoji: t.emoji, description: t.description, instructions: t.instructions, knowledge: [], starters: [] });
}

export async function createProject(name: string): Promise<Project> {
  return saveItem("projects", { name: name.trim() || "New project", instructions: "", knowledge: [] });
}

// ---------------------------------------------------------------- plugins

export async function installPlugin(draft: PluginDraft): Promise<Plugin> {
  const existing = library.list("plugins").find((p) => p.name === draft.name && (p.sourceUrl ?? "") === (draft.sourceUrl ?? ""));
  const plugin = await saveItem("plugins", { ...draft, id: existing?.id, mcpServers: draft.mcpServers.map((m) => ({ ...m, id: m.id || uid("mcp") })) });
  // agents that ship with a plugin become ordinary agents tied to it
  for (const a of draft.agents) {
    const prev = library.list("agents").find((x) => x.pluginId === plugin.id && x.name === a.name);
    await saveItem("agents", { id: prev?.id, name: a.name, emoji: a.emoji, description: a.description, instructions: a.instructions, knowledge: prev?.knowledge ?? [], starters: prev?.starters ?? [], pluginId: plugin.id });
  }
  for (const cmd of draft.commands) void cmd;
  return plugin;
}

export async function uninstallPlugin(id: string) {
  const p = library.get("plugins", id);
  if (!p) return;
  for (const a of library.list("agents").filter((x) => x.pluginId === id)) await deleteItem("agents", a.id);
  for (const s of p.settings) if (s.secret) await deleteSecret(pluginSecretName(id, s.key));
  for (const m of p.mcpServers) await mcpManager.reset(m.id);
  await deleteItem("plugins", id);
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  await saveItem("plugins", { id, enabled });
}

export async function savePluginSetting(p: Plugin, key: string, value: string, secret: boolean) {
  if (secret) {
    if (value) await setSecret(pluginSecretName(p.id, key), value);
    else await deleteSecret(pluginSecretName(p.id, key));
    await saveItem("plugins", { id: p.id, values: { ...p.values, [key]: value ? "•" : "" } });
  } else await saveItem("plugins", { id: p.id, values: { ...p.values, [key]: value } });
}

export const galleryPlugins = () => GALLERY;

// ---------------------------------------------------------------- export / import

const modelNameOf = (m: Message) => (m.model ? (findModel(get().settings, m.model)?.model.name ?? m.model.modelId) : undefined);

export async function exportChat(format: "md" | "html" | "json" | "pdf" | "docx") {
  const c = live.get(get().activeId ?? "");
  if (!c) return;
  const name = safeFileName(c.title || "chat");
  let bytes: Uint8Array;
  let mime: string;
  if (format === "md") [bytes, mime] = [utf8.encode(chatToMarkdown(c, modelNameOf)), "text/markdown"];
  else if (format === "html") [bytes, mime] = [utf8.encode(chatToHtml(c, modelNameOf)), "text/html"];
  else if (format === "json") [bytes, mime] = [utf8.encode(JSON.stringify(c, null, 2)), "application/json"];
  else if (format === "pdf") [bytes, mime] = [await buildPdf(chatToMarkdown(c, modelNameOf), { title: c.title }), "application/pdf"];
  else [bytes, mime] = [await buildDocx(chatToMarkdown(c, modelNameOf), { title: c.title }), mimeFromName("x.docx")];
  const where = await saveFile(bytes, `${name}.${format}`, mime);
  if (where) toast(where, "ok");
}

/** ChatGPT / Claude / TypingMind exports become ordinary chats here. */
export async function importChats(file: File): Promise<number> {
  const { source, chats } = detectAndImport(await file.text());
  for (const c of chats) await repo.save(c);
  await repo.flush();
  refreshMetas();
  toast(`Imported ${chats.length} chat(s) from ${source}.`, "ok");
  scheduleSync();
  return chats.length;
}

/** Search every chat's text (titles, messages). */
export async function searchChats(query: string): Promise<{ meta: ConvMeta; snippet: string }[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: { meta: ConvMeta; snippet: string }[] = [];
  for (const meta of repo.list()) {
    if (meta.title.toLowerCase().includes(q)) {
      out.push({ meta, snippet: meta.preview ?? "" });
      continue;
    }
    const c = live.get(meta.id) ?? (await repo.get(meta.id));
    if (!c) continue;
    for (const m of c.messages) {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "attachment" || p.type === "artifact" ? p.name : "")).join(" ");
      const at = text.toLowerCase().indexOf(q);
      if (at >= 0) {
        out.push({ meta, snippet: `${at > 40 ? "…" : ""}${text.slice(Math.max(0, at - 40), at + q.length + 80).replace(/\s+/g, " ")}` });
        break;
      }
    }
    if (out.length >= 100) break;
  }
  return out;
}

export interface UsageRow {
  key: string;
  name: string;
  input: number;
  output: number;
  messages: number;
  cost?: number;
}

/** Built-in list prices (USD per million tokens) where known; users can add their own. */
const KNOWN_PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export async function usageStats(sinceDays: number): Promise<{ rows: UsageRow[]; days: { day: string; tokens: number; cost: number }[] }> {
  const since = Date.now() - sinceDays * 86_400_000;
  const rows = new Map<string, UsageRow>();
  const days = new Map<string, { tokens: number; cost: number }>();
  const prices = get().settings.prices;
  for (const meta of repo.list()) {
    if (meta.updatedAt < since) continue;
    const c = live.get(meta.id) ?? (await repo.get(meta.id));
    if (!c) continue;
    for (const m of c.messages) {
      if (m.role !== "assistant" || !m.usage || m.createdAt < since) continue;
      const key = m.model ? `${m.model.providerId}::${m.model.modelId}` : "unknown";
      const row = rows.get(key) ?? { key, name: modelNameOf(m) ?? "Unknown model", input: 0, output: 0, messages: 0 };
      row.input += m.usage.input ?? 0;
      row.output += m.usage.output ?? 0;
      row.messages++;
      const price = prices[key] ?? KNOWN_PRICES[m.model?.modelId ?? ""];
      const cost = price ? ((m.usage.input ?? 0) * price.input + (m.usage.output ?? 0) * price.output) / 1e6 : 0;
      if (price) row.cost = (row.cost ?? 0) + cost;
      rows.set(key, row);
      const day = new Date(m.createdAt).toISOString().slice(0, 10);
      const d = days.get(day) ?? { tokens: 0, cost: 0 };
      d.tokens += (m.usage.input ?? 0) + (m.usage.output ?? 0);
      d.cost += cost;
      days.set(day, d);
    }
  }
  return {
    rows: [...rows.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
    days: [...days.entries()].sort().map(([day, v]) => ({ day, ...v })),
  };
}

// ---------------------------------------------------------------- sync & backup

interface SyncTarget {
  kv: KV;
  id: string;
  label: string;
  /** where this target's sync state is kept on this device */
  stateKey: string;
}

function syncTargets(settings: Settings): SyncTarget[] {
  const out: SyncTarget[] = [];
  const p = platform();
  if (isTauri && settings.sync.icloud && p.icloudContainer) {
    const dir = joinPath(p.icloudContainer, "Documents");
    out.push({ kv: new FsKV(dir), id: `icloud:${dir}`, label: "iCloud", stateKey: "sync-state.json" });
  } else if (isTauri && settings.sync.folder) {
    out.push({ kv: new FsKV(settings.sync.folder), id: `folder:${settings.sync.folder}`, label: settings.sync.folder, stateKey: "sync-state.json" });
  }
  const cloud = settings.sync.cloud;
  if (cloud?.account) {
    out.push({ kv: cloudKV(cloud), id: `${cloud.provider}:${cloud.clientId}`, label: CLOUD_NAMES[cloud.provider], stateKey: "sync-state-cloud.json" });
  }
  return out;
}

/** Label for the sync status line ("iCloud + OneDrive"). */
function syncTarget(settings: Settings): { label: string } | null {
  const list = syncTargets(settings);
  return list.length ? { label: list.map((t) => t.label).join(" + ") } : null;
}

let syncing = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSync() {
  if (!get().settings.sync.auto || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow(true);
  }, 4000);
}

export async function syncNow(quiet = false) {
  const targets = syncTargets(get().settings);
  if (!targets.length) {
    set({ sync: { state: "off" } });
    if (!quiet) toast("Sync is not set up. Turn on iCloud, choose a folder, or sign in to Google Drive or OneDrive in Settings → Sync & backup.", "info");
    return;
  }
  if (syncing || Object.keys(get().busy).length) return;
  syncing = true;
  const label = targets.map((t) => t.label).join(" + ");
  set({ sync: { ...get().sync, state: "syncing", target: label } });
  const total = { pulled: 0, pushed: 0, libPulled: 0, libPushed: 0, errors: [] as string[] };
  try {
    for (const id of [...saveTimers.keys()]) await saveNow(id);
    // each target merges into this device, so a chat from iCloud reaches OneDrive in the same run
    for (const target of targets) {
      try {
        if (platform().icloudContainer && target.id.startsWith("icloud:")) {
          await invoke("icloud_prepare", { dir: joinPath(platform().icloudContainer!, "Documents") }).catch(() => undefined);
        }
        let state: SyncState = emptySyncState(target.id);
        try {
          const raw = await kv.getText(target.stateKey);
          const parsed = raw ? (JSON.parse(raw) as SyncState) : null;
          if (parsed && parsed.remoteId === target.id) state = parsed;
        } catch {
          /* start fresh */
        }
        const report = await syncWithRemote(repo, target.kv, state, library);
        await kv.setText(target.stateKey, JSON.stringify(state));
        total.pulled += report.pulled;
        total.pushed += report.pushed;
        total.libPulled += report.libPulled;
        total.libPushed += report.libPushed;
        total.errors.push(...report.errors.map((e) => (targets.length > 1 ? `${target.label}: ${e}` : e)));
      } catch (e) {
        total.errors.push(`${target.label}: ${errText(e)}`);
      }
    }
    if (total.pulled) {
      for (const id of [...live.keys()]) {
        if (privateIds.has(id)) continue;
        const fresh = await repo.get(id);
        if (!fresh || fresh.deletedAt) {
          live.delete(id);
          if (get().activeId === id) set({ activeId: null, active: null });
        } else live.set(id, fresh);
      }
      const a = live.get(get().activeId ?? "");
      if (a) set({ active: { ...a, messages: a.messages.slice() } });
    }
    refreshMetas();
    const message = total.errors.length ? `${total.errors.length} item(s) could not be synced: ${total.errors[0]}` : undefined;
    set({ sync: { state: total.errors.length ? "error" : "idle", target: label, at: Date.now(), message } });
    if (!quiet) {
      const moved = total.pulled + total.pushed + total.libPulled + total.libPushed;
      toast(total.errors.length ? message! : moved ? `Synced: ${total.pulled + total.libPulled} received, ${total.pushed + total.libPushed} sent.` : "Everything is up to date.", total.errors.length ? "error" : "ok");
    }
  } finally {
    syncing = false;
  }
}

/** Sign in to Google Drive or OneDrive with a code, then sync with it. */
export async function connectCloudSync(cfg: CloudSync, onCode: (c: DeviceCode) => void, signal?: AbortSignal) {
  const { account } = await cloudSignIn(cfg, onCode, signal);
  await updateSettings((s) => ({ sync: { ...s.sync, cloud: { provider: cfg.provider, clientId: cfg.clientId.trim(), tenant: cfg.tenant?.trim() || undefined, account } } }));
  toast(`Signed in to ${CLOUD_NAMES[cfg.provider]} as ${account}. Syncing now.`, "ok");
  void syncNow(false);
}

export async function disconnectCloudSync() {
  const cloud = get().settings.sync.cloud;
  if (cloud) await cloudSignOut(cloud.provider);
  await kv.remove("sync-state-cloud.json").catch(() => undefined);
  await updateSettings((s) => ({ sync: { ...s.sync, cloud: undefined } }));
}

export async function exportBackupFile(includeFiles: boolean) {
  for (const id of [...saveTimers.keys()]) await saveNow(id);
  const bytes = await exportBackup(repo, { includeFiles, device: platform().hostname, library });
  const name = `meridian-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXT}`;
  const where = await saveFile(bytes, name, "application/zip");
  if (where) toast(`Backup created (${formatBytes(bytes.length)}). ${where}.`, "ok");
}

export async function importBackupFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await importBackup(repo, bytes, library);
  for (const id of [...live.keys()]) if (!privateIds.has(id)) live.delete(id);
  refreshMetas();
  const id = get().activeId;
  if (id) await openChat(id);
  toast(
    `Import finished: ${r.added} new chat(s) added, ${r.merged} merged with chats already here, ${r.unchanged} already up to date${r.library ? `, ${r.library} agents/projects/prompts/plugins/automations/memories added or updated` : ""}. Nothing was replaced.`,
    "ok",
  );
  scheduleSync();
  return r;
}

/** Keep a conversation made elsewhere (automations) in memory and on disk. */
export async function adoptConversation(c: Conversation) {
  live.set(c.id, c);
  await repo.save(c);
  refreshMetas();
  render(c.id);
}

export function liveConversation(id: string | undefined): Conversation | undefined {
  return id ? live.get(id) : undefined;
}

export { setBusy as setConversationBusy };

export async function loadBlob(blobId: string) {
  return repo.getBlob(blobId);
}

/** Default media models are picked automatically; this says which (for the settings page). */
export function autoMediaModel(kind: "image" | "video"): ModelRef | undefined {
  return pickDefaultMedia(allProviders(get().settings), kind);
}

export type { TurnVersion };
