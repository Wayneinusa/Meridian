# Meridian — handoff for the next session

**Read this file first.** It is the single source of truth for continuing this project in a new chat. Claude Code loads it automatically.

**Keep it current.** Whenever a piece of work is finished (with each commit that changes behaviour), update:

- *Status*: what is built
- *Next up*: what remains
- *Open questions*: decisions waiting on the owner
- `docs/PROJECT-LOG.md`: one entry per request and release

Commit these files together with the work. Do not let them go stale.

## The project

Meridian is a multi-provider AI client: one app (Tauri 2 with React and TypeScript) for **Windows** and **iPhone/iPad**. It also runs on macOS and Linux, and as a browser build for development and tests.

The owner's goal is feature parity with, or better than, **Claude Cowork**, **TypingMind** and the **Grok** app, while staying local-first. That means:

- the user's own API keys, stored in the OS keychain;
- chats stored on the device and synced through iCloud, a sync folder, Google Drive or OneDrive;
- backups that merge on import and never replace existing chats.

- **Repository:** https://github.com/Wayneinusa/Meridian (branch `main`); push remote `https://github.com/Wayneinusa/Meridian.git`.
- **Releases** (the owner downloads from here): https://github.com/Wayneinusa/Meridian/releases/latest. It carries `Meridian_<version>_x64-setup.exe` (Windows) and `Meridian-unsigned.ipa` (iPhone/iPad).
- **Version:** each CI build is `0.2.<run number>`. The latest released version is **0.2.15** (check the release page; CI numbers it).

## How the owner likes to work

- They want **download links** for Windows and iPhone/iPad after each round of work. Give both links from the latest release once CI finishes, and keep them updated.
- They write requests as long feature lists. Build in the order they give. For very large items, the owner previously asked for an architecture plan first and confirmation before coding; that plan is `docs/agent-roadmap.md`, and it is now confirmed.
- Explain decisions in plain language. Be honest about what was verified versus only tested against mocks. Nothing has been run against real provider APIs from the build machine, because the network blocks them.
- Commit and push when work is done; a hook asks for it. **No pull requests** unless asked.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01PmSWcMRX4P7NLux9Cjhz5y
  ```
  A new session gets its own session URL from its system prompt; use that one. Never put model names or IDs in code, commits or docs.
- The owner's email and personal details must never go into requests to outside services.

## Decisions the owner made (do not re-ask)

| Topic | Decision |
|---|---|
| Browser agent | **Bundled Chromium**: Chrome for Testing, downloaded once into the app folder, pinned version. Shipping it inside the installer was rejected because of the size. A **Firefox** option uses the installed Firefox with its own profile, over WebDriver BiDi. |
| Computer use | **Ask before every action by default**; the owner can change it to risky-only or nothing, and "Allow for this task" is available. |
| Remote worker | **Both** a self-hosted worker (Docker, run by the owner) **and** a hosted option. |
| X tools | **Both**: the official X API with the owner's own developer app (search, threads, post with approval, trends), and Grok's native `x_search` (already built). |
| Images / video | Free backends first-class. The defaults: Pollinations, then Cloudflare, then AI Horde, then keyed providers. |
| Sign in with X | Uses the public OAuth client of xAI's Grok CLI (`auth.x.ai`, client `b1a00492-…`): loopback port 56121 on desktop, device code everywhere. It is unofficial for third parties; the API key remains the fallback. |
| Banks | Read-only, through SimpleFIN Bridge or the owner's own Plaid keys. Wells Fargo, American Express and Capital One each have a connector, plus "Any bank". |
| iOS builds | GitHub Actions on **`macos-15-intel`**: Apple-silicon runners were cancelled for lack of capacity. The app is unsigned; the owner sideloads it. |

## Status: built and shipped (0.2.15)

| Area | Where |
|---|---|
| Providers: Claude (official SDK), OpenAI, Gemini, xAI, OpenAI-compatible presets including Runpod and Hostinger. A Model ID field and Wake up for cold models. | `src/providers/` |
| Grok: Responses API with native `web_search` and `x_search`, Sign in with X (browser and device code; a paste box for the code xAI's page may show) | `src/providers/xai.ts`, `src/connectors/oauth.ts`, `src-tauri/src/oauth.rs` |
| Images and video: Pollinations, AI Horde, Cloudflare, fal.ai, Runway, custom templates, plugin engines. A backend picker with separate image and video defaults. | `src/providers/backends.ts`, `media.ts`, `mediaUtil.ts`, `src/ui/BackendPicker.tsx` |
| Agents, projects (knowledge with BM25), prompts and slash commands, memory, plan checklist, questions, sub-agents (`delegate`), research mode | `src/agent/`, `src/tools/assistant.ts`, `src/knowledge/` |
| Plugins: Claude format, TypingMind single- and multi-function, Meridian JSON; sandboxed JS with standard `fetch`; plugin image/video engines | `src/plugins/`, `src/tools/sandbox.ts` |
| Connectors: Claude directory (MCP, OAuth 2.1), registry search, Google and Microsoft built in, banks | `src/connectors/` |
| Automations (schedules, catch-up, notifications, tray) | `src/automations/` |
| Sync: iCloud, folder, Google Drive, OneDrive (device-code sign-in); merging backups | `src/storage/` (`sync.ts`, `cloudkv.ts`, `backup.ts`) |
| Approvals and questions **inside the chat**, never popups | `src/ui/Dialogs.tsx` (`ChatPrompts`) |
| **Computer use**: a screenshot-and-action loop, ask every action by default, preview of where the click lands, rate limit, kill switch (Stop, Esc, Ctrl+Alt+Esc enforced natively) | `src/tools/computer-use.ts`, `src-tauri/src/screen.rs`, `src/platform/killswitch.ts` |
| **Browser agent**: managed Chromium download or Firefox; CDP and BiDi drivers; numbered page snapshot; approval rules; panel | `src/browser/`, `src/tools/browser.ts`, `src-tauri/src/browser.rs`, `src/ui/BrowserPanel.tsx`, `src/ui/BrowserSettings.tsx` |
| **Consortium**: plan → assign → work (scratchpad, `ask_member`) → review → draft and vote rounds → final (consensus, majority or no agreement); stop a member, force the vote, user notes | `src/agent/consortium.ts`, `src/state/consortiumRun.ts`, `src/ui/Consortium.tsx` |
| Chat features: versions, compare, fork, private chats, archive, Grok section at the bottom of the sidebar, search, export and import, usage page, voice, favourites first in a wide model menu | `src/ui/` |

## Next up (the agreed order: see `docs/agent-roadmap.md`)

1. **Background mode for computer use.** Act on app controls without moving the real mouse: Windows UI Automation (`src-tauri/src/uia.rs`) and macOS Accessibility (`ax.rs`), with an element list given to the model.
2. **Long-running sessions.** Goal, budget and state machine persisted after every step; mid-run steering (continue / pivot / stop / change goal); survive restarts (tray); wake on schedule or event.
3. **Specialised sub-agents.** Library agents with `role: subagent` called by name from `delegate`, in parallel or in sequence, with context hand-off; child rows in the plan checklist; plugins can ship them.
4. **Rich artifacts.** In-app preview and light editing for xlsx (grid with live formulas), pptx (slides and notes), docx and Markdown; Open in app and Download.
5. **Auto-invoked skills.** Match skill descriptions to the request (BM25 plus project instructions); suggest or pre-load them with confirmation; manual `/` stays.
6. **X tools, both options.** Official X API tools with the owner's developer app (search, read threads, trends, post with approval), and research mode that "prefers real-time sources" (on by default with Grok).
7. **Remote worker, both options.** A self-hosted Docker worker using the same engine, plus Dispatch from iPhone to a computer, with status synced through the existing sync layer. The **hosted** option needs a server and accounts: **ask the owner where it should run** before building it.

## Open questions for the owner

- The hosted remote worker: where to host it (which cloud or provider) and how accounts should work. This is asked when item 7 is reached.

## Build, test, release

```bash
npm install
npm run typecheck && npx vitest run      # 134 unit tests (18 files)
(cd src-tauri && cargo test --lib)       # Rust tests (the sign-in listener)
npm run build                            # web bundle for the e2e suites
node e2e/run.cjs                          # 62 checks, core app        (port 4173)
node e2e/features.cjs                     # 35 checks, library etc.    (port 4175)
node e2e/media-sync.cjs                   # 23 checks, free media, sync (port 4176)
node e2e/grok-banks.cjs                   # 23 checks, Grok, banks, UI  (port 4177)
node e2e/consortium.cjs                   # 15 checks, consortium       (port 4178)
npx tauri build --debug --no-bundle && xvfb-run -a node e2e/native.cjs   # real Linux app via tauri-driver
```

- Each e2e script starts its own `vite preview`; run `pkill -f "vite preview"` first if a port is taken.
- The native test needs `tauri-driver`, `/usr/bin/WebKitWebDriver` and Chromium at `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (Playwright's). The test writes `installed.json` so the app uses that Chromium.
- **CI** (`.github/workflows/build.yml`): on every push to `main`, the jobs are Tests (ubuntu), iPhone and iPad (`macos-15-intel`, unsigned ipa), Windows (NSIS) and Publish results. The results go to the **`ci-logs`** branch (`status.txt`, `report-*.txt`). Read them with `git fetch origin ci-logs && git show FETCH_HEAD:report-ios.txt`.
- Each build creates the release `v0.2.<run>` with both files. `cancel-in-progress` is off, so pushes queue instead of cancelling.
- Check CI over the public API, for example `curl https://api.github.com/repos/Wayneinusa/Meridian/actions/runs?per_page=3`. The GitHub MCP server does not connect from this environment.
- `testflight.yml` (signed TestFlight upload) exists but has never been run; it needs the owner's Apple developer secrets.

## Lessons learned (avoid repeating mistakes)

- **zustand v5:** selectors must not return new arrays or objects on each call, or React loops and the page goes blank. Select stable state and compute outside, or use `useMemo`.
- **e2e locators:** find provider cards by heading, e.g. `.card` with `has: h4 /^OpenAI$/`. The "Add another provider" card (which sits first) mentions OpenAI. Scope buttons to avoid strict-mode collisions, e.g. `.modal-foot` Install, or `exact: true`.
- **Mocks:** members' system prompts contain the base "You are the assistant…" text, so match `/You are (\w+), one member/`. Mock servers must answer favicon and other GET requests from the browser. Wait for specific results rather than for "idle" right after sending.
- **Build machine network:** docs.x.ai, Mozilla, googlechromelabs and many vendor sites are blocked. Read vendor API shapes from npm package sources (`registry.npmjs.org` works), for example `@ai-sdk/xai`, `@ai-sdk/openai` and `pi-xai-oauth`. GitHub raw works.
- **Chromium as root** needs `--no-sandbox`; `browser.rs` adds it when Linux `HOME=/root`.
- **Platform code:** keep desktop-only Rust under `cfg(desktop)` or target-specific dependencies (global-shortcut, reqwest, zip). Windows/macOS-only code (`screen.rs` with xcap and enigo) is not compiled on Linux; check the APIs against `~/.cargo/registry/src` sources. CI compiles Windows and iOS.
- **Tool approvals:** `needsApproval` is synchronous. The browser tool keeps the last page's element metadata per chat for that reason.
- **Consortium:** member messages carry `Message.member` and are excluded from later model history; only `phase: "final"` stays. User notes typed mid-run carry `member.phase: "note"` so they stay inside the thread.
- The old iOS problem was GitHub runner capacity, not code. Intel Macs fixed it.
- **Sign in with X:** xAI's page (auth.x.ai) does not always redirect. Its script hands the code to `http://127.0.0.1:56121/callback` with fetch, which a browser only allows after a CORS and Private Network Access preflight. `oauth.rs` answers OPTIONS with those headers and accepts the code by GET or POST. When that still fails, the page says "Enter this code… into Grok Build"; the card's paste box finishes sign-in (`manualRedirect` in `oauth.ts`, safe because PKCE ties the code to this attempt).
- Under full parallel load the xlsx test in `tests/tools.test.ts` can pass its 5 s timeout; rerun it alone before chasing it.

## Where things are

```
src/agent/        engine.ts (agent loop), consortium.ts, prompt.ts
src/providers/    anthropic, openai, gemini, xai, media, backends, mediaUtil, params, registry, wake
src/tools/        files, media, web, computer, computer-use, browser, mcp, sandbox, assistant, types
src/browser/      transport (WebSocket/RPC), drivers (CDP, BiDi), page (injected reader), session
src/connectors/   catalog, oauth (incl. device flow), native (Google/Microsoft), banks
src/plugins/      import (Claude, TypingMind, JSON), runtime, engines, gallery
src/storage/      repo, library, merge, sync, cloudkv, backup, transfer, kv
src/state/        store.ts (app state), consortiumRun.ts, defaults.ts
src/ui/           React components (Chat, Composer, MessageView, Settings*, Consortium, BackendPicker, …)
src-tauri/src/    browser, screen, shell, fs_cmds, secrets, mcp, oauth, icloud, background, platform
docs/             agent-roadmap.md (design of remaining work), PROJECT-LOG.md (history)
e2e/, tests/      browser/native end-to-end and unit tests
```
