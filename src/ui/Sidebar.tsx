import { useMemo, useState } from "react";
import { deleteChat, newChat, openChat, renameChat, syncNow, togglePin, useApp } from "../state/store";
import type { ConvMeta } from "../types";
import { Icon } from "./icons";

function groupOf(m: ConvMeta, now: number): string {
  if (m.pinned) return "Pinned";
  const days = Math.floor((startOfDay(now) - startOfDay(m.updatedAt)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  return "Older";
}
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function Sidebar() {
  const metas = useApp((s) => s.metas);
  const activeId = useApp((s) => s.activeId);
  const busy = useApp((s) => s.busy);
  const open = useApp((s) => s.sidebarOpen);
  const sync = useApp((s) => s.sync);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const out: { name: string; items: ConvMeta[] }[] = [];
    for (const m of metas) {
      if (q && !m.title.toLowerCase().includes(q) && !(m.preview ?? "").toLowerCase().includes(q)) continue;
      const g = groupOf(m, now);
      const last = out[out.length - 1];
      if (last?.name === g) last.items.push(m);
      else out.push({ name: g, items: [m] });
    }
    return out;
  }, [metas, query]);

  const syncLabel =
    sync.state === "off"
      ? "Sync off"
      : sync.state === "syncing"
        ? "Syncing…"
        : sync.state === "error"
          ? "Sync problem"
          : sync.at
            ? `Synced ${new Date(sync.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Sync on";

  return (
    <aside className={`sidebar ${open ? "" : "closed"}`} aria-hidden={!open}>
      <div className="sidebar-top">
        <div className="row">
          <div className="brand grow">
            <span className="mark">M</span>Meridian
          </div>
          <button className="icon-btn" title="Hide sidebar" onClick={() => useApp.setState({ sidebarOpen: false })}>
            <Icon.menu />
          </button>
        </div>
        <button className="btn primary" onClick={newChat}>
          <Icon.plus /> New chat
        </button>
        <input type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
      </div>
      <nav className="conv-list">
        {groups.length === 0 && <div className="hint" style={{ padding: 12 }}>{query ? "No chats match." : "Your chats will appear here."}</div>}
        {groups.map((g) => (
          <div key={g.name}>
            <div className="conv-group">{g.name}</div>
            {g.items.map((m) =>
              renaming === m.id ? (
                <input
                  key={m.id}
                  type="text"
                  autoFocus
                  defaultValue={m.title}
                  aria-label="Chat title"
                  onBlur={(e) => {
                    void renameChat(m.id, e.target.value);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <div key={m.id} className={`conv ${m.id === activeId ? "active" : ""}`}>
                  <button className="conv-open" onClick={() => void openChat(m.id)} title={m.title}>
                    {m.title}
                  </button>
                  {busy[m.id] !== undefined && <span className="dot" title="Working" />}
                  <span className="conv-actions">
                    <button className={`icon-btn ${m.pinned ? "on" : ""}`} title={m.pinned ? "Unpin" : "Pin"} onClick={() => void togglePin(m.id)}>
                      <Icon.pin />
                    </button>
                    <button className="icon-btn" title="Rename" onClick={() => setRenaming(m.id)}>
                      <Icon.edit />
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete"
                      onClick={() => {
                        if (confirm(`Delete "${m.title}"? It is removed from your synced devices too.`)) void deleteChat(m.id);
                      }}
                    >
                      <Icon.trash />
                    </button>
                  </span>
                </div>
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="sync-pill"
          title={sync.message ?? (sync.target ? `Syncing with ${sync.target}` : "Set up sync")}
          onClick={() => (sync.state === "off" ? useApp.setState({ settingsTab: "sync" }) : void syncNow())}
        >
          <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 6, width: 16, height: 16 }}>
            <Icon.cloud />
          </span>
          {syncLabel}
        </button>
        <button className="icon-btn" title="Settings" onClick={() => useApp.setState({ settingsTab: "providers" })}>
          <Icon.gear />
        </button>
      </div>
    </aside>
  );
}
