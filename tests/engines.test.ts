import { afterEach, describe, expect, it, vi } from "vitest";
import { argsForTool, engineProviders, runPluginEngine, suggestEngines } from "../src/plugins/engines";
import { convertPlaceholders, fromJson, wrapTypingMindCode } from "../src/plugins/import";
import type { Plugin } from "../src/types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
afterEach(() => vi.unstubAllGlobals());

describe("TypingMind import", () => {
  it("reads a classic single-function plugin and calls its function", () => {
    const [d] = fromJson(
      JSON.stringify({
        uuid: "u1",
        title: "Weather",
        emoji: "🌦",
        openaiSpec: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
        userSettings: [{ name: "apiKey", label: "API key", type: "password", required: true }],
        implementationType: "javascript",
        code: "async function get_weather(params, userSettings) { return params.city; }",
      }),
    );
    expect(d.name).toBe("Weather");
    expect(d.tools[0].code).toContain("return await get_weather(args, settings);");
    expect(d.settings[0]).toMatchObject({ key: "apiKey", secret: true, required: true });
    expect(d.engines).toEqual([]);
  });

  it("reads multi-function plugins (pluginFunctions) with shared code and HTTP actions", () => {
    const [d] = fromJson(
      JSON.stringify({
        title: "Toolbox",
        userSettings: [{ name: "token", type: "password" }],
        code: "async function search(p, s) { return 1 } async function fetchPage(p, s) { return 2 }",
        pluginFunctions: [
          { openaiSpec: { name: "search", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } },
          { openaiSpec: { name: "fetchPage", description: "Fetch a page", parameters: { type: "object", properties: { url: { type: "string" } } } } },
          {
            implementationType: "http",
            openaiSpec: { name: "lookup", description: "Look up a word", parameters: { type: "object", properties: { word: { type: "string" } } } },
            httpAction: { url: "https://api.test/define?w={word}", method: "GET", hasHeaders: true, requestHeaders: '{"Authorization":"Bearer {token}"}' },
          },
          { openaiSpec: { name: "draw_image", description: "Generate an image from a prompt", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } }, code: "async function draw_image(p){ return 'x' }" },
        ],
      }),
    );
    expect(d.tools.map((t) => t.name)).toEqual(["search", "fetchPage", "lookup", "draw_image"]);
    expect(d.tools[1].code).toContain("return await fetchPage(args, settings);");
    expect(d.tools[2]).toMatchObject({ kind: "http", http: { url: "https://api.test/define?w={{word}}", headers: { Authorization: "Bearer {{settings.token}}" } } });
    expect(d.engines).toEqual([{ id: "tool-draw_image", kind: "image", name: "draw image", tool: "draw_image" }]);
  });

  it("accepts OpenAI-style function lists and plugin bundles", () => {
    const list = fromJson(
      JSON.stringify({
        plugins: [
          { name: "Bundle A", functions: [{ type: "function", function: { name: "a", parameters: {} } }], code: "async function a(){return 1}" },
          { title: "B", openaiSpec: { name: "b" }, code: "return 2" },
        ],
      }),
    );
    expect(list.map((d) => d.name)).toEqual(["Bundle A", "B"]);
    expect(list[1].tools[0].code).toBe("return 2");
  });

  it("converts placeholders and finds the function to call", () => {
    expect(convertPlaceholders('{"q":"{query}","k":"{userSettings.key}","x":"{{query}}"}', ["query"], ["key"])).toBe('{"q":"{{query}}","k":"{{settings.key}}","x":"{{query}}"}');
    expect(wrapTypingMindCode("const run = async (p) => p.a;", "other_name")).toContain("return await run(args, settings);");
  });
});

describe("plugin engines", () => {
  const plugin = (over: Partial<Plugin> = {}): Plugin => ({
    id: "p1",
    createdAt: 1,
    updatedAt: 1,
    name: "Painter",
    source: "file",
    enabled: true,
    tools: [{ name: "paint", description: "Generate an image", kind: "http", inputSchema: { type: "object", properties: { description: { type: "string" }, size: { type: "string" } } }, http: { method: "POST", url: "https://paint.test/api", body: '{"p":"{{description}}","size":"{{size}}"}' } }],
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    settings: [],
    values: {},
    engines: [{ id: "e1", kind: "image", name: "Painter", tool: "paint" }],
    ...over,
  });

  it("become providers in the pickers", () => {
    const [p] = engineProviders([plugin(), plugin({ id: "p2", engines: [] })]);
    expect(p).toMatchObject({ id: "plugin:p1", kind: "plugin", pluginId: "p1", models: [{ id: "e1", kind: "image" }] });
    expect(engineProviders([plugin({ enabled: false })])).toEqual([]);
  });

  it("map the request onto the tool's parameters", () => {
    const args = argsForTool({ type: "object", properties: { description: { type: "string" }, size: { type: "string", enum: ["1024x1024", "512x512"] }, n: { type: "integer" } } }, { prompt: "fox", width: 1024, height: 1024, count: 2, aspect_ratio: "1:1" });
    expect(args).toEqual({ description: "fox", size: "1024x1024", n: 2 });
    expect(argsForTool({ type: "object", properties: { thing: { type: "string" } }, required: ["thing"] }, { prompt: "fox" })).toEqual({ thing: "fox" });
  });

  it("run a tool and download the image it points to", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url} ${init.body ?? ""}`);
      if (url === "https://paint.test/api") return Response.json({ result: { url: "https://paint.test/out/1" } });
      return new Response(PNG as BodyInit, { headers: { "content-type": "image/png" } });
    });
    const p = plugin();
    const [provider] = engineProviders([p]);
    const out = await runPluginEngine({ provider, apiKey: "", model: provider.models[0], prompt: "a fox" }, "image", { plugins: () => [p], getSecret: async () => null });
    expect(out[0].mime).toBe("image/png");
    expect(calls[0]).toContain('"p":"a fox"');
    expect(calls[1]).toBe("GET https://paint.test/out/1 ");
  });

  it("are suggested only for tools that make pictures or videos", () => {
    expect(suggestEngines([{ name: "search_web", description: "Search the web", kind: "js", inputSchema: {} }])).toEqual([]);
    expect(suggestEngines([{ name: "dalle", description: "Create images with DALL-E", kind: "js", inputSchema: {} }])[0].kind).toBe("image");
    expect(suggestEngines([{ name: "make_clip", description: "Generate a video clip", kind: "js", inputSchema: {} }])[0].kind).toBe("video");
  });
});
