import { useEffect, useState } from "react";
import { CATALOG, searchRegistry, type CatalogEntry, type RegistryServer } from "../connectors/catalog";
import { signInNative } from "../connectors/native";
import { isBankConnector } from "../connectors/banks";
import { BankSetup } from "./BankSetup";
import { forgetTokens, loadTokens, saveTokens, signIn } from "../connectors/oauth";
import { platform } from "../platform";
import { deleteSecret, getSecret, mcpTokenName, setSecret } from "../platform/secrets";
import { errText, toast, updateSettings, useApp } from "../state/store";
import { mcpManager } from "../tools/mcp";
import type { McpServerConfig } from "../types";
import { uid } from "../types";
import { Icon } from "./icons";

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

async function patchServer(id: string, p: Partial<McpServerConfig>) {
  await updateSettings((s) => ({ mcpServers: s.mcpServers.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  await mcpManager.reset(id);
}

function ConnectorCard({ server }: { server: McpServerConfig }) {
  const [, force] = useState(0);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const apps = useApp((s) => s.settings.oauthApps);
  useEffect(() => mcpManager.onChange(() => force((n) => n + 1)), []);
  useEffect(() => {
    void loadTokens(server.id).then((t) => setSignedIn(!!t));
  }, [server.id, busy]);
  const status = mcpManager.status.get(server.id);
  const entry = CATALOG.find((c) => c.id === server.catalogId);
  const native = server.transport === "native";
  const bank = isBankConnector(server.catalogId);

  const connect = async () => {
    setBusy("Connecting…");
    const cfg = useApp.getState().settings.mcpServers.find((x) => x.id === server.id)!;
    const st = await mcpManager.connect(cfg);
    setBusy("");
    if (st.state === "ready") toast(`${server.name}: connected, ${st.tools.length} tools.`, "ok");
    else if (st.state === "signin") toast(`${server.name}: sign in first.`, "info");
    else toast(`${server.name}: ${st.error ?? "could not connect"}`, "error");
  };

  const doSignIn = async () => {
    setBusy("Waiting for you to sign in in the browser…");
    try {
      if (native) {
        const app = server.catalogId === "google" ? apps.google : apps.microsoft;
        if (!app?.clientId) throw new Error(`Add your ${server.catalogId === "google" ? "Google" : "Microsoft"} app's client ID below first.`);
        const secret = server.catalogId === "google" ? await getSecret("oauthapp.google.secret") : null;
        await saveTokens(server.id, await signInNative(server, { ...app, clientSecret: secret ?? undefined }));
      } else {
        await saveTokens(server.id, await signIn({ resource: server.url!, resourceMetadataUrl: status?.resourceMetadata }));
      }
      await patchServer(server.id, { oauth: { authorized: true } });
      toast(`${server.name}: signed in.`, "ok");
      if (!native) await connect();
    } catch (e) {
      toast(`${server.name}: ${errText(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  const signOut = async () => {
    await forgetTokens(server.id);
    await patchServer(server.id, { oauth: { authorized: false } });
    setSignedIn(false);
    toast(`${server.name}: signed out.`, "ok");
  };

  const badge =
    bank ? <span className="badge">read-only</span>
    : native ? (signedIn ? <span className="badge ok">signed in</span> : <span className="badge err">not signed in</span>)
    : status?.state === "ready" ? <span className="badge ok">{status.tools.length} tool{status.tools.length === 1 ? "" : "s"}</span>
    : status?.state === "signin" ? <span className="badge err">sign in needed</span>
    : status?.state === "error" ? <span className="badge err">error</span>
    : status?.state === "connecting" ? <span className="spinner" />
    : null;

  return (
    <div className="card">
      <div className="row">
        <span style={{ fontSize: 22 }}>{entry?.emoji ?? "🔌"}</span>
        <h4 className="grow">{server.name}</h4>
        {badge}
        <label className="switch" style={{ padding: 0 }}>
          <input type="checkbox" checked={server.enabled} onChange={(e) => void patchServer(server.id, { enabled: e.target.checked })} aria-label={`Enable ${server.name}`} />
        </label>
        <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Less" : "Details"}</button>
      </div>
      {busy && <div className="hint" style={{ marginTop: 6 }}><span className="spinner" style={{ display: "inline-block", verticalAlign: "-2px" }} /> {busy}</div>}
      {status?.state === "error" && !open && <div className="note err" style={{ marginTop: 8 }}>{status.error}</div>}
      <div className="row wrap" style={{ marginTop: 8 }}>
        {!bank && (native || status?.state === "signin" || server.oauth?.authorized || entry?.auth === "oauth") && !signedIn && (
          <button className="btn small primary" disabled={!!busy} onClick={() => void doSignIn()}>Sign in</button>
        )}
        {signedIn && !bank && <button className="btn small" onClick={() => void signOut()}>Sign out</button>}
        {!native && <button className="btn small" disabled={!!busy} onClick={() => void connect()}>Connect and list tools</button>}
      </div>
      {bank && <BankSetup server={server} />}
      {open && (
        <div style={{ marginTop: 10 }}>
          {entry?.note && <p className="hint">{entry.note}</p>}
          {!native && server.transport !== "stdio" && (
            <>
              <label className="field">
                <span>Server address {server.transport === "sse" ? "(SSE)" : ""}</span>
                <input type="url" defaultValue={server.url} spellCheck={false} onBlur={(e) => e.target.value !== (server.url ?? "") && void patchServer(server.id, { url: e.target.value.trim() })} />
              </label>
              <label className="field">
                <span>Transport</span>
                <select value={server.transport} onChange={(e) => void patchServer(server.id, { transport: e.target.value as "http" | "sse" })}>
                  <option value="http">Streamable HTTP</option>
                  <option value="sse">SSE (older servers)</option>
                </select>
              </label>
              <label className="field">
                <span>Access token or API key (instead of signing in; sent as Bearer)</span>
                <div className="row">
                  <input type="password" autoComplete="off" placeholder={server.hasToken ? "•••••••• saved — type to replace" : "Optional"} value={token} onChange={(e) => setToken(e.target.value)} />
                  <button
                    className="btn"
                    disabled={!token.trim() && !server.hasToken}
                    onClick={async () => {
                      if (token.trim()) await setSecret(mcpTokenName(server.id), token.trim());
                      else await deleteSecret(mcpTokenName(server.id));
                      await patchServer(server.id, { hasToken: !!token.trim() });
                      setToken("");
                    }}
                  >
                    {token.trim() ? "Save" : "Clear"}
                  </button>
                </div>
              </label>
            </>
          )}
          {server.transport === "stdio" && (
            <>
              <label className="field">
                <span>Command</span>
                <input type="text" defaultValue={server.command} spellCheck={false} onBlur={(e) => void patchServer(server.id, { command: e.target.value.trim() })} />
              </label>
              <label className="field">
                <span>Arguments (one per line)</span>
                <textarea rows={2} defaultValue={(server.args ?? []).join("\n")} spellCheck={false} onBlur={(e) => void patchServer(server.id, { args: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} />
              </label>
              <label className="field">
                <span>Environment (NAME=value per line)</span>
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
                    void patchServer(server.id, { env });
                  }}
                />
              </label>
            </>
          )}
          <Toggle checked={!!server.trusted} onChange={(v) => void patchServer(server.id, { trusted: v })} label="Run this connector's tools without asking" hint="Otherwise each call is confirmed, because connectors act in outside services." />
          {status?.state === "error" && <div className="note err" style={{ marginBottom: 8 }}>{status.error}</div>}
          {status?.state === "ready" && status.tools.length > 0 && (
            <div className="chips" style={{ marginBottom: 8 }}>
              {status.tools.map((t) => (
                <span className="badge" key={t.name} title={t.description}>{t.name}</span>
              ))}
            </div>
          )}
          <button
            className="btn small danger"
            onClick={async () => {
              if (!confirm(`Remove ${server.name}?`)) return;
              await deleteSecret(mcpTokenName(server.id));
              await forgetTokens(server.id);
              await mcpManager.reset(server.id);
              await updateSettings((s) => ({ mcpServers: s.mcpServers.filter((x) => x.id !== server.id) }));
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function OAuthApps() {
  const apps = useApp((s) => s.settings.oauthApps);
  const set = (p: Partial<typeof apps>) => void updateSettings((s) => ({ oauthApps: { ...s.oauthApps, ...p } }));
  const loopback = "http://127.0.0.1 (any port)";
  return (
    <details className="card">
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Google and Microsoft app setup</summary>
      <p className="hint">
        Google and Microsoft require each app to be registered. Register your own (free) and paste its client ID here. Redirect addresses to allow: {loopback} on desktop, and <code>meridian://oauth/callback</code> on iPhone/iPad.
      </p>
      <label className="field">
        <span>Google OAuth client ID (Google Cloud Console → APIs & Services → Credentials → OAuth client, type "Desktop app"; enable the Gmail, Calendar and Drive APIs)</span>
        <input type="text" defaultValue={apps.google?.clientId ?? ""} spellCheck={false} onBlur={(e) => set({ google: e.target.value.trim() ? { clientId: e.target.value.trim() } : undefined })} />
      </label>
      <label className="field">
        <span>Google client secret (Desktop app clients have one; stored in the keychain)</span>
        <input type="password" placeholder="Paste and leave the field to save" onBlur={async (e) => { if (e.target.value.trim()) { await setSecret("oauthapp.google.secret", e.target.value.trim()); e.target.value = ""; toast("Saved.", "ok"); } }} />
      </label>
      {platform().mobile && <div className="note warn">Google only accepts its own URL scheme for iPhone apps, so Google sign-in works on Windows and Mac; on iPhone and iPad use Microsoft 365 or connectors that support sign-in.</div>}
      <label className="field">
        <span>Microsoft application (client) ID (Microsoft Entra → App registrations → New; platform "Mobile and desktop applications")</span>
        <input type="text" defaultValue={apps.microsoft?.clientId ?? ""} spellCheck={false} onBlur={(e) => set({ microsoft: e.target.value.trim() ? { clientId: e.target.value.trim(), tenant: apps.microsoft?.tenant } : undefined })} />
      </label>
      <label className="field">
        <span>Microsoft tenant (common, organizations, consumers or your tenant ID)</span>
        <input type="text" defaultValue={apps.microsoft?.tenant ?? "common"} onBlur={(e) => apps.microsoft && set({ microsoft: { ...apps.microsoft, tenant: e.target.value.trim() || "common" } })} />
      </label>
    </details>
  );
}

function addFromCatalog(e: CatalogEntry) {
  const server: McpServerConfig = { id: uid("mcp"), name: e.name, transport: e.transport, url: e.url, enabled: true, catalogId: e.id };
  void updateSettings((s) => ({ mcpServers: [...s.mcpServers, server] }));
  toast(`${e.name} added. ${isBankConnector(e.id) ? "Connect it through SimpleFIN or Plaid on its card." : e.auth === "oauth" ? "Sign in to finish." : e.auth === "token" ? "Paste your access token under Details." : "Connecting…"}`, "ok");
  if (e.auth === "none") setTimeout(() => void mcpManager.connect(server), 300);
}

export function ConnectorsTab() {
  const servers = useApp((s) => s.settings.mcpServers);
  const [q, setQ] = useState("");
  const [registry, setRegistry] = useState<RegistryServer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [custom, setCustom] = useState({ name: "", url: "", transport: "http" as "http" | "sse" | "stdio" });
  const desktop = platform().desktop;
  const shown = CATALOG.filter((c) => !q || `${c.name} ${c.description} ${c.category}`.toLowerCase().includes(q.toLowerCase()));
  const cats = [...new Set(shown.map((c) => c.category))];
  return (
    <>
      <h3>Connectors</h3>
      <p>Connect your accounts and tools so the assistant can search, read and act in them. Most connectors sign in with your account in the browser; nothing is shared with anyone but that service.</p>
      {servers.length > 0 && <h4>Your connectors</h4>}
      {servers.map((s) => (
        <ConnectorCard key={s.id} server={s} />
      ))}
      <OAuthApps />

      <h4>Directory</h4>
      <input type="search" placeholder="Search connectors" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      {cats.map((cat) => (
        <div key={cat}>
          <div className="section-title" style={{ margin: "12px 0 6px" }}>{cat}</div>
          <div className="grid">
            {shown
              .filter((c) => c.category === cat)
              .map((c) => {
                const added = servers.some((s) => s.catalogId === c.id);
                return (
                  <div key={c.id} className="tile" style={{ minHeight: 0 }}>
                    <span className="tile-emoji">{c.emoji}</span>
                    <b>{c.name}</b>
                    <span className="tile-desc">{c.description}</span>
                    <div className="row">
                      <button className="btn small" disabled={added} onClick={() => addFromCatalog(c)}>{added ? "Added" : <><Icon.plus /> Add</>}</button>
                      {c.auth === "none" && <span className="badge">no sign-in</span>}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      <h4>More from the MCP registry</h4>
      <div className="card">
        <p className="hint" style={{ marginTop: 0 }}>Search the public registry of connector servers.</p>
        <div className="row">
          <input type="search" placeholder="e.g. calendar, crm, weather" onKeyDown={async (e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value; setSearching(true); try { setRegistry(await searchRegistry(v)); } catch (err) { toast(errText(err), "error"); } finally { setSearching(false); } } }} />
          {searching && <span className="spinner" />}
        </div>
        {registry && !registry.length && <p className="hint">Nothing found.</p>}
        {registry?.map((r) => (
          <div className="list-row" key={`${r.name}|${r.url}`} style={{ marginTop: 6 }}>
            <div className="grow">
              <div className="title">{r.title ?? r.name}</div>
              <div className="sub">{r.description ?? r.url}</div>
            </div>
            <button
              className="btn small"
              onClick={() => {
                const server: McpServerConfig = { id: uid("mcp"), name: r.title ?? r.name.split("/").pop() ?? r.name, transport: r.transport, url: r.url, enabled: true };
                void updateSettings((s) => ({ mcpServers: [...s.mcpServers, server] }));
                setTimeout(() => void mcpManager.connect(server), 300);
                toast(`Added ${server.name}.`, "ok");
              }}
            >
              <Icon.plus /> Add
            </button>
          </div>
        ))}
      </div>

      <h4>Add by address</h4>
      <div className="card">
        <div className="row wrap">
          <input type="text" placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} style={{ flex: "1 1 140px" }} />
          <select value={custom.transport} onChange={(e) => setCustom({ ...custom, transport: e.target.value as typeof custom.transport })} style={{ flex: "0 1 200px" }} aria-label="Connector type">
            <option value="http">Remote server (URL)</option>
            <option value="sse">Remote server, SSE</option>
            <option value="stdio" disabled={!desktop}>Local command{desktop ? "" : " (desktop only)"}</option>
          </select>
        </div>
        {custom.transport !== "stdio" && <input type="url" placeholder="https://example.com/mcp" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} style={{ marginTop: 8 }} />}
        <button
          className="btn primary"
          style={{ marginTop: 8 }}
          disabled={!custom.name.trim() || (custom.transport !== "stdio" && !custom.url.trim())}
          onClick={() => {
            const server: McpServerConfig = { id: uid("mcp"), name: custom.name.trim(), transport: custom.transport, url: custom.url.trim() || undefined, enabled: true };
            void updateSettings((s) => ({ mcpServers: [...s.mcpServers, server] }));
            setCustom({ name: "", url: "", transport: "http" });
          }}
        >
          Add
        </button>
      </div>
    </>
  );
}
