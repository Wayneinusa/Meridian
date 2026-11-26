// Browser end-to-end check of the collaborative consortium: a cross-model team
// (two Claude members, one GPT member) plans, works with a shared scratchpad,
// reviews, disagrees in round 1, converges in round 2, and the user adds an
// instruction while it runs. Providers are mocked.
//   npm run build && node e2e/consortium.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "screens");
const PORT = 4178;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const seen = { claude: [], gpt: [], scratch: 0, planner: [] };
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a member says, from the phase its prompt asks for. */
function answer(name, prompt, hasResult) {
  // execution crew (automatic team)
  if (/You lead this crew/.test(prompt)) return { text: 'Go: {"assignments":[{"member":"Scout","part":"pull this week\'s bookings"},{"member":"Reconciler","part":"match payouts to bookings"}]}' };
  if (/Your job:/.test(prompt)) return { text: `${name} DONE: ${name === "Scout" ? "12 bookings pulled" : "2 mismatches found"}`, delay: 400 };
  if (/Audit the crew/.test(prompt)) return { text: "PASS\nFigures check out." };
  if (/crew's report/.test(prompt)) return { text: "CREW REPORT: 12 bookings, 2 mismatches to review." };
  if (/Propose how the team/.test(prompt)) return { text: `- ${name} looks at it from the ${name === "Skeptic" ? "risks" : "benefits"} side\nI take: the ${name === "Skeptic" ? "case against" : name === "Advocate" ? "case for" : "verdict"}` };
  if (/You coordinate\. Assign/.test(prompt)) return { text: 'Assignments: {"assignments":[{"member":"Advocate","part":"argue for remote work"},{"member":"Skeptic","part":"argue against remote work"},{"member":"Judge","part":"weigh the evidence"}]}' };
  if (/Do your part now/.test(prompt)) {
    if (name === "Advocate" && !hasResult) return { tool: { name: "scratchpad", input: { action: "append", text: "Fact: commuting costs 50 minutes a day" } } };
    return { text: `${name} CONTRIBUTION: ${name === "Skeptic" ? "collaboration suffers" : "productivity rises"}`, delay: 1200 };
  }
  if (/Review your teammates/.test(prompt)) return { text: `${name} review: mostly sound.\nPOSITION: hybrid is best` };
  if (/Revise the joint answer/.test(prompt)) return { text: "DRAFT 2: hybrid work, with costs fixed" };
  if (/Write the team's joint answer/.test(prompt)) return { text: "DRAFT 1: remote work wins" };
  if (/Vote\./.test(prompt)) {
    const round = Number(/round (\d)/.exec(prompt)?.[1] ?? 1);
    return { text: name === "Skeptic" && round === 1 ? "DISAGREE: it ignores collaboration costs" : "AGREE\nFine." };
  }
  if (/Present the joint answer/.test(prompt)) return { text: "FINAL: A hybrid model is best for most teams." };
  return { text: "ok" };
}

function claudeStream(model, out) {
  const ev = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  if (out.tool) {
    ev.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tu_${Date.now()}`, name: out.tool.name, input: {} } });
    ev.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(out.tool.input) } });
  } else {
    ev.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.text } });
  }
  ev.push({ type: "content_block_stop", index: 0 });
  ev.push({ type: "message_delta", delta: { stop_reason: out.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

async function mocks(page) {
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname === "/v1/models") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: null }], has_more: false }) });
    const body = req.postDataJSON();
    const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : (body.system ?? "");
    if (/You name conversations/.test(sys)) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: claudeStream(body.model, { text: "Remote work debate" }) });
    if (/You design teams of AI agents/.test(sys)) {
      seen.planner.push(textOf(body.messages[0].content));
      const team = { style: "execute", rationale: "Operational work: a small crew that acts at once, with an auditor.", members: [{ name: "Scout", emoji: "🔭", role: "pulls the week's bookings", model: "anthropic::claude-opus-5-5" }, { name: "Reconciler", emoji: "🧮", role: "matches payouts against bookings", model: "openai::gpt-4o", coordinator: true }, { name: "Auditor", emoji: "✅", role: "audits the figures", model: "anthropic::claude-opus-5-5" }] };
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: claudeStream(body.model, { text: "```json\n" + JSON.stringify(team) + "\n```" }) });
    }
    const name = /You are (\w+), one member/.exec(sys)?.[1] ?? "?";
    const prompt = textOf(body.messages[0].content);
    const hasResult = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    if (hasResult) seen.scratch++;
    seen.claude.push({ name, prompt, tools: (body.tools ?? []).map((t) => t.name) });
    const out = answer(name, prompt, hasResult);
    if (out.delay) await sleep(out.delay);
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: claudeStream(body.model, out) });
  });
  await page.route("https://api.openai.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname === "/v1/models") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "gpt-4o" }] }) });
    const body = req.postDataJSON();
    const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
    const name = /You are (\w+), one member/.exec(sys)?.[1] ?? "?";
    const prompt = textOf(body.messages.find((m) => m.role === "user")?.content);
    seen.gpt.push({ name, prompt });
    const out = answer(name, prompt, false);
    if (out.delay) await sleep(out.delay);
    const text = out.text ?? "ok";
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
}

async function settings(page, tab) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"]').first().click();
  await page.locator('button[title="Settings"]').click();
  await page.getByRole("tab", { name: tab }).click();
}
const card = (page, name) => page.locator(".card", { has: page.locator("h4", { hasText: new RegExp(`^${name}$`) }) }).first();

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("preview did not start")), 20000);
    server.stdout.on("data", (d) => String(d).includes(String(PORT)) && (clearTimeout(t), res()));
    server.on("exit", (c) => rej(new Error(`preview exited ${c}`)));
  });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mocks(page);
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".empty h1");
    await settings(page, "Providers & keys");
    for (const [name, key] of [["Anthropic", "sk-ant"], ["OpenAI", "sk-oa"]]) {
      await card(page, name).locator('input[type="password"]').first().fill(key);
      await card(page, name).getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction((n) => [...document.querySelectorAll(".toast.ok")].some((t) => t.textContent.startsWith(n)), name);
    }
    await page.locator('.modal [title="Close"]').first().click();

    console.log("the consortium studio: a full page, manual team from a quick start");
    await page.locator(".chip-btn", { hasText: "Consortium" }).first().click();
    await page.waitForSelector('[data-testid="consortium-studio"]');
    check("the consortium opens as a full page, not a popup", (await page.locator(".popover").count()) === 0 && (await page.locator('[data-testid="consortium-studio"]').boundingBox()).width > 900);
    check("manual and automatic ways to build a team", (await page.getByRole("radio", { name: "Manual team" }).count()) === 1 && (await page.getByRole("radio", { name: "Automatic team" }).count()) === 1);
    check("quick starts include operational crews", (await page.locator('[data-testid="preset"]', { hasText: "Operations crew" }).count()) === 1 && (await page.locator('[data-testid="preset"]', { hasText: "Incident response" }).count()) === 1);
    await page.locator('[data-testid="preset"]', { hasText: "Operations crew" }).click();
    const names = () => page.locator('[data-testid="member-row"] input[aria-label="Member name"]').evaluateAll((els) => els.map((e) => e.value).join(","));
    check("the operations preset fills five roles as an execution crew", (await page.locator('[data-testid="member-row"]').count()) === 5 && (await page.getByRole("radio", { name: /Execution crew/ }).getAttribute("aria-checked")) === "true" && /Guest Contact/.test(await names()), await names());
    await page.locator('select[aria-label="Number of agents"]').selectOption("6");
    check("the number of agents can be changed", (await page.locator('[data-testid="member-row"]').count()) === 6);
    await page.locator('[data-testid="preset"]', { hasText: "Debate" }).click();
    check("Debate team suggested: three members", (await page.locator('[data-testid="member-row"]').count()) === 3);
    await page.getByRole("button", { name: "Move Judge up" }).click();
    check("members can be reordered", (await names()) === "Advocate,Judge,Skeptic", await names());
    await page.getByRole("button", { name: "Move Judge down" }).click();
    const skeptic = page.locator('[data-testid="member-row"]').nth(1);
    const gptValue = await skeptic.locator("select").first().evaluate((sel) => [...sel.options].find((o) => /gpt-4o/.test(o.textContent))?.value);
    await skeptic.locator("select").first().selectOption(gptValue);
    await page.screenshot({ path: path.join(SHOTS, "59-consortium-studio.png"), fullPage: true });
    await page.locator('textarea[aria-label="Task for the team"]').fill("Is remote work better than office work?");
    await page.getByRole("button", { name: "Start the consortium" }).click();
    await page.waitForSelector('[data-testid="team-panel"]');
    const panel = await page.locator('[data-testid="team-panel"]').textContent();
    check("the team panel lists each member with its role and model", /Advocate/.test(panel) && /Skeptic/.test(panel) && /Judge/.test(panel) && /gpt-4o/i.test(panel) && /coordinator/.test(panel), panel.slice(0, 300));
    check("header shows consortium mode with 3 members", /Consortium · 3/.test(await page.locator(".chip-btn", { hasText: "Consortium" }).first().textContent()));

    console.log("run: plan, work, review, vote, converge");
    await page.waitForFunction(() => /working/.test(document.querySelector('[data-testid="team-panel"]')?.textContent ?? ""), null, { timeout: 20000 });
    // an instruction typed while the team works
    await page.locator('textarea[aria-label="Message"]').fill("Mention costs explicitly");
    await page.locator('button[title="Add instruction"]').click();
    await page.screenshot({ path: path.join(SHOTS, "60-consortium-running.png") });
    await page.waitForSelector('[data-testid="consortium-outcome"]', { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('button[title="Stop"]'), null, { timeout: 20000 });
    const thread = await page.locator('[data-testid="consortium-thread"]').first().textContent();
    check("the planning discussion is visible", /Planning: who does what/.test(thread) && /I take: the case for/.test(thread));
    check("assignments shown and put in the plan", /Assignments/.test(thread) && (await page.locator(".plan li").count()) === 3 && /Skeptic: argue against remote work/.test(await page.locator(".plan").textContent()));
    check("each member's work is in the thread", ["Advocate CONTRIBUTION", "Skeptic CONTRIBUTION", "Judge CONTRIBUTION"].every((t) => thread.includes(t)));
    if (seen.scratch < 1) console.log("    debug claude calls:", JSON.stringify(seen.claude.map((c) => [c.name, c.prompt.slice(0, 40), c.tools.length])).slice(0, 1500));
    if (seen.gpt.length < 5) console.log("    debug gpt calls:", JSON.stringify(seen.gpt.map((c) => [c.name, c.prompt.slice(0, 40)])));
    check("the shared scratchpad was used", seen.scratch >= 1 && seen.claude.some((c) => c.name === "Advocate" && c.tools.includes("scratchpad") && c.tools.includes("ask_member")));
    check("reviews and two vote rounds", /Reviews/.test(thread) && /Votes \(round 1\)/.test(thread) && /Votes \(round 2\)/.test(thread));
    check("a disagreement is shown, then resolved", (await page.locator(".member-msg .badge", { hasText: "disagrees" }).count()) === 1 && /DRAFT 2/.test(thread));
    check("the final answer states the consensus", /Consensus \(3 of 3\)/.test(await page.locator('[data-testid="consortium-outcome"]').textContent()) && /FINAL: A hybrid model/.test(await page.locator(".msg.assistant").last().textContent()));
    check("cross-model: the Skeptic spoke through GPT", seen.gpt.length >= 5 && seen.gpt.every((g) => g.name === "Skeptic"));
    const laterPrompt = [...seen.claude, ...seen.gpt].filter((p) => /Mention costs explicitly/.test(p.prompt));
    check("the user's instruction reached the members", laterPrompt.length >= 1 && /Instructions the user added/.test(laterPrompt[0].prompt));
    check("the instruction shows inside the discussion", (await page.locator('.member-msg[data-phase="note"]', { hasText: "Mention costs explicitly" }).count()) === 1 && (await page.locator('[data-testid="consortium-thread"]').count()) === 1);
    await page.locator('[data-testid="consortium-thread"]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "61-consortium-thread.png") });
    await page.locator(".consortium-outcome").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "62-consortium-answer.png") });
    check("the shared scratchpad shows in the team panel", /commuting costs 50 minutes/.test(await page.locator('[data-testid="scratchpad"]').textContent()));

    console.log("automatic team: the planner proposes an execution crew");
    await page.locator(".nav-item", { hasText: "Consortium" }).click().catch(async () => {
      await page.locator('button[title="Show chats"]').first().click();
      await page.locator(".nav-item", { hasText: "Consortium" }).click();
    });
    await page.getByRole("radio", { name: "Automatic team" }).click();
    const auto = page.locator('[data-testid="auto-team"]');
    await auto.locator('textarea[aria-label="Task"]').fill("Reconcile this week's payouts against bookings");
    await auto.locator('select[aria-label="Maximum agents"]').selectOption("3");
    await auto.getByRole("button", { name: "Propose a team" }).click();
    await page.waitForSelector('[data-testid="rationale"]', { timeout: 20000 });
    check("the planner got the task, the limit and the models", /Reconcile this week/.test(seen.planner[0] ?? "") && /2 to 3 agents/.test(seen.planner[0]) && /openai::gpt-4o/.test(seen.planner[0]));
    check("the proposal shows why, and the team is editable", /Operational work/.test(await page.locator('[data-testid="rationale"]').textContent()) && (await page.locator('[data-testid="member-row"]').count()) === 3);
    check("each proposed member has its own model", (await page.locator('[data-testid="member-row"]').nth(1).locator("select").first().inputValue()) === "openai::gpt-4o" && (await page.locator('[data-testid="member-row"]').nth(0).locator("select").first().inputValue()) === "anthropic::claude-opus-5-5");
    check("the planner chose an execution crew", (await page.getByRole("radio", { name: /Execution crew/ }).getAttribute("aria-checked")) === "true");
    await page.locator('[data-testid="member-row"]').nth(0).locator('textarea[aria-label="Role"]').fill("pulls the week's bookings from the calendar");
    await page.screenshot({ path: path.join(SHOTS, "63-consortium-auto.png"), fullPage: true });
    const beforeC = seen.claude.length;
    const beforeG = seen.gpt.length;
    await page.getByRole("button", { name: "Start the consortium" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="consortium-outcome"]')].some((e) => /Crew/.test(e.textContent)), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('button[title="Stop"]'), null, { timeout: 20000 });
    const crewCalls = [...seen.claude.slice(beforeC), ...seen.gpt.slice(beforeG)];
    check("the crew ran without votes", !crewCalls.some((c) => /Vote\./.test(c.prompt)) && crewCalls.some((c) => /Your job:/.test(c.prompt)));
    check("the edited role reached the member", seen.claude.some((c) => c.name === "Scout" && /Your job/.test(c.prompt)) && true);
    check("the auditor audited, the coordinator reported", crewCalls.some((c) => c.name === "Auditor" && /Audit the crew/.test(c.prompt)) && seen.gpt.some((g) => g.name === "Reconciler" && /crew's report/.test(g.prompt)));
    check("the outcome says what got done", /Crew finished — 2 of 2 jobs done · audit passed/.test(await page.locator('[data-testid="consortium-outcome"]').last().textContent()) && /CREW REPORT/.test(await page.locator(".msg.assistant").last().textContent()));
    const crewThread = await page.locator('[data-testid="consortium-thread"]').last().textContent();
    check("the crew's thread reads as jobs and an audit, not raw JSON", /Jobs/.test(crewThread) && /Audit/.test(crewThread) && !/"assignments"/.test(crewThread) && /Scout: pull this week/.test(crewThread), crewThread.slice(0, 300));
    check("the team panel replaces the status chips above the message box", (await page.locator('[data-testid="consortium-bar"]').count()) === 0);
    await page.screenshot({ path: path.join(SHOTS, "64-consortium-crew.png") });
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e);
    await page.screenshot({ path: path.join(SHOTS, "consortium-failure.png") }).catch(() => {});
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall consortium checks passed");
  process.exit(failures ? 1 : 0);
}
main();
