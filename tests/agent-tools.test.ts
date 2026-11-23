import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: any }[] = [];
let screenshots = 0;
vi.mock("../src/platform", async (orig) => {
  const real = (await orig()) as object;
  return {
    ...real,
    isTauri: false,
    invoke: async (cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === "screenshot") {
        screenshots++;
        return { png_b64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), width: 1280, height: 800, screen_width: 2560, screen_height: 1600 };
      }
      if (cmd === "list_windows") return [{ title: "Untitled - Notepad", app: "Notepad", minimized: false }];
      return null;
    },
  };
});

import { BidiDriver } from "../src/browser/drivers";
import type { Socket } from "../src/browser/transport";
import { withRecentScreenshots } from "../src/agent/engine";
import { defaultSettings, migrateSettings } from "../src/state/defaults";
import { computerNeedsApproval, computerUseTool, isComputerUseKilled, killComputerUse, rearmComputerUse } from "../src/tools/computer-use";
import type { ToolContext } from "../src/tools/types";
import type { Message } from "../src/types";

afterEach(() => {
  calls.length = 0;
  rearmComputerUse();
});

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    conversationId: "c1",
    signal: new AbortController().signal,
    settings: defaultSettings(),
    saveBlob: async (_b: Uint8Array, mime: string, name: string) => ({ blobId: `b${screenshots}`, mime, name, size: 4 }),
    ...over,
  }) as unknown as ToolContext;

describe("computer use", () => {
  it("asks for every action by default, and the setting can relax that", () => {
    const s = defaultSettings();
    expect(s.computerUse.approval).toBe("each");
    expect(computerNeedsApproval("click", s)).toBe(true);
    expect(computerNeedsApproval("screenshot", s)).toBe(true);
    expect(computerNeedsApproval("wait", s)).toBe(false);
    s.computerUse.approval = "risky";
    expect(computerNeedsApproval("click", s)).toBe(false);
    expect(computerNeedsApproval("type", s)).toBe(true);
    expect(computerNeedsApproval("key", s)).toBe(true);
    s.computerUse.approval = "auto";
    expect(computerNeedsApproval("type", s)).toBe(false);
    // older settings files get the safe default
    expect(migrateSettings({ providers: [] }).computerUse.approval).toBe("each");
  });

  it("acts, then returns a fresh screenshot; previews show where a click lands", async () => {
    const tool = computerUseTool("windows");
    const c = ctx();
    const first = await tool.run({ action: "screenshot" }, c);
    expect(first.images).toHaveLength(1);
    expect(first.text).toContain("1280x800");
    const preview = await tool.preview!({ action: "click", x: 640, y: 400 }, c);
    expect(preview).toMatchObject({ width: 1280, height: 800, marks: [{ x: 640, y: 400, label: "click" }] });
    const drag = await tool.preview!({ action: "drag", x: 10, y: 20, x2: 300, y2: 400 }, c);
    expect(drag!.marks).toHaveLength(2);
    const r = await tool.run({ action: "click", x: 640, y: 400 }, c);
    expect(calls.find((x) => x.cmd === "input_action")!.args).toMatchObject({ action: "click", x: 640, y: 400 });
    expect(r.text).toMatch(/click at \(640, 400\): done/);
    expect(r.images).toHaveLength(1);
    expect(tool.summarize({ action: "type", text: "hello" })).toBe('Type "hello"');
    const wins = await tool.run({ action: "list_windows" }, c);
    expect(wins.text).toContain("Notepad: Untitled - Notepad");
  });

  it("refuses to click before it has seen the screen", async () => {
    const r = await computerUseTool("macos").run({ action: "click", x: 1, y: 1 }, ctx({ conversationId: "fresh" }));
    expect(r.isError).toBe(true);
  });

  it("stops everything with the kill switch until the next message", async () => {
    killComputerUse();
    expect(isComputerUseKilled()).toBe(true);
    expect(calls.some((x) => x.cmd === "computer_kill" && x.args.on === true)).toBe(true);
    const r = await computerUseTool("windows").run({ action: "type", text: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(calls.some((x) => x.cmd === "input_action")).toBe(false);
    rearmComputerUse();
    expect(calls.some((x) => x.cmd === "computer_kill" && x.args.on === false)).toBe(true);
  });

  it("rate-limits actions", async () => {
    const tool = computerUseTool("windows");
    const c = ctx();
    c.settings.computerUse.actionsPerMinute = 120; // one every 500 ms
    await tool.run({ action: "screenshot" }, c);
    const t0 = Date.now();
    await tool.run({ action: "scroll", dy: 3 }, c);
    await tool.run({ action: "scroll", dy: 3 }, c);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it("keeps only the newest screenshots in the model's view", () => {
    const step = (i: number): Message => ({
      id: `a${i}`,
      role: "assistant",
      createdAt: i,
      updatedAt: i,
      parts: [{ type: "tool_call", id: `t${i}`, name: "computer", input: {}, status: "done", result: { text: `shot ${i}`, images: [{ blobId: `b${i}`, mime: "image/png", name: "s.png", size: 1 }] } }],
    });
    const msgs = [step(1), step(2), step(3), step(4)];
    const out = withRecentScreenshots(msgs, 2);
    const imgs = out.map((m) => (m.parts[0] as any).result.images?.length ?? 0);
    expect(imgs).toEqual([0, 0, 1, 1]);
    expect((out[0].parts[0] as any).result.text).toContain("older screenshot omitted");
    expect(msgs[0]).toBe(msgs[0]); // the stored chat is not changed
    expect((msgs[0].parts[0] as any).result.images).toHaveLength(1);
  });
});

describe("Firefox driver (WebDriver BiDi)", () => {
  it("speaks BiDi: session, navigation, scripts, input, screenshots, login prompts", async () => {
    const sent: any[] = [];
    let onMsg: (t: string) => void = () => undefined;
    const reply = (id: number, result: unknown) => setTimeout(() => onMsg(JSON.stringify({ type: "success", id, result })), 0);
    const socket: Socket = {
      send: (t) => {
        const m = JSON.parse(t);
        sent.push(m);
        switch (m.method) {
          case "browsingContext.getTree":
            return reply(m.id, { contexts: [{ context: "ctx1", url: "about:blank" }] });
          case "script.evaluate":
            return reply(m.id, { type: "success", result: { type: "string", value: JSON.stringify({ title: "Hi" }) } });
          case "browsingContext.captureScreenshot":
            return reply(m.id, { data: "AAAA" });
          case "network.addIntercept":
            return reply(m.id, { intercept: "i1" });
          default:
            return reply(m.id, {});
        }
      },
      onMessage: (cb) => (onMsg = cb),
      onClose: () => undefined,
      close: () => undefined,
    };
    const d = await BidiDriver.over(socket);
    await d.navigate("https://example.org/");
    expect(await d.evaluate<{ title: string }>("x")).toEqual({ title: "Hi" });
    await d.click(10.4, 20.6, { count: 2 });
    await d.press("ctrl+a");
    await d.insertText("hi");
    expect(await d.screenshot()).toEqual({ data: "AAAA", mime: "image/jpeg" });
    await d.setAuth({ username: "u", password: "p" });
    // a login prompt arrives: it is answered with the credentials
    onMsg(JSON.stringify({ type: "event", method: "network.authRequired", params: { isBlocked: true, request: { request: "r9" } } }));
    await new Promise((r) => setTimeout(r, 10));
    const by = (method: string) => sent.filter((m) => m.method === method);
    expect(sent[0]).toMatchObject({ method: "session.new" });
    expect(by("session.subscribe")[0].params.events).toContain("network.authRequired");
    expect(by("browsingContext.navigate")[0].params).toEqual({ context: "ctx1", url: "https://example.org/", wait: "complete" });
    const pointer = by("input.performActions")[0].params.actions[0];
    expect(pointer.actions).toEqual([{ type: "pointerMove", x: 10, y: 21 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    const keys = by("input.performActions")[1].params.actions[0].actions;
    expect(keys).toEqual([{ type: "keyDown", value: "" }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: "" }]);
    expect(by("network.continueWithAuth")[0].params).toEqual({ request: "r9", action: "provideCredentials", credentials: { type: "password", username: "u", password: "p" } });
  });
});
