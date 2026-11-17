import { runInSandbox } from "./sandbox";
import type { Tool } from "./types";

export const runJavascript: Tool = {
  group: "files",
  title: "Run JavaScript",
  spec: {
    name: "run_javascript",
    description:
      "Run JavaScript in an isolated sandbox for exact calculations, data processing, parsing, statistics or quick checks. The code is the body of an async function: " +
      "use console.log for output and/or return a value. `args.files` holds the text of any chat files you name in `files`. No DOM, no network. Time limit 30 s.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript (async function body)" },
        files: { type: "array", items: { type: "string" }, description: "Names of text files in this chat (CSV, JSON...) to pass in as args.files[name]" },
      },
      required: ["code"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Run JavaScript (${String(i.code).split("\n").length} lines)`,
  async run(input, ctx) {
    const files: Record<string, string> = {};
    for (const name of Array.isArray(input.files) ? input.files : []) {
      const f = [...ctx.files()].reverse().find((x) => x.name === name);
      const bytes = f ? await ctx.loadBlob(f.blobId) : null;
      if (bytes) files[String(name)] = new TextDecoder().decode(bytes).slice(0, 5_000_000);
    }
    const r = await runInSandbox(String(input.code), { files }, {}, { signal: ctx.signal });
    const out = [r.logs.join("\n"), r.result != null ? `=> ${r.result}` : "", r.error ? `Error: ${r.error}` : ""].filter(Boolean).join("\n").slice(0, 40_000);
    return { text: out || "(no output)", isError: !!r.error };
  },
};
