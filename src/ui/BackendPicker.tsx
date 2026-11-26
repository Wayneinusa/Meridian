import { useEffect, useMemo, useRef, useState } from "react";
import { BACKENDS, providerReady, type Pricing } from "../providers/backends";
import { engineProviders } from "../plugins/engines";
import { imagineFor, mediaChoice } from "../tools/media";
import { currentModelRef, setChatModel, setDefaultMedia, updateSettings, useApp } from "../state/store";
import type { ModelInfo, ModelRef, ProviderConfig } from "../types";
import { Icon } from "./icons";

/** Providers from settings plus the image / video engines of installed plugins. */
export function useProviders(): ProviderConfig[] {
  const providers = useApp((s) => s.settings.providers);
  const plugins = useApp((s) => s.lib.plugins);
  return useMemo(() => [...providers, ...engineProviders(plugins)], [providers, plugins]);
}

const PRICE_LABEL: Record<Pricing | "key" | "plugin" | "xai", string> = {
  free: "Free",
  "free-credits": "Free daily allowance",
  trial: "Pay per use",
  paid: "Paid",
  custom: "Custom",
  key: "Your key",
  xai: "Sign-in or key",
  plugin: "Plugin",
};

export function pricingOf(p: ProviderConfig): keyof typeof PRICE_LABEL {
  if (p.kind === "plugin") return "plugin";
  if (p.kind === "xai") return "xai";
  return BACKENDS[p.kind]?.pricing ?? "key";
}

const ORDER: (keyof typeof PRICE_LABEL)[] = ["free", "free-credits", "plugin", "xai", "key", "trial", "custom", "paid"];

/** How a backend is named in the menu: xAI's media models are Grok Imagine. */
export const backendName = (p: ProviderConfig) => (p.kind === "xai" ? "Grok Imagine (xAI)" : p.name);

/** Why a provider cannot make this kind right now, or null when it can. */
export function setupNeeded(p: ProviderConfig, kind: "image" | "video"): string | null {
  if (providerReady(p, kind)) return null;
  const b = BACKENDS[p.kind];
  if (b?.needsAccountId && !p.accountId) return "needs account ID and token";
  if (b?.keyless === "image" && kind === "video") return "video needs a free key";
  return "needs a key";
}

const fits = (m: ModelInfo, kind: "image" | "video") => m.kind === kind || (kind === "image" && !!m.caps.imageOutput);

/** Image / Video backend choice for the current generation, plus the saved defaults. */
export function BackendPicker({ kind }: { kind: "image" | "video" }) {
  const providers = useProviders();
  const settings = useApp((s) => s.settings);
  const active = useApp((s) => s.active);
  const draft = useApp((s) => s.draft);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLSpanElement>(null);
  const ref = currentModelRef(active);
  const def = kind === "image" ? settings.imageModel : settings.videoModel;
  // what new messages in a chat like this one get when nothing is picked for it
  const chat = active ?? draft;
  const auto = mediaChoice(settings, kind)?.ref;
  const grokPick = mediaChoice(settings, kind, { model: chat.model, chatModel: chat.chatModel })?.reason === "grok";
  const imagine = imagineFor(settings, kind);

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
      .filter((p) => p.enabled && (p.models.some((m) => fits(m, kind)) || BACKENDS[p.kind]?.makes.includes(kind)))
      .map((p) => ({
        provider: p,
        pricing: pricingOf(p),
        setup: setupNeeded(p, kind),
        models: p.models.filter((m) => fits(m, kind) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || backendName(p).toLowerCase().includes(q))),
      }))
      .filter((g) => g.models.length || (!q && g.setup))
      .sort((a, b) => ORDER.indexOf(a.pricing) - ORDER.indexOf(b.pricing));
  }, [providers, query, kind]);

  const current = providers.find((p) => p.id === ref?.providerId);
  const currentModel = current?.models.find((m) => m.id === ref?.modelId);
  const isDefault = (r: ModelRef) => (def ? def.providerId === r.providerId && def.modelId === r.modelId : auto?.providerId === r.providerId && auto.modelId === r.modelId);
  const many = groups.reduce((n, g) => n + g.models.length, 0) > 12;

  return (
    <span className="pop-anchor" ref={wrap}>
      <button className="chip-btn backend-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title={`${kind === "image" ? "Image" : "Video"} backend`}>
        {current && pricingOf(current) === "free" && <span className="tag-free">Free</span>}
        <span className="backend-name">{current ? `${backendName(current)} · ${currentModel?.name ?? ref?.modelId}` : "Choose a backend"}</span>
        <Icon.chevron />
      </button>
      {open && (
        <div className="popover backend-pop" role="listbox" aria-label={`${kind === "image" ? "Image" : "Video"} backends`}>
          <div className="menu-head">{kind === "image" ? "Image" : "Video"} backend for this chat</div>
          {many && <input type="search" placeholder="Search backends and models" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="Search backends" />}
          {groups.map((g) => (
            <div key={g.provider.id} className="backend-group">
              <div className="menu-head row">
                <span className="grow">{backendName(g.provider)}</span>
                <span className={`badge ${g.pricing === "free" ? "ok" : ""}`}>{PRICE_LABEL[g.pricing]}</span>
              </div>
              {g.setup ? (
                <button className="menu-item muted" onClick={() => (setOpen(false), useApp.setState({ settingsTab: "providers" }))}>
                  <Icon.gear /> Set up ({g.setup})
                </button>
              ) : (
                g.models.map((m) => {
                  const r = { providerId: g.provider.id, modelId: m.id };
                  const sel = ref?.providerId === r.providerId && ref.modelId === r.modelId;
                  const dflt = isDefault(r);
                  return (
                    <div key={m.id} className={`menu-item backend-item ${sel ? "sel" : ""}`} role="option" aria-selected={sel}>
                      <button className="grow link-btn" title={m.id} onClick={() => (setOpen(false), void setChatModel(r))}>
                        {m.name}
                      </button>
                      {grokPick && imagine && imagine.providerId === r.providerId && imagine.modelId === r.modelId && (
                        <span className="badge" title="Chats with a Grok model use Grok Imagine unless you pick a backend for the chat">Grok chats</span>
                      )}
                      {dflt ? (
                        <span className="badge ok" title={def ? "Used for new chats" : "Chosen automatically; click another model's Make default to change"}>Default</span>
                      ) : (
                        <button className="btn small" onClick={() => void setDefaultMedia(kind, r)} title={`Use ${m.name} for ${kind === "image" ? "images" : "videos"} in new chats`}>
                          Make default
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ))}
          {!groups.length && <div className="hint" style={{ padding: 10 }}>Nothing matches.</div>}
          {imagine && (
            <label className="switch menu-item" style={{ padding: "6px 10px" }}>
              <input type="checkbox" checked={settings.grokImagine !== false} onChange={(e) => void updateSettings({ grokImagine: e.target.checked })} />
              <span>
                Use Grok Imagine in Grok chats
                <small>When the chat model is Grok and you have not picked a backend for the chat.</small>
              </span>
            </label>
          )}
          {def && (
            <button className="menu-item" onClick={() => void setDefaultMedia(kind, undefined)}>
              <Icon.refresh /> Let the app choose the default
            </button>
          )}
          <button className="menu-item" onClick={() => (setOpen(false), useApp.setState({ settingsTab: "providers" }))}>
            <Icon.gear /> Set up free and paid backends
          </button>
        </div>
      )}
    </span>
  );
}
