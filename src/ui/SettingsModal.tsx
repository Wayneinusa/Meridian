import { useEffect, useRef, useState } from "react";
import { invoke, platform } from "../platform";
import { pickFolder } from "../platform/files";
import { deleteSecret, mcpTokenName, setSecret } from "../platform/secrets";
import { BACKENDS, providerReady } from "../providers/backends";
import { backendProvider, COMPATIBLE_PRESETS, manualModel } from "../providers/registry";
import { openExternal } from "../platform/files";
import { addManualModel, cancelWake, connectCloudSync, signInGrok, signOutGrok, disconnectCloudSync, exportBackupFile, importBackupFile, refreshModels, removeModel, saveProviderKey, syncNow, toast, updateSettings, useApp, wakeUp } from "../state/store";
import { mcpManager } from "../tools/mcp";
import { CLOUD_NAMES } from "../storage/cloudkv";
import type { DeviceCode } from "../connectors/oauth";
import type { CloudSync, McpServerConfig, MediaHttpSpec, ModelInfo, ModelRef, ProviderConfig, ProviderKind, Settings } from "../types";
import { modelKey, uid } from "../types";
import { useProviders } from "./BackendPicker";
import { BrowserSettings } from "./BrowserSettings";
import { Icon } from "./icons";
import { ConnectorsTab } from "./ConnectorsTab";
import { MemoryTab, PluginsTab } from "./PluginsTab";
import { GeneralExtras, SearchKeys } from "./SettingsExtras";

const TABS = [
  ["providers", "Providers & keys"],
  ["models", "Models"],
  ["tools", "Tools & computer"],
  ["connectors", "Connectors"],
  ["plugins", "Plugins"],
  ["memory", "Memory"],
  ["sync", "Sync & backup"],
  ["general", "General"],
] as const;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.55 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

// ---------- providers ----------

/** Grok: "Sign in with X" next to the API key. */
function XSignIn({ provider }: { provider: ProviderConfig }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [inBrowser, setInBrowser] = useState(false);
  const [pasted, setPasted] = useState("");
  const [failed, setFailed] = useState("");
  const abort = useRef<AbortController | null>(null);
  const manual = useRef<{ resolve: (v: string) => void; reject: (e: unknown) => void } | null>(null);
  const desktop = platform().desktop;
  const go = async (mode: "browser" | "device") => {
    setBusy(true);
    setFailed("");
    abort.current = new AbortController();
    // xAI's page sometimes shows the code instead of returning it: the user can paste it here
    const pastedCode = new Promise<string>((resolve, reject) => (manual.current = { resolve, reject }));
    pastedCode.catch(() => undefined);
    if (mode === "browser") setInBrowser(true);
    try {
      await signInGrok(provider.id, mode, setCode, abort.current.signal, mode === "browser" ? pastedCode : undefined);
      toast("Signed in with X. Grok now uses your subscription.", "ok");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast(`Sign in with X: ${errText(e)}`, "error");
        // stays on the card: a toast is easy to miss after coming back from the browser
        setFailed(errText(e));
      }
    } finally {
      setBusy(false);
      setCode(null);
      setInBrowser(false);
      setPasted("");
      manual.current = null;
    }
  };
  return (
    <div className="subcard" data-testid="x-signin">
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="grow">Method 2: Sign in with X</b>
        {provider.signedIn && <span className="badge ok">signed in{provider.signedInAs ? ` as ${provider.signedInAs}` : ""}</span>}
      </div>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Use Grok with your SuperGrok or X Premium subscription instead of a metered key. Sign-in happens on xAI's page (auth.x.ai, which may call it “Grok Build”); Meridian only keeps the tokens, in this
        device's keychain. When both are set up, the sign-in is used.
      </p>
      {failed && !busy && (
        <div className="note err" role="alert" data-testid="x-signin-error" style={{ marginBottom: 8 }}>
          Sign-in did not finish: {failed}
        </div>
      )}
      {code ? (
        <div className="note" role="status">
          Open <b>{code.verification_url}</b> and enter <code data-testid="x-device-code" style={{ fontSize: 17, letterSpacing: 1.5 }}>{code.user_code}</code>{" "}
          <button className="btn small" onClick={() => void openExternal(code.verification_url_complete ?? code.verification_url)}>Open page</button>{" "}
          <button className="btn small" onClick={() => abort.current?.abort()}>Cancel</button>
        </div>
      ) : inBrowser ? (
        <div className="note" role="status" data-testid="x-paste">
          <div style={{ marginBottom: 6 }}>
            Finish on xAI's page in your browser. If it shows <b>“Enter this code to finish signing in”</b>, copy that code and paste it here:
          </div>
          <div className="row">
            <input type="text" spellCheck={false} autoComplete="off" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the code from xAI's page" aria-label="Code from xAI" />
            <button className="btn primary" disabled={!pasted.trim()} onClick={() => manual.current?.resolve(pasted.trim())}>Finish signing in</button>
            <button className="btn" onClick={() => manual.current?.reject(new DOMException("Aborted", "AbortError"))}>Cancel</button>
          </div>
        </div>
      ) : provider.signedIn ? (
        <button className="btn small" onClick={() => void signOutGrok(provider.id).then(() => toast("Signed out of X.", "ok"))}>Sign out</button>
      ) : (
        <div className="row wrap">
          {desktop && (
            <button className="btn primary" disabled={busy} onClick={() => void go("browser")}>
              {busy ? "Waiting for the browser…" : "Sign in with X"}
            </button>
          )}
          <button className={`btn ${desktop ? "" : "primary"}`} disabled={busy} onClick={() => void go("device")}>
            {desktop ? "Use a code instead" : "Sign in with X (code)"}
          </button>
        </div>
      )}
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderConfig }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelKind, setModelKind] = useState<"" | "chat" | "image" | "video">("");
  const [waking, setWaking] = useState<Record<string, string>>({});
  const builtin = ["anthropic", "openai", "gemini", "xai", "pollinations", "horde"].includes(provider.id);
  const media = BACKENDS[provider.kind];
  const ready = providerReady(provider);
  const manual = provider.models.filter((m) => m.userEdited);

  const wake = async (id: string) => {
    setWaking((w) => ({ ...w, [id]: "starting" }));
    try {
      const r = await wakeUp(provider.id, id, (note) => setWaking((w) => ({ ...w, [id]: note })));
      toast(r.ok ? r.message : `${id}: ${r.message}`, r.ok ? "ok" : "error");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast(`${id}: ${errText(e)}`, "error");
    } finally {
      setWaking((w) => {
        const n = { ...w };
        delete n[id];
        return n;
      });
    }
  };

  const addModel = async (andWake: boolean) => {
    const id = modelId.trim();
    if (!id) return;
    await addManualModel(provider.id, id, modelKind || undefined);
    setModelId("");
    const kind = useApp.getState().settings.providers.find((p) => p.id === provider.id)?.models.find((m) => m.id === id)?.kind;
    toast(`Added ${id}. It is now in the model picker${kind && kind !== "chat" ? ` under ${kind === "image" ? "Image" : "Video"}` : ""}.`, "ok");
    if (andWake && kind === "chat") void wake(id);
  };
  const patch = (p: Partial<ProviderConfig>) => updateSettings((s) => ({ providers: s.providers.map((x) => (x.id === provider.id ? { ...x, ...p } : x)) }));

  const fetchModels = async () => {
    setBusy(true);
    try {
      const n = await refreshModels(provider.id);
      toast(`${provider.name}: ${n} models available.`, "ok");
    } catch (e) {
      toast(`${provider.name}: ${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await saveProviderKey(provider.id, key);
    setKey("");
    if (key.trim()) await fetchModels();
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h4 className="grow">{provider.name}</h4>
        {media && <span className={`badge ${media.pricing === "free" ? "ok" : ""}`}>{media.pricing === "free" ? "Free" : media.pricing === "free-credits" ? "Free daily allowance" : media.pricing === "custom" ? "Custom" : media.pricing === "trial" ? "Pay per use" : "Paid"}</span>}
        {provider.kind === "xai" ? (
          <>
            {provider.signedIn && <span className="badge ok">Signed in with X</span>}
            {provider.hasKey && <span className="badge ok">API key configured</span>}
            {!provider.signedIn && !provider.hasKey && <span className="badge">needs a key or sign-in</span>}
          </>
        ) : media ? (
          <span className={`badge ${ready ? "ok" : ""}`}>{!provider.enabled ? "off" : ready ? (provider.hasKey ? "ready · key saved" : "ready · no key needed") : "needs setup"}</span>
        ) : (
          <span className={`badge ${provider.hasKey ? "ok" : ""}`}>{provider.hasKey ? "key saved" : provider.kind === "openai-compatible" ? "no key" : "needs a key"}</span>
        )}
        <span className="badge">{provider.models.length} model{provider.models.length === 1 ? "" : "s"}</span>
      </div>
      {media && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>{media.help}</p>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <label className="switch" style={{ margin: 0 }}>
              <input type="checkbox" checked={provider.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} aria-label={`Use ${provider.name}`} />
              <span>Use {provider.name}</span>
            </label>
            {media.keyUrl && (
              <button className="btn small" onClick={() => void openExternal(media.keyUrl!)}>
                <Icon.globe /> {media.keyless === "none" ? "Get a key" : "Get a free key"}
              </button>
            )}
          </div>
        </>
      )}
      {media?.needsAccountId && (
        <label className="field">
          <span>Account ID</span>
          <input type="text" spellCheck={false} autoCapitalize="off" defaultValue={provider.accountId ?? ""} placeholder="32 characters, from the Cloudflare dashboard" onBlur={(e) => e.target.value.trim() !== (provider.accountId ?? "") && void patch({ accountId: e.target.value.trim() || undefined })} aria-label="Cloudflare account ID" />
        </label>
      )}
      {!builtin && (
        <label className="field">
          <span>Name</span>
          <input type="text" defaultValue={provider.name} onBlur={(e) => e.target.value.trim() && e.target.value !== provider.name && void patch({ name: e.target.value.trim() })} />
        </label>
      )}
      {(!media || provider.kind === "custom-media") && (
        <label className="field">
          <span>API endpoint</span>
          <input type="url" defaultValue={provider.baseUrl} spellCheck={false} placeholder={provider.kind === "custom-media" ? "https://your-server/v1" : undefined} onBlur={(e) => e.target.value !== provider.baseUrl && void patch({ baseUrl: e.target.value.trim() })} />
        </label>
      )}
      {provider.kind === "xai" && <XSignIn provider={provider} />}
      <label className="field">
        <span>{provider.kind === "xai" ? "Method 1: API key (console.x.ai, billed per use)" : (media?.keyLabel ?? "API key")}</span>
        <div className="row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={provider.hasKey ? "•••••••• saved — type to replace" : media && media.keyless !== "none" ? "Optional" : "Paste your key"}
            aria-label={`${provider.name} key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <button className="btn primary" disabled={!key.trim()} onClick={() => void save()}>Save</button>
        </div>
      </label>
      <label className="field">
        <span>Model ID (optional)</span>
        <div className="row wrap">
          <input
            type="text"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={provider.kind === "fal" ? "e.g. fal-ai/flux/dev" : provider.kind === "pollinations" ? "e.g. alibaba/wan-2.2-fast" : provider.kind === "cloudflare" ? "e.g. @cf/black-forest-labs/flux-1-schnell" : "e.g. meta-llama/Llama-3.3-70B-Instruct"}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addModel(true)}
            style={{ flex: "1 1 220px" }}
            aria-label={`Model ID for ${provider.name}`}
          />
          <select value={modelKind} onChange={(e) => setModelKind(e.target.value as typeof modelKind)} style={{ width: "auto", flex: "0 0 auto" }} aria-label="Model type">
            <option value="">Detect type</option>
            <option value="chat">Chat</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
          <button className="btn" disabled={!modelId.trim()} onClick={() => void addModel(false)}>Add</button>
          {!media && (
            <button className="btn primary" disabled={!modelId.trim()} onClick={() => void addModel(true)} title="Add the model and send a test message until it has loaded">
              Add &amp; wake up
            </button>
          )}
        </div>
        <small className="hint">
          {media
            ? "For a model this service has that is not in the list. It then appears in the Image or Video backend list."
            : "For models the provider does not list right now, such as cold models that load on first use. Wake up sends a tiny test message and keeps retrying for up to 10 minutes while the model loads."}
        </small>
      </label>
      {(provider.kind === "custom-media" || provider.kind === "openai-compatible") && <MediaApiFields provider={provider} patch={patch} />}
      {manual.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {manual.map((m) => (
            <div className="model-row" key={m.id}>
              <span className="name" title={m.id}>{m.id}</span>
              <span className="badge">{m.kind}</span>
              {waking[m.id] ? (
                <>
                  <span className="spinner" />
                  <span className="hint">{waking[m.id]}</span>
                  <button className="btn small" onClick={() => cancelWake(provider.id, m.id)}>Stop</button>
                </>
              ) : (
                m.kind === "chat" && (
                  <button className="btn small" onClick={() => void wake(m.id)}>Wake up</button>
                )
              )}
              <button className="icon-btn" title={`Remove ${m.id}`} onClick={() => void removeModel(provider.id, m.id)}>
                <Icon.x />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap">
        <button className="btn small" disabled={busy} onClick={() => void fetchModels()}>
          <Icon.refresh /> {busy ? "Fetching…" : "Fetch model list"}
        </button>
        {provider.hasKey && (
          <button className="btn small danger" onClick={() => void saveProviderKey(provider.id, "")}>Remove key</button>
        )}
        {!builtin && (
          <button
            className="btn small danger"
            onClick={() => {
              if (!confirm(`Remove ${provider.name}?`)) return;
              void saveProviderKey(provider.id, "").then(() => updateSettings((s) => ({ providers: s.providers.filter((x) => x.id !== provider.id) })));
            }}
          >
            Remove provider
          </button>
        )}
      </div>
    </div>
  );
}

const TEMPLATE_EXAMPLE = `{
  "method": "POST",
  "url": "https://my-server.example/generate",
  "headers": { "Authorization": "Bearer {{key}}" },
  "body": { "prompt": "{{prompt}}", "width": "{{width}}", "height": "{{height}}" },
  "resultPath": "images"
}`;

function TemplateField({ label, value, onSave }: { label: string; value?: MediaHttpSpec; onSave: (v?: MediaHttpSpec) => void }) {
  const [text, setText] = useState(value ? JSON.stringify({ ...value, body: value.body ? safeParse(value.body) : undefined }, null, 2) : "");
  const [err, setErr] = useState("");
  const save = () => {
    if (!text.trim()) {
      setErr("");
      return onSave(undefined);
    }
    try {
      const j = JSON.parse(text) as MediaHttpSpec & { body?: unknown };
      if (!j.url) throw new Error("url is missing");
      onSave({ ...j, method: j.method === "GET" ? "GET" : "POST", body: j.body == null ? undefined : typeof j.body === "string" ? j.body : JSON.stringify(j.body) });
      setErr("");
    } catch (e) {
      setErr(`Not saved: ${errText(e)}`);
    }
  };
  return (
    <label className="field">
      <span>{label}</span>
      <textarea rows={6} spellCheck={false} placeholder={TEMPLATE_EXAMPLE} value={text} onChange={(e) => setText(e.target.value)} onBlur={save} className="mono" />
      {err && <small className="note err">{err}</small>}
    </label>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** How a custom or OpenAI-compatible server makes images and videos. */
function MediaApiFields({ provider, patch }: { provider: ProviderConfig; patch: (p: Partial<ProviderConfig>) => Promise<void> }) {
  const custom = provider.kind === "custom-media";
  const [open, setOpen] = useState(custom);
  if (!open)
    return (
      <button className="link-btn" style={{ marginBottom: 10 }} onClick={() => setOpen(true)}>
        Image and video options…
      </button>
    );
  return (
    <div className="subcard">
      <label className="field">
        <span>Video API</span>
        <select value={provider.videoApi ?? "openai"} onChange={(e) => void patch({ videoApi: e.target.value as ProviderConfig["videoApi"] })} aria-label="Video API">
          <option value="openai">OpenAI style: POST /videos, poll /videos/&#123;id&#125;</option>
          <option value="xai">xAI style: POST /videos/generations, poll /videos/&#123;id&#125;</option>
          <option value="fal">fal queue style: POST /&#123;model&#125;, poll status_url</option>
          <option value="template">Described by a template (below)</option>
        </select>
      </label>
      {custom && (
        <TemplateField
          label="Image request template (optional; empty = POST /images/generations)"
          value={provider.imageTemplate}
          onSave={(v) => void patch({ imageTemplate: v })}
        />
      )}
      {provider.videoApi === "template" && <TemplateField label="Video request template" value={provider.videoTemplate} onSave={(v) => void patch({ videoTemplate: v })} />}
      <small className="hint">
        Templates fill in {"{{prompt}} {{model}} {{width}} {{height}} {{aspect_ratio}} {{seconds}} {{count}} {{seed}} {{image}}"} (the attached picture as a data URI) and {"{{key}}"}. The image or video is found in the response automatically (a file, a link, a data URI or base64), or set resultPath. For job APIs add jobIdPath, pollUrl (with {"{{id}}"}), statusPath and failedPattern.
      </small>
    </div>
  );
}

const MEDIA_KINDS: ProviderKind[] = ["pollinations", "horde", "cloudflare", "fal", "runway", "custom-media"];

function ProvidersTab({ settings }: { settings: Settings }) {
  const [preset, setPreset] = useState("");
  const p = platform();
  const where = p.os === "windows" ? "Windows Credential Manager" : p.os === "ios" || p.os === "macos" ? "the Apple Keychain" : p.os === "web" ? "this browser's storage" : "this device's app data";
  return (
    <>
      <h3>Providers & keys</h3>
      <p>
        Meridian talks to model providers directly with your own API keys. Keys are stored in {where} on this device only. They are never put in chats, sync folders or backups.
      </p>
      {p.os === "web" && <div className="note warn" style={{ marginBottom: 12 }}>You are running in a browser, where keys can only be kept in browser storage. Use the installed app for keychain storage.</div>}
      <div className="card">
        <h4 style={{ marginBottom: 8 }}>Add another provider</h4>
        <p className="hint" style={{ marginBottom: 8 }}>Any service or local server with an OpenAI-compatible API.</p>
        <div className="row">
          <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Provider preset">
            <option value="">Choose…</option>
            {COMPATIBLE_PRESETS.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!preset}
            onClick={() => {
              const c = COMPATIBLE_PRESETS.find((x) => x.name === preset)!;
              void updateSettings((s) => ({
                providers: [...s.providers, { id: uid("p"), kind: "openai-compatible", name: c.name.replace(" (local)", ""), baseUrl: c.baseUrl, enabled: true, models: [] }],
              }));
              setPreset("");
              const placeholder = /YOUR-[A-Z-]+|ENDPOINT_ID/.exec(c.baseUrl)?.[0];
              toast(placeholder ? `${c.name} added at the end of the list. In its API endpoint, replace ${placeholder} with your own value.` : `${c.name} added at the end of the list.`, "ok");
            }}
          >
            Add
          </button>
        </div>
      </div>
      <h3 style={{ marginTop: 18 }}>Free image & video</h3>
      <p>
        Pollinations and AI Horde work with no sign-up. Pollinations makes video with a free key, Cloudflare has a free daily allowance, and fal.ai, Runway or your own server can be added too. Choose
        which one to use, and the defaults, from the backend button next to Image / Video in the message box.
      </p>
      {settings.providers.filter((pr) => pr.kind in BACKENDS).map((pr) => (
        <ProviderCard key={pr.id} provider={pr} />
      ))}
      <div className="card">
        <h4 style={{ marginBottom: 8 }}>Add an image / video service</h4>
        <div className="row wrap">
          {MEDIA_KINDS.filter((k) => k === "custom-media" || !settings.providers.some((pr) => pr.kind === k)).map((k) => (
            <button
              key={k}
              className="btn"
              onClick={() => {
                const id = k === "custom-media" ? uid("media") : k;
                void updateSettings((st) => ({ providers: [...st.providers, backendProvider(k, id)] })).then(() => toast(`${BACKENDS[k]!.name} added below. ${BACKENDS[k]!.keyless === "all" ? "" : "Paste its key to finish."}`, "ok"));
              }}
              title={BACKENDS[k]!.tagline}
            >
              <Icon.plus /> {BACKENDS[k]!.name}
            </button>
          ))}
        </div>
      </div>
      <h3 style={{ marginTop: 18 }}>Chat providers</h3>
      {settings.providers.filter((pr) => !(pr.kind in BACKENDS)).map((pr) => (
        <ProviderCard key={pr.id} provider={pr} />
      ))}
    </>
  );
}

// ---------- models ----------

function ModelSelect({ value, onChange, filter, empty }: { settings: Settings; value?: ModelRef; onChange: (r?: ModelRef) => void; filter: (m: ModelInfo) => boolean; empty: string }) {
  const providers = useProviders();
  return (
    <select
      value={modelKey(value)}
      onChange={(e) => {
        const [providerId, modelId] = e.target.value.split("::");
        onChange(e.target.value ? { providerId, modelId } : undefined);
      }}
    >
      <option value="">{empty}</option>
      {providers.map((p) => {
        const models = p.models.filter(filter);
        if (!models.length) return null;
        return (
          <optgroup key={p.id} label={p.name}>
            {models.map((m) => (
              <option key={m.id} value={`${p.id}::${m.id}`}>{m.name}</option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

function ModelsTab({ settings }: { settings: Settings }) {
  const [open, setOpen] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [filter, setFilter] = useState("");
  const patchModel = (providerId: string, modelId: string, fn: (m: ModelInfo) => ModelInfo) =>
    updateSettings((s) => ({
      providers: s.providers.map((p) => (p.id === providerId ? { ...p, models: p.models.map((m) => (m.id === modelId ? { ...fn(m), userEdited: true } : m)) } : p)),
    }));
  return (
    <>
      <h3>Models</h3>
      <p>Features switch on per model: a model that cannot see images, read PDFs or call tools is simply not given them.</p>
      <label className="field">
        <span>Default chat model</span>
        <ModelSelect settings={settings} value={settings.defaultModel} onChange={(r) => void updateSettings({ defaultModel: r })} filter={(m) => m.kind === "chat"} empty="First available" />
      </label>
      <label className="field">
        <span>Image generation</span>
        <ModelSelect settings={settings} value={settings.imageModel} onChange={(r) => void updateSettings({ imageModel: r })} filter={(m) => m.kind === "image" || !!m.caps.imageOutput} empty="Automatic (Pollinations, free)" />
      </label>
      <label className="field">
        <span>Video generation</span>
        <ModelSelect settings={settings} value={settings.videoModel} onChange={(r) => void updateSettings({ videoModel: r })} filter={(m) => m.kind === "video"} empty="Automatic (first ready video backend)" />
      </label>
      <p className="hint" style={{ marginBottom: 14 }}>
        Images and videos come from the free services under Providers & keys (Pollinations, AI Horde, Cloudflare), from plugins that add an engine, or from OpenAI, Google, xAI, OpenRouter, fal.ai and Runway with your key. Any chat model that can use tools can then ask for pictures and clips.
      </p>

      <h4>Capabilities per model</h4>
      <p className="hint" style={{ marginBottom: 8 }}>Detected automatically. Correct them here if a provider's listing is wrong.</p>
      {settings.providers.map((p) => (
        <div className="card" key={p.id}>
          <button className="menu-item" style={{ padding: 0, minHeight: 28 }} onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
            <h4 className="grow">{p.name}</h4>
            <span className="badge">{p.models.length}</span>
            <Icon.chevron />
          </button>
          {open === p.id && (
            <div style={{ marginTop: 10 }}>
              {p.models.length > 12 && <input type="search" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />}
              {p.models
                .filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || m.name.toLowerCase().includes(filter.toLowerCase()))
                .map((m) => (
                  <div className="model-row" key={m.id}>
                    <span className="name" title={m.id}>{m.name}</span>
                    <select
                      value={m.kind}
                      style={{ width: 92, minHeight: 30, padding: "2px 6px", fontSize: 13 }}
                      aria-label={`${m.name} type`}
                      onChange={(e) => void patchModel(p.id, m.id, (x) => ({ ...x, kind: e.target.value as ModelInfo["kind"] }))}
                    >
                      <option value="chat">chat</option>
                      <option value="image">image</option>
                      <option value="video">video</option>
                    </select>
                    <span className="caps">
                      {(["vision", "pdf", "tools", "thinking"] as const).map((cap) => (
                        <label key={cap}>
                          <input type="checkbox" checked={!!m.caps[cap]} onChange={(e) => void patchModel(p.id, m.id, (x) => ({ ...x, caps: { ...x.caps, [cap]: e.target.checked } }))} />
                          {cap === "vision" ? "images" : cap === "pdf" ? "PDF" : cap}
                        </label>
                      ))}
                    </span>
                  </div>
                ))}
              <div className="row" style={{ marginTop: 10 }}>
                <input type="text" placeholder="Add a model by id" value={newId} spellCheck={false} onChange={(e) => setNewId(e.target.value)} />
                <button
                  className="btn"
                  disabled={!newId.trim() || p.models.some((m) => m.id === newId.trim())}
                  onClick={() => {
                    void updateSettings((s) => ({ providers: s.providers.map((x) => (x.id === p.id ? { ...x, models: [...x.models, manualModel(newId.trim())] } : x)) }));
                    setNewId("");
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

// ---------- tools ----------

function ToolsTab({ settings }: { settings: Settings }) {
  const p = platform();
  const setTool = (k: keyof Settings["tools"], v: boolean) => updateSettings((s) => ({ tools: { ...s.tools, [k]: v } }));
  return (
    <>
      <h3>Tools & computer</h3>
      <p>What the assistant may do besides writing text. Tools are only offered to models that support tool calling.</p>
      <div className="card">
        <Toggle checked={settings.tools.files} onChange={(v) => void setTool("files", v)} label="Create files" hint="Excel workbooks, PDFs, Word documents, PowerPoint decks and any text or code file. Made on this device." />
        <Toggle checked={settings.tools.media} onChange={(v) => void setTool("media", v)} label="Generate images and video" hint="Uses the image and video models chosen under Models." />
        <Toggle checked={settings.tools.web} onChange={(v) => void setTool("web", v)} label="Web access" hint="Read web pages. Addresses you did not type yourself are confirmed first." />
        <Toggle checked={settings.webSearch} disabled={!settings.tools.web} onChange={(v) => void updateSettings({ webSearch: v })} label="Prefer native provider search when available (Claude, Grok)" hint="Claude uses Anthropic's web search and fetch; Grok uses xAI's web search and X search. Both cite their sources and are billed by the provider. Off: every model uses Meridian's web search below." />
        <Toggle checked={settings.tools.connectors} onChange={(v) => void setTool("connectors", v)} label="Connectors" hint="Tools from the MCP servers on the Connectors tab." />
      </div>

      <h4>Computer access</h4>
      {p.desktop ? (
        <div className="card">
          <Toggle
            checked={settings.tools.computer}
            onChange={(v) => void setTool("computer", v)}
            label="Let the assistant use this computer"
            hint={`Run ${p.os === "windows" ? "PowerShell" : "shell"} commands, read and write files, open apps, install software${p.os === "windows" ? " with winget" : p.os === "macos" ? " with Homebrew" : ""}${p.canControlScreen ? ", take screenshots and use the mouse and keyboard" : ""}. You are asked before each action.`}
          />
          <Toggle
            checked={settings.autoApproveComputer}
            disabled={!settings.tools.computer}
            onChange={(v) => {
              if (v && !confirm("The assistant will run commands, change files and install software without asking first. A mistaken or manipulated instruction could damage data. Turn this on?")) return;
              void updateSettings({ autoApproveComputer: v });
            }}
            label="Never ask before computer actions"
            hint="Not recommended. Anything the model decides to run will run immediately."
          />
          {!p.canControlScreen && <div className="hint">Screenshots and mouse/keyboard control are available in the Windows and macOS builds.</div>}
        </div>
      ) : null}
      {p.desktop && p.canControlScreen ? (
        <div className="card" data-testid="computer-use-settings">
          <h4 style={{ marginTop: 0 }}>Computer use (screen, mouse and keyboard)</h4>
          <p className="hint" style={{ marginTop: 0 }}>
            The assistant looks at a screenshot, chooses an action, and gets a new screenshot after it, step by step. Each step shows in the chat with a picture of where it will click.
            Press <b>Stop</b>, <b>Esc</b>, or <b>Ctrl+Alt+Esc</b> anywhere (⌃⌥Esc on a Mac) to stop at once; mouse and keyboard stay blocked until you send a new message.
          </p>
          <label className="field">
            <span>Ask before</span>
            <select value={settings.computerUse.approval} onChange={(e) => {
              const v = e.target.value as Settings["computerUse"]["approval"];
              if (v === "auto" && !confirm("Every mouse click and keystroke will happen without asking. A mistaken or manipulated instruction could delete, send or buy things. Turn this on?")) return;
              void updateSettings((st) => ({ computerUse: { ...st.computerUse, approval: v } }));
            }} aria-label="Computer use approval">
              <option value="each">Every action (recommended)</option>
              <option value="risky">Risky actions only: typing, shortcuts, drags, right and double clicks</option>
              <option value="auto">Nothing (not recommended)</option>
            </select>
            <small className="hint">The approval card also offers “Allow for this task”, which stops asking until you send your next message.</small>
          </label>
          <div className="row wrap">
            <label className="field" style={{ flex: "1 1 160px" }}>
              <span>Actions per minute (at most)</span>
              <input type="number" min={1} max={120} value={settings.computerUse.actionsPerMinute} onChange={(e) => void updateSettings((st) => ({ computerUse: { ...st.computerUse, actionsPerMinute: Math.max(1, Math.min(120, Number(e.target.value) || 30)) } }))} />
            </label>
            <label className="field" style={{ flex: "1 1 160px" }}>
              <span>Steps per task (at most)</span>
              <input type="number" min={5} max={500} value={settings.computerUse.maxSteps} onChange={(e) => void updateSettings((st) => ({ computerUse: { ...st.computerUse, maxSteps: Math.max(5, Math.min(500, Number(e.target.value) || 80)) } }))} />
            </label>
            <label className="field" style={{ flex: "1 1 160px" }}>
              <span>Screenshots the model keeps seeing</span>
              <input type="number" min={1} max={10} value={settings.computerUse.keepScreenshots} onChange={(e) => void updateSettings((st) => ({ computerUse: { ...st.computerUse, keepScreenshots: Math.max(1, Math.min(10, Number(e.target.value) || 3)) } }))} />
            </label>
          </div>
        </div>
      ) : p.desktop ? null : (
        <div className="note">
          {p.mobile
            ? "iPhone and iPad do not allow any app to run commands, control other apps or install software, so these tools exist only in the Windows (and macOS/Linux) app. Everything else works here, and files the assistant makes are saved to the Files app."
            : "Computer access needs the installed desktop app. It is not available in a browser."}
        </div>
      )}

      <h4>Browser</h4>
      <BrowserSettings />

      <h4>Web search</h4>
      <SearchKeys />
      <div className="card">
        <Toggle checked={settings.subagents} onChange={(v) => void updateSettings({ subagents: v })} label="Sub-agents" hint="Let the assistant hand independent parts of big jobs to helpers that work in parallel (uses more tokens)." />
      </div>

      <h4>Always allowed</h4>
      {settings.alwaysAllow.length === 0 ? (
        <div className="hint">Nothing yet. Tools you choose “Always allow” for show up here.</div>
      ) : (
        <div className="chips">
          {settings.alwaysAllow.map((name) => (
            <span className="chip" key={name}>
              <span>{name}</span>
              <button aria-label={`Ask again for ${name}`} onClick={() => void updateSettings((s) => ({ alwaysAllow: s.alwaysAllow.filter((n) => n !== name) }))}>×</button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- sync & backup ----------

/** Sync chats through Google Drive or OneDrive, on every platform (alongside iCloud or a folder). */
function CloudSyncCard({ settings }: { settings: Settings }) {
  const cloud = settings.sync.cloud;
  const [provider, setProvider] = useState<CloudSync["provider"]>(cloud?.provider ?? "onedrive");
  const [clientId, setClientId] = useState(cloud?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(cloud?.tenant ?? "");
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const google = provider === "google";

  if (cloud?.account) {
    return (
      <div className="card">
        <div className="row">
          <span className="grow">
            Syncing with <b>{CLOUD_NAMES[cloud.provider]}</b> as {cloud.account}.{" "}
            <span className="hint">{cloud.provider === "google" ? "Chats are in the Meridian folder in My Drive." : "Chats are in Apps › your app's folder in OneDrive."}</span>
          </span>
          <button className="btn small danger" onClick={() => confirm(`Stop syncing with ${CLOUD_NAMES[cloud.provider]}? Chats stay on this device and in the cloud.`) && void disconnectCloudSync()}>
            Sign out
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          Sign in with the same account and the same app (client) ID on your other devices: Windows, iPhone, iPad, Mac. Every chat is merged, never replaced. This works alongside iCloud: chats from iCloud are passed on to {CLOUD_NAMES[cloud.provider]} and back.
        </p>
      </div>
    );
  }

  const start = async () => {
    setBusy(true);
    abort.current = new AbortController();
    try {
      await connectCloudSync({ provider, clientId, clientSecret: secret, tenant }, setCode, abort.current.signal);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast(errText(e), "error");
    } finally {
      setBusy(false);
      setCode(null);
    }
  };

  return (
    <div className="card">
      <p className="hint" style={{ marginTop: 0 }}>
        Keep chats in your own Google Drive or OneDrive and have them appear on every device, including Windows PCs, the same way iCloud sync works. You register a free app with Google or Microsoft once (about five minutes, see <b>Sync with Google Drive or OneDrive</b> in the README) and sign in with a code on each device.
      </p>
      <div className="seg" role="radiogroup" aria-label="Cloud drive" style={{ marginBottom: 10 }}>
        {(["onedrive", "google"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={provider === k} className={provider === k ? "sel" : ""} onClick={() => setProvider(k)}>
            {CLOUD_NAMES[k]}
          </button>
        ))}
      </div>
      <label className="field">
        <span>{google ? "OAuth client ID (type: TVs and Limited Input devices)" : "Application (client) ID"}</span>
        <input type="text" spellCheck={false} autoCapitalize="off" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={google ? "1234567890-abc….apps.googleusercontent.com" : "00000000-0000-0000-0000-000000000000"} aria-label="Client ID" />
      </label>
      {google ? (
        <label className="field">
          <span>Client secret</span>
          <input type="password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" aria-label="Client secret" />
          <small className="hint">Google gives this type of client a secret; it is kept in this device's keychain with your sign-in.</small>
        </label>
      ) : (
        <label className="field">
          <span>Account type (optional)</span>
          <select value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="Account type">
            <option value="">Personal and work or school accounts</option>
            <option value="consumers">Personal Microsoft accounts only</option>
            <option value="organizations">Work or school accounts only</option>
          </select>
        </label>
      )}
      {code ? (
        <div className="note" role="status">
          <div style={{ marginBottom: 6 }}>
            Open <b>{code.verification_url}</b> on any device and enter this code:
          </div>
          <div className="row wrap">
            <code style={{ fontSize: 20, letterSpacing: 2, padding: "4px 10px" }} data-testid="device-code">{code.user_code}</code>
            <button className="btn small" onClick={() => void navigator.clipboard?.writeText(code.user_code)}>Copy code</button>
            <button className="btn small primary" onClick={() => void openExternal(code.verification_url_complete ?? code.verification_url)}>Open sign-in page</button>
            <button className="btn small" onClick={() => abort.current?.abort()}>Cancel</button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>Waiting for you to finish signing in…</div>
        </div>
      ) : (
        <button className="btn primary" disabled={busy || !clientId.trim() || (google && !secret.trim())} onClick={() => void start()}>
          {busy ? "Starting…" : `Sign in to ${CLOUD_NAMES[provider]}`}
        </button>
      )}
    </div>
  );
}

function SyncTab({ settings }: { settings: Settings }) {
  const sync = useApp((s) => s.sync);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [working, setWorking] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const p = platform();
  const setSync = (patch: Partial<Settings["sync"]>) => updateSettings((s) => ({ sync: { ...s.sync, ...patch } }));
  const apple = p.os === "ios" || p.os === "macos";
  // where the iOS app's iCloud folder lands on a computer with iCloud Drive
  const cloudCandidate = p.icloudDrive && p.identifier ? `${p.icloudDrive}${p.os === "windows" ? "\\" : "/"}iCloud~${p.identifier.replace(/\./g, "~")}` : "";
  const [appCloudDir, setAppCloudDir] = useState("");
  useEffect(() => {
    if (!cloudCandidate) return;
    invoke<boolean>("fs_exists", { path: cloudCandidate }).then((ok) => setAppCloudDir(ok ? cloudCandidate : ""), () => undefined);
  }, [cloudCandidate]);

  return (
    <>
      <h3>Sync & backup</h3>
      <p>
        Chats are always stored on this device. Sync keeps the same chats on your other devices; backups are a file you move yourself. Both merge, message by message: nothing already on a device is replaced.
      </p>

      <h4>Sync</h4>
      <div className="card">
        {apple &&
          (p.icloudContainer ? (
            <Toggle checked={settings.sync.icloud} onChange={(v) => void setSync({ icloud: v })} label="Sync with iCloud" hint="Chats and their files are kept in this app's iCloud Drive folder and appear on your other Apple devices signed in to the same Apple Account." />
          ) : (
            <div className="note warn" style={{ marginBottom: 10 }}>
              iCloud is not available to the app right now. Sign in to iCloud and turn on iCloud Drive in the Settings app{p.os === "ios" ? "" : " (System Settings)"}, then reopen Meridian.
            </div>
          ))}
        {p.desktop && (
          <>
            <label className="field">
              <span>Sync folder {apple && settings.sync.icloud && p.icloudContainer ? "(not used while iCloud sync is on)" : ""}</span>
              <div className="row">
                <input type="text" readOnly value={settings.sync.folder ?? ""} placeholder="No folder chosen" />
                <button
                  className="btn"
                  onClick={async () => {
                    const dir = await pickFolder();
                    if (dir) await setSync({ folder: dir });
                  }}
                >
                  Choose…
                </button>
                {settings.sync.folder && <button className="btn" onClick={() => void setSync({ folder: undefined })}>Clear</button>}
              </div>
            </label>
            {(p.os === "windows" || p.os === "macos") && !(apple && settings.sync.icloud && p.icloudContainer) && (
              <div className="note" style={{ marginBottom: 10 }}>
                {!p.icloudDrive ? (
                  <>
                    {p.os === "windows" ? "Windows has no built-in iCloud. " : ""}To share chats with your iPhone and iPad automatically, {p.os === "windows" ? <>install <b>iCloud for Windows</b> from the Microsoft Store, sign in, turn on iCloud Drive, and then</> : "turn on iCloud Drive and"} choose the Meridian folder in iCloud Drive here. Or move chats by hand with the backup file below.
                  </>
                ) : appCloudDir ? (
                  <>
                    Found the Meridian folder from your iPhone or iPad in iCloud Drive.{" "}
                    {settings.sync.folder === appCloudDir ? (
                      <b>This PC is syncing with it.</b>
                    ) : (
                      <button className="btn small" onClick={() => void setSync({ folder: appCloudDir })}>Sync with it</button>
                    )}
                  </>
                ) : (
                  <>
                    iCloud Drive is set up on this computer. Open Meridian on your iPhone or iPad once with iCloud sync on; a <b>Meridian</b> folder then appears in iCloud Drive (on disk: <code>{cloudCandidate}</code>) and a button to use it shows up here. You can also choose any other folder in iCloud Drive right now.
                  </>
                )}
              </div>
            )}
          </>
        )}
        {p.os === "web" && <div className="note">iCloud and folder sync need the installed app. Google Drive and OneDrive sync (below) and backups work here too.</div>}
      </div>
      <h4>Google Drive or OneDrive</h4>
      <CloudSyncCard settings={settings} />
      <div className="card">
        <Toggle checked={settings.sync.auto} onChange={(v) => void setSync({ auto: v })} label="Sync automatically" hint="On launch, after each reply and once a minute." />
        <div className="row wrap">
          <button className="btn" disabled={sync.state === "off" || sync.state === "syncing"} onClick={() => void syncNow()}>
            <Icon.refresh /> {sync.state === "syncing" ? "Syncing…" : "Sync now"}
          </button>
          <span className="hint">
            {sync.state === "off" ? "Sync is off." : `Target: ${sync.target}${sync.at ? ` · last synced ${new Date(sync.at).toLocaleString()}` : ""}`}
          </span>
        </div>
        {sync.message && <div className="note err" style={{ marginTop: 8 }}>{sync.message}</div>}
      </div>

      <h4>Backup file</h4>
      <div className="card">
        <p className="hint" style={{ marginBottom: 8 }}>
          Export every chat to one <code>.meridianbackup</code> file, move it any way you like (AirDrop, USB, email, a cloud drive), and import it on another device. Importing adds chats that are missing and merges chats that exist on both. API keys are never included.
        </p>
        <Toggle checked={includeFiles} onChange={setIncludeFiles} label="Include attachments and generated files" hint="Larger file. Without it, chats import but their files show as unavailable." />
        <div className="row wrap">
          <button
            className="btn"
            disabled={!!working}
            onClick={async () => {
              setWorking("export");
              try {
                await exportBackupFile(includeFiles);
              } catch (e) {
                toast(`Export failed: ${errText(e)}`, "error");
              } finally {
                setWorking("");
              }
            }}
          >
            <Icon.download /> {working === "export" ? "Exporting…" : "Export backup"}
          </button>
          <input
            ref={importInput}
            type="file"
            hidden
            accept=".meridianbackup,.zip,application/zip"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setWorking("import");
              try {
                await importBackupFile(file);
              } catch (err) {
                toast(`Import failed: ${errText(err)}`, "error");
              } finally {
                setWorking("");
              }
            }}
          />
          <button className="btn" disabled={!!working} onClick={() => importInput.current?.click()}>
            {working === "import" ? "Importing…" : "Import backup"}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- general ----------

function GeneralTab({ settings }: { settings: Settings }) {
  return (
    <>
      <h3>General</h3>
      <p>Appearance and behaviour.</p>
      <label className="field">
        <span>Appearance</span>
        <select value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as Settings["theme"] })}>
          <option value="system">Match the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="field">
        <span>Your standing instructions (added to every chat)</span>
        <textarea rows={4} defaultValue={settings.systemPrompt} placeholder="e.g. I'm a product manager in Berlin. Prefer concise answers and metric units." onBlur={(e) => e.target.value !== settings.systemPrompt && void updateSettings({ systemPrompt: e.target.value })} />
      </label>
      <div className="card">
        <Toggle checked={settings.showThinking} onChange={(v) => void updateSettings({ showThinking: v })} label="Show the model's thinking" hint="A collapsed summary of reasoning, when the model provides one." />
        <Toggle
          checked={settings.refusalFallback}
          onChange={(v) => void updateSettings({ refusalFallback: v })}
          label="Claude: retry declined requests on a fallback model"
          hint="If one of the newest Claude models declines a request for safety reasons, Anthropic re-runs it on another Claude model in the same call (billed at that model's rate). The reply shows which model answered."
        />
      </div>
      <label className="field">
        <span>Maximum tool steps per reply</span>
        <input type="number" min={1} max={200} defaultValue={settings.maxAgentSteps} onBlur={(e) => void updateSettings({ maxAgentSteps: Math.min(200, Math.max(1, Math.round(Number(e.target.value) || 40))) })} />
      </label>
      <p className="hint">Sampling and other generation parameters are behind the sliders button at the top of a chat.</p>
      <GeneralExtras />
    </>
  );
}

export function SettingsModal() {
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const close = () => useApp.setState({ settingsTab: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !useApp.getState().permissions.length && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!tab) return null;
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" style={{ height: "min(100%, 720px)" }}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close" onClick={close}>
            <Icon.x />
          </button>
        </div>
        <div className="settings">
          <div className="settings-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "sel" : ""} onClick={() => useApp.setState({ settingsTab: id })}>
                {label}
              </button>
            ))}
          </div>
          <div className="settings-pane" role="tabpanel">
            {tab === "providers" && <ProvidersTab settings={settings} />}
            {tab === "models" && <ModelsTab settings={settings} />}
            {tab === "tools" && <ToolsTab settings={settings} />}
            {tab === "connectors" && <ConnectorsTab />}
            {tab === "sync" && <SyncTab settings={settings} />}
            {tab === "general" && <GeneralTab settings={settings} />}
            {tab === "plugins" && <PluginsTab />}
            {tab === "memory" && <MemoryTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
