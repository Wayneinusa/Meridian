# Agent roadmap: computer use, browser agent, and what follows

Status:

- **Built:** 1 (computer use, foreground), 2 (the browser agent) and ◆ (the consortium).
- **Next, in order:** 3 to 9.

Decisions from the owner:
- Bundled Chromium, plus a Firefox option.
- Computer use asks before every action by default, and that can be changed.
- Remote worker: both self-hosted and hosted.
- X tools: both the official X API (your own developer app) and Grok's built-in `x_search`.

## Where things stand

| Piece | Today | File |
|---|---|---|
| Agent loop | One loop for chats, sub-agents and automations: model call → tool calls → approval → run → repeat, with step budget, abort, versions. | `src/agent/engine.ts` |
| Tools | `Tool` objects with a JSON schema, a group (`files`, `media`, `web`, `computer`, `connectors`), `needsApproval`, `summarize`, `run`. Approval is per call, *Always allow* per tool, auto-approve per automation; requests now show inside the chat. | `src/tools/*`, `src/ui/Dialogs.tsx` |
| Desktop control | `take_screenshot` (xcap) and `computer_input` (enigo: move, click, double/right click, scroll, type, keys), each approved. No loop: the model must call them one by one. | `src/tools/computer.ts`, `src-tauri/src/screen.rs` |
| Sub-agents | `delegate` runs a child loop with its own context (depth 1, parallel), result returned as text. | `engine.ts` (`runSubagent`) |
| Plans | `update_plan` writes a checklist shown above the chat. | `src/tools/assistant.ts`, `Chat.tsx` |
| Plugins / skills | Claude-format skills listed in the system prompt, loaded on demand with `read_skill`; slash commands. | `src/plugins/*` |
| Automations | Schedules run a chat turn in the background (tray on desktop, foreground on iOS). | `src/automations/*` |

## 1. Visual computer use

**Goal:** a task such as "rename these invoices in Finder and file them by month" runs as a continuous screenshot → decide → (approve) → act loop that any agent or automation can start.

### Design

- **One tool, its own loop.** A new tool `use_computer({ goal, app? })` starts a *computer session*: a sub-loop (built on `runSubagent`) whose only tools are `computer` actions. The parent model gets a summary and the final screenshot when it ends. Models can also call the single-step `computer` tool directly.
- **Native computer-use APIs where they exist, one schema everywhere else.**
  - Claude: Anthropic's `computer` tool type (screenshots in tool results, coordinates scaled for it).
  - OpenAI: the Responses `computer_use` tool.
  - Grok, Gemini, local vision models: a function tool with the same action schema (`screenshot`, `click {x,y,button}`, `double_click`, `move`, `drag`, `scroll {dx,dy}`, `type {text}`, `key {combo}`, `focus_window {title}`, `wait {ms}`, `done {summary}`), with the screenshot returned as an image in the tool result. Models without vision are not offered it.
- **Every step is visible.** The step is a `tool_call` part whose result holds the screenshot with the proposed action drawn on it (crosshair or box). The approval card shows that preview.
- **Approval policy** (Settings → Tools & computer → Computer use):
  - *Ask for every action* (default).
  - *Ask for risky actions*: typing, keys with modifiers, anything in a password field, and the first action in each new app.
  - *Don't ask for this task*: per session, offered on the first approval card.
  - Allow-lists: apps where clicks and scrolls don't ask.
- **Safety.**
  - Rate limit: actions per minute, default 30.
  - Step budget per session, default 50.
  - A kill switch, checked before every input: Stop in the chat, Esc, and a global shortcut (Ctrl+Alt+Esc / ⌃⌥Esc) registered with `tauri-plugin-global-shortcut`.
  - Input pauses while the user moves the mouse.
- **Background mode** ("don't steal my mouse"):
  - **Windows:** UI Automation (Invoke, Value and Scroll patterns on the target window's elements).
  - **macOS:** the Accessibility API (AXPress and AXSetValue on elements found by role and title).
  - Both act on controls without moving the real pointer, when the app exposes them. When it doesn't, the session asks to switch to foreground mode. The model sees an element list (role, name, bounds) next to the screenshot so it can address controls by id.
- **Where it runs:** desktop only. iPhone/iPad never offer it, and automations that need it run only on a computer that is online (the existing *run on this device* field).

### New and changed files

```
src-tauri/src/screen.rs        + capture_scaled(max_side) → PNG + scale; windows_list; window_focus; KILL flag; rate limiter
src-tauri/src/uia.rs           Windows UI Automation: element tree of a window, invoke/set value/scroll by id (windows crate)
src-tauri/src/ax.rs            macOS Accessibility: same API via AXUIElement (accessibility-sys)
src/agent/computer.ts          session loop, policy, budgets, coordinate scaling, provider-native tool mapping
src/tools/computer-use.ts      use_computer + computer tools
src/ui/ComputerStep.tsx        step preview (screenshot + action overlay) inside the tool call
src/types.ts                   Settings.computerUse { approval, actionsPerMinute, maxSteps, background, allowApps }
```

**Tests**

- Unit: the loop against a fake screen and a scripted model (stops at the budget, rate limit and kill switch; approval policy decisions; scaling).
- Browser e2e: the step preview and approval card.
- Native e2e (`e2e/native.cjs`): screenshot and focus on the Linux build.

## 2. Interactive browser agent

**Goal:** the assistant drives its own browser, separate from the user's, to navigate, read, click, fill forms, extract data and take screenshots.

### Design

- **Isolated browser over CDP.** Meridian launches the installed Chromium-based browser with `--remote-debugging-port` and its own profile folder in the app's data. On Windows that is Edge, which is always installed; elsewhere Chrome, Edge, Brave or Chromium. The user's own profile is never touched. *Use my browser* (the user's signed-in Chrome) comes later, as an opt-in extension, and only when explicitly asked.
- **Page snapshot with references.** Each step returns a compact page view: the accessibility tree, with interactive elements numbered (`[12] button "Sign in"`), plus an optional screenshot. Actions refer to those numbers. This works with models without vision and is far cheaper than screenshots.
- **Tools.** One `browser` tool with these actions:

  | Group | Actions |
  |---|---|
  | Navigation and reading | `open`, `navigate`, `snapshot`, `back` |
  | Interaction | `click {ref}`, `type {ref, text, submit?}`, `select`, `fill_form {fields}`, `press` |
  | Data | `extract {schema or question}`, `screenshot` |
  | Tabs and timing | `tabs`, `switch_tab`, `wait {for}` |
  | Basic auth | `auth` (answer a browser authentication prompt) |

  `extract` asks a small model to fill the schema from the page text.
- **Approval.**
  - Reading pages on a site the user typed, or found through search in this chat, doesn't ask. This reuses the trusted-URL rule from `fetch_url`.
  - These always ask: navigating to a new site, submitting a form, typing into a password or payment field, and downloads.
  - Per-site allow-lists.
- **Visible.** A browser panel next to the chat, like the Files panel, shows the latest screenshot and URL and has a *Take over* button.
- **Plan and research.** Each page visited becomes a plan-step note. In research mode, `browser` replaces `fetch_url` for pages that need JavaScript or a sign-in.
- **Where it runs:** desktop. On iPhone/iPad the same tools can drive the browser of a connected computer (see 3).

### New files

```
src-tauri/src/browser.rs       find/launch the browser with an isolated profile; WebSocket bridge to CDP (tokio-tungstenite)
src/browser/cdp.ts             minimal CDP client (Page, Runtime, DOM, Input, Accessibility, Network.authRequired)
src/browser/snapshot.ts        accessibility tree → numbered compact text; element ref → box / node id
src/tools/browser.ts           the browser tool and its approval rules
src/ui/BrowserPanel.tsx        live view + Take over
```

**Tests**

- Unit: snapshot building from recorded CDP responses; ref resolution; approval rules.
- Native e2e: drive a local test page in the Linux build's Chromium (open, fill form, extract).

## 3–8 and the consortium: outline

| # | Feature | Approach (short) |
|---|---|---|
| 3 | Remote execution + Dispatch | A small **Meridian worker** (the same agent engine, headless, Node), self-hosted with Docker or on a VPS. It syncs chats through the existing sync layer (folder, Drive, OneDrive) plus a task queue file per device. It can continue a chat when the app is closed; tools that need the desktop are marked *needs computer* and wait for it. **Dispatch:** iPhone/iPad queue a task for a named computer; the computer picks it up and the status syncs back. Opt-in, labelled *remote*, and keys stay in each device's keychain (the worker has its own). |
| 4 | Long-running sessions | A *session* is a chat flag with a goal, budget (steps, time, money) and state machine (running / paused / waiting / done), persisted after every step so it resumes after a restart. Mid-run steering adds a user note the loop reads before its next step (continue, pivot, stop, change goal). Tray keeps it alive. Wake-up triggers are schedules (existing) plus events (a file in a folder, a connector poll, a webhook through the remote worker). |
| 5 | Rich artifacts | Preview and light editing for `.xlsx` (grid with formulas, recalculated), `.pptx` (slide thumbnails, edit text boxes and notes), `.docx` and Markdown (rich text editor), saved as a new version of the artifact. *Open in app* and *Download* on every file. |
| 6 | Specialised sub-agents | Library *agents* gain `role: subagent` and can be invoked by name (`delegate {agent: "research"}`), in parallel or in sequence, with context hand-off (selected files and notes). The plan checklist shows a child row per sub-agent with its status. Plugins can ship sub-agents (already parsed from Claude plugins). |
| 7 | Auto-invoked skills | Each skill's description is matched against the request (BM25 over names and descriptions, plus the project's instructions). Matches above a threshold are pre-loaded or suggested as a chip ("Use *PDF report* skill?"), and tools from plugins can be suggested the same way. Manual `/skill` stays. |
| 8 | X / real-time layer | Grok's native `x_search` is done. Add X tools through the official X API with the user's own X developer app: read threads, search, analyse trends, and post with approval. Research mode gains a *Prefer real-time sources* switch that weights X and news (default on with Grok). |
| ◆ | Consortium | Built on sub-agents. Phases: **plan** (agents propose a split, a coordinator merges it; visible as a discussion thread) → **work** (parallel, shared scratchpad document, questions to each other through a `message_agent` tool) → **review** (each reviews the others) → **converge** (vote or consensus check, at most N rounds) → **synthesis**. Disagreement is reported as separate positions, never forced. UI: a participants bar with status, a collapsible discussion thread, controls for *add instruction*, *stop agent* and *force vote*. Limits on agents (2–6), rounds and budget are user-set. Any mix of models works, because it uses the existing provider layer. |

## Proposed order of work

Each step is one commit series, shippable on its own, with tests and README.

1. Computer use, foreground: loop, policy, kill switch, preview; Claude native plus the shared schema.
2. Browser agent: isolated CDP browser, snapshot refs, tools, panel.
3. Background mode for computer use (UI Automation / Accessibility).
4. Long-running sessions and steering (also needed by 1–2 for long tasks).
5. Specialised sub-agents, then the consortium.
6. Rich artifacts.
7. Auto-invoked skills.
8. X tools and real-time research.
9. Remote worker and Dispatch.

## Questions before starting (answered)

The answers are in *Status* at the top. Notes on what was built:

- **The bundled Chromium is downloaded on first use rather than shipped inside the installer.** It is Chrome for Testing, pinned to one version and kept in Meridian's own folder. Shipping it inside would add about 150 MB to every install and every update, including on iPhone, where it could not run.
- **Firefox is the copy installed on the computer, run with Meridian's own profile.** Firefox's only official downloads are installers, not a portable build Meridian could manage.

1. **Browser:** use the installed Edge/Chrome over CDP (no extra download, what this plan assumes), or bundle a Chromium (about 150 MB more per install, same version everywhere)?
2. **Computer-use default:** "Ask for every action" (safest, what this plan assumes) or "Ask for risky actions"?
3. **Remote worker:** self-hosted only (Docker image you run yourself), or also a hosted option? A hosted option needs a server and an account system that does not exist today.
4. **X tools:** the official X API needs your own X developer app, whose free tier is very limited (posting only), and reading needs a paid tier. Is that acceptable, or should real-time X stay limited to Grok's `x_search`?
