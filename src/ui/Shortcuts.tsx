import { useEffect, useState } from "react";
import { attachToComposer, newChat, setView, stop, useApp } from "../state/store";

/** Keyboard shortcuts, and "Quote" for text selected in an answer. */
export function Shortcuts() {
  const [quote, setQuote] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView({ name: "search" });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChat();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        newChat({ incognito: true });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useApp.setState({ settingsTab: "general" });
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useApp.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
      } else if (e.key === "Escape" &&  !useApp.getState().settingsTab && !document.querySelector(".overlay")) {
        const id = useApp.getState().activeId;
        if (id && useApp.getState().busy[id] !== undefined) stop(id);
      }
    };
    const onUp = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      const node = sel?.anchorNode?.parentElement;
      if (!text || !node?.closest(".msg.assistant") || text.length > 4000) return setQuote(null);
      const r = sel!.getRangeAt(0).getBoundingClientRect();
      setQuote({ x: r.left + r.width / 2, y: r.top, text });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchend", onUp);
    };
  }, []);
  if (!quote) return null;
  return (
    <button
      className="btn small primary quote-btn"
      style={{ left: quote.x, top: Math.max(8, quote.y - 40) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        attachToComposer([], `> ${quote.text.replace(/\n/g, "\n> ")}\n\n`);
        window.getSelection()?.removeAllRanges();
        setQuote(null);
      }}
    >
      Quote in reply
    </button>
  );
}
