// Plugins as image / video backends. A plugin lists `engines`; each one becomes
// a model under a virtual provider ("plugin:<id>") in the Image and Video
// pickers. An engine calls one of the plugin's tools, an HTTP template or a
// piece of JavaScript, and whatever comes back is searched for the media.
import { runTemplate, templateVars, type BackendRequest } from "../providers/backends";
import { mediaFromResult, type MediaOutput } from "../providers/mediaUtil";
import { ProviderError } from "../providers/types";
import { runInSandbox } from "../tools/sandbox";
import type { ModelInfo, Plugin, PluginEngine, PluginTool, ProviderConfig } from "../types";
import { missingSettings, pluginSettingValues, runHttpTool } from "./runtime";

export const enginesOf = (p: Pick<Plugin, "engines">): PluginEngine[] => p.engines ?? [];

/** Virtual providers for the Image / Video pickers. */
export function engineProviders(plugins: Plugin[]): ProviderConfig[] {
  return plugins
    .filter((p) => p.enabled && enginesOf(p).length && !p.deletedAt)
    .map((p) => ({
      id: `plugin:${p.id}`,
      kind: "plugin" as const,
      name: `${p.emoji ? `${p.emoji} ` : ""}${p.name}`,
      baseUrl: "",
      enabled: true,
      hasKey: true,
      pluginId: p.id,
      models: enginesOf(p).map(
        (e): ModelInfo => ({ id: e.id, name: e.name, kind: e.kind, caps: { vision: true, pdf: false, tools: false, thinking: false } }),
      ),
    }));
}

const PROMPT_KEY = /prompt|description|query|text|input|idea|subject|instruction/i;

/** Map our generation request onto a tool's parameters by name. */
export function argsForTool(schema: Record<string, unknown> | undefined, vars: Record<string, unknown>): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const names = Object.keys(props);
  const args: Record<string, unknown> = {};
  let promptSet = false;
  for (const name of names) {
    const type = props[name]?.type;
    const enumValues = props[name]?.enum;
    if (!promptSet && PROMPT_KEY.test(name) && (!type || type === "string")) {
      args[name] = vars.prompt;
      promptSet = true;
    } else if (/^width$/i.test(name)) args[name] = vars.width;
    else if (/^height$/i.test(name)) args[name] = vars.height;
    else if (/aspect/i.test(name)) args[name] = enumValues && !enumValues.includes(vars.aspect_ratio) ? enumValues[0] : vars.aspect_ratio;
    else if (/^size$/i.test(name)) {
      const s = `${vars.width}x${vars.height}`;
      args[name] = enumValues && !enumValues.includes(s) ? enumValues[0] : s;
    } else if (/^(n|count|num_?images|number_of_images|images)$/i.test(name) && (type === "integer" || type === "number")) args[name] = vars.count;
    else if (/duration|seconds|length/i.test(name)) args[name] = type === "string" ? String(vars.seconds) : vars.seconds;
    else if (/seed/i.test(name)) args[name] = vars.seed;
    else if (/image|init|source|reference|start_?frame/i.test(name) && vars.image && (!type || type === "string")) args[name] = vars.image;
  }
  // a tool with one required text parameter of another name still gets the prompt
  if (!promptSet) {
    const required = (schema?.required as string[] | undefined) ?? [];
    const target = required.find((n) => !(n in args)) ?? names.find((n) => !(n in args) && (props[n]?.type ?? "string") === "string");
    if (target) args[target] = vars.prompt;
    else args.prompt = vars.prompt;
  }
  return args;
}

async function runTool(t: PluginTool, args: Record<string, unknown>, values: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  if (t.kind === "http" && t.http) return runHttpTool(t, args, values, signal, true);
  if (t.kind === "js" && t.code) {
    const r = await runInSandbox(t.code, args, values, { signal, allowNetwork: true, timeoutMs: 10 * 60_000 });
    if (r.error) throw new ProviderError(`The plugin failed: ${r.error.split("\n")[0]}`);
    return r.result;
  }
  throw new ProviderError("This plugin tool has no implementation.");
}

export interface EngineDeps {
  plugins: () => Plugin[];
  getSecret: (name: string) => Promise<string | null>;
}

export async function runPluginEngine(req: BackendRequest, kind: "image" | "video", deps: EngineDeps): Promise<MediaOutput[]> {
  const plugin = deps.plugins().find((p) => p.id === req.provider.pluginId);
  const engine = plugin && enginesOf(plugin).find((e) => e.id === req.model.id);
  if (!plugin || !engine) throw new ProviderError("That plugin engine is no longer installed.");
  if (!plugin.enabled) throw new ProviderError(`The ${plugin.name} plugin is turned off.`);
  const values = await pluginSettingValues(plugin, deps.getSecret);
  const missing = missingSettings(plugin, values);
  if (missing.length) throw new ProviderError(`The ${plugin.name} plugin needs settings first: ${missing.join(", ")} (Settings → Plugins).`);
  const vars = templateVars(req);
  const count = engine.tool ? Number(vars.count) : 1;
  const out: MediaOutput[] = [];
  if (engine.http) return runTemplate(engine.http, vars, values, kind, req);
  for (let i = 0; i < Math.max(1, count); i++) {
    let result: unknown;
    if (engine.code) {
      const r = await runInSandbox(engine.code, vars, values, { signal: req.signal, allowNetwork: true, timeoutMs: 10 * 60_000 });
      if (r.error) throw new ProviderError(`The plugin failed: ${r.error.split("\n")[0]}`);
      result = r.result;
    } else if (engine.tool) {
      const t = plugin.tools.find((x) => x.name === engine.tool);
      if (!t) throw new ProviderError(`The plugin has no tool named ${engine.tool}.`);
      req.onProgress?.(count > 1 ? `image ${i + 1} of ${count}` : kind === "image" ? "creating image" : "creating video");
      result = await runTool(t, argsForTool(t.inputSchema, { ...vars, seed: Number(vars.seed) + i }), values, req.signal);
    }
    const found = await mediaFromResult(result, kind, req.signal);
    if (!found.length) {
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      throw new ProviderError(`The plugin answered, but no ${kind} was found in what it returned: ${text.slice(0, 240)}`);
    }
    out.push(...found);
    if (!engine.tool) break;
  }
  return out;
}

const IMAGE_TOOL = /dall-?e|midjourney|stable.?diffusion|flux|imagen|ideogram|text.?to.?image|image.?gen|(generate|create|make|draw|render|paint|design)\w*[\s_-]*(an?\s+)?(image|picture|photo|art|illustration|drawing|logo|icon)/i;
const VIDEO_TOOL = /text.?to.?video|video.?gen|(generate|create|make|render|animate)\w*[\s_-]*(an?\s+)?(video|clip|animation|movie)/i;

/** Tools that obviously make images or videos become engines automatically (the user can remove them). */
export function suggestEngines(tools: PluginTool[]): PluginEngine[] {
  const out: PluginEngine[] = [];
  for (const t of tools) {
    const text = `${t.name} ${t.description}`;
    const kind = VIDEO_TOOL.test(text) ? "video" : IMAGE_TOOL.test(text) ? "image" : null;
    if (!kind) continue;
    out.push({ id: `tool-${t.name}`, kind, name: t.name.replace(/[_-]+/g, " "), tool: t.name });
  }
  return out;
}
