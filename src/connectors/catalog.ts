// The connector directory: official remote MCP servers of the services
// Claude connects to. Addresses marked `checked` were confirmed against the
// public MCP registry; the others come from the vendors' documentation and
// can be edited after adding.
import { httpFetch } from "../platform/http";

export interface CatalogEntry {
  id: string;
  name: string;
  emoji: string;
  description: string;
  url?: string;
  transport: "http" | "sse" | "native";
  /** oauth: Sign in; token: paste a key; none: open */
  auth: "oauth" | "token" | "none";
  category: "Productivity" | "Communication" | "Development" | "Design" | "Data & docs" | "Payments" | "Banking" | "Sales & support" | "Knowledge";
  checked?: boolean;
  note?: string;
}

export const CATALOG: CatalogEntry[] = [
  // banks: read-only, through SimpleFIN Bridge or Plaid (see connectors/banks.ts)
  { id: "wellsfargo", name: "Wells Fargo", emoji: "🏦", description: "Checking, savings and credit card accounts: balances and transactions. Read-only.", transport: "native", auth: "token", category: "Banking", note: "Connects through SimpleFIN Bridge or Plaid; you sign in to the bank on their page." },
  { id: "amex", name: "American Express", emoji: "💳", description: "Card balances and transactions. Read-only.", transport: "native", auth: "token", category: "Banking", note: "Connects through SimpleFIN Bridge or Plaid; you sign in to the bank on their page." },
  { id: "capitalone", name: "Capital One", emoji: "🏛️", description: "Card, checking and savings balances and transactions. Read-only.", transport: "native", auth: "token", category: "Banking", note: "Connects through SimpleFIN Bridge or Plaid; you sign in to the bank on their page." },
  { id: "anybank", name: "Any bank (all accounts)", emoji: "💰", description: "Every account you linked in SimpleFIN or Plaid: Chase, Bank of America, Citi, credit unions and thousands more. Read-only.", transport: "native", auth: "token", category: "Banking" },
  { id: "google", name: "Google Workspace", emoji: "📧", description: "Gmail, Google Calendar and Google Drive: search and read mail, draft and send, see and create events, find and read files.", transport: "native", auth: "oauth", category: "Productivity", note: "Uses your own Google Cloud OAuth client (Settings shows how)." },
  { id: "microsoft", name: "Microsoft 365", emoji: "📨", description: "Outlook mail and calendar, OneDrive files.", transport: "native", auth: "oauth", category: "Productivity", note: "Uses your own Microsoft Entra app registration (Settings shows how)." },
  { id: "notion", name: "Notion", emoji: "📝", description: "Search, read, create and update pages and databases.", url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth", category: "Data & docs", checked: true },
  { id: "linear", name: "Linear", emoji: "📐", description: "Issues, projects and team workflows.", url: "https://mcp.linear.app/mcp", transport: "http", auth: "oauth", category: "Development", checked: true },
  { id: "atlassian", name: "Atlassian (Jira & Confluence)", emoji: "🧭", description: "Jira issues and Confluence pages.", url: "https://mcp.atlassian.com/v1/mcp", transport: "http", auth: "oauth", category: "Development", checked: true },
  { id: "asana", name: "Asana", emoji: "✅", description: "Tasks, projects and goals.", url: "https://mcp.asana.com/sse", transport: "sse", auth: "oauth", category: "Productivity" },
  { id: "monday", name: "monday.com", emoji: "📅", description: "Boards, items, workflows and dashboards.", url: "https://mcp.monday.com/mcp", transport: "http", auth: "oauth", category: "Productivity", checked: true },
  { id: "clickup", name: "ClickUp", emoji: "🎯", description: "Tasks, docs and workspace hierarchy.", url: "https://mcp.clickup.com/mcp", transport: "http", auth: "oauth", category: "Productivity" },
  { id: "airtable", name: "Airtable", emoji: "🗂️", description: "Bases, tables and records.", url: "https://mcp.airtable.com/mcp", transport: "http", auth: "oauth", category: "Data & docs", checked: true },
  { id: "box", name: "Box", emoji: "📦", description: "Search and read Box content.", url: "https://mcp.box.com", transport: "http", auth: "oauth", category: "Data & docs" },
  { id: "dropbox", name: "Dropbox", emoji: "🗃️", description: "Search, organise and share files.", url: "https://mcp.dropbox.com/mcp", transport: "http", auth: "oauth", category: "Data & docs" },
  { id: "canva", name: "Canva", emoji: "🎨", description: "Search, create, autofill and export designs.", url: "https://mcp.canva.com/mcp", transport: "http", auth: "oauth", category: "Design", checked: true },
  { id: "figma", name: "Figma", emoji: "🖌️", description: "Design context, screenshots and diagrams.", url: "https://mcp.figma.com/mcp", transport: "http", auth: "oauth", category: "Design", checked: true },
  { id: "miro", name: "Miro", emoji: "🟨", description: "Read and create content on Miro boards.", url: "https://mcp.miro.com/", transport: "http", auth: "oauth", category: "Design" },
  { id: "webflow", name: "Webflow", emoji: "🌐", description: "Pages, CMS content and site publishing.", url: "https://mcp.webflow.com/mcp", transport: "http", auth: "oauth", category: "Design", checked: true },
  { id: "github", name: "GitHub", emoji: "🐙", description: "Repositories, issues, pull requests and code.", url: "https://api.githubcopilot.com/mcp/", transport: "http", auth: "token", category: "Development", note: "Paste a GitHub personal access token as the access token." },
  { id: "sentry", name: "Sentry", emoji: "🛡️", description: "Errors, issues and releases.", url: "https://mcp.sentry.dev/mcp", transport: "http", auth: "oauth", category: "Development" },
  { id: "vercel", name: "Vercel", emoji: "▲", description: "Projects, deployments and logs.", url: "https://mcp.vercel.com", transport: "http", auth: "oauth", category: "Development" },
  { id: "netlify", name: "Netlify", emoji: "🟩", description: "Sites, deploys and settings.", url: "https://netlify-mcp.netlify.app/mcp", transport: "http", auth: "oauth", category: "Development" },
  { id: "supabase", name: "Supabase", emoji: "🟢", description: "Databases, auth and storage.", url: "https://mcp.supabase.com/mcp", transport: "http", auth: "oauth", category: "Development" },
  { id: "cloudflare", name: "Cloudflare", emoji: "☁️", description: "Workers, KV, R2 and D1 on the developer platform.", url: "https://bindings.mcp.cloudflare.com/mcp", transport: "http", auth: "oauth", category: "Development", checked: true },
  { id: "cloudflare-docs", name: "Cloudflare Docs", emoji: "📘", description: "Search Cloudflare's documentation.", url: "https://docs.mcp.cloudflare.com/mcp", transport: "http", auth: "none", category: "Knowledge", checked: true },
  { id: "huggingface", name: "Hugging Face", emoji: "🤗", description: "Models, datasets, papers and Spaces.", url: "https://huggingface.co/mcp", transport: "http", auth: "oauth", category: "Knowledge", checked: true },
  { id: "stripe", name: "Stripe", emoji: "💳", description: "Payments, customers, invoices and docs.", url: "https://mcp.stripe.com", transport: "http", auth: "oauth", category: "Payments", checked: true },
  { id: "paypal", name: "PayPal", emoji: "🅿️", description: "Invoices, orders, disputes and products.", url: "https://mcp.paypal.com/mcp", transport: "http", auth: "oauth", category: "Payments", checked: true },
  { id: "square", name: "Square", emoji: "⬛", description: "Payments, orders and merchant data.", url: "https://mcp.squareup.com/sse", transport: "sse", auth: "oauth", category: "Payments" },
  { id: "intercom", name: "Intercom", emoji: "💬", description: "Conversations and contacts.", url: "https://mcp.intercom.com/mcp", transport: "http", auth: "oauth", category: "Sales & support" },
  { id: "hubspot", name: "HubSpot", emoji: "🧲", description: "CRM contacts, companies and deals.", url: "https://mcp.hubspot.com/", transport: "http", auth: "oauth", category: "Sales & support" },
  { id: "fireflies", name: "Fireflies", emoji: "🎙️", description: "Meeting transcripts and summaries.", url: "https://api.fireflies.ai/mcp", transport: "http", auth: "oauth", category: "Communication", checked: true },
  { id: "granola", name: "Granola", emoji: "🥣", description: "Meeting notes and transcripts.", url: "https://mcp.granola.ai/mcp", transport: "http", auth: "oauth", category: "Communication" },
  { id: "zapier", name: "Zapier", emoji: "⚡", description: "Actions across thousands of apps.", url: "https://mcp.zapier.com/api/v1/connect", transport: "http", auth: "oauth", category: "Productivity", checked: true },
  { id: "deepwiki", name: "DeepWiki", emoji: "📗", description: "Ask questions about any public GitHub repository.", url: "https://mcp.deepwiki.com/mcp", transport: "http", auth: "none", category: "Knowledge" },
  { id: "context7", name: "Context7", emoji: "📚", description: "Up-to-date library and framework documentation.", url: "https://mcp.context7.com/mcp", transport: "http", auth: "none", category: "Knowledge" },
  { id: "mslearn", name: "Microsoft Learn", emoji: "🎓", description: "Search Microsoft's official documentation.", url: "https://learn.microsoft.com/api/mcp", transport: "http", auth: "none", category: "Knowledge" },
];

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  url: string;
  transport: "http" | "sse";
  website?: string;
}

/** Search the official MCP registry for remote servers. */
export async function searchRegistry(query: string, signal?: AbortSignal): Promise<RegistryServer[]> {
  const res = await httpFetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}&limit=60`, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`The MCP registry answered ${res.status}.`);
  const j = await res.json();
  const out = new Map<string, RegistryServer>();
  for (const item of (j.servers ?? []) as any[]) {
    const s = item.server ?? item;
    for (const r of (s.remotes ?? []) as { type?: string; url?: string }[]) {
      if (!r.url || /\{[^}]+\}/.test(r.url)) continue;
      const transport = r.type === "sse" ? "sse" : "http";
      const key = `${s.name}|${transport}`;
      if (out.has(key) || (transport === "sse" && out.has(`${s.name}|http`))) continue;
      out.set(key, { name: s.name, title: s.title, description: s.description, version: s.version, url: r.url, transport, website: s.websiteUrl ?? s.repository?.url });
    }
  }
  return [...out.values()];
}
