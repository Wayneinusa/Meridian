import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelKind } from "../types";
import { currentModelRef, setChatModel, toggleFavorite, useApp } from "../state/store";
import { findModel } from "../providers/registry";
import { modelLabel, providerReady } from "../providers/backends";
import { pricingOf, setupNeeded, useProviders } from "./BackendPicker";
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
  const providers = useProviders();
  const active = useApp((s) => s.active);
  // re-read on every store change so a choice made before the chat exists shows up
  useApp((s) => s.metas);
  useApp((s) => s.draft);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const ref = currentModelRef(active);
  const current = findModel(settings, ref);
  const [tab, setTab] = useState<ModelKind>(current?.model.kind ?? "chat");
  useEffect(() => {
    if (open) setTab(current?.model.kind ?? "chat");
  }, [open]);

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
    return providers
      .filter((p) => p.enabled)
      .map((p) => ({
        provider: p,
        models: p.models
          .filter((m) => (m.kind === tab || (tab === "image" && m.kind === "chat" && m.caps.imageOutput)) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)))
          .sort((a, b) => Number(settings.favorites.includes(`${p.id}::${b.id}`)) - Number(settings.favorites.includes(`${p.id}::${a.id}`))),
      }))
      .filter((g) => g.models.length);
  }, [providers, query, tab]);

  return (
    <div className="pop-anchor" ref={wrap}>
      <button className="model-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Choose model">
        <span>{current ? modelLabel(current.provider, current.model) : "Choose model"}</span>
        <Icon.chevron />
      </button>
      {open && (
        <div className="popover" style={{ right: 0, top: 42, width: 340 }} role="listbox">
          <div className="seg" role="tablist" style={{ marginBottom: 6 }}>
            {(["chat", "image", "video"] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "sel" : ""} onClick={() => setTab(k)}>
                {k === "chat" ? "Chat" : k === "image" ? "Image" : "Video"}
              </button>
            ))}
          </div>
          <input type="search" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Search models" />
          {groups.length === 0 && (
            <div className="hint" style={{ padding: 10 }}>
              {tab === "chat"
                ? "No models yet. Add an API key in Settings → Providers & keys and the model list is fetched for you."
                : tab === "image"
                  ? "No image backends are on. Turn on Pollinations or AI Horde (free) in Settings → Providers & keys."
                  : "No video models yet. Paste a free Pollinations key (enter.pollinations.ai) in Settings → Providers & keys, or a key for OpenAI, Google, xAI, fal.ai or Runway."}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.provider.id}>
              <div className="menu-head">
                {g.provider.name}
                {pricingOf(g.provider) === "free" ? " · free" : ""}
                {tab !== "chat" && setupNeeded(g.provider, tab) ? ` · ${setupNeeded(g.provider, tab)}` : !providerReady(g.provider) && tab === "chat" ? " · no key" : ""}
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
                    <span
                      role="button"
                      tabIndex={0}
                      className={`star ${settings.favorites.includes(`${g.provider.id}::${m.id}`) ? "on" : ""}`}
                      title="Favourite (shown first)"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleFavorite({ providerId: g.provider.id, modelId: m.id });
                      }}
                    >
                      ★
                    </span>
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
