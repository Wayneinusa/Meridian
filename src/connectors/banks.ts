// Bank connections, read-only: accounts, balances and transactions.
//
// Banks do not offer personal API access, so Meridian reaches them through an
// aggregator the user signs up for themselves:
//   SimpleFIN Bridge  paste a one-time Setup Token; read-only by design
//   Plaid             your own Plaid developer keys; the bank sign-in happens
//                     on Plaid's hosted page (Meridian never sees the password)
// Credentials (the SimpleFIN access URL, Plaid keys and access tokens) live in
// the OS keychain and are never synced.
import { httpFetch, readError } from "../platform/http";
import type { Tool } from "../tools/types";
import type { McpServerConfig } from "../types";
import { base64ToBytes, bytesToBase64, utf8 } from "../util/bytes";

export const SIMPLEFIN_SECRET = "bank.simplefin.access";
export const PLAID_CREDS_SECRET = "bank.plaid.creds";
export const PLAID_ITEMS_SECRET = "bank.plaid.items";

/** Bank connectors in the directory; each shows only that bank's accounts. */
export const BANK_FILTERS: Record<string, RegExp | null> = {
  wellsfargo: /wells\s*fargo/i,
  amex: /american\s*express|\bamex\b/i,
  capitalone: /capital\s*one/i,
  anybank: null,
};
export const isBankConnector = (catalogId?: string) => !!catalogId && catalogId in BANK_FILTERS;

export interface BankAccount {
  id: string;
  institution: string;
  name: string;
  currency: string;
  balance: number | null;
  available?: number | null;
  asOf?: string;
  type?: string;
  mask?: string;
  source: "simplefin" | "plaid";
}

export interface BankTransaction {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  pending?: boolean;
  category?: string;
}

type GetSecret = (name: string) => Promise<string | null>;

// ---------------------------------------------------------------- SimpleFIN

/** Exchange a SimpleFIN Setup Token (base64 of a claim URL) for the access URL. One-time: the token stops working after. */
export async function simplefinClaim(setupToken: string): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = utf8.decode(base64ToBytes(setupToken.trim())).trim();
  } catch {
    throw new Error("That is not a SimpleFIN Setup Token. Copy the whole token from bridge.simplefin.org.");
  }
  if (!/^https:\/\//.test(claimUrl)) throw new Error("That is not a SimpleFIN Setup Token. Copy the whole token from bridge.simplefin.org.");
  const res = await httpFetch(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });
  if (res.status === 403) throw new Error("SimpleFIN refused the token: it was already used or has expired. Create a new Setup Token.");
  if (!res.ok) throw new Error(`SimpleFIN: ${await readError(res)}`);
  const access = (await res.text()).trim();
  if (!/^https:\/\/[^/]+@/.test(access)) throw new Error("SimpleFIN returned an unexpected answer.");
  return access;
}

/** The access URL carries user:password; browsers refuse those in fetch, so move them to a header. */
function splitAccess(access: string): { base: string; auth: string } {
  const u = new URL(access);
  const auth = `Basic ${bytesToBase64(utf8.encode(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`))}`;
  u.username = "";
  u.password = "";
  return { base: u.toString().replace(/\/$/, ""), auth };
}

interface SfAccount {
  org?: { name?: string; domain?: string };
  id: string;
  name: string;
  currency?: string;
  balance?: string;
  "available-balance"?: string;
  "balance-date"?: number;
  transactions?: { id: string; posted?: number; transacted_at?: number; amount: string; description?: string; payee?: string; memo?: string; pending?: boolean }[];
}

async function simplefinGet(access: string, query: Record<string, string>, signal?: AbortSignal): Promise<{ accounts: SfAccount[]; errors: string[] }> {
  const { base, auth } = splitAccess(access);
  const res = await httpFetch(`${base}/accounts?${new URLSearchParams(query)}`, { headers: { Authorization: auth }, signal });
  if (res.status === 402) throw new Error("SimpleFIN says the subscription needs payment (bridge.simplefin.org).");
  if (res.status === 403) throw new Error("SimpleFIN no longer accepts this connection. Connect again with a new Setup Token.");
  if (!res.ok) throw new Error(`SimpleFIN: ${await readError(res)}`);
  const j = await res.json();
  return { accounts: j.accounts ?? [], errors: (j.errors ?? []).map(String) };
}

const num = (s?: string) => (s == null || s === "" ? null : Number(s));
const day = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");

function sfAccount(a: SfAccount): BankAccount {
  return {
    id: `sf:${a.id}`,
    institution: a.org?.name ?? a.org?.domain ?? "Bank",
    name: a.name,
    currency: a.currency ?? "USD",
    balance: num(a.balance),
    available: num(a["available-balance"]),
    asOf: day(a["balance-date"]),
    source: "simplefin",
  };
}

// ---------------------------------------------------------------- Plaid

export interface PlaidCreds {
  clientId: string;
  secret: string;
  env: "production" | "sandbox";
}
export interface PlaidItem {
  itemId: string;
  accessToken: string;
  institution: string;
}

const plaidBase = (c: PlaidCreds) => `https://${c.env === "sandbox" ? "sandbox" : "production"}.plaid.com`;

async function plaid(c: PlaidCreds, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const res = await httpFetch(`${plaidBase(c)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }), signal });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error_code === "PRODUCT_NOT_READY") throw new Error("Plaid is still downloading transactions for this bank. Try again in a few minutes.");
    if (j.error_code === "ITEM_LOGIN_REQUIRED") throw new Error("The bank asks you to sign in again: reconnect it in Settings → Connectors.");
    throw new Error(`Plaid: ${j.display_message ?? j.error_message ?? res.status}${j.error_code ? ` (${j.error_code})` : ""}`);
  }
  return j;
}

/** Start Plaid's hosted bank sign-in; open `url` in the browser. */
export async function plaidLinkStart(c: PlaidCreds, userId: string): Promise<{ linkToken: string; url: string }> {
  const j = await plaid(c, "/link/token/create", {
    client_name: "Meridian",
    user: { client_user_id: userId },
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    hosted_link: {},
  });
  if (!j.hosted_link_url) throw new Error("Plaid did not return a sign-in page. Hosted Link may need to be enabled for your Plaid account.");
  return { linkToken: j.link_token, url: j.hosted_link_url };
}

/** Wait until the user finished Plaid's page, then trade the result for long-lived access tokens. */
export async function plaidLinkFinish(c: PlaidCreds, linkToken: string, opts: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number } = {}): Promise<PlaidItem[]> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  for (;;) {
    if (Date.now() > deadline) throw new Error("The bank sign-in was not finished within 15 minutes.");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, opts.pollMs ?? 3000);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))));
    });
    const j = await plaid(c, "/link/token/get", { link_token: linkToken }, opts.signal);
    const found: { token: string; institution: string }[] = [];
    for (const s of j.link_sessions ?? []) {
      for (const r of s.results?.item_add_results ?? []) if (r.public_token) found.push({ token: r.public_token, institution: r.institution?.name ?? "Bank" });
      if (s.on_success?.public_token && !found.some((f) => f.token === s.on_success.public_token)) found.push({ token: s.on_success.public_token, institution: s.on_success.metadata?.institution?.name ?? "Bank" });
      if (s.exit && !found.length) throw new Error(`The bank sign-in was closed${s.exit.error?.display_message ? `: ${s.exit.error.display_message}` : "."}`);
    }
    if (!found.length) continue;
    const items: PlaidItem[] = [];
    for (const f of found) {
      const ex = await plaid(c, "/item/public_token/exchange", { public_token: f.token }, opts.signal);
      items.push({ itemId: ex.item_id, accessToken: ex.access_token, institution: f.institution });
    }
    return items;
  }
}

function plaidAccount(a: any, item: PlaidItem): BankAccount {
  return {
    id: `pl:${item.itemId}:${a.account_id}`,
    institution: item.institution,
    name: a.official_name ?? a.name,
    currency: a.balances?.iso_currency_code ?? "USD",
    balance: a.balances?.current ?? null,
    available: a.balances?.available ?? null,
    type: [a.type, a.subtype].filter(Boolean).join(" "),
    mask: a.mask ?? undefined,
    source: "plaid",
  };
}

// ---------------------------------------------------------------- reading

export interface BankSources {
  simplefin?: string;
  plaid?: { creds: PlaidCreds; items: PlaidItem[] };
}

export async function loadBankSources(getSecret: GetSecret): Promise<BankSources> {
  const out: BankSources = {};
  const sf = await getSecret(SIMPLEFIN_SECRET);
  if (sf) out.simplefin = sf;
  const creds = await getSecret(PLAID_CREDS_SECRET);
  const items = await getSecret(PLAID_ITEMS_SECRET);
  if (creds && items) {
    try {
      const parsed = JSON.parse(items) as PlaidItem[];
      if (parsed.length) out.plaid = { creds: JSON.parse(creds), items: parsed };
    } catch {
      /* unreadable: treat as not connected */
    }
  }
  return out;
}

export const hasBankSource = (s: BankSources) => !!s.simplefin || !!s.plaid?.items.length;

export async function listAccounts(src: BankSources, signal?: AbortSignal): Promise<{ accounts: BankAccount[]; warnings: string[] }> {
  const accounts: BankAccount[] = [];
  const warnings: string[] = [];
  if (src.simplefin) {
    const r = await simplefinGet(src.simplefin, { "balances-only": "1" }, signal);
    accounts.push(...r.accounts.map(sfAccount));
    warnings.push(...r.errors);
  }
  if (src.plaid) {
    for (const item of src.plaid.items) {
      try {
        const j = await plaid(src.plaid.creds, "/accounts/balance/get", { access_token: item.accessToken }, signal);
        accounts.push(...(j.accounts ?? []).map((a: unknown) => plaidAccount(a, item)));
      } catch (e) {
        warnings.push(`${item.institution}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { accounts, warnings };
}

export async function listTransactions(src: BankSources, account: BankAccount, days: number, signal?: AbortSignal): Promise<BankTransaction[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  if (account.source === "simplefin" && src.simplefin) {
    const id = account.id.slice(3);
    const r = await simplefinGet(src.simplefin, { "start-date": String(Math.floor(start.getTime() / 1000)), "end-date": String(Math.floor(end.getTime() / 1000)), account: id }, signal);
    const a = r.accounts.find((x) => x.id === id);
    return (a?.transactions ?? []).map((t) => ({
      id: t.id,
      accountId: account.id,
      date: day(t.transacted_at ?? t.posted),
      amount: Number(t.amount),
      description: [t.payee, t.description, t.memo].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(" · "),
      pending: !!t.pending || !t.posted,
    }));
  }
  if (account.source === "plaid" && src.plaid) {
    const [, itemId, accountId] = account.id.split(":");
    const item = src.plaid.items.find((i) => i.itemId === itemId);
    if (!item) return [];
    const j = await plaid(src.plaid.creds, "/transactions/get", { access_token: item.accessToken, start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), options: { account_ids: [accountId], count: 500 } }, signal);
    // Plaid: positive amounts are money leaving the account; show spending as negative like SimpleFIN
    return (j.transactions ?? []).map((t: any) => ({
      id: t.transaction_id,
      accountId: account.id,
      date: t.authorized_date ?? t.date,
      amount: -Number(t.amount),
      description: t.merchant_name ?? t.name,
      pending: !!t.pending,
      category: t.personal_finance_category?.primary ?? (Array.isArray(t.category) ? t.category.join(" / ") : undefined),
    }));
  }
  return [];
}

// ---------------------------------------------------------------- tools

const money = (n: number | null | undefined, cur: string) => (n == null ? "?" : `${n < 0 ? "-" : ""}${cur === "USD" ? "$" : `${cur} `}${Math.abs(n).toFixed(2)}`);

/** The read-only bank tools, limited to the banks whose connectors are on. */
export function bankTools(servers: McpServerConfig[], getSecret: GetSecret): Tool[] {
  const banks = servers.filter((s) => s.enabled && isBankConnector(s.catalogId));
  if (!banks.length) return [];
  const filters = banks.map((s) => BANK_FILTERS[s.catalogId!]);
  const allowed = (a: BankAccount) => filters.some((f) => !f || f.test(a.institution));
  const trusted = banks.every((s) => s.trusted);
  const names = banks.map((s) => s.name).join(", ");
  const accountsFor = async (signal?: AbortSignal) => {
    const src = await loadBankSources(getSecret);
    if (!hasBankSource(src)) throw new Error("No bank is connected yet. Connect one in Settings → Connectors (SimpleFIN or Plaid).");
    const r = await listAccounts(src, signal);
    return { src, accounts: r.accounts.filter(allowed), warnings: r.warnings };
  };
  const find = (accounts: BankAccount[], q: unknown) => {
    const s = String(q ?? "").toLowerCase();
    return accounts.find((a) => a.id === q) ?? accounts.find((a) => `${a.institution} ${a.name} ${a.mask ?? ""}`.toLowerCase().includes(s));
  };
  return [
    {
      group: "connectors",
      title: "Banks: list accounts",
      spec: {
        name: "bank_list_accounts",
        description: `[Banks: ${names}] List the user's bank and card accounts with current and available balances. Read-only.`,
        inputSchema: { type: "object", properties: {} },
      },
      needsApproval: () => !trusted,
      summarize: () => "Read your bank accounts and balances",
      async run(_input, ctx) {
        const { accounts, warnings } = await accountsFor(ctx.signal);
        if (!accounts.length) return { text: `No accounts found for ${names}.${warnings.length ? ` Notes from the bank service: ${warnings.join("; ")}` : ""}` };
        const lines = accounts.map((a) => `- ${a.institution} · ${a.name}${a.mask ? ` (…${a.mask})` : ""}${a.type ? ` [${a.type}]` : ""}: balance ${money(a.balance, a.currency)}${a.available != null ? `, available ${money(a.available, a.currency)}` : ""}${a.asOf ? ` (as of ${a.asOf})` : ""} — id ${a.id}`);
        return { text: [...lines, ...(warnings.length ? [`Notes: ${warnings.join("; ")}`] : [])].join("\n") };
      },
    },
    {
      group: "connectors",
      title: "Banks: transactions",
      spec: {
        name: "bank_transactions",
        description: `[Banks: ${names}] Recent transactions of one account (by id from bank_list_accounts, or a name such as "Capital One Venture"). Spending is negative. Read-only.`,
        inputSchema: {
          type: "object",
          properties: {
            account: { type: "string", description: "Account id or name" },
            days: { type: "integer", description: "How many days back, 1-90. Default 30." },
            search: { type: "string", description: "Only transactions whose description contains this text" },
          },
          required: ["account"],
        },
      },
      needsApproval: () => !trusted,
      summarize: (i) => `Read transactions of ${String(i.account)} (last ${Number(i.days) || 30} days)`,
      async run(input, ctx) {
        const { src, accounts } = await accountsFor(ctx.signal);
        const acct = find(accounts, input.account);
        if (!acct) return { isError: true, text: `No account matches "${String(input.account)}". Accounts: ${accounts.map((a) => `${a.institution} · ${a.name} (${a.id})`).join("; ") || "none"}` };
        const days = Math.min(Math.max(Math.round(Number(input.days) || 30), 1), 90);
        let txs = await listTransactions(src, acct, days, ctx.signal);
        const q = typeof input.search === "string" ? input.search.toLowerCase() : "";
        if (q) txs = txs.filter((t) => t.description.toLowerCase().includes(q));
        txs.sort((a, b) => b.date.localeCompare(a.date));
        if (!txs.length) return { text: `No transactions in ${acct.institution} · ${acct.name} for the last ${days} days${q ? ` matching "${q}"` : ""}.` };
        const total = txs.reduce((s, t) => s + t.amount, 0);
        return {
          text: [
            `${acct.institution} · ${acct.name}, last ${days} days: ${txs.length} transactions, net ${money(total, acct.currency)}.`,
            ...txs.slice(0, 400).map((t) => `${t.date}  ${money(t.amount, acct.currency).padStart(11)}  ${t.description}${t.category ? ` [${t.category}]` : ""}${t.pending ? " (pending)" : ""}`),
          ].join("\n"),
        };
      },
    },
  ];
}
