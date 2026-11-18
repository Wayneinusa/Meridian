// Reading plugins from the formats people actually share:
//  - Claude plugins (and marketplaces): .claude-plugin/plugin.json with
//    commands/*.md, skills/<name>/SKILL.md, agents/*.md and .mcp.json
//  - TypingMind plugins: JSON with openaiSpec and javascript / http implementation,
//    including multi-function ones (pluginFunctions / functions arrays)
//  - Meridian plugin JSON (the Plugin type, minus ids)
import { unzipSync } from "fflate";
import { httpFetch, readError } from "../platform/http";
import type { McpServerConfig, Plugin, PluginAgentDef, PluginCommand, PluginEngine, PluginSettingDef, PluginSkill, PluginTool } from "../types";
import { suggestEngines } from "./engines";
import { uid } from "../types";
import { utf8 } from "../util/bytes";

export type PluginDraft = Omit<Plugin, "id" | "createdAt" | "updatedAt" | "deletedAt">;

export function emptyDraft(name: string, source: Plugin["source"]): PluginDraft {
  return { name, source, enabled: true, tools: [], skills: [], commands: [], agents: [], mcpServers: [], settings: [], values: {} };
}

/** YAML front matter (the simple key: value subset Claude plugins use). */
export function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md.trim() };
  const meta: Record<string, string> = {};
  let lastKey = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      meta[lastKey] = kv[2].replace(/^["']|["']$/g, "");
    } else if (lastKey && /^\s+\S/.test(line)) {
      meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { meta, body: m[2].trim() };
}

type Files = Record<string, string>;

function decodeTextFiles(entries: Record<string, Uint8Array>): Files {
  const out: Files = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || bytes.length > 2_000_000) continue;
    if (!/\.(md|json|txt|ya?ml|js|ts|py|sh|csv|html|xml|toml)$/i.test(name) && !name.endsWith("/SKILL")) continue;
    out[name] = utf8.decode(bytes);
  }
  return out;
}

function mcpFromJson(json: unknown): Omit<McpServerConfig, "enabled">[] {
  const servers = (json as { mcpServers?: Record<string, Record<string, unknown>> })?.mcpServers ?? (json as Record<string, Record<string, unknown>>);
  const out: Omit<McpServerConfig, "enabled">[] = [];
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg || typeof cfg !== "object") continue;
    if (typeof cfg.url === "string") {
      out.push({ id: uid("mcp"), name, transport: cfg.type === "sse" ? "sse" : "http", url: cfg.url, headers: (cfg.headers as Record<string, string>) ?? undefined });
    } else if (typeof cfg.command === "string") {
      out.push({ id: uid("mcp"), name, transport: "stdio", command: cfg.command, args: (cfg.args as string[]) ?? [], env: (cfg.env as Record<string, string>) ?? {} });
    }
  }
  return out;
}

/** Build one plugin from the files under `root` ("" or "some/dir/"). */
export function claudePluginFromFiles(files: Files, root: string, fallbackName: string): PluginDraft | null {
  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length) : null);
  let manifest: Record<string, unknown> = {};
  const mf = files[`${root}.claude-plugin/plugin.json`];
  if (mf) {
    try {
      manifest = JSON.parse(mf);
    } catch {
      /* use defaults */
    }
  }
  const draft = emptyDraft(String(manifest.name ?? fallbackName), "file");
  draft.description = typeof manifest.description === "string" ? manifest.description : undefined;
  draft.version = typeof manifest.version === "string" ? manifest.version : undefined;
  const author = manifest.author as { name?: string } | string | undefined;
  draft.author = typeof author === "string" ? author : author?.name;
  draft.homepage = typeof manifest.homepage === "string" ? manifest.homepage : typeof manifest.repository === "string" ? manifest.repository : undefined;

  for (const [path, text] of Object.entries(files)) {
    const r = rel(path);
    if (r == null) continue;
    let m: RegExpExecArray | null;
    if ((m = /^commands\/(.+)\.md$/.exec(r))) {
      const { meta, body } = frontMatter(text);
      draft.commands.push({ name: m[1].replace(/\//g, ":"), description: meta.description, argumentHint: meta["argument-hint"], body });
    } else if ((m = /^skills\/([^/]+)\/SKILL\.md$/i.exec(r))) {
      const { meta, body } = frontMatter(text);
      const dir = `${root}skills/${m[1]}/`;
      const extra: Record<string, string> = {};
      for (const [p2, t2] of Object.entries(files)) if (p2.startsWith(dir) && !/SKILL\.md$/i.test(p2)) extra[p2.slice(dir.length)] = t2;
      draft.skills.push({ name: meta.name || m[1], description: meta.description || body.split("\n")[0].slice(0, 200), body, files: extra });
    } else if ((m = /^agents\/(.+)\.md$/.exec(r))) {
      const { meta, body } = frontMatter(text);
      draft.agents.push({ name: meta.name || m[1], description: meta.description, instructions: body, model: meta.model });
    }
  }
  const mcp = files[`${root}.mcp.json`];
  if (mcp) {
    try {
      draft.mcpServers = mcpFromJson(JSON.parse(mcp));
    } catch {
      /* ignore broken .mcp.json */
    }
  }
  if (manifest.mcpServers && typeof manifest.mcpServers === "object") draft.mcpServers.push(...mcpFromJson({ mcpServers: manifest.mcpServers }));
  draft.commands.sort((a, b) => a.name.localeCompare(b.name));
  if (!draft.commands.length && !draft.skills.length && !draft.agents.length && !draft.mcpServers.length) return null;
  return draft;
}

/** Every plugin in a zip: a single plugin, a marketplace repo, or a folder of skills. */
export function pluginsFromZip(bytes: Uint8Array, nameHint = "plugin"): PluginDraft[] {
  const files = decodeTextFiles(unzipSync(bytes));
  const paths = Object.keys(files);
  // GitHub archives put everything under "repo-branch/"
  const top = paths.length && paths.every((p) => p.split("/")[0] === paths[0].split("/")[0]) && paths[0].includes("/") ? `${paths[0].split("/")[0]}/` : "";
  const roots = new Set<string>();
  for (const p of paths) {
    const m = /^(.*?)\.claude-plugin\/plugin\.json$/.exec(p);
    if (m) roots.add(m[1]);
  }
  // marketplace.json can point at plugin folders that have no plugin.json of their own
  const market = files[`${top}.claude-plugin/marketplace.json`];
  if (market) {
    try {
      for (const pl of (JSON.parse(market).plugins ?? []) as { source?: string; name?: string }[]) {
        if (typeof pl.source === "string" && pl.source.startsWith("./")) roots.add(`${top}${pl.source.slice(2).replace(/\/?$/, "/")}`);
      }
    } catch {
      /* ignore */
    }
  }
  if (!roots.size) roots.add(top);
  const out: PluginDraft[] = [];
  for (const root of roots) {
    const fallback = root.replace(/\/$/, "").split("/").pop() || nameHint;
    const d = claudePluginFromFiles(files, root, fallback);
    if (d) out.push(d);
  }
  if (!out.length) {
    // a zip with just SKILL.md files (Claude skill uploads)
    const skills: PluginSkill[] = [];
    for (const [p, t] of Object.entries(files)) {
      if (!/(^|\/)SKILL\.md$/i.test(p)) continue;
      const { meta, body } = frontMatter(t);
      skills.push({ name: meta.name || p.split("/").slice(-2, -1)[0] || "skill", description: meta.description || "", body });
    }
    if (skills.length) out.push({ ...emptyDraft(nameHint, "file"), skills });
  }
  return out;
}

/** TypingMind plugin JSON. */
interface FnSpec {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface TmFunction {
  openaiSpec?: FnSpec;
  spec?: FnSpec;
  function?: FnSpec;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  implementationType?: string;
  code?: string;
  httpAction?: TmHttpAction;
  outputType?: string;
}

interface TmHttpAction {
  url: string;
  method?: string;
  requestHeaders?: string | Record<string, string>;
  requestBody?: string | Record<string, unknown>;
  hasHeaders?: boolean;
  hasBody?: boolean;
  resultPath?: string;
}

/** The OpenAI function spec of an entry, in any of the shapes people use. */
function specOf(f: TmFunction): FnSpec | null {
  const s = f.openaiSpec ?? f.spec ?? f.function ?? (f.name ? { name: f.name, description: f.description, parameters: f.parameters } : null);
  return s?.name ? s : null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Names of the functions a TypingMind code block defines. */
function definedFunctions(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) out.add(m[1]);
  return [...out];
}

/**
 * TypingMind code defines a function named after the tool and is called with
 * (params, userSettings). Shared code may define several functions, or one
 * with another name: call the right one.
 */
export function wrapTypingMindCode(code: string, name: string): string {
  const defined = definedFunctions(code);
  if (!defined.length) return code; // a bare body: it already returns its result
  if (defined.includes(name)) return `${code}\nreturn await ${name}(args, settings);`;
  if (defined.length === 1) return `${code}\nreturn await ${defined[0]}(args, settings);`;
  // several functions and none we recognised by name: prefer the tool's name if the code defines it some other way
  const pickFn = IDENT.test(name) ? `(typeof ${name} === "function" ? ${name} : ${defined[0]})` : defined[0];
  return `${code}\nreturn await ${pickFn}(args, settings);`;
}

/** TypingMind HTTP actions use {param} and {userSettings.key}; ours are {{param}} and {{settings.key}}. */
export function convertPlaceholders(text: string, params: string[], settingKeys: string[]): string {
  return text.replace(/(\{)?\{\s*([\w.]+)\s*\}(\})?/g, (m, open: string | undefined, key: string, close: string | undefined) => {
    if (open && close) return m.replace(/\{\{\s*userSettings\./, "{{settings."); // already {{x}}
    const bare = key.replace(/^(userSettings|settings|params|parameters|args)\./, "");
    if (/^(userSettings|settings)\./.test(key) || (settingKeys.includes(bare) && !params.includes(bare))) return `${open ?? ""}{{settings.${bare}}}${close ?? ""}`;
    if (params.includes(bare)) return `${open ?? ""}{{${bare}}}${close ?? ""}`;
    return m;
  });
}

function toolFrom(f: TmFunction, shared: Record<string, unknown>, settingKeys: string[]): PluginTool | null {
  const spec = specOf(f);
  if (!spec?.name) return null;
  const params = Object.keys(((spec.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  const tool: PluginTool = {
    name: spec.name,
    description: spec.description ?? "",
    inputSchema: spec.parameters ?? { type: "object", properties: {} },
    kind: "js",
    outputType: f.outputType ?? (shared.outputType as string | undefined),
  };
  const impl = f.implementationType ?? (shared.implementationType as string | undefined);
  const http = f.httpAction ?? (impl === "http" ? (shared.httpAction as TmHttpAction | undefined) : undefined);
  const code = f.code ?? (shared.code as string | undefined);
  if ((impl === "http" || !code) && http?.url) {
    let headers: Record<string, string> = {};
    const rawHeaders = http.requestHeaders;
    if (rawHeaders && http.hasHeaders !== false) {
      try {
        headers = typeof rawHeaders === "string" ? JSON.parse(convertPlaceholders(rawHeaders, params, settingKeys)) : rawHeaders;
      } catch {
        /* unreadable headers: leave them out */
      }
    }
    for (const k of Object.keys(headers)) headers[k] = convertPlaceholders(String(headers[k]), params, settingKeys);
    const rawBody = http.requestBody;
    const body = rawBody && http.hasBody !== false ? convertPlaceholders(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody), params, settingKeys) : undefined;
    tool.kind = "http";
    tool.http = { method: (http.method ?? "GET").toUpperCase() as "GET", url: convertPlaceholders(http.url, params, settingKeys), headers, body, resultPath: http.resultPath };
    return tool;
  }
  if (typeof code === "string" && code.trim()) {
    tool.code = wrapTypingMindCode(code, spec.name);
    return tool;
  }
  return null;
}

/**
 * TypingMind plugins: the classic single-function export (openaiSpec + code or
 * httpAction) and multi-function ones (pluginFunctions / functions / tools
 * arrays sharing userSettings and, optionally, one code block).
 */
export function fromTypingMind(j: Record<string, unknown>): PluginDraft | null {
  const list = (j.pluginFunctions ?? j.functions ?? (Array.isArray(j.tools) ? j.tools : undefined)) as TmFunction[] | undefined;
  const fns: TmFunction[] = Array.isArray(list) && list.length ? list.map((x) => ((x as { type?: string; function?: FnSpec }).type === "function" && !(x as TmFunction).code ? { ...x, function: (x as { function?: FnSpec }).function } : x)) : [j as TmFunction];
  const first = specOf(fns[0] ?? {});
  const title = String(j.title ?? j.name ?? first?.name ?? "Plugin");
  const draft = emptyDraft(title, "file");
  draft.description = String(j.overviewMarkdown ?? j.description ?? first?.description ?? "").slice(0, 2000);
  draft.emoji = typeof j.emoji === "string" ? j.emoji : undefined;
  for (const s of (j.userSettings ?? []) as { name: string; label?: string; type?: string; required?: boolean; description?: string; defaultValue?: string; default?: string }[]) {
    if (!s?.name) continue;
    draft.settings.push({ key: s.name, label: s.label ?? s.name, secret: s.type === "password", required: !!s.required, help: s.description, default: s.defaultValue ?? s.default } satisfies PluginSettingDef);
  }
  const settingKeys = draft.settings.map((s) => s.key);
  for (const f of fns) {
    const t = toolFrom(f, j, settingKeys);
    if (t) draft.tools.push(t);
  }
  if (!draft.tools.length) return null;
  draft.engines = suggestEngines(draft.tools);
  return draft;
}

const isTypingMind = (j: Record<string, unknown>) =>
  !!(j.openaiSpec || j.pluginFunctions || (Array.isArray(j.functions) && !j.skills) || (j.code && (j.spec || j.function)) || j.implementationType);

export function fromJson(text: string): PluginDraft[] {
  const j = JSON.parse(text);
  if (Array.isArray(j)) return j.flatMap((x) => fromJson(JSON.stringify(x)));
  if (j && typeof j === "object" && Array.isArray(j.plugins) && !j.name) return j.plugins.flatMap((x: unknown) => fromJson(JSON.stringify(x)));
  if (isTypingMind(j)) {
    const d = fromTypingMind(j);
    return d ? [d] : [];
  }
  if (j.mcpServers && !j.name) return [{ ...emptyDraft("MCP servers", "file"), mcpServers: mcpFromJson(j) }];
  if (typeof j.name === "string") {
    const d = emptyDraft(j.name, "file");
    const tools = (j.tools ?? []) as PluginTool[];
    return [
      {
        ...d,
        ...j,
        tools,
        skills: (j.skills ?? []) as PluginSkill[],
        commands: (j.commands ?? []) as PluginCommand[],
        agents: (j.agents ?? []) as PluginAgentDef[],
        mcpServers: mcpFromJson({ mcpServers: Object.fromEntries(((j.mcpServers ?? []) as McpServerConfig[]).map((m) => [m.name, m])) }),
        settings: (j.settings ?? []) as PluginSettingDef[],
        engines: Array.isArray(j.engines) ? (j.engines as PluginEngine[]).map((e, i) => ({ ...e, id: e.id || `engine-${i + 1}` })) : suggestEngines(tools),
        values: j.values ?? {},
        enabled: true,
      },
    ];
  }
  throw new Error("This JSON is not a plugin Meridian understands (Meridian, TypingMind or .mcp.json format).");
}

export async function pluginsFromFile(name: string, bytes: Uint8Array): Promise<PluginDraft[]> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const list = isZip ? pluginsFromZip(bytes, name.replace(/\.(zip|plugin)$/i, "")) : name.toLowerCase().endsWith(".md") ? skillFromMarkdown(name, utf8.decode(bytes)) : fromJson(utf8.decode(bytes));
  if (!list.length) throw new Error("No plugin found in that file.");
  return list;
}

function skillFromMarkdown(name: string, md: string): PluginDraft[] {
  const { meta, body } = frontMatter(md);
  const skillName = meta.name || name.replace(/\.md$/i, "");
  return [{ ...emptyDraft(skillName, "file"), skills: [{ name: skillName, description: meta.description || body.split("\n")[0].slice(0, 200), body }] }];
}

/** From a link: a GitHub repository (or folder in one), a zip, or a JSON file. */
export async function pluginsFromUrl(raw: string): Promise<PluginDraft[]> {
  const url = raw.trim();
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(\/.*)?)?/.exec(url);
  let fetchUrl = url;
  let sub = "";
  if (gh) {
    const [, owner, repo, branch, path] = gh;
    fetchUrl = `https://codeload.github.com/${owner}/${repo.replace(/\.git$/, "")}/zip/${branch ? `refs/heads/${branch}` : "HEAD"}`;
    sub = (path ?? "").replace(/^\//, "").replace(/\/?$/, "/");
    if (sub === "/") sub = "";
  }
  const res = await httpFetch(fetchUrl);
  if (!res.ok) throw new Error(`Could not download the plugin: ${await readError(res)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let list: PluginDraft[];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (sub) {
      // keep only the chosen folder
      const all = unzipSync(bytes);
      const top = Object.keys(all)[0]?.split("/")[0] ?? "";
      const prefix = `${top}/${sub}`;
      const filtered: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) filtered[k.slice(top.length + 1)] = v;
      const files = decodeTextFiles(filtered);
      const d = claudePluginFromFiles(files, sub, sub.replace(/\/$/, "").split("/").pop() || "plugin");
      list = d ? [d] : pluginsFromZip(bytes, gh?.[2] ?? "plugin");
    } else list = pluginsFromZip(bytes, gh?.[2] ?? "plugin");
  } else list = url.toLowerCase().endsWith(".md") ? skillFromMarkdown(url.split("/").pop() ?? "skill", utf8.decode(bytes)) : fromJson(utf8.decode(bytes));
  if (!list.length) throw new Error("No plugin found at that address.");
  return list.map((d) => ({ ...d, source: "url", sourceUrl: url }));
}
