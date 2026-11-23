import { useEffect, useState } from "react";
import { browserStatus, listenInstall } from "../browser/session";
import { invoke, platform } from "../platform";
import { openExternal } from "../platform/files";
import { errText, toast, updateSettings, useApp } from "../state/store";
import type { Settings } from "../types";

type Status = Awaited<ReturnType<typeof browserStatus>>;

/** Settings → Tools & computer → Browser: which browser the assistant uses and how carefully. */
export function BrowserSettings() {
  const settings = useApp((s) => s.settings);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState("");
  const p = platform();
  const set = (patch: Partial<Settings["browser"]>) => void updateSettings((s) => ({ browser: { ...s.browser, ...patch } }));
  const refresh = () => void browserStatus().then(setStatus, () => setStatus(null));
  useEffect(() => {
    if (p.desktop) refresh();
  }, []);

  if (!p.desktop) {
    return <div className="note">The assistant's own browser runs in the Windows, macOS and Linux app. {p.mobile ? "iPhone and iPad do not let apps drive a browser." : ""}</div>;
  }

  const download = async () => {
    setBusy("starting download");
    const stop = await listenInstall(setBusy);
    try {
      await invoke("browser_install_chromium");
      toast("Meridian's Chromium is ready.", "ok");
    } catch (e) {
      toast(`Download failed: ${errText(e)}`, "error");
    } finally {
      stop();
      setBusy("");
      refresh();
    }
  };

  const b = settings.browser;
  return (
    <div className="card" data-testid="browser-settings">
      <label className="switch">
        <input type="checkbox" checked={settings.tools.browser} onChange={(e) => void updateSettings((s) => ({ tools: { ...s.tools, browser: e.target.checked } }))} />
        <span>
          Let the assistant use its own browser
          <small>It opens pages, clicks, fills forms and reads data in a separate browser with its own profile. Your own browser, logins and history are never touched.</small>
        </span>
      </label>
      <div className="field">
        <span>Browser</span>
        <div className="engine-choice">
          <label className="switch">
            <input type="radio" name="engine" checked={b.engine === "chromium"} onChange={() => set({ engine: "chromium" })} />
            <span>
              Meridian's Chromium (recommended)
              <small>
                {status?.chromium ? `Downloaded (version ${status.chromium_version}). The same version on every computer, updated when you download again.` : "Downloaded once into Meridian's folder (about 150 MB), not installed system-wide."}
              </small>
            </span>
          </label>
          <div className="row wrap" style={{ margin: "0 0 8px 28px" }}>
            {busy ? (
              <span className="hint"><span className="spinner" style={{ display: "inline-block", verticalAlign: "-2px" }} /> {busy}</span>
            ) : (
              <>
                <button className="btn small" onClick={() => void download()}>{status?.chromium ? "Update" : "Download"}</button>
                {status?.chromium && (
                  <button className="btn small danger" onClick={() => void invoke("browser_remove_chromium").then(refresh, (e) => toast(errText(e), "error"))}>Remove</button>
                )}
              </>
            )}
          </div>
          <label className="switch">
            <input type="radio" name="engine" checked={b.engine === "firefox"} onChange={() => set({ engine: "firefox" })} />
            <span>
              Firefox
              <small>{status?.firefox ? `Found: ${status.firefox}. Meridian uses its own profile, not yours.` : "Not found on this computer."}</small>
            </span>
          </label>
          {!status?.firefox && (
            <button className="link-btn" style={{ marginLeft: 28 }} onClick={() => void openExternal("https://www.mozilla.org/firefox/new/")}>Get Firefox</button>
          )}
        </div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={b.showWindow} onChange={(e) => set({ showWindow: e.target.checked })} />
        <span>
          Show the browser window
          <small>You can watch and take over at any time. Off: it runs without a window and you follow it in the panel beside the chat.</small>
        </span>
      </label>
      <label className="field">
        <span>Ask before</span>
        <select value={b.approval} onChange={(e) => set({ approval: e.target.value as Settings["browser"]["approval"] })} aria-label="Browser approval">
          <option value="rules">Going to new sites, submitting forms, typing passwords or card numbers, downloads, logins</option>
          <option value="each">Every action except reading the page</option>
        </select>
        <small className="hint">Sites you named in the chat, found by a search in it, or listed below open without asking. The approval card also offers “Allow for this task”.</small>
      </label>
      <label className="field">
        <span>Sites it may open without asking (one per line)</span>
        <textarea
          rows={3}
          spellCheck={false}
          defaultValue={b.allowSites.join("\n")}
          placeholder={"wikipedia.org\nmy-company.com"}
          onBlur={(e) => set({ allowSites: e.target.value.split(/\s+/).map((x) => x.trim()).filter(Boolean) })}
          aria-label="Allowed sites"
        />
      </label>
    </div>
  );
}
