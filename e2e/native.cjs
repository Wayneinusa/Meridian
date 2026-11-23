// Drives the REAL desktop app (Tauri + WebKitGTK on Linux) through WebDriver,
// against a local mock of the Anthropic API that streams slowly. This covers
// what the browser test cannot: the native HTTP client and its URL scope,
// streaming through it, the shell / file tools, secret storage, the on-disk
// store and folder sync.
//
//   npx tauri build --debug --no-bundle
//   xvfb-run -a node e2e/native.cjs
// Needs: tauri-driver (cargo install tauri-driver), WebKitWebDriver (webkit2gtk-driver).
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP = path.resolve(__dirname, "../src-tauri/target/debug/meridian");
const SHOTS = path.join(__dirname, "screens");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-native-"));
const DATA_HOME = path.join(TMP, "data");
const SYNC_DIR = path.join(TMP, "cloud-folder");
const WORK_FILE = path.join(TMP, "written-by-assistant.txt");
const MOCK_PORT = 8787;
const DRIVER = "http://127.0.0.1:4444";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock Anthropic API with real, slow streaming ----------
const requests = [];
function startMock() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: null }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" }));
      }
      const body = JSON.parse(raw);
      const sysText = Array.isArray(body.system) ? body.system.map((b) => b.text).join(" ") : (body.system ?? "");
      const isTitle = /You name conversations/.test(sysText);
      if (!isTitle) requests.push({ body, headers: req.headers });
      const last = body.messages[body.messages.length - 1];
      const toolResult = Array.isArray(last.content) && last.content.find((b) => b.type === "tool_result");
      const userText = Array.isArray(last.content) ? last.content.filter((b) => b.type === "text").map((b) => b.text).join(" ") : String(last.content);
      let blocks, stop = "end_turn";
      if (isTitle) {
        blocks = [{ type: "text", text: "hello" }];
      } else if (toolResult) {
        const t = toolResult.content.map((c) => c.text ?? "").join("");
        blocks = [{ type: "text", text: `Tool said: ${t.slice(0, 200)}` }];
      } else if (/run a command/.test(userText)) {
        blocks = [{ type: "tool_use", id: "toolu_cmd", name: "run_command", input: { command: "echo meridian-native-ok && uname -s" } }];
        stop = "tool_use";
      } else if (/make files/.test(userText)) {
        // four tool calls in one turn: every document writer, inside the app's content-security policy
        blocks = [
          { type: "tool_use", id: "toolu_x", name: "create_spreadsheet", input: { filename: "t.xlsx", sheets: [{ name: "S", rows: [["a", "b"], [1, "=A2*2"]] }] } },
          { type: "tool_use", id: "toolu_p", name: "create_pdf", input: { filename: "t.pdf", markdown: "# Title\n\nText with **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |" } },
          { type: "tool_use", id: "toolu_d", name: "create_document", input: { filename: "t.docx", markdown: "# Title\n\n- one\n- two" } },
          { type: "tool_use", id: "toolu_s", name: "create_presentation", input: { filename: "t.pptx", slides: [{ title: "Hello" }, { title: "Points", bullets: ["a", "b"] }] } },
        ];
        stop = "tool_use";
      } else if (/write a file/.test(userText)) {
        blocks = [{ type: "tool_use", id: "toolu_write", name: "write_file", input: { path: WORK_FILE, content: "written natively ✓" } }];
        stop = "tool_use";
      } else {
        blocks = [{ type: "text", text: "FIRST-HALF " }, { type: "__pause", ms: 2500 }, { type: "text", text: "SECOND-HALF" }];
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({ type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
      let index = 0;
      let open = false;
      for (const b of blocks) {
        if (b.type === "__pause") {
          await sleep(b.ms);
          continue;
        }
        if (b.type === "text") {
          if (!open) {
            send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
            open = true;
          }
          send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
        } else {
          send({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
          send({ type: "content_block_stop", index });
          index++;
        }
      }
      if (open) send({ type: "content_block_stop", index });
      send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } });
      send({ type: "message_stop" });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

// ---------- minimal W3C WebDriver client ----------
async function wd(method, url, body) {
  const res = await fetch(DRIVER + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
let session;
const js = (fn, ...args) => wd("POST", `/session/${session}/execute/sync`, { script: `return (${fn}).apply(null, arguments)`, args });
async function waitFor(fn, args = [], timeout = 30000, label = "") {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await js(fn, ...args);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label || fn}`);
    await sleep(150);
  }
}
const HELPERS = `
  window.__t = {
    set(el, v) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    blur(el) { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); },
    byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text)); },
    card(text) { return [...document.querySelectorAll(".card")].find((c) => c.querySelector("h4") && c.querySelector("h4").textContent.includes(text)); },
  };`;
const click = (sel, text) => js(function (sel, text) { const el = text ? window.__t.byText(sel, text) : document.querySelector(sel); if (!el) return false; el.click(); return true; }, sel, text ?? null);
async function shot(name) {
  const b64 = await wd("GET", `/session/${session}/screenshot`);
  fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(b64, "base64"));
}
async function openSettings(tab) {
  await js(function () { const b = document.querySelector('button[title="Show chats"]'); if (b) b.click(); });
  await sleep(100);
  await click('button[title="Settings"]');
  await waitFor(function () { return !!document.querySelector(".settings-tabs"); });
  await click(".settings-tabs button", tab);
  await sleep(150);
}
const closeSettings = () => click('.modal [title="Close"]');
async function sendMessage(text) {
  await js(function (t) { window.__t.set(document.querySelector('textarea[aria-label="Message"]'), t); }, text);
  await sleep(80);
  await click('button[title="Send"]');
}
const idle = () => waitFor(function () { return !document.querySelector('button[title="Stop"]') && !document.querySelector('.perm-card'); }, [], 40000, "idle");

async function launch() {
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP } } } })).sessionId;
  await waitFor(function () { return !!document.querySelector(".empty h1, .messages"); }, [], 30000, "app boot");
  await js(`function(){ ${HELPERS} }`);
}
const quit = () => wd("DELETE", `/session/${session}`).catch(() => {});

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const mock = await startMock();
  const driver = spawn("tauri-driver", ["--port", "4444", "--native-driver", "/usr/bin/WebKitWebDriver"], {
    env: { ...process.env, XDG_DATA_HOME: DATA_HOME, XDG_CONFIG_HOME: path.join(TMP, "config"), XDG_CACHE_HOME: path.join(TMP, "cache"), WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
    stdio: "ignore",
  });
  await sleep(1500);
  const appData = path.join(DATA_HOME, "app.meridian.client");

  try {
    console.log("launch");
    await launch();
    const info = await js(function () { return { tauri: "__TAURI_INTERNALS__" in window, title: document.querySelector(".empty h1")?.textContent }; });
    check("app boots inside the native shell", info.tauri === true && info.title === "What are we working on?", JSON.stringify(info));
    await waitFor(function () { return true; });
    await sleep(600);
    check("on-disk store created by native file commands", fs.existsSync(path.join(appData, "store", "index.json")), appData);

    console.log("provider over the native HTTP client");
    await openSettings("Providers & keys");
    await js(function (url) {
      const card = window.__t.card("Anthropic");
      const endpoint = card.querySelector('input[type="url"]');
      window.__t.set(endpoint, url);
      window.__t.blur(endpoint);
    }, `http://127.0.0.1:${MOCK_PORT}`);
    await sleep(300);
    await js(function () { const card = window.__t.card("Anthropic"); window.__t.set(card.querySelector('input[type="password"]'), "sk-native-test"); });
    await sleep(100);
    await js(function () { [...window.__t.card("Anthropic").querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click(); });
    const toast = await waitFor(function () { const t = document.querySelector(".toast"); return t ? t.textContent : null; }, [], 15000, "model fetch toast");
    check("model list fetched from a localhost endpoint (URL scope allows http://host:port)", /1 models available/.test(toast), toast);
    const secrets = JSON.parse(fs.readFileSync(path.join(appData, "secrets.json"), "utf8"));
    check("key stored through the native secret command", secrets["provider.anthropic"] === "sk-native-test");
    check("key file is private (0600)", (fs.statSync(path.join(appData, "secrets.json")).mode & 0o777) === 0o600);
    check("key absent from settings.json", !fs.readFileSync(path.join(appData, "store", "settings.json"), "utf8").includes("sk-native-test"));

    console.log("computer access switch");
    await click(".settings-tabs button", "Tools & computer");
    await sleep(150);
    const hasComputer = await js(function () { const l = window.__t.byText("label.switch", "Let the assistant use this computer"); if (!l) return false; l.querySelector("input").click(); return true; });
    check("desktop build offers computer access", hasComputer === true);
    await shot("20-native-settings-tools");
    await closeSettings();

    console.log("streaming through the native HTTP client");
    await sendMessage("hello");
    const partial = await waitFor(function () { const m = document.querySelector(".msg.assistant"); return m && m.textContent.includes("FIRST-HALF") ? m.textContent : null; }, [], 15000, "first half");
    check("first half visible before the stream finished (real streaming)", partial.includes("FIRST-HALF") && !partial.includes("SECOND-HALF"), partial);
    await idle();
    check("full reply after the stream finished", await js(function () { return document.querySelector(".msg.assistant").textContent.includes("FIRST-HALF SECOND-HALF"); }));
    check("request carried the key and computer tools", requests[0].headers.authorization === "Bearer sk-native-test" && requests[0].body.tools.some((t) => t.name === "run_command") && requests[0].body.tools.some((t) => t.name === "install_app"), JSON.stringify({ h: requests[0].headers, tools: requests[0].body.tools.map((t) => t.name) }));
    check("system prompt describes this machine", /System: linux; shell for run_command: sh/.test(requests[0].body.system) && requests[0].body.system.includes(os.homedir()), requests[0].body.system.slice(0, 300));
    check("custom endpoint: no beta fallback or hosted web tools sent", !requests[0].body.fallbacks && !requests[0].body.tools.some((t) => t.type));

    console.log("shell command with approval");
    await sendMessage("please run a command");
    await waitFor(function () { return !!document.querySelector('.perm-card'); }, [], 15000, "permission dialog");
    const prompt = await js(function () { return document.querySelector('.perm-card .perm-cmd').textContent; });
    check("approval shows the exact command", prompt.includes("echo meridian-native-ok && uname -s"), prompt);
    await shot("21-native-permission");
    await click('.perm-card button', "Allow once");
    await idle();
    const cmdResult = requests[requests.length - 1].body.messages.at(-1).content[0];
    const cmdText = cmdResult.content.map((c) => c.text).join("");
    check("command ran natively and its output went back to the model", !cmdResult.is_error && cmdText.includes("meridian-native-ok") && cmdText.includes("Linux") && cmdText.includes("[exit code 0]"), cmdText);

    console.log("file write with approval");
    await sendMessage("now write a file");
    await waitFor(function () { return !!document.querySelector('.perm-card'); }, [], 15000, "permission dialog 2");
    check("nothing written before approval", !fs.existsSync(WORK_FILE));
    await click('.perm-card button', "Allow once");
    await idle();
    check("file written on disk with the right content", fs.existsSync(WORK_FILE) && fs.readFileSync(WORK_FILE, "utf8") === "written natively ✓");
    await waitFor(function () { return document.querySelectorAll(".toast").length === 0; }, [], 10000, "notifications to clear");
    check("notifications clear themselves", true);
    await shot("22-native-chat");

    console.log("document writers inside the app (xlsx, pdf, docx, pptx)");
    await sendMessage("make files please");
    await waitFor(function () { return document.querySelectorAll(".file-card").length >= 4 || !!document.querySelector(".error-line"); }, [], 90000, "four files");
    await idle();
    const results = requests[requests.length - 1].body.messages.at(-1).content;
    check("four results returned together, none failed", results.length === 4 && results.every((r) => r.type === "tool_result" && !r.is_error), JSON.stringify(results.map((r) => r.content[0].text.slice(0, 90))));
    const cards = await js(function () { return [...document.querySelectorAll(".file-card .file-name")].map(function (e) { return e.textContent; }); });
    check("four file cards shown", ["t.xlsx", "t.pdf", "t.docx", "t.pptx"].every((n) => cards.includes(n)), JSON.stringify(cards));
    await sleep(500);
    const blobDir = path.join(appData, "store", "blobs");
    const heads = fs.readdirSync(blobDir).map((f) => fs.readFileSync(path.join(blobDir, f)).subarray(0, 4).toString("latin1"));
    check("files on disk are real zip/PDF containers", heads.filter((h) => h.startsWith("PK")).length === 3 && heads.filter((h) => h === "%PDF").length === 1, JSON.stringify(heads));
    await shot("22b-native-files");

    console.log("conversation persisted as a file");
    await sleep(1800);
    const convDir = path.join(appData, "store", "conversations");
    const convFiles = fs.readdirSync(convDir);
    const conv = JSON.parse(fs.readFileSync(path.join(convDir, convFiles[0]), "utf8"));
    check("one JSON file per conversation with all messages", convFiles.length === 1 && conv.messages.length >= 10 && conv.title === "hello", `${convFiles.length} files, ${conv.messages.length} msgs`);
    await quit();

    console.log("folder sync (second launch)");
    const settingsPath = path.join(appData, "store", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.sync = { icloud: true, auto: true, folder: SYNC_DIR };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    // a chat that "another device" already put into the shared folder
    fs.mkdirSync(path.join(SYNC_DIR, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(SYNC_DIR, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(SYNC_DIR, "blobs", "bphoneblob1"), Buffer.from("PHONE-FILE"));
    const foreign = { id: "cfromphone", title: "Written on the phone", createdAt: Date.now() - 5000, updatedAt: Date.now() - 4000, removed: {}, messages: [{ id: "m1", role: "user", createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000, parts: [{ type: "attachment", blobId: "bphoneblob1", name: "note.txt", mime: "text/plain", size: 10 }, { type: "text", text: "hi from iPhone" }] }] };
    fs.writeFileSync(path.join(SYNC_DIR, "conversations", "cfromphone.json"), JSON.stringify(foreign));
    // and a diverged copy of the PC's own chat, as if the phone had added a message to it
    const diverged = { ...conv, updatedAt: conv.updatedAt + 1, messages: [...conv.messages, { id: "mphone", role: "user", createdAt: Date.now() + 60000, updatedAt: Date.now() + 60000, parts: [{ type: "text", text: "added on the phone" }] }] };
    diverged.messages = diverged.messages.slice(0, 2).concat(diverged.messages.slice(-1)); // the phone copy is also missing later PC messages
    fs.writeFileSync(path.join(SYNC_DIR, "conversations", conv.id + ".json"), JSON.stringify(diverged));

    await launch();
    await waitFor(function () { return document.querySelectorAll(".conv").length === 2 && /Synced/.test(document.querySelector(".sync-pill").textContent); }, [], 20000, "sync to finish");
    check("chat from the other device appears", await js(function () { return !!window.__t.byText(".conv", "Written on the phone"); }));
    check("its attachment was pulled down", fs.existsSync(path.join(appData, "store", "blobs", "bphoneblob1")));
    const mergedLocal = JSON.parse(fs.readFileSync(path.join(convDir, conv.id + ".json"), "utf8"));
    const mergedRemote = JSON.parse(fs.readFileSync(path.join(SYNC_DIR, "conversations", conv.id + ".json"), "utf8"));
    check("diverged chat merged, not replaced (all PC messages + the phone's)", mergedLocal.messages.length === conv.messages.length + 1 && mergedLocal.messages.some((m) => m.id === "mphone"), `${mergedLocal.messages.length} vs ${conv.messages.length}+1`);
    check("merged result written back to the shared folder", mergedRemote.messages.length === mergedLocal.messages.length);
    await shot("23-native-synced");
    await quit();
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e.message);
    try {
      await shot("native-failure");
      console.error(await js(function () { return document.body.innerText.slice(0, 600); }));
    } catch {}
    await quit();
  } finally {
    driver.kill();
    mock.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall native checks passed");
  process.exit(failures ? 1 : 0);
}
main();
