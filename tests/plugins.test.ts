import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GALLERY } from "../src/plugins/gallery";
import { fromJson, frontMatter, pluginsFromFile, pluginsFromZip } from "../src/plugins/import";
import { expandCommand, fillTemplate, pluginTools, runHttpTool, skillsPrompt, pluginSkills } from "../src/plugins/runtime";
import type { Plugin } from "../src/types";

const enc = (s: string) => new TextEncoder().encode(s);
afterEach(() => vi.unstubAllGlobals());

describe("plugin import", () => {
  it("reads front matter", () => {
    expect(frontMatter("---\nname: pdf\ndescription: Use for PDFs\n  and forms\n---\n# Body\ntext")).toEqual({ meta: { name: "pdf", description: "Use for PDFs and forms" }, body: "# Body\ntext" });
  });

  it("reads a Claude plugin from a GitHub-style zip", () => {
    const zip = zipSync({
      "repo-main/.claude-plugin/plugin.json": enc(JSON.stringify({ name: "sales", version: "1.2.0", description: "Sales tools", author: { name: "Acme" } })),
      "repo-main/commands/forecast.md": enc("---\ndescription: Build a forecast\nargument-hint: [quarter]\n---\nForecast $ARGUMENTS using the CRM."),
      "repo-main/commands/deals/review.md": enc("Review deals."),
      "repo-main/skills/pipeline/SKILL.md": enc("---\nname: pipeline-review\ndescription: Use when reviewing a sales pipeline\n---\nSteps..."),
      "repo-main/skills/pipeline/reference.md": enc("extra notes"),
      "repo-main/agents/sdr.md": enc("---\nname: SDR\ndescription: Writes outreach\nmodel: sonnet\n---\nYou write outreach emails."),
      "repo-main/.mcp.json": enc(JSON.stringify({ mcpServers: { hubspot: { type: "http", url: "https://mcp.hubspot.com/" }, local: { command: "npx", args: ["-y", "x"] } } })),
    });
    const [p] = pluginsFromZip(zip);
    expect(p).toMatchObject({ name: "sales", version: "1.2.0", author: "Acme" });
    expect(p.commands.map((c) => c.name)).toEqual(["deals:review", "forecast"]);
    expect(p.commands[1]).toMatchObject({ description: "Build a forecast", argumentHint: "[quarter]" });
    expect(p.skills[0]).toMatchObject({ name: "pipeline-review", description: "Use when reviewing a sales pipeline", files: { "reference.md": "extra notes" } });
    expect(p.agents[0]).toMatchObject({ name: "SDR", instructions: "You write outreach emails.", model: "sonnet" });
    expect(p.mcpServers.map((m) => [m.name, m.transport, m.url ?? m.command])).toEqual([["hubspot", "http", "https://mcp.hubspot.com/"], ["local", "stdio", "npx"]]);
  });

  it("reads every plugin of a marketplace repository", () => {
    const zip = zipSync({
      "m-main/.claude-plugin/marketplace.json": enc(JSON.stringify({ plugins: [{ name: "a", source: "./plugins/a" }, { name: "b", source: "./plugins/b" }] })),
      "m-main/plugins/a/commands/hello.md": enc("Say hello"),
      "m-main/plugins/b/.claude-plugin/plugin.json": enc(JSON.stringify({ name: "Bee" })),
      "m-main/plugins/b/skills/x/SKILL.md": enc("---\nname: x\ndescription: d\n---\nbody"),
    });
    expect(pluginsFromZip(zip).map((p) => p.name).sort()).toEqual(["Bee", "a"]);
  });

  it("reads TypingMind plugins and single skills", async () => {
    const tm = {
      title: "Weather",
      openaiSpec: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
      implementationType: "javascript",
      code: "async function get_weather(params, userSettings) { return 'sunny in ' + params.city + userSettings.unit; }",
      userSettings: [{ name: "apiKey", label: "API key", type: "password", required: true }, { name: "unit", label: "Unit" }],
    };
    const [d] = fromJson(JSON.stringify(tm));
    expect(d.tools[0]).toMatchObject({ name: "get_weather", kind: "js" });
    expect(d.tools[0].code).toContain("return await get_weather(args, settings);");
    expect(d.settings).toEqual([{ key: "apiKey", label: "API key", secret: true, required: true, help: undefined }, { key: "unit", label: "Unit", secret: false, required: false, help: undefined }]);
    const http = fromJson(JSON.stringify({ ...tm, implementationType: "http", httpAction: { url: "https://x/w?c={city}", method: "post", hasBody: true, requestBody: '{"c":"{{city}}"}' } }))[0];
    expect(http.tools[0]).toMatchObject({ kind: "http", http: { method: "POST", body: '{"c":"{{city}}"}' } });
    const [skill] = await pluginsFromFile("brand.md", enc("---\nname: brand-voice\ndescription: Our tone\n---\nBe warm."));
    expect(skill.skills[0]).toMatchObject({ name: "brand-voice", body: "Be warm." });
    expect(() => fromJson('{"foo": 1}')).toThrow(/not a plugin/);
  });
});

describe("plugin runtime", () => {
  it("fills templates with the right escaping", () => {
    expect(fillTemplate("https://a/?q={{q}}&n={{n}}", { q: "a b&c", n: 3 }, {}, "url")).toBe("https://a/?q=a%20b%26c&n=3");
    expect(fillTemplate('{"q":"{{q}}","tags":"{{tags}}","k":"{{settings.key}}","x":"pre-{{q}}"}', { q: 'say "hi"', tags: ["a"] }, { key: "K" }, "json")).toBe('{"q":"say \\"hi\\"","tags":["a"],"k":"K","x":"pre-say \\"hi\\""}');
  });

  it("expands slash commands Claude-style", () => {
    expect(expandCommand("Translate into $1:\n\n$ARGUMENTS", "French hello there")).toBe("Translate into French:\n\nFrench hello there");
    expect(expandCommand("Summarize the chat.", "focus on costs")).toBe("Summarize the chat.\n\nfocus on costs");
  });

  it("runs HTTP tools and picks a result path", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ data: { rate: 1.08 } });
    });
    const out = await runHttpTool({ name: "t", description: "", inputSchema: {}, kind: "http", http: { method: "GET", url: "https://api.x/rate?from={{from}}", headers: { Authorization: "Bearer {{settings.key}}" }, resultPath: "data" } }, { from: "EUR" }, { key: "S3" });
    expect(seen!.url).toBe("https://api.x/rate?from=EUR");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer S3");
    expect(JSON.parse(out)).toEqual({ rate: 1.08 });
  });

  it("exposes tools, skills and a read_skill tool; refuses without required settings", async () => {
    const p = { id: "p1", name: "Demo", enabled: true, tools: [{ name: "Get Thing!", description: "d", inputSchema: { type: "object", properties: {} }, kind: "http", http: { method: "GET", url: "https://x" } }], skills: [{ name: "s1", description: "when X", body: "do Y", files: { "a.md": "A" } }], commands: [], agents: [], mcpServers: [], settings: [{ key: "k", label: "Key", required: true }], values: {} } as unknown as Plugin;
    const tools = pluginTools([p], async () => null);
    expect(tools.map((t) => t.spec.name)).toEqual(["get_thing", "read_skill"]);
    const r = await tools[0].run({}, {} as never);
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/needs settings first \(Key\)/);
    expect((await tools[1].run({ name: "s1" }, {} as never)).text).toContain("do Y");
    expect((await tools[1].run({ name: "s1", file: "a.md" }, {} as never)).text).toBe("A");
    expect(skillsPrompt(pluginSkills([p]))).toContain("- s1: when X");
  });

  it("ships a valid gallery", () => {
    for (const g of GALLERY) {
      expect(g.name).toBeTruthy();
      for (const t of g.tools) expect(t.kind === "http" ? !!t.http?.url : !!t.code).toBe(true);
    }
    expect(GALLERY.length).toBeGreaterThanOrEqual(8);
  });
});
