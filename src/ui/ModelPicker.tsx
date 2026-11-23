import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelKind } from "../types";
import { currentModelRef, setChatModel, toggleFavorite, useApp } from "../state/store";
import { findModel } from "../providers/registry";
import { modelLabel, providerReady } from "../providers/backends";
import { pricingOf, setupNeeded, useProviders } from "./BackendPicker";
import type { ModelInfo, ProviderConfig } from "../types";
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
    const fits = (m: ModelInfo) => (m.kind === tab || (tab === "image" && m.kind === "chat" && m.caps.imageOutput)) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    const isFav = (p: ProviderConfig, m: ModelInfo) => settings.favorites.includes(`${p.id}::${m.id}`);
    const enabled = providers.filter((p) => p.enabled);
    // favourites first, across every provider, then each provider's other models
    const favs = enabled.flatMap((p) => p.models.filter((m) => fits(m) && isFav(p, m)).map((m) => ({ provider: p, model: m })));
    const rest = enabled
      .map((p) => ({ title: p.name, provider: p, items: p.models.filter((m) => fits(m) && !isFav(p, m)).map((m) => ({ provider: p, model: m })) }))
      .filter((g) => g.items.length);
    return favs.length ? [{ title: "★ Favourites", provider: null as ProviderConfig | null, items: favs }, ...rest] : rest;
  }, [providers, query, tab, settings.favorites]);

  return (
    <div className="pop-anchor" ref={wrap}>
      <button className="model-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Choose model">
        <span>{current ? modelLabel(current.provider, current.model) : "Choose model"}</span>
        <Icon.chevron />
      </button>
      {open && (
        <div className="popover model-pop" role="listbox">
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
            <div key={g.provider?.id ?? "favourites"}>
              <div className="menu-head">
                {g.title}
                {g.provider && pricingOf(g.provider) === "free" ? " · free" : ""}
                {g.provider && (tab !== "chat" && setupNeeded(g.provider, tab) ? ` · ${setupNeeded(g.provider, tab)}` : !providerReady(g.provider) && tab === "chat" ? " · no key" : "")}
              </div>
              {g.items.map(({ provider: p, model: m }) => {
                const sel = ref?.providerId === p.id && ref.modelId === m.id;
                const fav = settings.favorites.includes(`${p.id}::${m.id}`);
                return (
                  <button
                    key={`${p.id}::${m.id}`}
                    className={`menu-item ${sel ? "sel" : ""}`}
                    role="option"
                    aria-selected={sel}
                    onClick={() => {
                      void setChatModel({ providerId: p.id, modelId: m.id });
                      setOpen(false);
                    }}
                  >
                    <span
                      role="button"
                      tabIndex={0}
                      className={`star ${fav ? "on" : ""}`}
                      title={fav ? "Remove from favourites" : "Favourite (shown first)"}
                      aria-label={fav ? `Unfavourite ${m.name}` : `Favourite ${m.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleFavorite({ providerId: p.id, modelId: m.id });
                      }}
                    >
                      ★
                    </span>
                    <span className="model-name" title={m.id}>
                      {m.name}
                      {!g.provider && <span className="muted"> · {p.name}</span>}
                    </span>
                    <span className="muted model-caps">{capBadges(m).join(" · ")}</span>
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
