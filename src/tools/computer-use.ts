// Visual computer use: the model looks at a screenshot, picks an action,
// the user approves it (by default every one), Meridian performs it and
// sends back a fresh screenshot. The agent loop repeats that until the task
// is done, so every step is visible in the chat and can be stopped.
//
// Safety: approval per action (configurable), a preview of where the click
// lands, a rate limit, a step budget (engine), and a kill switch (Stop, Esc,
// or Ctrl+Alt+Esc anywhere) that the native side enforces too.
import { invoke } from "../platform";
import type { Settings } from "../types";
import { base64ToBytes } from "../util/bytes";
import type { PermissionPreview, Tool, ToolContext } from "./types";

interface Shot {
  png_b64: string;
  width: number;
  height: number;
  screen_width: number;
  screen_height: number;
}

interface Last {
  blobId: string;
  width: number;
  height: number;
}

/** the latest screenshot of each chat: coordinates refer to it, previews draw on it */
const lastShot = new Map<string, Last>();
const lastActionAt = new Map<string, number>();
let killed = false;

/** Stop all computer use now (Stop button, Esc, global shortcut). */
export function killComputerUse() {
  killed = true;
  void invoke("computer_kill", { on: true }).catch(() => undefined);
}

/** A new task from the user re-arms computer use. */
export function rearmComputerUse() {
  if (!killed) return;
  killed = false;
  void invoke("computer_kill", { on: false }).catch(() => undefined);
}

export const isComputerUseKilled = () => killed;

export const COMPUTER_ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "wait", "list_windows", "focus_window"] as const;
type Action = (typeof COMPUTER_ACTIONS)[number];

/** Actions that ask under "ask for risky actions": they type, use shortcuts, or drag things around. */
const RISKY: Action[] = ["type", "key", "drag", "double_click", "right_click", "focus_window"];
/** Actions that never change anything on screen. */
const PASSIVE: Action[] = ["wait", "list_windows"];

export function computerNeedsApproval(action: Action, settings: Settings): boolean {
  const mode = settings.computerUse?.approval ?? "each";
  if (PASSIVE.includes(action)) return false;
  if (mode === "auto") return false;
  if (mode === "risky") return RISKY.includes(action);
  return true;
}

function describe(i: Record<string, unknown>): string {
  const a = String(i.action);
  switch (a) {
    case "screenshot":
      return "Look at the screen (take a screenshot)";
    case "type":
      return `Type "${String(i.text ?? "").slice(0, 80)}"`;
    case "key":
      return `Press ${String(i.keys)}`;
    case "drag":
      return `Drag from (${i.x}, ${i.y}) to (${i.x2}, ${i.y2})`;
    case "scroll":
      return `Scroll ${Number(i.dy ?? 0) >= 0 ? "down" : "up"}${i.x !== undefined ? ` at (${i.x}, ${i.y})` : ""}`;
    case "wait":
      return `Wait ${Number(i.ms) || 1000} ms`;
    case "list_windows":
      return "List the open windows";
    case "focus_window":
      return `Bring "${String(i.title)}" to the front`;
    default:
      return `${a.replace("_", " ")} at (${i.x}, ${i.y})`;
  }
}

async function capture(ctx: Pick<ToolContext, "saveBlob" | "conversationId">): Promise<{ ref: Awaited<ReturnType<ToolContext["saveBlob"]>>; shot: Shot }> {
  const shot = await invoke<Shot>("screenshot");
  const ref = await ctx.saveBlob(base64ToBytes(shot.png_b64), "image/png", `screen-${Date.now().toString(36)}.png`);
  lastShot.set(ctx.conversationId, { blobId: ref.blobId, width: shot.width, height: shot.height });
  return { ref, shot };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))));
  });

/** Bring a window to the front by (part of) its app name or title. */
async function focusWindow(title: string, os: string): Promise<string> {
  const q = title.replace(/["`$\\']/g, "");
  // run_command already runs PowerShell on Windows and sh elsewhere
  const command =
    os === "windows"
      ? `$s = New-Object -ComObject WScript.Shell; if (-not $s.AppActivate('${q}')) { exit 1 }`
      : `osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "${q}") to true' 2>/dev/null || open -a "${q}"`;
  const r = await invoke<{ code: number | null; stdout: string; stderr: string }>("run_command", { command, cwd: null, timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`Could not bring "${title}" to the front. Use list_windows to see the exact names.`);
  return `Brought "${title}" to the front.`;
}

export function computerUseTool(os: string): Tool {
  return {
    group: "computer",
    title: "Computer",
    allowForTask: true,
    spec: {
      name: "computer",
      description:
        "Use the user's computer like a person: look at the screen and act with the mouse and keyboard. Every action returns a fresh screenshot, so work step by step: " +
        "look, act, check the new screenshot, continue. Coordinates are pixels in the most recent screenshot. Actions: screenshot; click, double_click, right_click, move (x, y); " +
        "drag (x, y to x2, y2); scroll (dy notches, positive is down; dx for sideways; optional x, y to scroll over a spot); type (text); key (a combination such as 'ctrl+s', 'enter', 'cmd+space'); " +
        "wait (ms); list_windows; focus_window (title or app name). Prefer keyboard shortcuts and typing over hunting for small targets. Stop and ask the user before anything irreversible " +
        "(deleting, sending, buying) unless they clearly asked for it. Each action may need the user's approval.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...COMPUTER_ACTIONS] },
          x: { type: "integer" },
          y: { type: "integer" },
          x2: { type: "integer", description: "drag: where to drop" },
          y2: { type: "integer", description: "drag: where to drop" },
          dy: { type: "integer", description: "scroll: notches, positive is down" },
          dx: { type: "integer", description: "scroll: notches, positive is right" },
          text: { type: "string" },
          keys: { type: "string" },
          ms: { type: "integer", description: "wait: milliseconds (max 10000)" },
          title: { type: "string", description: "focus_window: window title or app name" },
        },
        required: ["action"],
      },
    },
    needsApproval: (i, ctx) => computerNeedsApproval(String(i.action) as Action, ctx.settings),
    summarize: describe,
    async preview(i, ctx): Promise<PermissionPreview | undefined> {
      const last = lastShot.get(ctx.conversationId);
      if (!last || typeof i.x !== "number" || typeof i.y !== "number") return undefined;
      const marks: PermissionPreview["marks"] = [{ x: i.x, y: i.y, label: String(i.action) }];
      if (i.action === "drag" && typeof i.x2 === "number" && typeof i.y2 === "number") marks.push({ x: i.x2, y: i.y2, label: "drop" });
      return { blobId: last.blobId, width: last.width, height: last.height, marks };
    },
    async run(i, ctx) {
      const action = String(i.action) as Action;
      if (killed) return { isError: true, text: "Computer use was stopped by the user (kill switch). Do not continue; tell the user what was done so far." };
      if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (action === "list_windows") {
        const list = await invoke<{ title: string; app: string; minimized: boolean }[]>("list_windows");
        return { text: list.map((w) => `- ${w.app ? `${w.app}: ` : ""}${w.title}${w.minimized ? " (minimised)" : ""}`).join("\n") || "No windows." };
      }
      if (action === "wait") {
        await sleep(Math.min(Math.max(Number(i.ms) || 1000, 100), 10_000), ctx.signal);
      } else if (action === "focus_window") {
        await focusWindow(String(i.title ?? ""), os);
      } else if (action !== "screenshot") {
        if (["click", "double_click", "right_click", "move", "drag"].includes(action) && !lastShot.has(ctx.conversationId)) {
          return { isError: true, text: "Take a screenshot first: coordinates refer to the latest screenshot." };
        }
        // rate limit: at most N actions a minute
        const perMinute = Math.max(1, ctx.settings.computerUse?.actionsPerMinute ?? 30);
        const gap = 60_000 / perMinute;
        const since = Date.now() - (lastActionAt.get(ctx.conversationId) ?? 0);
        if (since < gap) await sleep(gap - since, ctx.signal);
        if (killed) return { isError: true, text: "Computer use was stopped by the user (kill switch)." };
        lastActionAt.set(ctx.conversationId, Date.now());
        await invoke("input_action", {
          action,
          x: typeof i.x === "number" ? i.x : null,
          y: typeof i.y === "number" ? i.y : null,
          dy: typeof i.dy === "number" ? i.dy : null,
          dx: typeof i.dx === "number" ? i.dx : null,
          x2: typeof i.x2 === "number" ? i.x2 : null,
          y2: typeof i.y2 === "number" ? i.y2 : null,
          text: typeof i.text === "string" ? i.text : null,
          keys: typeof i.keys === "string" ? i.keys : null,
        });
        // let the screen settle before looking again
        await sleep(action === "type" || action === "key" ? 700 : 450, ctx.signal);
      }
      const { ref, shot } = await capture(ctx);
      const did = action === "screenshot" ? "Screenshot" : `${describe(i)}: done. Screenshot after it`;
      return { text: `${did}: ${shot.width}x${shot.height} pixels (screen ${shot.screen_width}x${shot.screen_height}).`, images: [ref] };
    },
  };
}
