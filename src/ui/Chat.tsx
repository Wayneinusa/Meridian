import { useEffect, useLayoutEffect, useRef } from "react";
import { send, useApp } from "../state/store";
import { Composer } from "./Composer";
import { Icon } from "./icons";
import { MessageView } from "./MessageView";
import { ModelPicker } from "./ModelPicker";
import { ParamsPanel } from "./ParamsPanel";

const STARTERS = [
  { title: "Make a spreadsheet", text: "Create a monthly household budget spreadsheet with example categories and formulas for totals." },
  { title: "Write a document", text: "Write a one-page project proposal for a community garden and give it to me as a PDF." },
  { title: "Build a slide deck", text: "Create a 6-slide presentation introducing a new coffee brand, with speaker notes." },
  { title: "Plan something", text: "Plan a 3-day trip to Lisbon as a table with times, places and rough costs." },
];

export function Chat() {
  const active = useApp((s) => s.active);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const paramsOpen = useApp((s) => s.paramsOpen);
  const busy = useApp((s) => (s.activeId ? s.busy[s.activeId] !== undefined : false));
  const hasParams = !!(active?.params && Object.keys(active.params).length) || !!active?.systemPrompt;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // follow the stream unless the user scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [active?.id]);

  const messages = active?.messages ?? [];

  return (
    <main className="main">
      <header className="chat-header">
        {!sidebarOpen && (
          <button className="icon-btn" title="Show chats" onClick={() => useApp.setState({ sidebarOpen: true })}>
            <Icon.menu />
          </button>
        )}
        <div className="chat-title">{active?.title ?? "New chat"}</div>
        <ModelPicker />
        <button
          className={`icon-btn ${paramsOpen || hasParams ? "on" : ""}`}
          title="Model parameters"
          aria-pressed={paramsOpen}
          onClick={() => useApp.setState({ paramsOpen: !paramsOpen })}
        >
          <Icon.sliders />
        </button>
      </header>

      {messages.length === 0 ? (
        <div className="empty">
          <div>
            <h1>What are we working on?</h1>
            <p>Ask anything, attach documents and images, or have files made for you. Pick the model at the top right.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => void send(s.text)}>
                  <b>{s.title}</b>
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="messages-inner">
            {messages.map((m, i) => (
              <MessageView key={m.id} message={m} isLast={i === messages.length - 1} busy={busy} />
            ))}
          </div>
        </div>
      )}
      <Composer />
      {paramsOpen && <ParamsPanel />}
    </main>
  );
}
