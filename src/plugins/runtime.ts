// Turns installed plugins into tools, skills and slash commands.
import { httpFetch, readError } from "../platform/http";
import { runInSandbox } from "../tools/sandbox";
import type { Tool } from "../tools/types";
import type { Plugin, PluginCommand, PluginSkill, PluginTool } from "../types";
import { bytesToBase64 } from "../util/bytes";
import { fillTemplate } from "../util/template";

export const pluginSecretName = (pluginId: string, key: string) => `plugin.${pluginId}.${key}`;

export async function pluginSettingValues(p: Plugin, getSecret: (name: string) => Promise<string | null>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of p.settings) {
    const v = s.secret ? await getSecret(pluginSecretName(p.id, s.key)) : (p.values[s.key] ?? s.default);
    if (v != null && v !== "") out[s.key] = v;
  }
  return out;
}

export function missingSettings(p: Plugin, values: Record<string, string>): string[] {
  return p.settings.filter((s) => s.required && !values[s.key]).map((s) => s.label);
}

export { fillTemplate };

function pick(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export async function runHttpTool(t: PluginTool, args: Record<string, unknown>, settings: Record<string, string>, signal?: AbortSignal, media = false): Promise<string> {
  const h = t.http!;
  // only fill the query string with URL encoding; keep the scheme and host as written
  const url = fillTemplate(h.url, args, settings, "url");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = fillTemplate(v, args, settings, "text");
  const body = h.body ? fillTemplate(h.body, args, settings, "json") : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  const res = await httpFetch(url, { method: h.method, headers, body: h.method === "GET" ? undefined : body, signal });
  if (!res.ok) throw new Error(await readError(res));
  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  if (/^(image|video)\//.test(type)) {
    // an image / video endpoint: hand back the file itself (engines) or say what came back (chat)
    const bytes = new Uint8Array(await res.arrayBuffer());
    return media ? `data:${type};base64,${bytesToBase64(bytes)}` : `(${type} file, ${bytes.length} bytes)`;
  }
  const text = await res.text();
  try {
    const data = pick(JSON.parse(text), h.resultPath);
    return typeof data === "string" ? data : JSON.stringify(data, null, 1);
  } catch {
    return text;
  }
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "tool";

export function pluginTools(plugins: Plugin[], getSecret: (name: string) => Promise<string | null>): Tool[] {
  const out: Tool[] = [];
  const used = new Set<string>();
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const t of p.tools) {
      let name = safeName(t.name);
      if (used.has(name)) name = `${safeName(p.name).slice(0, 20)}_${name}`.slice(0, 64);
      used.add(name);
      out.push({
        group: "connectors",
        title: `${p.name}: ${t.name}`,
        spec: { name, description: `[${p.name} plugin] ${t.description}`.slice(0, 1024), inputSchema: t.inputSchema ?? { type: "object", properties: {} } },
        needsApproval: () => t.confirm ?? (t.kind === "http" && t.http?.method !== "GET"),
        summarize: (i) => `${p.name} → ${t.name}(${JSON.stringify(i).slice(0, 160)})`,
        async run(input, ctx) {
          const values = await pluginSettingValues(p, getSecret);
          const missing = missingSettings(p, values);
          if (missing.length) return { isError: true, text: `The ${p.name} plugin needs settings first (${missing.join(", ")}). Ask the user to fill them in under Settings → Plugins.` };
          if (t.kind === "http" && t.http) return { text: (await runHttpTool(t, input, values, ctx.signal)).slice(0, 60_000) };
          if (t.kind === "js" && t.code) {
            const r = await runInSandbox(t.code, input, values, { signal: ctx.signal, allowNetwork: true });
            const text = [r.result ?? "", r.logs.length ? `[log]\n${r.logs.join("\n")}` : "", r.error ? `Error: ${r.error}` : ""].filter(Boolean).join("\n");
            return { text: text.slice(0, 60_000) || "(no output)", isError: !!r.error };
          }
          return { isError: true, text: "This plugin tool has no implementation." };
        },
      });
    }
  }
  const skills = pluginSkills(plugins);
  if (skills.length) out.push(readSkillTool(skills));
  return out;
}

export function pluginSkills(plugins: Plugin[]): (PluginSkill & { plugin: string })[] {
  return plugins.filter((p) => p.enabled).flatMap((p) => p.skills.map((s) => ({ ...s, plugin: p.name })));
}

export function pluginCommands(plugins: Plugin[]): (PluginCommand & { plugin: string })[] {
  return plugins.filter((p) => p.enabled).flatMap((p) => p.commands.map((c) => ({ ...c, plugin: p.name })));
}

/** Skills are listed briefly in the system prompt; the model loads one when it needs it (as in Claude). */
export function skillsPrompt(skills: (PluginSkill & { plugin: string })[]): string {
  if (!skills.length) return "";
  return [
    "You have skills: packaged instructions for specific kinds of work. When a task matches one, call read_skill with its name first and follow what it says.",
    "<available_skills>",
    ...skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 300)}`),
    "</available_skills>",
  ].join("\n");
}

function readSkillTool(skills: (PluginSkill & { plugin: string })[]): Tool {
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
      const s = skills.find((x) => x.name === input.name) ?? skills.find((x) => x.name.toLowerCase() === String(input.name).toLowerCase());
      if (!s) return { isError: true, text: `No skill named ${String(input.name)}. Available: ${skills.map((x) => x.name).join(", ")}` };
      if (input.file) {
        const f = s.files?.[String(input.file)];
        return f == null ? { isError: true, text: `No file ${String(input.file)}. Files: ${Object.keys(s.files ?? {}).join(", ") || "none"}` } : { text: f };
      }
      const files = Object.keys(s.files ?? {});
      return { text: `${s.body}${files.length ? `\n\n[Files in this skill: ${files.join(", ")}. Read one with read_skill(name, file).]` : ""}` };
    },
  };
}

/** Expand a slash command: $ARGUMENTS / $1 $2 (Claude style) and {{text}}. */
export function expandCommand(body: string, argText: string): string {
  const parts = argText.trim().split(/\s+/).filter(Boolean);
  let out = body.replace(/\$ARGUMENTS/g, argText.trim()).replace(/\$(\d)/g, (_m, n: string) => parts[Number(n) - 1] ?? "");
  if (!/\$ARGUMENTS|\{\{/.test(body) && argText.trim()) out = `${out}\n\n${argText.trim()}`;
  return out;
}
