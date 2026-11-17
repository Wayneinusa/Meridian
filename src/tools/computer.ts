// "Use my computer" tools: shell, files, apps, installs, screenshots and
// mouse/keyboard. Desktop builds only (Windows first; macOS and Linux work
// too). iOS and iPadOS do not let any app do these things.
//
// Every one of these asks the user first unless they chose "always allow"
// for that tool or switched on auto-approve in Settings.
import { invoke, platform } from "../platform";
import { base64ToBytes, bytesToBase64, formatBytes, mimeFromName, safeFileName } from "../util/bytes";
import type { Tool, ToolOutput } from "./types";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
}

const always = () => true;
const LIMIT = 30_000;

function clip(s: string): string {
  if (s.length <= LIMIT) return s;
  const head = s.slice(0, LIMIT * 0.6);
  const tail = s.slice(-LIMIT * 0.4);
  return `${head}\n\n[... ${s.length - LIMIT} characters omitted ...]\n\n${tail}`;
}

function formatCommand(r: CommandResult): ToolOutput {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(clip(r.stdout.trimEnd()));
  if (r.stderr.trim()) parts.push(`[stderr]\n${clip(r.stderr.trimEnd())}`);
  if (r.timed_out) parts.push("[The command was stopped because it ran past its time limit.]");
  parts.push(`[exit code ${r.code ?? "unknown"}]`);
  return { text: parts.join("\n\n"), isError: r.timed_out || (r.code !== 0 && r.code !== null) };
}

async function shell(command: string, cwd: string | undefined, timeoutSeconds: number): Promise<CommandResult> {
  return invoke<CommandResult>("run_command", { command, cwd: cwd || null, timeoutMs: Math.round(timeoutSeconds * 1000) });
}

const shellName = () => (platform().os === "windows" ? "PowerShell" : "sh");

const runCommand: Tool = {
  group: "computer",
  title: "Run command",
  spec: {
    name: "run_command",
    description:
      "Run a shell command on the user's computer and return its output. On Windows this is PowerShell; on macOS and Linux it is sh. " +
      "Use it to inspect the system, manage files and processes, run scripts and developer tools, and change settings. " +
      "Commands run with the user's own permissions and are not sandboxed, so prefer read-only commands unless the user asked for a change, " +
      "and never run anything destructive (deleting data, formatting, force-pushing) without the user asking for exactly that. Do not start interactive programs that wait for input.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run" },
        cwd: { type: "string", description: "Working directory (absolute path). Defaults to the user's home folder." },
        timeout_seconds: { type: "integer", description: "Time limit, default 120, max 1800" },
      },
      required: ["command"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Run in ${shellName()}: ${String(i.command)}`,
  async run(input) {
    const timeout = Math.min(Math.max(Number(input.timeout_seconds) || 120, 1), 1800);
    return formatCommand(await shell(String(input.command), input.cwd as string | undefined, timeout));
  },
};

const readFile: Tool = {
  group: "computer",
  title: "Read file",
  spec: {
    name: "read_file",
    description: "Read a text file from the user's computer. Returns up to 200,000 characters and says so when the file was longer.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path" } },
      required: ["path"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Read ${String(i.path)}`,
  async run(input) {
    const text = await invoke<string>("fs_read_text", { path: String(input.path) });
    const max = 200_000;
    if (text.length > max) return { text: `${text.slice(0, max)}\n\n[Only the first ${max} of ${text.length} characters are shown.]` };
    return { text: text || "(empty file)" };
  },
};

const writeFile: Tool = {
  group: "computer",
  title: "Write file",
  spec: {
    name: "write_file",
    description: "Create or overwrite a text file on the user's computer. Parent folders are created as needed. Read the file first if it may already exist and matter.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Write ${String(i.path)} (${formatBytes(String(i.content ?? "").length)})`,
  async run(input) {
    await invoke("fs_write_text", { path: String(input.path), content: String(input.content) });
    return { text: `Wrote ${String(input.content).length} characters to ${String(input.path)}.` };
  },
};

const listDirectory: Tool = {
  group: "computer",
  title: "List folder",
  spec: {
    name: "list_directory",
    description: "List the files and folders inside a folder on the user's computer, with sizes and modification times.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of the folder" } },
      required: ["path"],
    },
  },
  needsApproval: always,
  summarize: (i) => `List ${String(i.path)}`,
  async run(input) {
    const entries = await invoke<{ name: string; is_dir: boolean; size: number; modified_ms: number }[]>("fs_list", { path: String(input.path) });
    if (!entries.length) return { text: "(empty folder)" };
    const shown = entries.slice(0, 1000);
    const lines = shown
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      .map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}${e.is_dir ? "" : `  (${formatBytes(e.size)}, ${new Date(e.modified_ms).toISOString().slice(0, 16).replace("T", " ")})`}`);
    if (entries.length > shown.length) lines.push(`[${entries.length - shown.length} more entries not shown]`);
    return { text: lines.join("\n") };
  },
};

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+\-@/]{0,120}$/;

const searchApps: Tool = {
  group: "computer",
  title: "Search apps",
  spec: {
    name: "search_apps",
    description:
      "Search the system package manager for installable applications (winget on Windows, Homebrew on macOS). Use this to find the exact package id before install_app.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "App name, e.g. 'vlc' or 'visual studio code'" } },
      required: ["query"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Search for apps matching "${String(i.query)}"`,
  async run(input) {
    const q = String(input.query).replace(/["'`$;|&<>\r\n]/g, " ").trim();
    if (!q) return { isError: true, text: "Empty search." };
    const os = platform().os;
    if (os === "windows") return formatCommand(await shell(`winget search "${q}" --accept-source-agreements --disable-interactivity`, undefined, 120));
    if (os === "macos") return formatCommand(await shell(`brew search "${q}"`, undefined, 120));
    return { isError: true, text: "No app catalog is wired up on this system. Use run_command with the system's package manager (apt, dnf, flatpak...)." };
  },
};

const installApp: Tool = {
  group: "computer",
  title: "Install app",
  spec: {
    name: "install_app",
    description:
      "Install an application on the user's computer through the system package manager: winget on Windows (id like 'VideoLAN.VLC'), Homebrew on macOS (formula or cask name). " +
      "Find the exact id with search_apps first. Installing can take several minutes and may show a Windows permission prompt the user has to accept.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact package id from search_apps" },
        cask: { type: "boolean", description: "macOS only: install a GUI app (brew --cask)" },
      },
      required: ["id"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Install application ${String(i.id)}`,
  async run(input) {
    const id = String(input.id).trim();
    if (!PACKAGE_ID.test(id)) return { isError: true, text: "That does not look like a package id. Use search_apps to find the exact id." };
    const os = platform().os;
    if (os === "windows") {
      return formatCommand(
        await shell(`winget install --id "${id}" --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`, undefined, 1800),
      );
    }
    if (os === "macos") return formatCommand(await shell(`brew install ${input.cask === true ? "--cask " : ""}"${id}"`, undefined, 1800));
    return { isError: true, text: "No app catalog is wired up on this system. Use run_command with the system's package manager." };
  },
};

const openTarget: Tool = {
  group: "computer",
  title: "Open",
  spec: {
    name: "open",
    description: "Open a file, folder or URL with its default application, or launch an installed application by path, the way double-clicking would.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", description: "Absolute path or URL" } },
      required: ["target"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Open ${String(i.target)}`,
  async run(input) {
    await invoke("open_target", { target: String(input.target) });
    return { text: `Opened ${String(input.target)}.` };
  },
};

const saveGenerated: Tool = {
  group: "computer",
  title: "Save file to computer",
  spec: {
    name: "save_generated_file",
    description:
      "Copy a file that was created or attached in this conversation (spreadsheet, PDF, image, video, ...) to a folder on the user's computer. " +
      "Give the file name exactly as it was created and the absolute destination folder.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Name of the generated or attached file" },
        folder: { type: "string", description: "Absolute path of the destination folder, e.g. the user's Desktop" },
      },
      required: ["filename", "folder"],
    },
  },
  needsApproval: always,
  summarize: (i) => `Save ${String(i.filename)} into ${String(i.folder)}`,
  async run(input, ctx) {
    const wanted = String(input.filename);
    const file = [...ctx.files()].reverse().find((f) => f.name === wanted) ?? [...ctx.files()].reverse().find((f) => f.name.toLowerCase() === wanted.toLowerCase());
    if (!file) return { isError: true, text: `No file named "${wanted}" exists in this conversation. Available: ${ctx.files().map((f) => f.name).join(", ") || "none"}.` };
    const bytes = await ctx.loadBlob(file.blobId);
    if (!bytes) return { isError: true, text: "That file is not available on this device." };
    const sep = platform().os === "windows" ? "\\" : "/";
    const dest = String(input.folder).replace(/[\\/]+$/, "") + sep + safeFileName(file.name);
    await invoke("fs_write_b64", { path: dest, data: bytesToBase64(bytes) });
    return { text: `Saved to ${dest} (${formatBytes(bytes.length)}).` };
  },
};

interface Shot {
  png_b64: string;
  width: number;
  height: number;
  screen_width: number;
  screen_height: number;
}

const screenshot: Tool = {
  group: "computer",
  title: "Take screenshot",
  spec: {
    name: "take_screenshot",
    description:
      "Capture the user's main screen and look at it. Use it to see what is on screen before and after using computer_input. " +
      "Coordinates for computer_input are in the pixel space of the most recent screenshot.",
    inputSchema: { type: "object", properties: {} },
  },
  needsApproval: always,
  summarize: () => "Take a screenshot of the screen",
  async run(_input, ctx) {
    const shot = await invoke<Shot>("screenshot");
    const ref = await ctx.saveBlob(base64ToBytes(shot.png_b64), "image/png", `screenshot-${Date.now().toString(36)}.png`);
    return {
      text: `Screenshot captured: ${shot.width}x${shot.height} pixels (screen is ${shot.screen_width}x${shot.screen_height}). Use coordinates within ${shot.width}x${shot.height}.`,
      images: [ref],
    };
  },
};

const computerInput: Tool = {
  group: "computer",
  title: "Mouse and keyboard",
  spec: {
    name: "computer_input",
    description:
      "Control the mouse and keyboard of the user's computer. Take a screenshot first, act, then take another screenshot to check the result. " +
      "Actions: move, click, double_click, right_click (need x and y in screenshot pixels); scroll (x, y and dy: positive scrolls down); " +
      "type (text: types the string); key (keys: a combination such as 'ctrl+s', 'alt+tab', 'enter', 'win').",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["move", "click", "double_click", "right_click", "scroll", "type", "key"] },
        x: { type: "integer" },
        y: { type: "integer" },
        dy: { type: "integer", description: "Scroll amount in notches; positive is down" },
        text: { type: "string" },
        keys: { type: "string" },
      },
      required: ["action"],
    },
  },
  needsApproval: always,
  summarize: (i) => {
    const a = String(i.action);
    if (a === "type") return `Type "${String(i.text ?? "").slice(0, 60)}"`;
    if (a === "key") return `Press ${String(i.keys)}`;
    return `${a.replace("_", " ")} at (${i.x}, ${i.y})`;
  },
  async run(input) {
    await invoke("input_action", {
      action: String(input.action),
      x: typeof input.x === "number" ? input.x : null,
      y: typeof input.y === "number" ? input.y : null,
      dy: typeof input.dy === "number" ? input.dy : null,
      text: typeof input.text === "string" ? input.text : null,
      keys: typeof input.keys === "string" ? input.keys : null,
    });
    return { text: "Done. Take a screenshot to see the result." };
  },
};

export function computerTools(): Tool[] {
  const p = platform();
  if (!p.desktop) return [];
  const tools = [runCommand, readFile, writeFile, listDirectory, searchApps, installApp, openTarget, saveGenerated];
  if (p.canControlScreen) tools.push(screenshot, computerInput);
  return tools;
}

/** Facts about this machine for the system prompt, so the model writes correct paths and commands. */
export function computerContext(): string {
  const p = platform();
  if (!p.desktop) return "";
  return [
    `You can act on the user's computer through tools. System: ${p.os}; shell for run_command: ${shellName()}.`,
    `Home folder: ${p.homeDir}. Desktop: ${p.desktopDir}. Documents: ${p.documentsDir}. Downloads: ${p.downloadsDir}.`,
    "The user is asked to approve each action, so say briefly what you are about to do and why before acting, take the smallest step that works, and check results before continuing.",
  ].join("\n");
}

export { mimeFromName };
