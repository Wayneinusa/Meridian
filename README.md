# Meridian

A multi-provider AI workspace for **iPhone, iPad and Windows** from one codebase (it also builds for macOS and Linux). Bring your own API keys; chats, agents, projects and automations live on your device and sync through iCloud.

## What it does

| | |
|---|---|
| **Models** | Claude (official SDK), OpenAI, Google Gemini, xAI Grok (API key **or Sign in with X**), and anything OpenAI-compatible: OpenRouter, Ollama, LM Studio, Groq, Mistral, DeepSeek, Perplexity, Together, Fireworks, Cerebras, Hugging Face, Featherless, Moonshot, Qwen, Nvidia NIM, Azure, Runpod Serverless, a Hostinger VPS, your own endpoint. Favourite models are listed first in the model menu. Each provider card has an optional **Model ID** field for models the provider does not list (such as cold models), with **Wake up**, which retries a tiny request until the model has loaded. |
| **Images & video** | Chat / Image / Video switch in the composer, with a **backend button** next to it: pick the service and model for this chat, and **Make default** for images and for video separately. **Free**: Pollinations (no sign-up for images; a free key adds 50+ models and video), AI Horde (free community GPUs), Cloudflare Workers AI (free daily allowance). **With your key**: Grok Imagine, OpenAI (gpt-image, DALL·E, Sora), Google (Imagen, Gemini image models, Veo), OpenRouter, fal.ai (Flux, Kling, Wan, MiniMax…), Runway (Gen-4). **Custom**: any server, OpenAI-, xAI- or fal-style, or described by a request template. Plugins can add their own image or video engines. Aspect ratio, count, quality, length, resolution; **Edit** and **Animate** on any picture; chat models can also create pictures as a tool. |
| **Agents** | Assistants with their own instructions, model, tools, knowledge files, memory and conversation starters; eight templates. |
| **Projects** | Chats grouped with shared instructions, knowledge files (given in full when small, searched with BM25 when large), a default agent and model, and on desktop a work folder the assistant may use. |
| **Prompts** | A prompt library with `{{variables}}`; type `/` in the composer for prompts and plugin commands (`$ARGUMENTS` like Claude). |
| **Memory** | The assistant remembers lasting facts (and forgets on request); editable in Settings → Memory. |
| **Plugins** | Claude plugins (skills, slash commands, agents, `.mcp.json`) from a GitHub link or zip, including marketplaces; TypingMind plugins, single- and multi-function (`pluginFunctions` / `functions` arrays, JavaScript or HTTP, `{param}` and `{userSettings.x}` placeholders, standard `fetch`); `SKILL.md` files; Meridian JSON. Plugins whose tools make pictures or videos become Image / Video backends (or mark any tool as one). JavaScript runs in a sandbox. Gallery: Weather, Wikipedia, Currency rates, Hacker News, arXiv, Calculator, Writing commands, Research skills. |
| **Banks** | Wells Fargo, American Express, Capital One and thousands of other banks, **read-only** (balances and transactions), through SimpleFIN Bridge or your own Plaid keys. Each bank has its own connector; the assistant asks before every read unless you allow it. |
| **Connectors** | The services in Claude's directory with official MCP servers (Notion, Linear, Atlassian, Asana, monday.com, ClickUp, Airtable, Box, Dropbox, Canva, Figma, Miro, Webflow, GitHub, Sentry, Vercel, Netlify, Supabase, Cloudflare, Hugging Face, Stripe, PayPal, Square, Intercom, HubSpot, Fireflies, Granola, Zapier and more) with browser sign-in (OAuth 2.1, dynamic registration, PKCE). Google Workspace (Gmail, Calendar, Drive) and Microsoft 365 (Outlook, Calendar, OneDrive) built in. Search the public MCP registry, or add any server by address (HTTP, SSE, or a local command on desktop). |
| **Automations** | Scheduled tasks (once, every N minutes, daily on chosen days, weekly, monthly) with an agent, project, model and tools; each run is a chat; catch-up for missed runs; notifications. On desktop the app can stay in the tray to run them. |
| **Working like Cowork** | Approvals and questions appear **inside the chat** (Allow once / Always allow / Don't allow), never as a popup. A visible plan checklist, clarifying questions with choices, parallel sub-agents, a JavaScript sandbox for exact calculations, research mode (many searches, cited report), web search for every model (DuckDuckGo, Brave, Tavily, Exa or SearXNG; Claude uses Anthropic's search, Grok uses xAI's web and **X search**), files panel, HTML/SVG live preview. Desktop: shell, files, app installs (winget / Homebrew), screenshots and mouse/keyboard, each action approved. |
| **Chats** | Grok chats in their own collapsible section at the bottom of the list. Answer versions, compare up to four models side by side, retry with another model, edit and resend, fork, delete, quote in reply, private chats, archive, pin, move to project, full-text search, usage and cost page, auto titles, export to Markdown / PDF / Word / HTML / JSON, import from ChatGPT, Claude and TypingMind. |
| **Voice** | Dictation (OpenAI, Groq, xAI or Gemini speech-to-text), read aloud (OpenAI or xAI voices, or the device voice), hands-free voice mode. |
| **Files** | Reads images, PDFs, Word, Excel, PowerPoint, text and code; creates Excel with live formulas, PDF, Word, PowerPoint and any text file. |
| **Parameters** | Temperature, top-p/k, min-p, penalties, seed, max tokens, stop sequences, reasoning effort, thinking budget, verbosity, JSON mode, tool choice, logit bias, service tier, fast mode, context limit, raw extra fields; per chat, per model, or global. |
| **Storage** | One JSON file per chat and per library item. Automatic sync through **iCloud** (Apple devices), **Google Drive** or **OneDrive** (every device, Windows included), or any folder; backup files that merge on import. API keys and sign-in tokens stay in the OS keychain and are never synced or backed up. |

Features switch on per model: a model without vision is not sent images, a model without tool calling is not offered tools, and a parameter a provider does not accept is not sent (the panel says why).

Keyboard: Ctrl/⌘+K search, Ctrl/⌘+Shift+O new chat, Ctrl/⌘+Shift+P private chat, Ctrl/⌘+B sidebar, Ctrl/⌘+, settings, Esc stops a reply.

## What has been verified, and what has not

Built and tested in a Linux container without provider API keys; the iOS and Windows apps are built by GitHub Actions.

**Verified by running it**

- `npm test`: 112 unit tests. Merge, backup and sync of chats and library items; document writers and readers; parameters per provider; streaming and tool calls; image and video requests for xAI, OpenAI, Google and OpenRouter; cold-model wake-up; knowledge search; plugin import (Claude zip, marketplace, TypingMind, skills) and runtime; connector sign-in (discovery, registration, PKCE, refresh) and registry search; automation schedules; ChatGPT/Claude/TypingMind import; Pollinations (free slot waiting, keyed models, async video jobs), AI Horde, Cloudflare, fal.ai, Runway and custom templates; TypingMind multi-function import and plugin engines; Google Drive and OneDrive sync between two devices against fake servers.
- `npm run e2e`: 62 browser checks of the core app with providers mocked at the network layer, including Grok image creation, editing and image-to-video.
- `node e2e/features.cjs`: 35 browser checks of agents, projects with knowledge, prompts and slash commands, memory, gallery plugins (HTTP and sandboxed JavaScript), a directory connector, questions, plans, parallel sub-agents, research mode, versions, compare, automations, private chats, search, export, import and usage.
- `node e2e/media-sync.cjs`: 23 browser checks: free images with no keys (Pollinations, waiting for the free slot), the backend picker and its defaults, AI Horde, Pollinations video with a free key, a TypingMind multi-function plugin used as an image backend, and OneDrive sign-in with a code plus two-way sync.
- `node e2e/grok-banks.cjs`: 23 browser checks: the provider list and presets, a model menu wide enough for long names with favourites first, Grok with xAI's native web and X search (cited, shown in the chat), the Grok section, Sign in with X with a code and chats going to the subscription, a Capital One connection through SimpleFIN, and an approval answered inside the chat.
- `e2e/native.cjs`: checks against the **real desktop app** (Linux build) through WebDriver: native HTTP streaming, shell and file tools behind approval, key storage, document writers, on-disk store and folder sync.

**Built, but not run on a device**: the iPhone/iPad `.ipa` (built on GitHub's Intel Macs) and the Windows installer. Nothing iOS- or Windows-specific has been exercised by hand: Keychain, Files app, microphone, notifications, deep links, tray, Credential Manager.

**Not verified against the real services**: no call has gone to a real model provider, image service, connector, Google or Microsoft (this build machine cannot reach them). Request shapes follow the vendors' SDKs and documentation and are tested against mocks; first real use may need small fixes, video APIs especially.

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

## Grok: native search and Sign in with X

**Native search.** With *Settings → Tools & computer → Prefer native provider search when available (Claude, Grok)* on (the default), Grok models get xAI's own `web_search` and `x_search` tools through xAI's Responses API. xAI runs the searches, cites its sources inline, and each search shows in the chat like any other tool call, marked *native*, with the pages it used. Claude keeps Anthropic's search. Turn the option off, or use any other model, and Meridian's own web search is used instead.

**Two ways to sign in** (Settings → Providers & keys → xAI (Grok)):

1. **API key** from console.x.ai, billed per use.
2. **Sign in with X**: uses your SuperGrok or X Premium subscription instead of a key. On a computer, *Sign in with X* opens xAI's sign-in page in the browser; *Use a code instead* (the only option on iPhone/iPad) shows a short code to enter at xAI's device page. The page may be titled “Grok Build”: Meridian uses the public sign-in client of xAI's own Grok CLI, as other open-source Grok clients do. xAI has not said whether it supports this for third-party apps, so it could stop working; the API key always works. Tokens are kept in the keychain and refreshed automatically; *Sign out* removes them.

When both are set up, the sign-in is used (as in xAI's own tools). The card shows *Signed in with X*, *API key configured*, or both. If xAI says the account has no credits or subscription, the message says so and suggests the API key.

**Grok section.** Chats whose current model is Grok (or that switched to Image/Video from a Grok model) are listed in a collapsible **Grok** section at the bottom of the chat list. Pin, archive, rename, move and search work as everywhere else.

## Banks

Banks do not give individuals API access, so Meridian connects through an aggregator you sign up for. Either way it is **read-only**: balances and transactions, never payments, and your bank password is only ever entered on the bank's or aggregator's own page.

Settings → Connectors → *Banking*: add **Wells Fargo**, **American Express**, **Capital One**, or **Any bank** (every account you linked). Then on its card:

- **SimpleFIN Bridge** (simplest; $1.50 a month or $15 a year): make an account at bridge.simplefin.org, link your bank there (search for it first to check it is offered), create a **Setup Token**, paste it and press *Connect*.
- **Plaid** (free within Plaid's limited plan, more setup): sign up at dashboard.plaid.com, get Production access for *Transactions*, paste the client ID and secret, press *Connect a bank* and sign in to the bank on Plaid's page.

*Show my accounts* checks the connection. In chat, ask things like “what did I spend on restaurants at Capital One last month?”. The assistant asks before each read (*Allow once* / *Always allow*), unless you switch on *Run this connector's tools without asking*. The SimpleFIN address, Plaid keys and tokens stay in the keychain and are never synced.

## Free images and video

Nothing to set up for pictures: switch the message box to **Image** and send a description. The **backend button** next to the switch shows what will make it (the green *Free* tag marks free services).

| Service | Cost | Setup | Makes |
|---|---|---|---|
| **Pollinations** | Free | None. Without a key: one model, one picture every 45 s (the app waits for the slot), small logo. With a free key from [enter.pollinations.ai](https://enter.pollinations.ai): 50+ image models, no logo, no wait, and **video**, paid from free quest credits (“pollen”). Models that need a paid balance are hidden. | images, video |
| **AI Horde** | Free | None (anonymous key `0000000000`). A free key from [aihorde.net/register](https://aihorde.net/register) gives priority. Queues can take a few minutes. | images |
| **Cloudflare Workers AI** | Free daily allowance (10,000 Neurons, resets 00:00 UTC) | Free account. Paste the **Account ID** and an API token made with the *Workers AI* template. | images |
| **fal.ai** | Pay per use | Key from fal.ai. Any model id from fal.ai/models can be added with *Model ID*. | images, video |
| **Runway** | Paid API credits | Key from dev.runwayml.com. Gen-4 Turbo animates an attached picture. | images, video |
| **Custom image/video endpoint** | Yours | Base address and optional key. Images use `POST /images/generations`; video `POST /videos` (OpenAI), `/videos/generations` (xAI) or a fal-style queue, or describe any API with a template (`{{prompt}}`, `{{width}}`, `{{seconds}}`, `{{image}}`… plus `jobIdPath`, `pollUrl`, `statusPath` for job APIs). | images, video |

**Switching and defaults.** In Image or Video mode, click the backend button:

- Click a model to use it in **this chat**. Each chat remembers its own image and video backend.
- Click **Make default** to use it for new chats. Images and video have separate defaults. *Let the app choose* goes back to automatic: Pollinations first, then other free services, then your paid providers.
- *Set up* next to a service that is not ready opens its card in Settings → Providers & keys. Cloudflare, fal.ai, Runway and custom endpoints are added there with one click under **Free image & video**.

**Video for free**: paste a free Pollinations key (above), switch to **Video**, and the Pollinations video models (Wan, Seedance, Grok Imagine Video lite…) appear. Attach a picture first, or press **Animate** under one, to start the video from it.

**Plugins as backends**: a plugin whose tool generates images or videos (TypingMind DALL·E-style plugins, for example) shows up in the backend list automatically. Under Settings → Plugins → Details you can turn any tool into an image or video backend, or remove one. Meridian plugin JSON can also declare `engines` directly: `{ "kind": "image", "name": "…", "tool": "toolName" }`, an `http` template, or JavaScript `code` that returns a URL or data URI.

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

Every push to `main` also publishes the Windows installer (and, when the Mac build succeeds, the iPhone/iPad `.ipa`) at **Releases › Latest** (`https://github.com/Wayneinusa/Meridian/releases/latest`). Each build has its own version (`0.2.<build number>`), shown in Settings › General › About, and running a newer installer upgrades the installed copy without touching chats or settings.

## Build for iPhone and iPad

No Mac is needed: GitHub's Mac servers compile the app.

### Step 1: get the app file

1. Put this project in a GitHub repository (branch `main`). Every push starts the **Build** workflow.
2. Download `Meridian-unsigned.ipa` from **Releases › Latest**. (It is also under **Actions** → the latest **Build** run → **Artifacts** → `Meridian-iOS-unsigned`.)

On a public repository the Mac build minutes are free. On a private one they count ten-fold against the monthly allowance, and a build takes roughly 15 to 30 minutes. The build uses GitHub's Intel Macs (`macos-15-intel`), because jobs for its Apple-silicon Macs were repeatedly cancelled for lack of capacity; Intel Macs build the same arm64 app.

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
- **Google Drive or OneDrive** (every device: Windows, iPhone, iPad, Mac): see below. It works alongside iCloud: chats from iCloud are passed on to the cloud drive and back, so a Windows PC and an iPhone stay in step.
- **Backup file**: Settings → Sync & backup → Export gives one `.meridianbackup` file (a zip). Import it on any device.

### Sync with Google Drive or OneDrive

Google and Microsoft do not let an app register itself, so you create a free app registration once (about five minutes) and use the same one on all your devices. You sign in with a short code, which works the same on a PC and an iPhone.

**OneDrive**

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → *App registrations* → *New registration*. Name it *Meridian*. Under *Supported account types* choose *Accounts in any organizational directory and personal Microsoft accounts*. Leave the redirect address empty and register.
2. Open *Authentication*, set **Allow public client flows** to *Yes*, and save.
3. Copy the *Application (client) ID*.
4. In Meridian: Settings → Sync & backup → **OneDrive**, paste the ID, press **Sign in to OneDrive**, open microsoft.com/devicelogin on any device, enter the code and allow access. Chats go to the app's own folder (*Apps › Meridian*) in your OneDrive; Meridian cannot see your other files.

**Google Drive**

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project, and enable the **Google Drive API** (APIs & Services → Library).
2. Set up the consent screen (Google Auth Platform → *Get started*): *External*, your email. Then under *Audience* press **Publish app**; otherwise Google signs you out after 7 days. Meridian only asks for the `drive.file` permission (files it created), which needs no review by Google.
3. Under *Clients* → *Create client*, choose **TVs and Limited Input devices**. Copy the *Client ID* and *Client secret*.
4. In Meridian: Settings → Sync & backup → **Google Drive**, paste both, press **Sign in to Google Drive**, open google.com/device, enter the code and allow access. Chats go to a *Meridian* folder in My Drive.

Do the last step on each device with the same account and the same client ID. Sync runs on launch, after each reply and once a minute.

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

- **Google sign-in on iPhone/iPad**: Google only accepts its own URL scheme for iOS apps, so the Google Workspace *connector* signs in on Windows/Mac. (Google Drive *sync* uses a sign-in code and works on iPhone/iPad too.) Microsoft 365 and MCP connectors sign in on every device.
- **Sign in with X** relies on the public client of xAI's Grok CLI (see above); xAI could limit it to its own apps. On iPhone/iPad only the code sign-in works, because the browser sign-in needs a fixed local address the phone cannot keep open.
- **Banks** need SimpleFIN Bridge (paid) or a Plaid developer account; which banks work is decided by those services. Not run against them yet.
- **Free services change**: Pollinations, AI Horde and Cloudflare decide their own limits, models and terms. The free Pollinations tier is rate-limited per internet address; AI Horde is run by volunteers and can be slow at busy times.
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
  providers/    anthropic.ts (official SDK), openai.ts, gemini.ts, xai.ts (Responses API, native search,
                Sign in with X), media.ts (dispatch), backends.ts (Pollinations,
                AI Horde, Cloudflare, fal.ai, Runway, custom templates), mediaUtil.ts, params.ts, wake.ts
  tools/        files, media, web (fetch + search), computer, mcp, code sandbox, assistant tools
  connectors/   catalog (directory + registry), oauth.ts (incl. device codes), native.ts (Google, Microsoft), banks.ts
  plugins/      import (Claude, TypingMind, JSON), runtime, engines (plugins as image/video backends), gallery
  automations/  schedule.ts, runner.ts
  knowledge/    chunking + BM25 search
  storage/      chats, library, merge, sync, cloudkv (Google Drive, OneDrive), backup, import/export
  state/        store.ts (app state)
  voice.ts      dictation, read aloud, voice mode
  ui/           React components and pages
src-tauri/      Rust: files, shell, secrets, MCP processes, screen control, iCloud, sign-in redirects, tray
tests/          unit tests        e2e/  browser and native end-to-end tests
```
