import { useEffect, useMemo, useRef, useState } from "react";
import { currentModelRef, setChatModel, useApp } from "../state/store";
import { findModel } from "../providers/registry";
import type { ModelInfo } from "../types";
import { Icon } from "./icons";

export function capBadges(m: ModelInfo): string[] {
  const out: string[] = [];
  if (m.caps.vision) out.push("images");
  if (m.caps.pdf) out.push("PDF");
  if (m.caps.tools) out.push("tools");
  if (m.caps.thinking) out.push("thinking");
  if (m.caps.imageOutput) out.push("draws");
  return out;
}

export function ModelPicker() {
  const settings = useApp((s) => s.settings);
  const active = useApp((s) => s.active);
  // re-read on every store change so a choice made before the chat exists shows up
  useApp((s) => s.metas);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const ref = currentModelRef(active);
  const current = findModel(settings, ref);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return settings.providers
      .filter((p) => p.enabled)
      .map((p) => ({
        provider: p,
        models: p.models.filter((m) => m.kind === "chat" && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))),
      }))
      .filter((g) => g.models.length);
  }, [settings.providers, query]);

  return (
    <div className="pop-anchor" ref={wrap}>
      <button className="model-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Choose model">
        <span>{current ? current.model.name : "Choose model"}</span>
        <Icon.chevron />
      </button>
      {open && (
        <div className="popover" style={{ right: 0, top: 42, width: 340 }} role="listbox">
          <input type="search" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Search models" />
          {groups.length === 0 && (
            <div className="hint" style={{ padding: 10 }}>
              No models yet. Add an API key in Settings → Providers and the model list is fetched for you.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.provider.id}>
              <div className="menu-head">
                {g.provider.name}
                {!g.provider.hasKey && g.provider.kind !== "openai-compatible" ? " · no key" : ""}
              </div>
              {g.models.map((m) => {
                const sel = ref?.providerId === g.provider.id && ref.modelId === m.id;
                return (
                  <button
                    key={m.id}
                    className={`menu-item ${sel ? "sel" : ""}`}
                    role="option"
                    aria-selected={sel}
                    onClick={() => {
                      void setChatModel({ providerId: g.provider.id, modelId: m.id });
                      setOpen(false);
                    }}
                  >
                    <span className="grow" title={m.id}>{m.name}</span>
                    <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{capBadges(m).join(" · ")}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              useApp.setState({ settingsTab: "providers" });
            }}
          >
            <Icon.gear /> Manage providers and keys
          </button>
        </div>
      )}
    </div>
  );
}
