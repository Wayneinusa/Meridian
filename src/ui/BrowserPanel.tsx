import { closeSession } from "../browser/session";
import { useApp } from "../state/store";
import { Icon } from "./icons";

/** What the assistant's browser shows in this chat, next to the conversation. */
export function BrowserPanel() {
  const id = useApp((s) => s.activeId);
  const view = useApp((s) => (s.activeId ? s.browserViews[s.activeId] : undefined));
  const showWindow = useApp((s) => s.settings.browser.showWindow);
  return (
    <aside className="artifacts-panel browser-panel" aria-label="The assistant's browser">
      <div className="modal-head">
        <h2>Browser</h2>
        <button className="icon-btn" title="Hide" onClick={() => useApp.setState({ browserOpen: false })}>
          <Icon.x />
        </button>
      </div>
      {view ? (
        <div className="browser-body">
          <div className="browser-url" title={view.url}>
            <b>{view.title || "(untitled)"}</b>
            <span>{view.url}</span>
          </div>
          {view.image && <img src={view.image} alt={`What the browser shows: ${view.title}`} data-testid="browser-shot" />}
          <p className="hint">
            {view.engine === "firefox" ? "Firefox" : "Meridian's Chromium"}, with its own profile (not your browser).{" "}
            {showWindow ? "Its window is open on your desktop: you can take over there at any time." : "It runs without a window; turn on “Show the browser window” in Settings to take over."}
          </p>
          <button className="btn small" onClick={() => id && void closeSession(id)}>
            <Icon.x /> Close the browser
          </button>
        </div>
      ) : (
        <div className="hint" style={{ padding: 14 }}>The assistant has not opened a page in this chat.</div>
      )}
    </aside>
  );
}
