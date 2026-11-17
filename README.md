# Meridian

A multi-provider AI workspace for **iPhone, iPad and Windows** from one codebase (it also builds for macOS and Linux). Bring your own API keys; chats live on your device and sync through iCloud.

| | |
|---|---|
| **Models** | Claude (official SDK), OpenAI, Google Gemini, and anything with an OpenAI-compatible API: OpenRouter, Ollama, LM Studio, Groq, Mistral, xAI, DeepSeek, Together, your own endpoint |
| **Input** | Images, PDFs, Word, Excel, PowerPoint, text and code files. Sent natively when the model can read them, otherwise converted to text on the device |
| **Files out** | Excel workbooks with live formulas, PDFs, Word documents, PowerPoint decks, any text/code/HTML/SVG file. Built on the device, with preview, open and save |
| **Media** | Image generation (OpenAI image models, Imagen, Gemini image models) and video generation (Sora-style job API, Veo) |
| **Connectors** | Model Context Protocol: remote servers over HTTP on every device, local command servers on desktop |
| **Computer use** | Desktop only: shell commands, read/write files, open apps, install software (winget / Homebrew), screenshots and mouse/keyboard. Every action asks first |
| **Parameters** | Temperature, top-p, top-k, min-p, frequency/presence/repetition penalty, seed, max tokens, stop sequences, reasoning effort, thinking budget, verbosity, response format, tool choice, parallel tools, logit bias, service tier, fast mode, context window, plus raw extra request fields. Per chat, per model, or global |
| **Storage** | One JSON file per chat on the device. iCloud sync on Apple devices; folder sync on Windows (works with iCloud for Windows); backup files that merge on import |

Features switch on per model: a model without vision is not sent images, a model without tool calling is not offered tools, and a parameter a provider does not accept is not sent (the panel says why).

## What has been verified, and what has not

Built and tested in a Linux container without a Mac, a Windows machine or any provider API keys.

**Verified by running it**

- `npm test`: 33 unit tests. Merge, backup and sync logic; the xlsx/pdf/docx/pptx writers and readers; parameter mapping for every provider; Gemini and OpenAI streaming, tool calls and media jobs against mocked HTTP.
- `npm run e2e`: 54 checks driving the web UI in Chromium with provider APIs mocked at the network layer. Chat, streaming, thinking replay, file creation and download, attachments, approval prompts, image generation, parameters, provider switching mid-chat, an MCP connector, backup export/import, persistence, phone and tablet layouts.
- `e2e/native.cjs`: 25 checks driving the **real desktop app** (Linux build, WebKit) through WebDriver against a local mock model server. Native HTTP with true incremental streaming, shell commands and file writes behind approval, secret storage, all four document writers under the app's content-security policy, the on-disk store, and two-way folder sync including a merge of diverged copies.

**Built, but not run**

- The **Windows installer** (`Meridian_0.1.0_x64-setup.exe`) was cross-built from Linux with the MinGW toolchain. The executable imports only Windows system DLLs plus the WebView2 loader it ships with, and the installer contains both. It has not been launched on Windows, and it is unsigned, so SmartScreen will warn on first run. The same code passes its native tests in the Linux build; the Windows-specific parts (Credential Manager, PowerShell, screenshots, input control) compile but are unexercised. For a signed, MSVC-built release use the GitHub workflow below.
- The **iOS-only code** (iCloud container lookup, Keychain) type-checks for `aarch64-apple-ios`. The iOS app itself is compiled by the GitHub workflow on a Mac runner; it has not been run on a device.

**Not verified at all**

- Any call to a real provider. Claude goes through the official SDK and the request shape is asserted in tests; OpenAI, Gemini, image and video endpoints are written from their documented shapes and tested against mocks only. Video-generation APIs in particular change often.
- iCloud sync on a device, and the exact folder name iCloud for Windows gives the app's container (expected: `iCloudDrive\iCloud~app~meridian~client`). The app detects the folder if it exists, and any folder can be chosen by hand.
- Screenshots and mouse/keyboard control (Windows/macOS only).

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
- **Web fetches** to an address you did not type yourself ask first, so a document or web page cannot quietly make the model send data elsewhere.
- **Tool inputs** are validated against the tool's schema before anything runs; calls from a reply that was cut off are never run.
- The web view's content-security policy blocks remote scripts and remote images, and all network traffic goes through the native HTTP client. HTML previews are sandboxed.

iOS and iPadOS do not let any app run commands, control other apps or install software. On those devices Meridian does everything else, and saves files to the Files app.

## Known gaps

- Connectors that only offer browser sign-in (OAuth) are not supported yet; use servers that accept a token or API key.
- Hosted web search is wired up for Claude only. Other models can read pages with the built-in fetch tool or search through a connector.
- PDFs are typeset with a font that covers Latin, Greek and Cyrillic. Chinese, Japanese, Korean and Arabic text will not render in generated PDFs (Word and Excel output is unaffected).
- Claude's API no longer accepts temperature, top-p or top-k; those sliders apply to other providers, and reasoning effort is the control for Claude.
- No voice input/output, and no Android target.

## Tests

```bash
npm test
```

```bash
npm run build && npm run e2e
```

The native suite needs a Linux desktop build, `tauri-driver` (`cargo install tauri-driver`) and `webkit2gtk-driver`:

```bash
npm run tauri build -- --debug --no-bundle && xvfb-run -a node e2e/native.cjs
```

## Layout

```
src/
  providers/   anthropic.ts (official SDK), openai.ts, gemini.ts, media.ts, params.ts
  tools/       files.ts (xlsx/pdf/docx/pptx), media.ts, web.ts, computer.ts, mcp.ts, extract.ts
  storage/     merge.ts, repo.ts, sync.ts, backup.ts, kv.ts
  state/       store.ts (app state + the agent loop)
  platform/    the seam between the UI and the native shell
  ui/          React components
src-tauri/     Rust: files, shell, secrets, MCP processes, screen control, iCloud
tests/         unit tests        e2e/  browser and native end-to-end tests
```
