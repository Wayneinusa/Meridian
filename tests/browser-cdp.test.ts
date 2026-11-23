// Drives the real Chromium on this machine through the same code the app uses.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CdpDriver, parseKeys } from "../src/browser/drivers";
import { extractCall, focusCall, locateCall, selectCall, snapshotCall, type Snapshot } from "../src/browser/page";

const CHROME = ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", process.env.CHROME_BIN ?? ""].find((p) => p && existsSync(p));

const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Welcome to the shop</h1>
<p>Fresh apples and pears, every day.</p>
<a href="/second">Next page</a>
<form action="/done" method="get">
  <label for="email">Email</label><input id="email" name="email" type="email" placeholder="you@example.com">
  <label>Password <input name="pw" type="password"></label>
  <input name="card-number" autocomplete="cc-number" placeholder="Card">
  <select name="fruit"><option value="a">Apple</option><option value="p">Pear</option></select>
  <button type="submit">Buy now</button>
</form>
<button id="plain" type="button" onclick="document.title='clicked'">Plain button</button>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Apple</td><td>1.00</td></tr></table>
<div style="display:none"><button>Hidden</button></div>
</body></html>`;

let server: Server;
let base = "";
let chrome: ChildProcess;
let driver: CdpDriver;

beforeAll(async () => {
  if (!CHROME) return;
  server = createServer((req, res) => {
    if (req.url?.startsWith("/secret")) {
      const ok = req.headers.authorization === `Basic ${Buffer.from("ann:pw1").toString("base64")}`;
      res.writeHead(ok ? 200 : 401, ok ? { "content-type": "text/html" } : { "www-authenticate": 'Basic realm="x"' });
      return res.end(ok ? "<title>Secret</title><p>inside</p>" : "no");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url?.startsWith("/second") ? "<title>Second</title><p>Second page</p>" : req.url?.startsWith("/done") ? `<title>Done</title><p>${req.url}</p>` : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = mkdtempSync(join(tmpdir(), "mer-cdp-"));
  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-sandbox", "about:blank"]);
  const ws = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("chrome did not start")), 20_000);
    chrome.stderr!.on("data", (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
  });
  driver = await CdpDriver.connect(ws);
}, 40_000);

afterAll(() => {
  driver?.close();
  chrome?.kill();
  server?.close();
});

describe.skipIf(!CHROME)("browser agent on real Chromium (CDP)", () => {
  it("numbers what can be clicked and filled, and marks sensitive fields", async () => {
    await driver.navigate(`${base}/`);
    const s = await driver.evaluate<Snapshot>(snapshotCall(8000));
    expect(s.title).toBe("Shop");
    expect(s.text).toContain("# Welcome to the shop");
    expect(s.text).toContain("Fresh apples and pears");
    expect(s.text).toMatch(/\[1\] link "Next page" -> http:\/\/127\.0\.0\.1:\d+\/second/);
    expect(s.text).toContain('input "Email" type=email placeholder="you@example.com"');
    expect(s.text).not.toContain("Hidden");
    const byName = (n: string) => Object.values(s.refs).find((r) => r.name.includes(n))!;
    expect(byName("Password")).toMatchObject({ password: true, inForm: true });
    expect(byName("Card")).toMatchObject({ payment: true });
    expect(byName("Buy now")).toMatchObject({ submit: true });
    expect(byName("Plain button").submit).toBeUndefined();
  }, 30_000);

  it("clicks, types, selects, presses keys and extracts tables", async () => {
    const s = await driver.evaluate<Snapshot>(snapshotCall(8000));
    const ref = (n: string) => Number(Object.entries(s.refs).find(([, r]) => r.name.includes(n))![0]);
    const plain = await driver.evaluate<{ x: number; y: number }>(locateCall(ref("Plain button")));
    await driver.click(plain.x, plain.y);
    expect(await driver.evaluate<string>(`JSON.stringify(document.title)`)).toBe("clicked");
    await driver.evaluate(focusCall(ref("Email")));
    await driver.insertText("ann@example.com");
    expect(await driver.evaluate<string>(`JSON.stringify(document.querySelector('#email').value)`)).toBe("ann@example.com");
    expect(await driver.evaluate<string>(selectCall(ref("Apple"), "pear"))).toBe("selected Pear");
    const x = await driver.evaluate<{ tables: string[][][] }>(extractCall(5000));
    expect(x.tables[0]).toEqual([["Item", "Price"], ["Apple", "1.00"]]);
    // Enter in the email field submits the form
    await driver.evaluate(focusCall(ref("Email")));
    await driver.press("Enter");
    await new Promise((r) => setTimeout(r, 800));
    expect(await driver.evaluate<string>(`JSON.stringify(location.pathname)`)).toBe("/done");
    await driver.back();
    expect(await driver.evaluate<string>(`JSON.stringify(document.title)`)).not.toBe("Done");
  }, 30_000);

  it("takes screenshots, opens tabs and answers basic authentication", async () => {
    const shot = await driver.screenshot();
    expect(shot.mime).toBe("image/jpeg");
    expect(Buffer.from(shot.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await driver.newTab(`${base}/second`);
    const tabs = await driver.tabs();
    expect(tabs.filter((t) => t.active)[0].url).toContain("/second");
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    await driver.setAuth({ username: "ann", password: "pw1" });
    await driver.navigate(`${base}/secret`);
    expect(await driver.evaluate<string>(`JSON.stringify(document.title)`)).toBe("Secret");
  }, 30_000);

  it("parses key combinations", () => {
    expect(parseKeys("ctrl+shift+a").mods.map((m) => m.bit)).toEqual([2, 8]);
    expect(parseKeys("Enter").key.key).toBe("Enter");
    expect(() => parseKeys("hyper+x")).toThrow(/modifier/);
  });
});

// ---- the browser tool, end to end on the same Chromium
import { closeSession, setBrowserFactory } from "../src/browser/session";
import { browserNeedsApproval, browserTool } from "../src/tools/browser";
import type { ToolContext } from "../src/tools/types";
import { defaultSettings } from "../src/state/defaults";

describe.skipIf(!CHROME)("the browser tool", () => {
  const ctx = (userText: string): ToolContext =>
    ({
      conversationId: "c-browser",
      signal: new AbortController().signal,
      settings: defaultSettings(),
      saveBlob: async (_b: Uint8Array, mime: string, name: string) => ({ blobId: "blob1", mime, name, size: 1 }),
      userText: () => userText,
      trustedUrls: () => new Set<string>(),
      progress: () => undefined,
      ask: async () => null,
    }) as unknown as ToolContext;

  it("opens, reads, fills and submits, asking only where it should", async () => {
    setBrowserFactory(async () => ({ driver, pid: 0 }));
    const c = ctx(`please check ${base}/ for me`);
    // the site the user named opens without asking; another one asks
    expect(browserNeedsApproval({ action: "open", url: `${base}/` }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "open", url: "https://evil.example/steal" }, c)).toBe(true);
    const opened = await browserTool.run({ action: "open", url: `${base}/` }, c);
    expect(opened.text).toMatch(/^Opened\.\nPage: Shop — http/);
    expect(opened.text).toContain("(submits form)");
    const num = (name: string) => Number(new RegExp(`\\[(\\d+)\\] [a-z]+ "${name}`).exec(opened.text)![1]);
    // reading and plain clicks don't ask; passwords, card numbers and submits do
    expect(browserNeedsApproval({ action: "snapshot" }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "click", ref: num("Plain button") }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "click", ref: num("Buy now") }, c)).toBe(true);
    expect(browserNeedsApproval({ action: "type", ref: num("Email"), text: "a" }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "type", ref: num("Password"), text: "x" }, c)).toBe(true);
    expect(browserNeedsApproval({ action: "type", ref: num("Card"), text: "4111" }, c)).toBe(true);
    expect(browserNeedsApproval({ action: "fill_form", fields: [{ ref: num("Email"), value: "a" }], submit: true }, c)).toBe(true);
    expect(browserTool.summarize({ action: "type", ref: num("Password"), text: "secret" })).toBe('Type •••••• into input "Password"');
    const filled = await browserTool.run({ action: "fill_form", fields: [{ ref: num("Email"), value: "bo@example.com" }, { ref: num("Apple"), value: "Pear" }] }, c);
    expect(filled.text).toMatch(/filled; selected Pear/);
    expect(filled.text).toContain('value="bo@example.com"');
    // Enter in a form field counts as submitting
    expect(browserNeedsApproval({ action: "press", keys: "Enter" }, c)).toBe(true);
    const sent = await browserTool.run({ action: "press", keys: "Enter" }, c);
    expect(sent.text).toMatch(/Page: Done — http:\/\/127\.0\.0\.1:\d+\/done\?email=bo%40example\.com/);
    const shot = await browserTool.run({ action: "screenshot" }, c);
    expect(shot.images?.[0].mime).toBe("image/jpeg");
    const tabs = await browserTool.run({ action: "tabs" }, c);
    expect(tabs.text).toMatch(/\(current\) Done/);
    await closeSession("c-browser");
    setBrowserFactory(null);
  }, 60_000);

  it("'ask for every action' asks for everything except reading", () => {
    const c = ctx("");
    c.settings.browser.approval = "each";
    expect(browserNeedsApproval({ action: "snapshot" }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "extract" }, c)).toBe(false);
    expect(browserNeedsApproval({ action: "scroll", direction: "down" }, c)).toBe(true);
    expect(browserNeedsApproval({ action: "click", ref: 1 }, c)).toBe(true);
  });
});
