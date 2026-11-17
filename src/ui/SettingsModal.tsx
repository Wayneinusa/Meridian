import { useEffect, useRef, useState } from "react";
import { invoke, platform } from "../platform";
import { pickFolder } from "../platform/files";
import { deleteSecret, mcpTokenName, setSecret } from "../platform/secrets";
import { COMPATIBLE_PRESETS, manualModel } from "../providers/registry";
import { addManualModel, cancelWake, exportBackupFile, importBackupFile, refreshModels, removeModel, saveProviderKey, syncNow, toast, updateSettings, useApp, wakeUp } from "../state/store";
import { mcpManager } from "../tools/mcp";
import type { McpServerConfig, ModelInfo, ModelRef, ProviderConfig, Settings } from "../types";
import { modelKey, uid } from "../types";
import { Icon } from "./icons";

const TABS = [
  ["providers", "Providers & keys"],
  ["models", "Models"],
  ["tools", "Tools & computer"],
  ["connectors", "Connectors"],
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

function ProviderCard({ provider }: { provider: ProviderConfig }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelKind, setModelKind] = useState<"" | "chat" | "image" | "video">("");
  const [waking, setWaking] = useState<Record<string, string>>({});
  const builtin = ["anthropic", "openai", "gemini", "xai"].includes(provider.id);
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
        <span className={`badge ${provider.hasKey ? "ok" : ""}`}>{provider.hasKey ? "key saved" : provider.kind === "openai-compatible" ? "no key" : "needs a key"}</span>
        <span className="badge">{provider.models.length} models</span>
      </div>
      {!builtin && (
        <label className="field">
          <span>Name</span>
          <input type="text" defaultValue={provider.name} onBlur={(e) => e.target.value.trim() && e.target.value !== provider.name && void patch({ name: e.target.value.trim() })} />
        </label>
      )}
      <label className="field">
        <span>API endpoint</span>
        <input type="url" defaultValue={provider.baseUrl} spellCheck={false} onBlur={(e) => e.target.value !== provider.baseUrl && void patch({ baseUrl: e.target.value.trim() })} />
      </label>
      <label className="field">
        <span>API key</span>
        <div className="row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={provider.hasKey ? "•••••••• saved — type to replace" : "Paste your key"}
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
            placeholder="e.g. meta-llama/Llama-3.3-70B-Instruct"
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
          <button className="btn primary" disabled={!modelId.trim()} onClick={() => void addModel(true)} title="Add the model and send a test message until it has loaded">
            Add &amp; wake up
          </button>
        </div>
        <small className="hint">
          For models the provider does not list right now, such as cold models that load on first use. Wake up sends a tiny test message and keeps retrying for up to 10 minutes while the model loads.
        </small>
      </label>
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
      {settings.providers.map((pr) => (
        <ProviderCard key={pr.id} provider={pr} />
      ))}
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
            }}
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- models ----------

function ModelSelect({ settings, value, onChange, filter, empty }: { settings: Settings; value?: ModelRef; onChange: (r?: ModelRef) => void; filter: (m: ModelInfo) => boolean; empty: string }) {
  return (
    <select
      value={modelKey(value)}
      onChange={(e) => {
        const [providerId, modelId] = e.target.value.split("::");
        onChange(e.target.value ? { providerId, modelId } : undefined);
      }}
    >
      <option value="">{empty}</option>
      {settings.providers.map((p) => {
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
        <ModelSelect settings={settings} value={settings.imageModel} onChange={(r) => void updateSettings({ imageModel: r })} filter={(m) => m.kind === "image" || !!m.caps.imageOutput} empty="Off (no image model chosen)" />
      </label>
      <label className="field">
        <span>Video generation</span>
        <ModelSelect settings={settings} value={settings.videoModel} onChange={(r) => void updateSettings({ videoModel: r })} filter={(m) => m.kind === "video"} empty="Off (no video model chosen)" />
      </label>
      <p className="hint" style={{ marginBottom: 14 }}>
        Image and video models come from OpenAI, Google or an OpenAI-compatible provider. Add that provider's key and fetch its model list to see them here. Any chat model that can use tools can then ask for pictures and clips.
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
        <Toggle checked={settings.webSearch} disabled={!settings.tools.web} onChange={(v) => void updateSettings({ webSearch: v })} label="Provider web search" hint="Let Claude models use Anthropic's hosted web search and fetch (billed by Anthropic per search)." />
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
      ) : (
        <div className="note">
          {p.mobile
            ? "iPhone and iPad do not allow any app to run commands, control other apps or install software, so these tools exist only in the Windows (and macOS/Linux) app. Everything else works here, and files the assistant makes are saved to the Files app."
            : "Computer access needs the installed desktop app. It is not available in a browser."}
        </div>
      )}

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

// ---------- connectors ----------

function ConnectorCard({ server }: { server: McpServerConfig }) {
  const [, force] = useState(0);
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  useEffect(() => mcpManager.onChange(() => force((n) => n + 1)), []);
  const status = mcpManager.status.get(server.id);
  const patch = async (p: Partial<McpServerConfig>) => {
    await updateSettings((s) => ({ mcpServers: s.mcpServers.map((x) => (x.id === server.id ? { ...x, ...p } : x)) }));
    await mcpManager.reset(server.id);
  };
  const test = async () => {
    setTesting(true);
    const cfg = useApp.getState().settings.mcpServers.find((x) => x.id === server.id)!;
    const st = await mcpManager.connect(cfg);
    setTesting(false);
    if (st.state === "ready") toast(`${server.name}: connected, ${st.tools.length} tools.`, "ok");
    else toast(`${server.name}: ${st.error ?? "could not connect"}`, "error");
  };
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h4 className="grow">{server.name}</h4>
        {status?.state === "ready" && <span className="badge ok">{status.tools.length} tools</span>}
        {status?.state === "error" && <span className="badge err">error</span>}
        {status?.state === "connecting" && <span className="spinner" />}
        <span className="badge">{server.transport === "http" ? "remote" : "local command"}</span>
      </div>
      {server.transport === "http" ? (
        <>
          <label className="field">
            <span>Server URL</span>
            <input type="url" defaultValue={server.url} spellCheck={false} placeholder="https://example.com/mcp" onBlur={(e) => e.target.value !== (server.url ?? "") && void patch({ url: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Access token (sent as “Authorization: Bearer …”)</span>
            <div className="row">
              <input type="password" autoComplete="off" placeholder={server.hasToken ? "•••••••• saved — type to replace" : "Optional"} value={token} onChange={(e) => setToken(e.target.value)} />
              <button
                className="btn"
                disabled={!token.trim() && !server.hasToken}
                onClick={async () => {
                  if (token.trim()) await setSecret(mcpTokenName(server.id), token.trim());
                  else await deleteSecret(mcpTokenName(server.id));
                  await patch({ hasToken: !!token.trim() });
                  setToken("");
                }}
              >
                {token.trim() ? "Save" : "Clear"}
              </button>
            </div>
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>Command</span>
            <input type="text" defaultValue={server.command} spellCheck={false} placeholder="npx" onBlur={(e) => e.target.value !== (server.command ?? "") && void patch({ command: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>Arguments (one per line)</span>
            <textarea rows={2} defaultValue={(server.args ?? []).join("\n")} spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents"} onBlur={(e) => void patch({ args: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} />
          </label>
          <label className="field">
            <span>Environment variables (NAME=value, one per line)</span>
            <textarea
              rows={2}
              spellCheck={false}
              defaultValue={Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
              onBlur={(e) => {
                const env: Record<string, string> = {};
                for (const line of e.target.value.split("\n")) {
                  const i = line.indexOf("=");
                  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
                }
                void patch({ env });
              }}
            />
          </label>
        </>
      )}
      <Toggle checked={server.enabled} onChange={(v) => void patch({ enabled: v })} label="Enabled" />
      <Toggle checked={!!server.trusted} onChange={(v) => void patch({ trusted: v })} label="Run this connector's tools without asking" hint="Otherwise each call is confirmed, because connectors act in outside services." />
      {status?.state === "error" && <div className="note err" style={{ marginBottom: 8 }}>{status.error}</div>}
      {status?.state === "ready" && status.tools.length > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Tools</summary>
          <div className="chips" style={{ marginTop: 6 }}>
            {status.tools.map((t) => (
              <span className="badge" key={t.name} title={t.description}>{t.name}</span>
            ))}
          </div>
        </details>
      )}
      <div className="row wrap">
        <button className="btn small" disabled={testing} onClick={() => void test()}>{testing ? "Connecting…" : "Connect and list tools"}</button>
        <button
          className="btn small danger"
          onClick={async () => {
            if (!confirm(`Remove connector ${server.name}?`)) return;
            await deleteSecret(mcpTokenName(server.id));
            await mcpManager.reset(server.id);
            await updateSettings((s) => ({ mcpServers: s.mcpServers.filter((x) => x.id !== server.id) }));
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function ConnectorsTab({ settings }: { settings: Settings }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const desktop = platform().desktop;
  return (
    <>
      <h3>Connectors</h3>
      <p>
        Connect outside tools and data through the Model Context Protocol (MCP). Remote servers work on every device. Local servers started by a command run in the desktop app.
      </p>
      {settings.mcpServers.map((s) => (
        <ConnectorCard key={s.id} server={s} />
      ))}
      <div className="card">
        <h4 style={{ marginBottom: 8 }}>Add a connector</h4>
        <div className="row wrap">
          <input type="text" placeholder="Name, e.g. Notion" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 160px" }} />
          <select value={transport} onChange={(e) => setTransport(e.target.value as "http" | "stdio")} style={{ flex: "0 1 190px" }} aria-label="Connector type">
            <option value="http">Remote server (URL)</option>
            <option value="stdio" disabled={!desktop}>Local command{desktop ? "" : " (desktop only)"}</option>
          </select>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              void updateSettings((s) => ({ mcpServers: [...s.mcpServers, { id: uid("mcp"), name: name.trim(), transport, enabled: true }] }));
              setName("");
            }}
          >
            Add
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Remote servers are reached with a URL and, if needed, an access token or API key from that service. Servers that only offer browser sign-in (OAuth) are not supported yet.
        </p>
      </div>
    </>
  );
}

// ---------- sync & backup ----------

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
        {p.os === "web" && <div className="note">Sync needs the installed app. In a browser you can still export and import backups below.</div>}
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
    </>
  );
}

export function SettingsModal() {
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const close = () => useApp.setState({ settingsTab: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !useApp.getState().permission && close();
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
            {tab === "connectors" && <ConnectorsTab settings={settings} />}
            {tab === "sync" && <SyncTab settings={settings} />}
            {tab === "general" && <GeneralTab settings={settings} />}
          </div>
        </div>
      </div>
    </div>
  );
}
