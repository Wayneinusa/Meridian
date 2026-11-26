# Project log

One entry per request from the owner and per release. Newest at the bottom. Keep entries short; the details are in the commits.

## 1. The original app (before 0.2.8)

**Request:** an LLM client for iOS, iPadOS and Windows comparable to Claude Cowork. It should handle documents, image and video generation, files (spreadsheets, PDF), connectors, and computer access on desktop including installing apps. It should use API keys, store chats on the device and in iCloud, and on Windows offer backups that merge into Apple devices without replacing chats. Then: every model parameter (temperature, penalties, top-p and more).

**Delivered:**

- A Tauri 2 + React app with Claude, OpenAI, Gemini and OpenAI-compatible providers.
- File creation (xlsx, pdf, docx, pptx), reading documents, connectors (MCP), and desktop computer tools with approval.
- iCloud and folder sync, merging backups, and a full parameter panel.
- iOS built through GitHub Actions; the owner created the repository and installed the Claude GitHub app.

## 2. Image/video fix, plugins, Model ID, "everything Cowork/TypingMind/Grok have"

**Request:**

- Fix image and video generation.
- Plugins.
- An optional **Model ID** field under Providers & keys for cold models, with a way to wake them up.
- Every feature of TypingMind, the Grok app and Claude Cowork.
- Automations.
- The connectors that exist in Claude.

**Delivered:**

- **Media fixes:** media model classification fixed, OpenRouter image chat, and xAI built in.
- **Model ID:** the Model ID field with Wake up.
- **Library:** agents, projects, prompts, memory, research mode, versions and compare, voice, the usage page, import and export.
- **Plugins:** Claude and TypingMind formats with a gallery.
- **Connectors:** the Claude directory with OAuth, plus Google and Microsoft.
- **Automations.**

## 3. Releases and the iOS runner problem → 0.2.8, 0.2.9

**Problem:** Windows downloads "had no changes", because every build was version 0.1.0.

**Fix:**

- Builds are now numbered `0.2.<run>` and the version shows in Settings → General → About.
- Each build publishes a release with a permanent link.

**iOS:** GitHub's Apple-silicon runners never picked the job up, so it moved to `macos-15-intel`. The first iOS build to succeed was 0.2.9.

## 4. Free images/video, plugin engines, Drive/OneDrive sync → 0.2.10

**Request:**

- Free or free-credit image backends (Pollinations, AI Horde, Cloudflare, custom) and video backends (Pollinations, custom, optionally fal.ai and Runway).
- A visible backend list with per-generation choice and saved defaults.
- A TypingMind importer that handles single- and multi-function (`pluginFunctions`) plugins.
- Plugins that can act as image or video engines.
- Sync through OneDrive and Google Drive like iCloud.
- A retry of the iOS build.

**Delivered:** all of it. Free backends are first-class providers, the backend picker has separate image and video defaults, and Drive/OneDrive sync uses device-code sign-in.

## 5. UI fixes, banks, inline approvals, Grok native tools, Sign in with X, Grok section → 0.2.11

**Request:**

- A model menu wide enough for full names, favourites on top, and "Add another provider" first.
- Runpod and Hostinger presets.
- Permissions inside the chat like Claude, instead of popups.
- Bank connections: Wells Fargo, American Express, Capital One.
- xAI native `web_search` and `x_search`, Sign in with X for Grok, and a Grok section at the bottom of the chat list.
- A plan for Cowork/Grok parity (computer use, browser agent, remote and Dispatch, long sessions, artifacts, sub-agents, auto skills, X layer) and the Collaborative Multi-Agent Consortium.

**Delivered:** all of the immediate items, plus the plan in `docs/agent-roadmap.md`, waiting for confirmation.

## 6. Owner's decisions → computer use and browser agent → 0.2.12, 0.2.13

**Decisions:**

- A bundled Chromium, plus Firefox if possible.
- Computer use asks before every action by default, and that can be changed.
- The remote worker as both self-hosted and hosted.
- X tools as both options.

**Delivered:**

- **Computer use:** the screenshot-and-action loop, approval of every action with a preview of where the click lands, a rate limit, and a native kill switch.
- **Browser agent:** a managed Chromium download or the installed Firefox, CDP and BiDi drivers, numbered page snapshots, approval rules, and a browser panel.
- **Native test:** the real Linux app launches Chromium in it.

## 7. "Where is the Consortium?" → 0.2.14

It had been planned but not yet built.

**Delivered:** the Collaborative Multi-Agent Consortium.

- Teams of 2–6 members, cross-model, from saved agents or temporary roles, with suggested teams.
- Phases: plan → assign (to the plan checklist) → parallel work (shared scratchpad, `ask_member`) → reviews → draft and vote rounds → final answer. The outcome is consensus, majority with dissent, or no agreement.
- A status bar with Stop per member and Force a vote; instructions can be added mid-run.

## 8. Handoff files

**Request:** a file that is kept up to date, so a new chat can continue after the context limit.

**Delivered:** `CLAUDE.md`, which Claude Code loads automatically, and this log. Both are updated with every piece of work.

## 9. "Signing into Grok asks me to enter a code in Grok Build" → 0.2.16

**Cause:** xAI's sign-in page passes the code back to Meridian from a page script. The browser first asks the local listener for permission (a CORS / Private Network Access check), and the old listener didn't answer it, so the page fell back to showing the code.

**Fix:**

- The listener answers that check and accepts the code however the page sends it, so sign-in should finish on its own.
- If xAI still shows a code, the provider card has a **Code from xAI** box with **Finish signing in**.
- *Use a code instead* (device code) keeps working as before.
- Verified with Rust tests against the listener and unit tests of the paste path; not yet against xAI's real page, which the build machine cannot reach.

## 10. "It still doesn't work: the page says the device is connected, but nothing changes in the app" → 0.2.18

**Cause:** sign-in itself succeeded, but on Windows the tokens could not be saved. Windows Credential Manager holds at most 1280 characters per entry, and xAI's tokens are longer. The error appeared only as a short toast. The same limit could hit Google Drive, OneDrive and connector sign-ins.

**Fix:**

- Long secrets are split across several Credential Manager entries and joined again when read.
- A failed sign-in now leaves its reason on the Grok card.
- Verified with Rust tests using a store that enforces Windows' limit; the Windows build compiles in CI.

## 11. "Signed in, but chatting says 426: Your Grok CLI version (1) is outdated" → 0.2.20

Sign in with X now works on Windows (0.2.18).

**Cause:** xAI's subscription gateway refuses clients that report a version older than 1.0.13, and Meridian reported "1".

**Fix:** Meridian reports a version the gateway accepts. If xAI raises the minimum again, Meridian reads the new number from the refusal, remembers it and retries once, so it should not break the same way again. Tested against a mock that raises the minimum.

## 12. Grok native search, Grok Imagine, per-model styles, Consortium redesign, Skills

**Request** (four parts, built in this order):

1. Reliable Grok native search with both sign-in methods, a visible status, graceful fallbacks, and Claude unaffected. Grok Imagine as a first-class backend that Grok chats prefer and that any model can use.
2. Per-model custom instructions with a fallback to the global ones.
3. Consortium as a full-width experience, with manual and automatic teams, operational crews and per-member models.
4. A first-class Skills system (SKILL.md).

**Part 1 delivered:**

- **Search:** native search on both routes; a search chip in the composer; fallback to Meridian's search with a note when xAI refuses its own; a fallback to the API key when the subscription gateway refuses the account. The gateway gets xAI's request policy (`store: false`, encrypted reasoning).
- **Grok Imagine:** always listed and works with Sign in with X (requests go to api.x.ai with the sign-in, falling back to the key). Grok chats use it unless the chat has its own pick, with a switch to turn that off. Switching modes no longer changes saved defaults.

Tested with unit tests and mocked e2e; not yet against xAI's real service.

**Part 2 delivered:** a **Customize** settings tab.

- **Global:** a response style (presets or your own words), "what models should know about you", and the existing standing instructions.
- **Per model:** overrides with a field-level fallback to Global; instructions can replace the global ones or be added to them.
- **Managing it:** **Use Global** clears a model's settings, a "what this model receives" preview shows the result, and the chat's parameters panel shows Global or its own with a shortcut. This works for every provider. Consortium members use their own model's customization.

**Part 3 delivered:** the Consortium as a first-class, full-page studio.

- **Manual teams:** 2–6 agents, each with a name, a role, a model and provider, and an optional saved agent; a coordinator, and members can be reordered.
- **Automatic teams:** a strong model proposes the size, roles, models and a rationale, which you can edit or regenerate.
- **Quick starts**, including operational crews.
- **A new execution-crew mode:** jobs run at the same time, an auditor checks, there is one fix pass, then a report, with no voting.
- **A Team panel** beside the chat with live status, the shared scratchpad and the controls.
- The existing discussion-and-vote flow is unchanged.

**Part 4 delivered:** Skills as a first-class library item, in the SKILL.md format.

- **Getting skills:** install from a SKILL.md, a folder, a zip or a GitHub link; create, edit and export them.
- **Where they are used:** everywhere, only where assigned (agents, projects, consortium members), or off. Skills can declare the tools and connectors they need and are held back when those are missing.
- **In a chat:** progressive disclosure (`read_skill`), `/skill-name` loads a skill in full, and a Skills chip shows what a chat has.
- **Compatibility:** plugin skills keep working.

Still to do from the roadmap: auto-suggesting skills from the request.
