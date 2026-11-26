// Skills: reusable instructions (plus optional files) that an agent loads when
// a task calls for it. The format is the one Claude uses: a folder with a
// SKILL.md (YAML front matter with name and description, then Markdown) and
// any other files the instructions refer to.
//
// Progressive disclosure: only each active skill's name and description go in
// the system prompt. The model reads the rest with read_skill when it uses one.
// A skill the user names with /skill-name is loaded in full straight away.
import { strToU8, unzipSync, zipSync } from "fflate";
import { httpFetch, readError } from "../platform/http";
import type { Tool } from "../tools/types";
import type { Agent, McpServerConfig, Plugin, Project, Settings, Skill } from "../types";
import { utf8 } from "../util/bytes";

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  requiresTools?: string[];
  requiresConnectors?: string[];
  allowedTools?: string[];
  license?: string;
  version?: string;
}

/** "a, b", "[a, b]" or "a b" -> ["a", "b"] */
function listOf(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** Front matter: simple YAML (key: value, folded continuation lines, "- item" lists). */
export function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md.trim() };
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      meta[key] = kv[2].replace(/^["']|["']$/g, "").replace(/^[>|]-?$/, "");
    } else if (key && /^\s+-\s+/.test(line)) {
      meta[key] = [meta[key], line.replace(/^\s+-\s+/, "").trim()].filter(Boolean).join(", ");
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key]} ${line.trim()}`.trim();
    }
  }
  return { meta, body: m[2].trim() };
}

export function parseSkillMd(md: string, fallbackName = "skill", files: Record<string, string> = {}): SkillDraft {
  const { meta, body } = parseFrontMatter(md);
  return {
    name: (meta.name || fallbackName).trim().slice(0, 64),
    description: (meta.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || "").slice(0, 1024),
    body,
    files,
    allowedTools: listOf(meta["allowed-tools"]),
    requiresTools: listOf(meta["requires-tools"] ?? meta["required-tools"]),
    requiresConnectors: listOf(meta["requires-connectors"] ?? meta["required-connectors"]),
    license: meta.license || undefined,
    version: meta.version || undefined,
  };
}

/** SKILL.md text for a skill (front matter, then the body). */
export function toSkillMd(s: Pick<Skill, "name" | "description" | "body" | "requiresTools" | "requiresConnectors" | "allowedTools" | "license" | "version">): string {
  const q = (v: string) => (/[:#\n"']|^\s|\s$/.test(v) ? JSON.stringify(v) : v);
  const lines = ["---", `name: ${q(s.name)}`, `description: ${q(s.description.replace(/\s+/g, " ").trim())}`];
  if (s.license) lines.push(`license: ${q(s.license)}`);
  if (s.version) lines.push(`version: ${q(s.version)}`);
  if (s.allowedTools?.length) lines.push(`allowed-tools: ${s.allowedTools.join(", ")}`);
  if (s.requiresTools?.length) lines.push(`requires-tools: ${s.requiresTools.join(", ")}`);
  if (s.requiresConnectors?.length) lines.push(`requires-connectors: ${s.requiresConnectors.join(", ")}`);
  lines.push("---", "", s.body.trim(), "");
  return lines.join("\n");
}

/** A skill as a zip with its folder (SKILL.md and its files), for sharing or Claude. */
export function skillZip(s: Skill): Uint8Array {
  const dir = slug(s.name);
  const entries: Record<string, Uint8Array> = { [`${dir}/SKILL.md`]: strToU8(toSkillMd(s)) };
  for (const [p, t] of Object.entries(s.files ?? {})) entries[`${dir}/${p}`] = strToU8(t);
  return zipSync(entries);
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";

const TEXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|ts|py|sh|rb|sql|ini|cfg|env\.example)$/i;

/** Every skill in a set of files: each folder with a SKILL.md, with the files under it. */
export function skillsFromFiles(files: Record<string, string>): SkillDraft[] {
  const paths = Object.keys(files);
  const skillFiles = paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p));
  const dirs = skillFiles.map((p) => p.slice(0, p.length - "SKILL.md".length));
  return skillFiles.map((p, i) => {
    const dir = dirs[i];
    const own: Record<string, string> = {};
    for (const q of paths) {
      if (q === p || !q.startsWith(dir)) continue;
      // files of a skill nested deeper belong to that skill
      if (dirs.some((d) => d !== dir && d.startsWith(dir) && q.startsWith(d))) continue;
      own[q.slice(dir.length)] = files[q];
    }
    const folder = dir.replace(/\/$/, "").split("/").pop() || "skill";
    return parseSkillMd(files[p], folder, own);
  });
}

/** Text files from zip entries (binary files are skipped; skills are instructions). */
export function textFiles(entries: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || bytes.length > 1_500_000 || /(^|\/)(__MACOSX|\.git)\//.test(name)) continue;
    if (!TEXT.test(name) && !/(^|\/)SKILL\.md$/i.test(name)) continue;
    out[name] = utf8.decode(bytes);
  }
  return out;
}

export function skillsFromZip(bytes: Uint8Array): SkillDraft[] {
  return skillsFromFiles(textFiles(unzipSync(bytes)));
}

/** A single .md file: a SKILL.md, or plain instructions named after the file. */
export function skillFromMarkdownFile(name: string, text: string): SkillDraft {
  return parseSkillMd(text, name.replace(/\.md$/i, "").replace(/^SKILL$/i, "skill"));
}

/**
 * From a link: a GitHub repository or a folder in one (every SKILL.md in it),
 * a GitHub SKILL.md file, a zip, or a .md file.
 */
export async function skillsFromUrl(raw: string): Promise<SkillDraft[]> {
  const url = raw.trim();
  const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.md)$/i.exec(url);
  if (blob) {
    const [, owner, repo, ref, path] = blob;
    const res = await httpFetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
    if (!res.ok) throw new Error(`Could not download the skill: ${await readError(res)}`);
    return [skillFromMarkdownFile(path.split("/").slice(-2, -1)[0] ?? "skill", await res.text())];
  }
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
  if (!res.ok) throw new Error(`Could not download: ${await readError(res)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let list: SkillDraft[];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const all = unzipSync(bytes);
    if (gh) {
      // GitHub zips put everything under "<repo>-<branch>/"
      const top = Object.keys(all)[0]?.split("/")[0] ?? "";
      const prefix = `${top}/${sub}`;
      const kept: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) kept[k.slice(prefix.length)] = v;
      list = skillsFromFiles(textFiles(kept));
    } else list = skillsFromFiles(textFiles(all));
  } else list = [skillFromMarkdownFile(url.split("/").pop() ?? "skill", utf8.decode(bytes))];
  if (!list.length) throw new Error("No SKILL.md found at that address.");
  return list;
}

// ---------------------------------------------------------------- which skills a chat gets

export interface ActiveSkill {
  /** library id (plugin skills have none) */
  id?: string;
  name: string;
  description: string;
  body: string;
  files?: Record<string, string>;
  /** where it comes from, for the UI */
  from: string;
  /** what is missing for it to work (it is then not offered to the model) */
  missing: string[];
}

const GROUPS = ["web", "files", "media", "computer", "browser", "connectors"] as const;

/** What a skill needs that this setup lacks: tool groups switched off, connectors not added. */
export function skillMissing(s: Pick<Skill, "requiresTools" | "requiresConnectors">, tools: Settings["tools"], servers: McpServerConfig[], plugins: Plugin[] = []): string[] {
  const out: string[] = [];
  for (const t of s.requiresTools ?? []) {
    const g = t.toLowerCase() as (typeof GROUPS)[number];
    if ((GROUPS as readonly string[]).includes(g) && !tools[g]) out.push(`${g} tools are off`);
  }
  for (const c of s.requiresConnectors ?? []) {
    const want = c.toLowerCase();
    const has = servers.some((m) => m.enabled && (m.id.toLowerCase().includes(want) || m.name.toLowerCase().includes(want))) || plugins.some((p) => p.enabled && p.name.toLowerCase().includes(want));
    if (!has) out.push(`the ${c} connector is not added`);
  }
  return out;
}

export interface SkillContext {
  skills: Skill[];
  plugins: Plugin[];
  agent?: Pick<Agent, "skills" | "tools">;
  project?: Pick<Project, "skills">;
  /** a consortium member's own skills */
  member?: string[];
  settings: Pick<Settings, "tools" | "mcpServers">;
}

/**
 * The skills a chat gets: those available everywhere, plus those given to its
 * agent, project or consortium member, plus plugin skills. Skills turned off are
 * never included; assigned ones only where they were given.
 */
export function activeSkills(ctx: SkillContext): ActiveSkill[] {
  const given = new Set([...(ctx.agent?.skills ?? []), ...(ctx.project?.skills ?? []), ...(ctx.member ?? [])]);
  const tools = { ...ctx.settings.tools, ...(ctx.agent?.tools ?? {}) };
  const out: ActiveSkill[] = [];
  for (const s of ctx.skills) {
    if (s.availability === "off") continue;
    if (s.availability !== "everywhere" && !given.has(s.id)) continue;
    const from = s.availability === "everywhere" ? "everywhere" : [ctx.member?.includes(s.id) ? "member" : "", ctx.agent?.skills?.includes(s.id) ? "agent" : "", ctx.project?.skills?.includes(s.id) ? "project" : ""].filter(Boolean).join(", ");
    out.push({ id: s.id, name: s.name, description: s.description, body: s.body, files: s.files, from, missing: skillMissing(s, tools, ctx.settings.mcpServers, ctx.plugins) });
  }
  for (const p of ctx.plugins) {
    if (!p.enabled) continue;
    for (const s of p.skills) if (!out.some((x) => x.name === s.name)) out.push({ name: s.name, description: s.description, body: s.body, files: s.files, from: `plugin ${p.name}`, missing: [] });
  }
  return out;
}

/** /skill-name in the user's message: those skills are loaded in full now. */
export function namedSkills(text: string, all: { name: string }[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)\/([\w.-]+)/g)) {
    const hit = all.find((s) => slug(s.name) === m[1].toLowerCase() || s.name.toLowerCase() === m[1].toLowerCase());
    if (hit && !out.includes(hit.name)) out.push(hit.name);
  }
  return out;
}

/** Names and descriptions only (progressive disclosure), plus any skill the user asked for by name. */
export function skillsPrompt(skills: ActiveSkill[], loaded: string[] = []): string {
  const usable = skills.filter((s) => !s.missing.length);
  if (!usable.length) return "";
  const parts = [
    "You have skills: packaged instructions for specific kinds of work. When a task matches one, call read_skill with its name first and follow what it says.",
    "<available_skills>",
    ...usable.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 300)}`),
    "</available_skills>",
  ];
  for (const name of loaded) {
    const s = usable.find((x) => x.name === name);
    if (!s) continue;
    const files = Object.keys(s.files ?? {});
    parts.push(`The user asked for the skill "${s.name}". Its instructions (already loaded; follow them):\n<skill name="${s.name}">\n${s.body}\n</skill>${files.length ? `\nFiles in this skill: ${files.join(", ")} (read one with read_skill(name, file)).` : ""}`);
  }
  return parts.join("\n");
}

export function readSkillTool(skills: ActiveSkill[]): Tool {
  const usable = skills.filter((s) => !s.missing.length);
  return {
    group: "files",
    title: "Read skill",
    spec: {
      name: "read_skill",
      description: "Load the full instructions of one of your skills (see available_skills), or one of the files that ship with it.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string", description: "optional: a file bundled with the skill" } }, required: ["name"] },
    },
    needsApproval: () => false,
    summarize: (i) => `Read skill ${String(i.name)}${i.file ? ` / ${String(i.file)}` : ""}`,
    async run(input) {
      const s = usable.find((x) => x.name === input.name) ?? usable.find((x) => x.name.toLowerCase() === String(input.name).toLowerCase());
      if (!s) return { isError: true, text: `No skill named ${String(input.name)}. Available: ${usable.map((x) => x.name).join(", ")}` };
      if (input.file) {
        const f = s.files?.[String(input.file)];
        return f == null ? { isError: true, text: `No file ${String(input.file)}. Files: ${Object.keys(s.files ?? {}).join(", ") || "none"}` } : { text: f };
      }
      const files = Object.keys(s.files ?? {});
      return { text: `${s.body}${files.length ? `\n\n[Files in this skill: ${files.join(", ")}. Read one with read_skill(name, file).]` : ""}` };
    },
  };
}
