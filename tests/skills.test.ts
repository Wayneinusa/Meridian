import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSkills, namedSkills, parseSkillMd, readSkillTool, skillMissing, skillsFromFiles, skillsFromUrl, skillsFromZip, skillsPrompt, skillZip, toSkillMd } from "../src/skills/skills";
import type { Plugin, Settings, Skill } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

const MD = `---
name: pdf-report
description: >
  Builds a PDF report from data.
  Use when the user asks for a report.
license: MIT
allowed-tools:
  - create_file
  - run_javascript
requires-tools: files, web
requires-connectors: [notion]
---
# PDF report

1. Gather the data.
2. Read templates/cover.md.`;

const tools: Settings["tools"] = { files: true, media: true, web: true, computer: false, browser: true, connectors: true };
const skill = (over: Partial<Skill>): Skill => ({ id: "s1", createdAt: 1, updatedAt: 1, name: "pdf-report", description: "Builds PDF reports", body: "BODY", availability: "everywhere", source: "created", ...over });

describe("SKILL.md", () => {
  it("reads the front matter: name, folded description, lists, requirements", () => {
    const d = parseSkillMd(MD);
    expect(d.name).toBe("pdf-report");
    expect(d.description).toBe("Builds a PDF report from data. Use when the user asks for a report.");
    expect(d.allowedTools).toEqual(["create_file", "run_javascript"]);
    expect(d.requiresTools).toEqual(["files", "web"]);
    expect(d.requiresConnectors).toEqual(["notion"]);
    expect(d.license).toBe("MIT");
    expect(d.body.startsWith("# PDF report")).toBe(true);
  });

  it("a file without front matter is named after its folder and described by its first line", () => {
    const d = parseSkillMd("# Title\n\nWrite haiku about the topic.", "haiku");
    expect(d).toMatchObject({ name: "haiku", description: "Write haiku about the topic." });
  });

  it("writes SKILL.md back so it reads the same", () => {
    const back = parseSkillMd(toSkillMd(skill({ description: "Has: a colon", requiresTools: ["web"], requiresConnectors: ["notion"], license: "MIT" })));
    expect(back).toMatchObject({ name: "pdf-report", description: "Has: a colon", requiresTools: ["web"], requiresConnectors: ["notion"], license: "MIT", body: "BODY" });
  });
});

describe("installing", () => {
  it("finds every skill folder with its own files (nested skills keep theirs)", () => {
    const list = skillsFromFiles({
      "repo/skills/pdf/SKILL.md": MD,
      "repo/skills/pdf/templates/cover.md": "COVER",
      "repo/skills/pdf/sub/SKILL.md": "---\nname: sub\ndescription: inner\n---\nIN",
      "repo/skills/pdf/sub/x.txt": "X",
      "repo/README.md": "readme",
    });
    expect(list.map((s) => s.name).sort()).toEqual(["pdf-report", "sub"]);
    expect(Object.keys(list.find((s) => s.name === "pdf-report")!.files)).toEqual(["templates/cover.md"]);
    expect(list.find((s) => s.name === "sub")!.files).toEqual({ "x.txt": "X" });
  });

  it("reads a zip (binary files are skipped) and exports one that reads back", () => {
    const zip = zipSync({ "my-skill/SKILL.md": strToU8(MD), "my-skill/ref.json": strToU8("{}"), "my-skill/logo.png": new Uint8Array([137, 80, 78, 71]) });
    const [d] = skillsFromZip(zip);
    expect(d.name).toBe("pdf-report");
    expect(Object.keys(d.files)).toEqual(["ref.json"]);
    const out = unzipSync(skillZip(skill({ files: { "templates/a.md": "A" } })));
    expect(Object.keys(out).sort()).toEqual(["pdf-report/SKILL.md", "pdf-report/templates/a.md"]);
    expect(skillsFromZip(skillZip(skill({ files: { "templates/a.md": "A" } })))[0]).toMatchObject({ name: "pdf-report", body: "BODY", files: { "templates/a.md": "A" } });
  });

  it("installs from a GitHub folder (only that folder) and from a GitHub SKILL.md link", async () => {
    const repoZip = zipSync({ "skills-main/a/SKILL.md": strToU8("---\nname: a\ndescription: A\n---\nA"), "skills-main/b/SKILL.md": strToU8("---\nname: b\ndescription: B\n---\nB") });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("codeload")) return new Response(repoZip);
      return new Response("---\nname: c\ndescription: C\n---\nC");
    });
    expect((await skillsFromUrl("https://github.com/acme/skills/tree/main/b")).map((s) => s.name)).toEqual(["b"]);
    expect(urls[0]).toBe("https://codeload.github.com/acme/skills/zip/refs/heads/main");
    expect((await skillsFromUrl("https://github.com/acme/skills")).map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect((await skillsFromUrl("https://github.com/acme/skills/blob/main/c/SKILL.md"))[0].name).toBe("c");
    expect(urls.at(-1)).toBe("https://raw.githubusercontent.com/acme/skills/main/c/SKILL.md");
  });
});

describe("which skills a chat gets", () => {
  const plugin = { id: "p", name: "Docs plugin", enabled: true, skills: [{ name: "docx", description: "Word files", body: "DOCX" }], tools: [], commands: [], agents: [], mcpServers: [], settings: [], values: {} } as unknown as Plugin;
  const lib = [skill({ id: "e", name: "everywhere-one", availability: "everywhere" }), skill({ id: "a", name: "assigned-one", availability: "assigned" }), skill({ id: "o", name: "off-one", availability: "off" })];

  it("everywhere + assigned to the agent, project or member + plugin skills; never the ones turned off", () => {
    const base = { skills: lib, plugins: [plugin], settings: { tools, mcpServers: [] } };
    expect(activeSkills(base).map((s) => s.name)).toEqual(["everywhere-one", "docx"]);
    expect(activeSkills({ ...base, agent: { skills: ["a", "o"] } }).map((s) => `${s.name}:${s.from}`)).toEqual(["everywhere-one:everywhere", "assigned-one:agent", "docx:plugin Docs plugin"]);
    expect(activeSkills({ ...base, project: { skills: ["a"] } }).find((s) => s.name === "assigned-one")?.from).toBe("project");
    expect(activeSkills({ ...base, member: ["a"] }).find((s) => s.name === "assigned-one")?.from).toBe("member");
  });

  it("a skill whose tools or connectors are missing is shown but not offered", () => {
    expect(skillMissing({ requiresTools: ["computer", "web"], requiresConnectors: ["notion"] }, tools, [])).toEqual(["computer tools are off", "the notion connector is not added"]);
    expect(skillMissing({ requiresConnectors: ["notion"] }, tools, [{ id: "notion", name: "Notion", transport: "http", enabled: true }])).toEqual([]);
    const list = activeSkills({ skills: [skill({ requiresTools: ["computer"] })], plugins: [], settings: { tools, mcpServers: [] } });
    expect(list[0].missing.length).toBe(1);
    expect(skillsPrompt(list)).toBe("");
  });

  it("progressive disclosure: names and descriptions up front, the body on read_skill or /name", async () => {
    const list = activeSkills({ skills: [skill({ files: { "t.md": "T" } })], plugins: [], settings: { tools, mcpServers: [] } });
    const prompt = skillsPrompt(list);
    expect(prompt).toContain("- pdf-report: Builds PDF reports");
    expect(prompt).not.toContain("BODY");
    expect(skillsPrompt(list, ["pdf-report"])).toContain('<skill name="pdf-report">\nBODY\n</skill>');
    const read = readSkillTool(list);
    expect((await read.run({ name: "PDF-REPORT" }, {} as never)).text).toContain("BODY");
    expect((await read.run({ name: "pdf-report", file: "t.md" }, {} as never)).text).toBe("T");
    expect(namedSkills("please /pdf-report this, and /unknown", list)).toEqual(["pdf-report"]);
    expect(namedSkills("see https://x.com/path", list)).toEqual([]);
  });
});
