import { useMemo, useState } from "react";
import { deleteChat, moveToProject, newChat, openChat, renameChat, setArchived, setView, syncNow, togglePin, useApp } from "../state/store";
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

function ChatRow({ m, active, busy }: { m: ConvMeta; active: boolean; busy: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const projects = useApp((s) => s.lib.projects);
  if (renaming) {
    return (
      <input
        type="text"
        autoFocus
        defaultValue={m.title}
        aria-label="Chat title"
        onBlur={(e) => {
          void renameChat(m.id, e.target.value);
          setRenaming(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setRenaming(false);
        }}
      />
    );
  }
  return (
    <div className={`conv ${active ? "active" : ""}`}>
      <button className="conv-open" onClick={() => void openChat(m.id)} title={m.title}>
        {m.title}
      </button>
      {busy && <span className="dot" title="Working" />}
      <span className="conv-actions">
        <button className={`icon-btn ${m.pinned ? "on" : ""}`} title={m.pinned ? "Unpin" : "Pin"} onClick={() => void togglePin(m.id)}>
          <Icon.pin />
        </button>
        <span className="pop-anchor">
          <button className="icon-btn" title="More" aria-expanded={menu} onClick={() => setMenu((x) => !x)}>
            <Icon.more />
          </button>
          {menu && (
            <div className="popover" style={{ right: 0, top: 30, minWidth: 220 }} onMouseLeave={() => setMenu(false)}>
              <button className="menu-item" onClick={() => (setMenu(false), setRenaming(true))}><Icon.edit /> Rename</button>
              <button className="menu-item" onClick={() => (setMenu(false), void setArchived(m.id, !m.archived))}><Icon.archive /> {m.archived ? "Unarchive" : "Archive"}</button>
              {projects.length > 0 && <div className="menu-head">Move to project</div>}
              {projects.map((p) => (
                <button key={p.id} className={`menu-item ${m.projectId === p.id ? "sel" : ""}`} onClick={() => (setMenu(false), void moveToProject(m.id, m.projectId === p.id ? undefined : p.id))}>
                  <span>{p.emoji ?? "📁"}</span> <span className="grow">{p.name}</span>
                </button>
              ))}
              <button
                className="menu-item"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  setMenu(false);
                  if (confirm(`Delete "${m.title}"? It is removed from your synced devices too.`)) void deleteChat(m.id);
                }}
              >
                <Icon.trash /> Delete
              </button>
            </div>
          )}
        </span>
      </span>
    </div>
  );
}

export function Sidebar() {
  const metas = useApp((s) => s.metas);
  const activeId = useApp((s) => s.activeId);
  const busy = useApp((s) => s.busy);
  const open = useApp((s) => s.sidebarOpen);
  const sync = useApp((s) => s.sync);
  const view = useApp((s) => s.view);
  const projects = useApp((s) => s.lib.projects);
  const automations = useApp((s) => s.lib.automations);
  const showArchived = useApp((s) => s.showArchived);
  const [query, setQuery] = useState("");

  const [grokOpen, setGrokOpen] = useState(() => {
    try {
      return localStorage.getItem("meridian.grokOpen") !== "0";
    } catch {
      return true;
    }
  });
  const { groups, grok } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const out: { name: string; items: ConvMeta[] }[] = [];
    const grokChats: ConvMeta[] = [];
    for (const m of metas) {
      if (!!m.archived !== showArchived) continue;
      if (!q && m.projectId) continue; // project chats live under their project
      if (q && !m.title.toLowerCase().includes(q) && !(m.preview ?? "").toLowerCase().includes(q)) continue;
      // Grok chats get their own section at the very bottom (only a grouping: pin, archive, move work as usual)
      if (m.grok && !showArchived) {
        grokChats.push(m);
        continue;
      }
      const g = showArchived ? "Archived" : groupOf(m, now);
      const last = out[out.length - 1];
      if (last?.name === g) last.items.push(m);
      else out.push({ name: g, items: [m] });
    }
    // pinned Grok chats first, like the main list
    grokChats.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    return { groups: out, grok: grokChats };
  }, [metas, query, showArchived]);

  const syncLabel =
    sync.state === "off" ? "Sync off" : sync.state === "syncing" ? "Syncing…" : sync.state === "error" ? "Sync problem" : sync.at ? `Synced ${new Date(sync.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Sync on";
  const nav = (name: string, label: string, icon: React.ReactNode, count?: number) => (
    <button className={`nav-item ${view.name === name ? "sel" : ""}`} onClick={() => setView({ name } as never)}>
      {icon}
      <span className="grow">{label}</span>
      {count ? <span className="badge">{count}</span> : null}
    </button>
  );

  return (
    <aside className={`sidebar ${open ? "" : "closed"}`} aria-hidden={!open}>
      <div className="sidebar-top">
        <div className="row">
          <div className="brand grow">
            <span className="mark">M</span>Meridian
          </div>
          <button className="icon-btn" title="Private chat (not saved)" onClick={() => newChat({ incognito: true })}>
            <Icon.mask />
          </button>
          <button className="icon-btn" title="Hide sidebar" onClick={() => useApp.setState({ sidebarOpen: false })}>
            <Icon.menu />
          </button>
        </div>
        <button className="btn primary" onClick={() => newChat()}>
          <Icon.plus /> New chat
        </button>
        <nav className="nav">
          {nav("search", "Search", <Icon.search />)}
          {nav("agents", "Agents", <Icon.agent />)}
          {nav("projects", "Projects", <Icon.folder />)}
          {nav("prompts", "Prompts", <Icon.prompt />)}
          {nav("automations", "Automations", <Icon.clock />, automations.filter((a) => a.enabled).length)}
        </nav>
      </div>
      <nav className="conv-list">
        {projects.length > 0 && !query && !showArchived && (
          <div>
            <div className="conv-group">Projects</div>
            {projects.slice(0, 8).map((p) => (
              <button key={p.id} className={`nav-item ${view.name === "project" && view.id === p.id ? "sel" : ""}`} onClick={() => setView({ name: "project", id: p.id })}>
                <span>{p.emoji ?? "📁"}</span>
                <span className="grow">{p.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{metas.filter((m) => m.projectId === p.id && !m.archived).length || ""}</span>
              </button>
            ))}
          </div>
        )}
        <input type="search" placeholder="Filter chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter chats" style={{ margin: "10px 0 2px" }} />
        {groups.length === 0 && grok.length === 0 && <div className="hint" style={{ padding: 12 }}>{query ? "No chats match." : showArchived ? "No archived chats." : "Your chats will appear here."}</div>}
        {groups.map((g) => (
          <div key={g.name}>
            <div className="conv-group">{g.name}</div>
            {g.items.map((m) => (
              <ChatRow key={m.id} m={m} active={m.id === activeId && view.name === "chat"} busy={busy[m.id] !== undefined} />
            ))}
          </div>
        ))}
        {grok.length > 0 && (
          <div className="grok-section">
            <button
              className="conv-group grok-head"
              aria-expanded={grokOpen}
              onClick={() => {
                setGrokOpen(!grokOpen);
                try {
                  localStorage.setItem("meridian.grokOpen", grokOpen ? "0" : "1");
                } catch {
                  /* not remembered */
                }
              }}
            >
              <span className="grok-mark">𝕏</span>
              <span className="grow">Grok</span>
              <span className="badge">{grok.length}</span>
              <span aria-hidden="true">{grokOpen ? "▾" : "▸"}</span>
            </button>
            {grokOpen && grok.map((m) => <ChatRow key={m.id} m={m} active={m.id === activeId && view.name === "chat"} busy={busy[m.id] !== undefined} />)}
          </div>
        )}
        <button className="link-btn" onClick={() => useApp.setState({ showArchived: !showArchived })}>
          {showArchived ? "← Back to chats" : `Archived chats (${metas.filter((m) => m.archived).length})`}
        </button>
      </nav>
      <div className="sidebar-bottom">
        <button className="sync-pill" title={sync.message ?? (sync.target ? `Syncing with ${sync.target}` : "Set up sync")} onClick={() => (sync.state === "off" ? useApp.setState({ settingsTab: "sync" }) : void syncNow())}>
          <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 6, width: 16, height: 16 }}>
            <Icon.cloud />
          </span>
          {syncLabel}
        </button>
        <button className="icon-btn" title="Usage" onClick={() => setView({ name: "usage" })}>
          <Icon.chart />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => useApp.setState({ settingsTab: "providers" })}>
          <Icon.gear />
        </button>
      </div>
    </aside>
  );
}
