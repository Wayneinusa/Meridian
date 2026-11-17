# Meridian

A multi-provider AI workspace for **iPhone, iPad and Windows** from one codebase (it also builds for macOS and Linux). Bring your own API keys; chats, agents, projects and automations live on your device and sync through iCloud.

## What it does

| | |
|---|---|
| **Models** | Claude (official SDK), OpenAI, Google Gemini, xAI Grok, and anything OpenAI-compatible: OpenRouter, Ollama, LM Studio, Groq, Mistral, DeepSeek, Perplexity, Together, Fireworks, Cerebras, Hugging Face, Featherless, Moonshot, Qwen, Nvidia NIM, Azure, your own endpoint. Each provider card has an optional **Model ID** field for models the provider does not list (such as cold models), with **Wake up**, which retries a tiny request until the model has loaded. |
| **Images & video** | Chat / Image / Video switch in the composer. Grok Imagine (images, edits, video, image-to-video), OpenAI (gpt-image, DALL·E, edits, Sora with a start image), Google (Imagen, Gemini image models, Veo with a start image), OpenRouter image models. Aspect ratio, count, quality, length, resolution. **Edit** and **Animate** on any generated picture. Chat models can also create and edit pictures as a tool. |
| **Agents** | Assistants with their own instructions, model, tools, knowledge files, memory and conversation starters; eight templates. |
| **Projects** | Chats grouped with shared instructions, knowledge files (given in full when small, searched with BM25 when large), a default agent and model, and on desktop a work folder the assistant may use. |
| **Prompts** | A prompt library with `{{variables}}`; type `/` in the composer for prompts and plugin commands (`$ARGUMENTS` like Claude). |
| **Memory** | The assistant remembers lasting facts (and forgets on request); editable in Settings → Memory. |
| **Plugins** | Claude plugins (skills, slash commands, agents, `.mcp.json`) from a GitHub link or zip, including marketplaces; TypingMind plugins (JavaScript or HTTP); `SKILL.md` files; Meridian JSON. JavaScript runs in a sandbox. Gallery: Weather, Wikipedia, Currency rates, Hacker News, arXiv, Calculator, Writing commands, Research skills. |
| **Connectors** | The services in Claude's directory with official MCP servers (Notion, Linear, Atlassian, Asana, monday.com, ClickUp, Airtable, Box, Dropbox, Canva, Figma, Miro, Webflow, GitHub, Sentry, Vercel, Netlify, Supabase, Cloudflare, Hugging Face, Stripe, PayPal, Square, Intercom, HubSpot, Fireflies, Granola, Zapier and more) with browser sign-in (OAuth 2.1, dynamic registration, PKCE). Google Workspace (Gmail, Calendar, Drive) and Microsoft 365 (Outlook, Calendar, OneDrive) built in. Search the public MCP registry, or add any server by address (HTTP, SSE, or a local command on desktop). |
| **Automations** | Scheduled tasks (once, every N minutes, daily on chosen days, weekly, monthly) with an agent, project, model and tools; each run is a chat; catch-up for missed runs; notifications. On desktop the app can stay in the tray to run them. |
| **Working like Cowork** | A visible plan checklist, clarifying questions with choices, parallel sub-agents, a JavaScript sandbox for exact calculations, research mode (many searches, cited report), web search for every model (DuckDuckGo, Brave, Tavily, Exa or SearXNG; Claude uses its own), files panel, HTML/SVG live preview. Desktop: shell, files, app installs (winget / Homebrew), screenshots and mouse/keyboard, each action approved. |
| **Chats** | Answer versions, compare up to four models side by side, retry with another model, edit and resend, fork, delete, quote in reply, private chats, archive, pin, move to project, full-text search, usage and cost page, auto titles, export to Markdown / PDF / Word / HTML / JSON, import from ChatGPT, Claude and TypingMind. |
| **Voice** | Dictation (OpenAI, Groq, xAI or Gemini speech-to-text), read aloud (OpenAI or xAI voices, or the device voice), hands-free voice mode. |
| **Files** | Reads images, PDFs, Word, Excel, PowerPoint, text and code; creates Excel with live formulas, PDF, Word, PowerPoint and any text file. |
| **Parameters** | Temperature, top-p/k, min-p, penalties, seed, max tokens, stop sequences, reasoning effort, thinking budget, verbosity, JSON mode, tool choice, logit bias, service tier, fast mode, context limit, raw extra fields; per chat, per model, or global. |
| **Storage** | One JSON file per chat and per library item. iCloud sync on Apple devices, folder sync elsewhere (works with iCloud for Windows), backup files that merge on import. API keys and sign-in tokens stay in the OS keychain and are never synced or backed up. |

Features switch on per model: a model without vision is not sent images, a model without tool calling is not offered tools, and a parameter a provider does not accept is not sent (the panel says why).

Keyboard: Ctrl/⌘+K search, Ctrl/⌘+Shift+O new chat, Ctrl/⌘+Shift+P private chat, Ctrl/⌘+B sidebar, Ctrl/⌘+, settings, Esc stops a reply.

## What has been verified, and what has not

Built and tested in a Linux container without provider API keys; the iOS and Windows apps are built by GitHub Actions.

**Verified by running it**

- `npm test`: 72 unit tests. Merge, backup and sync of chats and library items; document writers and readers; parameters per provider; streaming and tool calls; image and video requests for xAI, OpenAI, Google and OpenRouter; cold-model wake-up; knowledge search; plugin import (Claude zip, marketplace, TypingMind, skills) and runtime; connector sign-in (discovery, registration, PKCE, refresh) and registry search; automation schedules; ChatGPT/Claude/TypingMind import.
- `npm run e2e`: 62 browser checks of the core app with providers mocked at the network layer, including Grok image creation, editing and image-to-video.
- `node e2e/features.cjs`: 35 browser checks of agents, projects with knowledge, prompts and slash commands, memory, gallery plugins (HTTP and sandboxed JavaScript), a directory connector, questions, plans, parallel sub-agents, research mode, versions, compare, automations, private chats, search, export, import and usage.
- `e2e/native.cjs`: checks against the **real desktop app** (Linux build) through WebDriver: native HTTP streaming, shell and file tools behind approval, key storage, document writers, on-disk store and folder sync.

**Built, but not run on a device**: the iPhone/iPad `.ipa` and the Windows installer (both built on GitHub). Nothing iOS- or Windows-specific has been exercised by hand: Keychain, Files app, microphone, notifications, deep links, tray, Credential Manager.

**Not verified against the real services**: no call has gone to a real model provider, connector, Google or Microsoft. Request shapes follow the vendors' SDKs and documentation and are tested against mocks; first real use may need small fixes, video APIs especially.

## Run it

```bash
npm install
```

```bash
npm run dev
```

That serves the UI in a browser at http://localhost:1420 with browser storage and no native features. For the desktop app (needs [Rust](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)):

```bash
npm run tauri dev
```

Then open Settings → Providers & keys, paste a key, and the model list is fetched.

## Build for Windows

On a Windows machine with Rust and Node installed:

```bash
npm run tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`. No Windows machine? The **Build** workflow on GitHub (`.github/workflows/build.yml`) builds it too and uploads it as the `Meridian-Windows` artifact.

It can also be cross-built on Linux (this is how the bundled installer was made; needs `mingw-w64` and `nsis`):

```bash
rustup target add x86_64-pc-windows-gnu
```

```bash
npm run tauri build -- --target x86_64-pc-windows-gnu --bundles nsis
```

Windows 10 and 11 include the WebView2 runtime the app needs; if it is missing, the installer downloads it.

Every push to `main` also publishes the Windows installer at **Releases › Latest** (`https://github.com/Wayneinusa/Meridian/releases/latest`). Each build has its own version (`0.2.<build number>`), shown in Settings › General › About, and running a newer installer upgrades the installed copy without touching chats or settings.

## Build for iPhone and iPad

No Mac is needed: GitHub's Mac servers compile the app.

### Step 1: get the app file

1. Put this project in a GitHub repository (branch `main`). Every push starts the **Build** workflow.
2. Open the repository's **Actions** tab, choose the latest **Build** run, and download `Meridian-iOS-unsigned` from **Artifacts**. It is a zip containing `Meridian-unsigned.ipa`. (`Meridian-Windows` in the same list is the Windows installer.)

On a public repository the Mac build minutes are free. On a private one they count ten-fold against the monthly allowance, and a build takes roughly 15 to 25 minutes.

### Step 2: install it

Apple requires every app to be signed before a device will run it.

**Route A: Sideloadly (free, from Windows or Mac).** [Sideloadly](https://sideloadly.io) signs the `.ipa` with your Apple ID and installs it over USB. Apps signed with a free Apple ID stop working after 7 days and must be installed again. **iCloud sync is not available on this route**, because Apple only grants the iCloud entitlement to paid developer accounts; chats stay on the device and you move them with backup files.

**Route B: TestFlight (paid Apple Developer Program, 99 USD per year).** This is the route with iCloud sync.

1. At developer.apple.com under Certificates, Identifiers & Profiles, register an iCloud container named `iCloud.<your bundle id>` and an App ID with your bundle identifier, with the iCloud capability enabled and that container selected.
2. At appstoreconnect.apple.com create an app with that bundle identifier.
3. Under Users and Access › Integrations › App Store Connect API create a team key with Admin access. Note the Key ID and Issuer ID and download the `.p8` file.
4. In the GitHub repository open Settings › Secrets and variables › Actions and add the secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the whole text of the `.p8` file) and `APPLE_TEAM_ID`, and the variable `BUNDLE_ID`.
5. In the Actions tab run **TestFlight**, then install the app from the TestFlight app on your iPhone and iPad.

The TestFlight workflow has not been run yet. Signing setups often need one or two adjustments on first use.

### On a Mac instead

```bash
npm run tauri ios init
```

```bash
./scripts/ios-setup.sh
```

```bash
npm run tauri ios dev -- --open
```

Before that, put your bundle identifier in `identifier` in `src-tauri/tauri.conf.json` and in the `iCloud.<identifier>` strings in `src-tauri/Info.ios.plist` and `src-tauri/ios/Meridian.entitlements`.

## Sync and backup

Every chat is `conversations/<id>.json`; every attachment or generated file is `blobs/<id>`. The same layout is used in the app's own store, in a sync folder and inside a backup file.

- **iPhone / iPad**: the app's iCloud container. It appears as a *Meridian* folder in iCloud Drive.
- **Windows**: there is no system iCloud, so pick a sync folder. With *iCloud for Windows* installed, choose the Meridian folder inside iCloud Drive and the PC syncs with your Apple devices automatically. OneDrive, Dropbox or a network share work the same way between PCs.
- **Backup file**: Settings → Sync & backup → Export gives one `.meridianbackup` file (a zip). Import it on any device.

Sync and import both **merge**. Messages are combined by id, the later edit of a message wins, deleted messages stay deleted, and a chat that exists only on one side is added. Importing a backup never deletes or replaces a chat, and importing the same file twice changes nothing. API keys and connector tokens are never written to chats, sync folders or backups.

## Safety model

- **Keys** are kept in Windows Credential Manager or the Apple Keychain. (The Linux development build uses a private file; the browser build uses browser storage.)
- **Computer tools** exist only in desktop builds and are off until switched on. Each call shows the exact command or path and waits for *Allow once*, *Always allow* or *Don't allow*. An auto-approve switch exists and is off by default.
- **Connector tools** ask before each call unless you mark the connector as trusted.
- **Web fetches** to an address you did not type yourself, and that did not come from a web search in that chat, ask first, so a document or web page cannot quietly make the model send data elsewhere.
- **Plugins**: JavaScript tools run in a sandboxed frame with no access to the app, its storage or keys; their network requests go through a bridge. Installing shows a warning when a plugin contains code or local commands.
- **Connector sign-in** tokens are kept in the keychain, refreshed automatically, and removed on Sign out. Connector tools ask before each call unless you trust that connector.
- **Automations** do not run tools without asking unless you switch that on for the automation.
- **Tool inputs** are validated against the tool's schema before anything runs; calls from a reply that was cut off are never run.
- The web view's content-security policy blocks remote scripts and remote images, and all network traffic goes through the native HTTP client. HTML previews are sandboxed.

iOS and iPadOS do not let any app run commands, control other apps or install software. On those devices Meridian does everything else, and saves files to the Files app.

## Known gaps

- **Google sign-in on iPhone/iPad**: Google only accepts its own URL scheme for iOS apps, so the Google Workspace connector signs in on Windows/Mac. Microsoft 365 and MCP connectors sign in on every device.
- **Claude's own Gmail, Calendar and Drive connectors** are hosted by Anthropic for Claude only; Meridian talks to the Google and Microsoft APIs directly, which needs your own (free) app registration. A few directory addresses come from vendor documentation rather than the registry and can be edited after adding.
- **Slack**: its MCP server only admits approved partner apps; use Zapier or a Slack-capable MCP server from the registry.
- **Automations on iPhone/iPad** run while the app is open; iOS suspends apps in the background, so missed runs happen when you return (catch-up).
- **Voice mode** is turn-based (listen, answer, speak), not full-duplex real-time voice.
- **Code execution** is JavaScript in a sandbox; Python runs on desktop through the shell tool.
- Generated PDFs cover Latin, Greek and Cyrillic; CJK and Arabic text needs Word or Excel output.
- Claude's API no longer accepts temperature/top-p/top-k; reasoning effort is the control for Claude.

## Layout

```
src/
  agent/        engine.ts (the agent loop for chats, sub-agents, automations), prompt.ts
  providers/    anthropic.ts (official SDK), openai.ts, gemini.ts, media.ts, params.ts, wake.ts
  tools/        files, media, web (fetch + search), computer, mcp, code sandbox, assistant tools
  connectors/   catalog (directory + registry), oauth.ts, native.ts (Google, Microsoft)
  plugins/      import (Claude, TypingMind, JSON), runtime, gallery
  automations/  schedule.ts, runner.ts
  knowledge/    chunking + BM25 search
  storage/      chats, library, merge, sync, backup, import/export
  state/        store.ts (app state)
  voice.ts      dictation, read aloud, voice mode
  ui/           React components and pages
src-tauri/      Rust: files, shell, secrets, MCP processes, screen control, iCloud, sign-in redirects, tray
tests/          unit tests        e2e/  browser and native end-to-end tests
```
