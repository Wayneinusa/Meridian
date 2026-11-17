// App state and the agent loop: send a message, stream the reply, run the
// tools the model asks for (after asking the user where needed), repeat.
import { create } from "zustand";
import { buildSystemPrompt } from "../agent/prompt";
import { initPlatform, invoke, isTauri, joinPath, platform } from "../platform";
import { saveFile } from "../platform/files";
import { deleteSecret, getSecret, providerKeyName, setSecret } from "../platform/secrets";
import { resolveParams, supportedParams } from "../providers/params";
import { adapterFor, findModel, mergeModelLists } from "../providers/registry";
import type { BlobAccess } from "../providers/types";
import { BACKUP_EXT, exportBackup, importBackup } from "../storage/backup";
import { FsKV, IdbKV, type KV } from "../storage/kv";
import { blobRefsOf, emptyConversation } from "../storage/merge";
import { blobKey, Repo } from "../storage/repo";
import { emptySyncState, syncWithRemote, type SyncState } from "../storage/sync";
import { activeTools, type Tool, type ToolContext } from "../tools";
import { createMedia, mediaModelFor, noMediaModelMessage } from "../tools/media";
import { extractText } from "../tools/extract";
import { validateInput } from "../tools/validate";
import type { BlobRef, Conversation, ConvMeta, MediaOptions, Message, ModelParams, ModelRef, Part, Settings, ToolResultData } from "../types";
import { uid } from "../types";
import { bytesToBase64, formatBytes, mimeFromName } from "../util/bytes";
import { defaultSettings, migrateSettings } from "./defaults";

export interface PermissionRequest {
  id: string;
  convId: string;
  toolName: string;
  title: string;
  summary: string;
  detail: string;
  group: Tool["group"];
  resolve(decision: "deny" | "once" | "always"): void;
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

interface State {
  ready: boolean;
  settings: Settings;
  metas: ConvMeta[];
  activeId: string | null;
  active: Conversation | null;
  /** conversation id -> short status while it is generating */
  busy: Record<string, string>;
  permission: PermissionRequest | null;
  toasts: Toast[];
  sync: SyncStatus;
  sidebarOpen: boolean;
  settingsTab: string | null;
  paramsOpen: boolean;
  preview: BlobRef | null;
  /** files handed to the composer from elsewhere (e.g. "Edit" on a generated image) */
  composerInbox: { parts: Extract<Part, { type: "attachment" }>[]; seq: number };
  /** choices made on the empty "new chat" screen, before a conversation exists */
  draft: Draft;
}

export interface Draft {
  model?: ModelRef;
  params?: ModelParams;
  media?: MediaOptions;
  chatModel?: ModelRef;
}

export const useApp = create<State>(() => ({
  ready: false,
  settings: defaultSettings(),
  metas: [],
  activeId: null,
  active: null,
  busy: {},
  permission: null,
  toasts: [],
  sync: { state: "off" },
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth > 860 : true,
  settingsTab: null,
  paramsOpen: false,
  preview: null,
  composerInbox: { parts: [], seq: 0 },
  draft: {},
}));

const set = useApp.setState;
const get = useApp.getState;

let kv: KV;
export let repo: Repo;
const live = new Map<string, Conversation>();
const aborts = new Map<string, AbortController>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const keyCache = new Map<string, string>();
const b64Cache = new Map<string, string>();

// ---------- small helpers ----------

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = uid("t");
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 9000 : 4500);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

function refreshMetas() {
  set({ metas: repo.list() });
}

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
  if (saveTimers.has(id)) return;
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
  if (!c) return;
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

function patchMessage(c: Conversation, messageId: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) {
  const i = c.messages.findIndex((m) => m.id === messageId);
  if (i < 0) return;
  const old = c.messages[i];
  const p = typeof patch === "function" ? patch(old) : patch;
  c.messages[i] = { ...old, ...p, updatedAt: Math.max(Date.now(), old.updatedAt + 1) };
  touch(c);
  render(c.id);
}

function patchToolCall(c: Conversation, messageId: string, callId: string, patch: Partial<Extract<Part, { type: "tool_call" }>>) {
  patchMessage(c, messageId, (m) => ({
    parts: m.parts.map((p) => (p.type === "tool_call" && p.id === callId ? { ...p, ...patch } : p)),
  }));
}

function setBusy(id: string, note: string | null) {
  set((s) => {
    const busy = { ...s.busy };
    if (note === null) delete busy[id];
    else busy[id] = note;
    return { busy };
  });
}

// ---------- startup ----------

export async function init() {
  const p = await initPlatform();
  kv = isTauri && p.dataDir ? new FsKV(joinPath(p.dataDir, "store")) : new IdbKV();
  repo = new Repo(kv);
  await repo.init();
  let settings = defaultSettings();
  try {
    const raw = await kv.getText("settings.json");
    if (raw) settings = migrateSettings(JSON.parse(raw));
  } catch {
    /* fall back to defaults */
  }
  // computer tools exist only on desktop builds
  if (!p.desktop) settings.tools.computer = false;
  set({ settings, metas: repo.list(), ready: true, sync: { state: syncTarget(settings) ? "idle" : "off", target: syncTarget(settings)?.label } });
  applyTheme(settings.theme);
  const first = repo.list()[0];
  if (first) await openChat(first.id);
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

export async function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
  const cur = get().settings;
  const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
  set({ settings: next });
  if (next.theme !== cur.theme) applyTheme(next.theme);
  const target = syncTarget(next);
  if (get().sync.target !== target?.label) set({ sync: { state: target ? "idle" : "off", target: target?.label } });
  await kv.setText("settings.json", JSON.stringify(next));
}

// ---------- providers & keys ----------

export async function getKey(providerId: string): Promise<string> {
  if (keyCache.has(providerId)) return keyCache.get(providerId)!;
  const k = (await getSecret(providerKeyName(providerId))) ?? "";
  keyCache.set(providerId, k);
  return k;
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

export function currentModelRef(conv?: Conversation | null): ModelRef | undefined {
  const s = get().settings;
  const candidates = [conv?.model, conv ? undefined : get().draft.model, s.defaultModel];
  for (const ref of candidates) if (findModel(s, ref)) return ref;
  for (const p of s.providers) {
    if (!p.enabled) continue;
    const m = p.models.find((x) => x.kind === "chat");
    if (m) return { providerId: p.id, modelId: m.id };
  }
  return undefined;
}

// ---------- conversations ----------

export async function openChat(id: string) {
  let c = live.get(id);
  if (!c) {
    const loaded = await repo.get(id);
    if (!loaded || loaded.deletedAt) return;
    c = loaded;
    live.set(id, c);
  }
  set({ activeId: id, active: { ...c, messages: c.messages.slice() }, paramsOpen: false });
  if (typeof window !== "undefined" && window.innerWidth <= 860) set({ sidebarOpen: false });
}

export function newChat() {
  set({ activeId: null, active: null, paramsOpen: false, draft: {} });
  if (typeof window !== "undefined" && window.innerWidth <= 860) set({ sidebarOpen: false });
}

function ensureConversation(): Conversation {
  const id = get().activeId;
  if (id && live.has(id)) return live.get(id)!;
  const c = emptyConversation(uid("c"), Date.now());
  const d = draft();
  c.model = d.model ?? currentModelRef(null);
  c.params = d.params;
  c.media = d.media;
  c.chatModel = d.chatModel;
  set({ draft: {} });
  live.set(c.id, c);
  set({ activeId: c.id, active: { ...c } });
  return c;
}

const draft = () => get().draft;
const setDraft = (patch: Partial<Draft>) => set((s) => ({ draft: { ...s.draft, ...patch } }));
export const draftModel = () => draft().model;
export const draftParams = () => draft().params;
export const draftMedia = () => draft().media;

export async function setChatModel(ref: ModelRef) {
  const settings = get().settings;
  const kind = findModel(settings, ref)?.model.kind ?? "chat";
  const id = get().activeId;
  const c = id ? live.get(id) : undefined;
  const current = c ? c.model : draft().model;
  // remember the chat model so the Chat button can switch back after making pictures
  const curKind = findModel(settings, current)?.model.kind ?? "chat";
  if (!c) {
    setDraft({ model: ref, ...(kind !== "chat" && curKind === "chat" ? { chatModel: current ?? currentModelRef(null) } : {}) });
  } else {
    if (kind !== "chat" && curKind === "chat") c.chatModel = current;
    c.model = ref;
    touch(c);
    render(c.id);
    await saveNow(c.id);
  }
  if (kind === "chat") await updateSettings({ defaultModel: ref });
  else if (kind === "image") await updateSettings({ imageModel: ref });
  else await updateSettings({ videoModel: ref });
}

export function currentKind(conv?: Conversation | null): "chat" | "image" | "video" {
  return findModel(get().settings, conv ? currentModelRef(conv) : (draft().model ?? currentModelRef(null)))?.model.kind ?? "chat";
}

/** Chat / Image / Video switch in the composer. */
export async function setChatMode(mode: "chat" | "image" | "video"): Promise<boolean> {
  const settings = get().settings;
  const c = live.get(get().activeId ?? "");
  if (mode === "chat") {
    const back = (c ? c.chatModel : draft().chatModel) ?? settings.defaultModel;
    const ref = back && findModel(settings, back)?.model.kind === "chat" ? back : undefined;
    const fallback = ref ?? settings.providers.flatMap((p) => p.models.filter((m) => m.kind === "chat").map((m) => ({ providerId: p.id, modelId: m.id })))[0];
    if (!fallback) return false;
    await setChatModel(fallback);
    return true;
  }
  const ref = mediaModelFor(settings, mode);
  if (!ref) {
    toast(noMediaModelMessage(mode), "error");
    return false;
  }
  await setChatModel(ref);
  return true;
}

export async function setChatMedia(media: MediaOptions) {
  const c = live.get(get().activeId ?? "");
  if (!c) {
    setDraft({ media });
    return;
  }
  c.media = media;
  touch(c);
  render(c.id);
  saveSoon(c.id, 300);
}

/** Put files into the composer (used by "Edit" / "Animate" on generated pictures). */
export function attachToComposer(refs: BlobRef[]) {
  set((s) => ({ composerInbox: { parts: refs.map((r) => ({ type: "attachment" as const, blobId: r.blobId, name: r.name, mime: r.mime, size: r.size })), seq: s.composerInbox.seq + 1 } }));
}

export async function setChatParams(params: ModelParams | undefined) {
  const id = get().activeId;
  const c = id ? live.get(id) : undefined;
  if (!c) {
    setDraft({ params });
    return;
  }
  c.params = params && Object.keys(params).length ? params : undefined;
  touch(c);
  render(c.id);
  saveSoon(c.id, 300);
}

export async function setChatSystemPrompt(text: string) {
  const c = ensureConversation();
  c.systemPrompt = text || undefined;
  touch(c);
  render(c.id);
  saveSoon(c.id, 300);
}

export async function renameChat(id: string, title: string) {
  const c = live.get(id) ?? (await repo.get(id));
  if (!c) return;
  c.title = title.trim() || "Untitled chat";
  touch(c);
  live.set(id, c);
  render(id);
  await saveNow(id);
}

export async function togglePin(id: string) {
  const c = live.get(id) ?? (await repo.get(id));
  if (!c) return;
  c.pinned = !c.pinned;
  touch(c);
  live.set(id, c);
  await saveNow(id);
}

export async function deleteChat(id: string) {
  stop(id);
  const doomed = live.get(id) ?? (await repo.get(id));
  live.delete(id);
  await repo.delete(id);
  // free the chat's attachments and generated files on this device
  if (doomed) {
    for (const ref of blobRefsOf(doomed)) await kv.remove(blobKey(ref.blobId)).catch(() => undefined);
  }
  refreshMetas();
  if (get().activeId === id) set({ activeId: null, active: null });
  scheduleSync();
}

// ---------- attachments ----------

export async function attachFile(file: File): Promise<Extract<Part, { type: "attachment" }>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || mimeFromName(file.name);
  if (bytes.length > 30 * 1024 * 1024) {
    toast(`${file.name} is ${formatBytes(bytes.length)}. Most providers reject requests above about 30 MB, so this may fail.`, "info");
  }
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

// ---------- sending ----------

export async function send(text: string, attachments: Part[] = []) {
  const trimmed = text.trim();
  if (!trimmed && !attachments.length) return;
  const c = ensureConversation();
  if (get().busy[c.id] !== undefined) return;
  const now = nextMessageTime(c);
  const parts: Part[] = [...attachments];
  if (trimmed) parts.push({ type: "text", text: trimmed });
  c.messages.push({ id: uid("m"), role: "user", createdAt: now, updatedAt: now, parts });
  if (c.messages.length === 1) {
    const base = trimmed || (attachments[0] as BlobRef | undefined)?.name || "New chat";
    c.title = base.split("\n")[0].slice(0, 60);
  }
  touch(c);
  render(c.id);
  await saveNow(c.id);
  await runAgent(c.id);
}

export function stop(convId?: string | null) {
  const id = convId ?? get().activeId;
  if (!id) return;
  aborts.get(id)?.abort();
  const perm = get().permission;
  if (perm?.convId === id) perm.resolve("deny");
}

/** Drop everything after the last user message and answer it again. */
export async function regenerate() {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  let i = c.messages.length - 1;
  while (i >= 0 && c.messages[i].role !== "user") i--;
  if (i < 0) return;
  removeAfter(c, i);
  render(c.id);
  await runAgent(c.id);
}

/** Replace a user message's text, drop what followed, and answer again. */
export async function editAndResend(messageId: string, text: string) {
  const c = live.get(get().activeId ?? "");
  if (!c || get().busy[c.id] !== undefined) return;
  const i = c.messages.findIndex((m) => m.id === messageId);
  if (i < 0 || c.messages[i].role !== "user") return;
  const old = c.messages[i];
  removeAfter(c, i - 1);
  const now = nextMessageTime(c);
  const parts: Part[] = [...old.parts.filter((p) => p.type === "attachment"), { type: "text", text: text.trim() }];
  c.messages.push({ id: uid("m"), role: "user", createdAt: now, updatedAt: now, parts });
  touch(c);
  render(c.id);
  await runAgent(c.id);
}

function removeAfter(c: Conversation, index: number) {
  const now = Date.now();
  for (const m of c.messages.slice(index + 1)) c.removed[m.id] = now;
  c.messages = c.messages.slice(0, index + 1);
  touch(c);
}

function askPermission(convId: string, tool: Tool, input: Record<string, unknown>): Promise<"deny" | "once" | "always"> {
  return new Promise((resolve) => {
    const req: PermissionRequest = {
      id: uid("p"),
      convId,
      toolName: tool.spec.name,
      title: tool.title,
      summary: tool.summarize(input),
      detail: JSON.stringify(input, null, 2),
      group: tool.group,
      resolve: (d) => {
        if (get().permission?.id === req.id) set({ permission: null });
        resolve(d);
      },
    };
    set({ permission: req });
  });
}

function toolContext(c: Conversation, signal: AbortSignal): ToolContext {
  return {
    conversationId: c.id,
    signal,
    settings: get().settings,
    saveBlob: (bytes, mime, name) => repo.putBlob(bytes, mime, name),
    loadBlob: (id) => repo.getBlob(id),
    files: () =>
      c.messages.flatMap((m) =>
        m.parts.flatMap((p) => (p.type === "attachment" || p.type === "artifact" ? [{ blobId: p.blobId, name: p.name, mime: p.mime, size: p.size, kind: p.type }] : [])),
      ),
    userText: () =>
      c.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")))
        .join("\n"),
    getKey,
    progress: (note) => setBusy(c.id, note),
  };
}

/** A turn in a chat whose model is an image or video model: the last message is the prompt. */
async function runMediaTurn(c: Conversation, ref: ModelRef, kind: "image" | "video", modelName: string, signal: AbortSignal, onId: (id: string) => void) {
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;
  const prompt = lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
  const inputs = lastUser.parts.filter((p): p is Extract<Part, { type: "attachment" }> => p.type === "attachment" && p.mime.startsWith("image/"));
  if (!prompt) throw new Error(kind === "image" ? "Describe the picture you want." : "Describe the video you want.");
  const now = nextMessageTime(c);
  const assistant: Message = { id: uid("m"), role: "assistant", createdAt: now, updatedAt: now, parts: [], model: ref };
  onId(assistant.id);
  c.messages.push(assistant);
  render(c.id);
  setBusy(c.id, kind === "image" ? (inputs.length ? "editing image" : "creating image") : "starting video");
  const { refs } = await createMedia(
    { kind, prompt, inputs, options: c.media, model: ref },
    {
      settings: get().settings,
      getKey,
      loadBlob: (id) => repo.getBlob(id),
      saveBlob: (bytes, mime, name) => repo.putBlob(bytes, mime, name),
      signal,
      progress: (note) => setBusy(c.id, note),
    },
  );
  patchMessage(c, assistant.id, {
    parts: refs.map((r) => ({ type: "artifact" as const, origin: "model" as const, ...r })),
    stopReason: "end",
  });
  void modelName;
}

async function runAgent(convId: string) {
  const c = live.get(convId);
  if (!c) return;
  const abort = new AbortController();
  aborts.set(convId, abort);
  setBusy(convId, "");
  let assistantId: string | null = null;

  try {
    const maxSteps = Math.max(1, get().settings.maxAgentSteps);
    for (let step = 0; ; step++) {
      const settings = get().settings;
      const ref = currentModelRef(c);
      const found = findModel(settings, ref);
      if (!found) throw new Error("No model is selected. Add an API key in Settings → Providers and pick a model.");
      const { provider, model } = found;
      if (model.kind !== "chat") {
        await runMediaTurn(c, ref!, model.kind, model.name, abort.signal, (id) => (assistantId = id));
        break;
      }
      const apiKey = await getKey(provider.id);
      if (!apiKey && provider.kind !== "openai-compatible") {
        throw new Error(`No API key for ${provider.name}. Add one in Settings → Providers.`);
      }

      // PDFs for a model that cannot read them natively: extract the text once, on the device
      if (!model.caps.pdf) {
        for (const m of c.messages) {
          for (const p of m.parts) {
            if (p.type === "attachment" && p.mime === "application/pdf" && p.extractedText === undefined) {
              setBusy(convId, `reading ${p.name}`);
              const bytes = await repo.getBlob(p.blobId);
              const ex = bytes ? await extractText(bytes, p.name, p.mime) : { text: null, truncated: false };
              p.extractedText = ex.text ?? "";
              if (ex.truncated) toast(`${p.name} is very long. Only the first part of its text will be sent.`, "info");
            }
          }
        }
      }

      setBusy(convId, step === 0 ? "" : "thinking");
      const tools = await activeTools(settings, model);
      const params = supportedParams(resolveParams(settings, ref, c), provider.kind, model);
      let history = c.messages;
      if (params.contextMessages && history.length > params.contextMessages) {
        let start = history.length - params.contextMessages;
        while (start > 0 && history[start].role !== "user") start--; // never start mid tool exchange
        history = history.slice(start);
      }
      const sendHistory = history.slice();

      const now = nextMessageTime(c);
      const assistant: Message = { id: uid("m"), role: "assistant", createdAt: now, updatedAt: now, parts: [], model: ref };
      assistantId = assistant.id;
      c.messages.push(assistant);
      render(convId);

      const result = await adapterFor(provider.kind).chat({
        provider,
        apiKey,
        model,
        system: buildSystemPrompt(settings, c, tools),
        messages: sendHistory,
        tools: tools.map((t) => t.spec),
        options: { params, webSearch: settings.webSearch && settings.tools.web, refusalFallback: settings.refusalFallback },
        signal: abort.signal,
        onUpdate: (parts) => {
          patchMessage(c, assistant.id, { parts });
          saveSoon(convId, 4000);
        },
        blobs,
      });

      patchMessage(c, assistant.id, {
        parts: result.parts,
        raw: result.raw,
        usage: result.usage,
        stopReason: result.stop,
        error: result.stop === "refusal" || result.stop === "max_tokens" ? result.stopDetail : undefined,
        model: result.servedBy ? { providerId: provider.id, modelId: result.servedBy } : ref,
      });
      saveSoon(convId);

      if (result.stop === "pause") continue; // a hosted tool paused the turn: ask the model to carry on
      const calls = result.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call" && !p.server);
      if (result.stop === "refusal" || result.stop === "max_tokens") {
        // a cut-off turn can leave half-written tool inputs: never run them
        for (const call of calls) {
          patchToolCall(c, assistant.id, call.id, { status: "error", result: { text: "Not run: the model's turn was cut off before this call was complete.", isError: true } });
        }
        break;
      }
      if (!calls.length) break;

      for (const call of calls) {
        if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const tool = tools.find((t) => t.spec.name === call.name);
        const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>;
        let res: ToolResultData;
        let artifacts: BlobRef[] = [];
        if (!tool) {
          res = { text: `There is no tool named "${call.name}".`, isError: true };
        } else {
          const invalid = validateInput(tool.spec.inputSchema, call.input);
          const ctx = toolContext(c, abort.signal);
          if (invalid) {
            res = { text: `Invalid input: ${invalid}. Fix the arguments and call the tool again.`, isError: true };
          } else {
            let allowed = true;
            const s = get().settings;
            const preApproved = s.alwaysAllow.includes(tool.spec.name) || (tool.group === "computer" && s.autoApproveComputer);
            if (tool.needsApproval(input, ctx) && !preApproved) {
              setBusy(convId, "waiting for your OK");
              const decision = await askPermission(convId, tool, input);
              if (decision === "always") await updateSettings((cur) => ({ alwaysAllow: [...new Set([...cur.alwaysAllow, tool.spec.name])] }));
              allowed = decision !== "deny";
            }
            if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (!allowed) {
              patchToolCall(c, assistant.id, call.id, { status: "denied", result: { text: "The user declined to run this tool.", isError: true } });
              continue;
            }
            patchToolCall(c, assistant.id, call.id, { status: "running" });
            setBusy(convId, tool.title);
            try {
              const out = await tool.run(input, ctx);
              res = { text: out.text, isError: out.isError, images: out.images };
              artifacts = out.artifacts ?? [];
            } catch (e) {
              if (isAbort(e) || abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
              res = { text: `The tool failed: ${errText(e)}`, isError: true };
            }
          }
        }
        patchMessage(c, assistant.id, (m) => {
          const parts: Part[] = [];
          for (const p of m.parts) {
            if (p.type === "tool_call" && p.id === call.id) {
              parts.push({ ...p, status: res.isError ? "error" : "done", result: res });
              for (const a of artifacts) parts.push({ type: "artifact", origin: "tool", toolCallId: call.id, ...a });
            } else parts.push(p);
          }
          return { parts };
        });
        saveSoon(convId);
      }

      if (step + 1 >= maxSteps) {
        patchMessage(c, assistant.id, { error: `Stopped after ${maxSteps} tool steps. Say "continue" to keep going, or raise the limit in Settings → General.` });
        break;
      }
    }
  } catch (e) {
    const stopped = isAbort(e) || abort.signal.aborted;
    if (assistantId) {
      patchMessage(c, assistantId, (m) => ({
        parts: m.parts.map((p) =>
          p.type === "tool_call" && !p.server && (p.status === "pending" || p.status === "running")
            ? { ...p, status: "error" as const, result: { text: "Stopped before this finished.", isError: true } }
            : p,
        ),
        stopReason: stopped ? "stopped" : "error",
        error: stopped ? undefined : errText(e),
      }));
    } else if (!stopped) {
      toast(errText(e), "error");
    }
  } finally {
    aborts.delete(convId);
    setBusy(convId, null);
    // an empty, error-free assistant bubble (stopped before anything arrived) is just noise
    if (assistantId) {
      const m = c.messages.find((x) => x.id === assistantId);
      if (m && !m.parts.length && !m.error) {
        c.messages = c.messages.filter((x) => x.id !== assistantId);
        c.removed[assistantId] = Date.now();
        render(convId);
      }
    }
    await saveNow(convId);
    scheduleSync();
  }
}

// ---------- sync & backup ----------

function syncTarget(settings: Settings): { kv: KV; id: string; label: string } | null {
  if (!isTauri) return null;
  const p = platform();
  if (settings.sync.icloud && p.icloudContainer) {
    const dir = joinPath(p.icloudContainer, "Documents");
    return { kv: new FsKV(dir), id: `icloud:${dir}`, label: "iCloud" };
  }
  if (settings.sync.folder) {
    return { kv: new FsKV(settings.sync.folder), id: `folder:${settings.sync.folder}`, label: settings.sync.folder };
  }
  return null;
}

let syncing = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync() {
  if (!get().settings.sync.auto || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow(true);
  }, 4000);
}

export async function syncNow(quiet = false) {
  const target = syncTarget(get().settings);
  if (!target) {
    set({ sync: { state: "off" } });
    if (!quiet) toast("Sync is not set up. Choose a sync folder in Settings → Sync & backup.", "info");
    return;
  }
  // never merge underneath a reply that is still being written
  if (syncing || Object.keys(get().busy).length) return;
  syncing = true;
  set({ sync: { ...get().sync, state: "syncing", target: target.label } });
  try {
    for (const id of [...saveTimers.keys()]) await saveNow(id);
    if (platform().icloudContainer && target.id.startsWith("icloud:")) {
      // ask iCloud to bring down files that exist only in the cloud so far
      await invoke("icloud_prepare", { dir: joinPath(platform().icloudContainer!, "Documents") }).catch(() => undefined);
    }
    let state: SyncState = emptySyncState(target.id);
    try {
      const raw = await kv.getText("sync-state.json");
      const parsed = raw ? (JSON.parse(raw) as SyncState) : null;
      if (parsed && parsed.remoteId === target.id) state = parsed;
    } catch {
      /* start fresh */
    }
    const report = await syncWithRemote(repo, target.kv, state);
    await kv.setText("sync-state.json", JSON.stringify(state));
    if (report.pulled) {
      // bring anything that changed underneath us back into memory
      for (const id of [...live.keys()]) {
        const fresh = await repo.get(id);
        if (!fresh || fresh.deletedAt) {
          live.delete(id);
          if (get().activeId === id) set({ activeId: null, active: null });
        } else {
          live.set(id, fresh);
        }
      }
      const a = live.get(get().activeId ?? "");
      if (a) set({ active: { ...a, messages: a.messages.slice() } });
    }
    refreshMetas();
    const message = report.errors.length ? `${report.errors.length} item(s) could not be synced: ${report.errors[0]}` : undefined;
    set({ sync: { state: report.errors.length ? "error" : "idle", target: target.label, at: Date.now(), message } });
    if (!quiet) {
      toast(
        report.errors.length
          ? message!
          : report.pulled || report.pushed
            ? `Synced: ${report.pulled} received, ${report.pushed} sent.`
            : "Everything is up to date.",
        report.errors.length ? "error" : "ok",
      );
    }
  } catch (e) {
    set({ sync: { state: "error", target: target.label, at: Date.now(), message: errText(e) } });
    if (!quiet) toast(`Sync failed: ${errText(e)}`, "error");
  } finally {
    syncing = false;
  }
}

export async function exportBackupFile(includeFiles: boolean) {
  for (const id of [...saveTimers.keys()]) await saveNow(id);
  const bytes = await exportBackup(repo, { includeFiles, device: platform().hostname });
  const name = `meridian-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXT}`;
  const where = await saveFile(bytes, name, "application/zip");
  if (where) toast(`Backup created (${formatBytes(bytes.length)}). ${where}.`, "ok");
}

export async function importBackupFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await importBackup(repo, bytes);
  live.clear();
  refreshMetas();
  const id = get().activeId;
  if (id) await openChat(id);
  toast(
    `Import finished: ${r.added} new chat(s) added, ${r.merged} merged with chats already here, ${r.unchanged} already up to date. Nothing was replaced.`,
    "ok",
  );
  scheduleSync();
  return r;
}

export async function loadBlob(blobId: string) {
  return repo.getBlob(blobId);
}
