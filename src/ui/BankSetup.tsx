import { useEffect, useRef, useState } from "react";
import {
  BANK_FILTERS,
  hasBankSource,
  listAccounts,
  loadBankSources,
  PLAID_CREDS_SECRET,
  PLAID_ITEMS_SECRET,
  plaidLinkFinish,
  plaidLinkStart,
  SIMPLEFIN_SECRET,
  simplefinClaim,
  type BankAccount,
  type BankSources,
  type PlaidCreds,
  type PlaidItem,
} from "../connectors/banks";
import { openExternal } from "../platform/files";
import { deleteSecret, getSecret, setSecret } from "../platform/secrets";
import { errText, toast, useApp } from "../state/store";
import type { McpServerConfig } from "../types";

/** Connect banks through SimpleFIN Bridge or Plaid, and see what is connected. */
export function BankSetup({ server }: { server: McpServerConfig }) {
  const deviceId = useApp((s) => s.settings.deviceId);
  const [src, setSrc] = useState<BankSources | null>(null);
  const [via, setVia] = useState<"simplefin" | "plaid">("simplefin");
  const [token, setToken] = useState("");
  const [plaidId, setPlaidId] = useState("");
  const [plaidSecret, setPlaidSecret] = useState("");
  const [plaidEnv, setPlaidEnv] = useState<PlaidCreds["env"]>("production");
  const [busy, setBusy] = useState("");
  const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const filter = BANK_FILTERS[server.catalogId ?? "anybank"];
  const bankName = server.catalogId === "anybank" ? "your bank" : server.name;

  const reload = async () => setSrc(await loadBankSources((n) => getSecret(n)));
  useEffect(() => {
    void reload();
    void getSecret(PLAID_CREDS_SECRET).then((c) => {
      if (!c) return;
      try {
        const p = JSON.parse(c) as PlaidCreds;
        setPlaidId(p.clientId);
        setPlaidEnv(p.env);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const show = async () => {
    if (!src) return;
    setBusy("Reading accounts…");
    try {
      const r = await listAccounts(src);
      setAccounts(r.accounts.filter((a) => !filter || filter.test(a.institution)));
      if (r.warnings.length) toast(r.warnings[0], "info");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };

  const connectSimplefin = async () => {
    setBusy("Connecting to SimpleFIN…");
    try {
      const access = await simplefinClaim(token);
      await setSecret(SIMPLEFIN_SECRET, access);
      setToken("");
      await reload();
      toast("SimpleFIN connected.", "ok");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };

  const connectPlaid = async () => {
    abort.current = new AbortController();
    try {
      const prev = await getSecret(PLAID_CREDS_SECRET);
      const old = prev ? (JSON.parse(prev) as PlaidCreds) : null;
      const creds: PlaidCreds = { clientId: plaidId.trim(), secret: plaidSecret.trim() || old?.secret || "", env: plaidEnv };
      if (!creds.clientId || !creds.secret) throw new Error("Enter your Plaid client ID and secret.");
      await setSecret(PLAID_CREDS_SECRET, JSON.stringify(creds));
      setPlaidSecret("");
      setBusy("Opening the bank sign-in page…");
      const { linkToken, url } = await plaidLinkStart(creds, `meridian-${deviceId}`);
      await openExternal(url);
      setBusy(`Sign in to ${bankName} on the page that opened, then come back here.`);
      const items = await plaidLinkFinish(creds, linkToken, { signal: abort.current.signal });
      const existing = JSON.parse((await getSecret(PLAID_ITEMS_SECRET)) ?? "[]") as PlaidItem[];
      await setSecret(PLAID_ITEMS_SECRET, JSON.stringify([...existing.filter((x) => !items.some((i) => i.itemId === x.itemId)), ...items]));
      await reload();
      toast(`Connected: ${items.map((i) => i.institution).join(", ")}.`, "ok");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };

  const disconnect = async (what: "simplefin" | string) => {
    if (what === "simplefin") await deleteSecret(SIMPLEFIN_SECRET);
    else {
      const items = (src?.plaid?.items ?? []).filter((i) => i.itemId !== what);
      if (items.length) await setSecret(PLAID_ITEMS_SECRET, JSON.stringify(items));
      else await deleteSecret(PLAID_ITEMS_SECRET);
    }
    setAccounts(null);
    await reload();
  };

  const connected = src && hasBankSource(src);
  return (
    <div className="bank-setup">
      {connected && (
        <div className="subcard">
          <div className="hint" style={{ marginBottom: 6 }}>
            <b>Connected.</b> The assistant can read balances and transactions{filter ? ` of your ${server.name} accounts` : ""} and asks first each time (unless you allow it below). It cannot move money.
          </div>
          {src?.simplefin && (
            <div className="model-row">
              <span className="name">SimpleFIN Bridge (all banks linked there)</span>
              <button className="btn small" onClick={() => void disconnect("simplefin")}>Disconnect</button>
            </div>
          )}
          {src?.plaid?.items.map((i) => (
            <div className="model-row" key={i.itemId}>
              <span className="name">Plaid: {i.institution}</span>
              <button className="btn small" onClick={() => void disconnect(i.itemId)}>Disconnect</button>
            </div>
          ))}
          <button className="btn small" disabled={!!busy} onClick={() => void show()} style={{ marginTop: 6 }}>Show my accounts</button>
          {accounts && (
            <div className="bank-accounts" data-testid="bank-accounts">
              {accounts.length === 0 && <div className="hint">No {filter ? `${server.name} ` : ""}accounts found yet. Link {bankName} in SimpleFIN or connect it with Plaid below.</div>}
              {accounts.map((a) => (
                <div key={a.id} className="model-row">
                  <span className="name">{a.institution} · {a.name}{a.mask ? ` …${a.mask}` : ""}</span>
                  <span className="badge">{a.balance == null ? "?" : `${a.currency === "USD" ? "$" : `${a.currency} `}${a.balance.toFixed(2)}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="seg" role="radiogroup" aria-label="Connect through" style={{ margin: "8px 0" }}>
        <button role="radio" aria-checked={via === "simplefin"} className={via === "simplefin" ? "sel" : ""} onClick={() => setVia("simplefin")}>SimpleFIN Bridge</button>
        <button role="radio" aria-checked={via === "plaid"} className={via === "plaid" ? "sel" : ""} onClick={() => setVia("plaid")}>Plaid</button>
      </div>
      {via === "simplefin" ? (
        <>
          <ol className="hint steps">
            <li>Create an account at <button className="link-btn inline" onClick={() => void openExternal("https://bridge.simplefin.org")}>bridge.simplefin.org</button> ($1.50 a month or $15 a year).</li>
            <li>Add {bankName} there and sign in to it (SimpleFIN uses read-only access through MX). Search for the bank first to check it is offered.</li>
            <li>Under <i>Apps</i>, create a <b>Setup Token</b> and paste it here. It works once.</li>
          </ol>
          <div className="row">
            <input type="password" autoComplete="off" placeholder="Setup Token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="SimpleFIN Setup Token" />
            <button className="btn primary" disabled={!token.trim() || !!busy} onClick={() => void connectSimplefin()}>Connect</button>
          </div>
        </>
      ) : (
        <>
          <ol className="hint steps">
            <li>Sign up at <button className="link-btn inline" onClick={() => void openExternal("https://dashboard.plaid.com/signup")}>dashboard.plaid.com</button> and request Production access for <i>Transactions</i> (personal use is free within Plaid's limited plan; Sandbox works for trying it out).</li>
            <li>Copy the client ID and the secret from <i>Developers → Keys</i>.</li>
            <li>Press <b>Connect a bank</b>: Plaid's page opens, you sign in to {bankName} there, and Meridian receives a read-only access token.</li>
          </ol>
          <label className="field">
            <span>Plaid client ID</span>
            <input type="text" spellCheck={false} value={plaidId} onChange={(e) => setPlaidId(e.target.value)} aria-label="Plaid client ID" />
          </label>
          <label className="field">
            <span>Plaid secret (kept in the keychain)</span>
            <input type="password" autoComplete="off" value={plaidSecret} onChange={(e) => setPlaidSecret(e.target.value)} placeholder={src?.plaid ? "•••••••• saved" : ""} aria-label="Plaid secret" />
          </label>
          <div className="row">
            <select value={plaidEnv} onChange={(e) => setPlaidEnv(e.target.value as PlaidCreds["env"])} aria-label="Plaid environment" style={{ width: "auto" }}>
              <option value="production">Production (real banks)</option>
              <option value="sandbox">Sandbox (test data)</option>
            </select>
            <button className="btn primary" disabled={!plaidId.trim() || !!busy} onClick={() => void connectPlaid()}>Connect a bank</button>
            {busy && abort.current && <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>}
          </div>
        </>
      )}
      {busy && <div className="hint" style={{ marginTop: 6 }}><span className="spinner" style={{ display: "inline-block", verticalAlign: "-2px" }} /> {busy}</div>}
    </div>
  );
}
