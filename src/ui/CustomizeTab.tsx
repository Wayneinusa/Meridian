// Settings → Customize: the global style / "about me" / instructions, and
// per-model overrides that fall back to them.
import { useEffect, useMemo, useState } from "react";
import { cleanOverride, globalCustomization, hasOverride, resolveCustomization, STYLES, styleName } from "../agent/customize";
import { findModel } from "../providers/registry";
import { updateSettings, useApp } from "../state/store";
import type { ModelCustomization, ModelRef, Settings, StyleId } from "../types";
import { modelKey } from "../types";
import { ModelSelect } from "./Modal";

const refOf = (key: string): ModelRef => {
  const [providerId, ...rest] = key.split("::");
  return { providerId, modelId: rest.join("::") };
};

function StyleFields({ style, styleText, onStyle, onText, inherit }: { style: StyleId | undefined; styleText?: string; onStyle: (s: StyleId | undefined) => void; onText: (t: string) => void; inherit?: string }) {
  return (
    <>
      <label className="field">
        <span>Response style</span>
        <select aria-label="Response style" value={style ?? ""} onChange={(e) => onStyle((e.target.value || undefined) as StyleId | undefined)}>
          {inherit !== undefined && <option value="">Use Global ({inherit})</option>}
          {STYLES.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {style && style !== "custom" && STYLES.find((s) => s.id === style)?.prompt && <small className="hint">{STYLES.find((s) => s.id === style)!.prompt}</small>}
      </label>
      {style === "custom" && (
        <label className="field">
          <span>Describe the style</span>
          <textarea rows={2} aria-label="Custom style" defaultValue={styleText ?? ""} placeholder="e.g. Answer like a seasoned editor: short sentences, active voice, no hedging." onBlur={(e) => onText(e.target.value)} />
        </label>
      )}
    </>
  );
}

function GlobalCard({ settings }: { settings: Settings }) {
  const g = globalCustomization(settings);
  const setCustom = (patch: Partial<NonNullable<Settings["customization"]>>) => void updateSettings((s) => ({ customization: { ...(s.customization ?? {}), ...patch } }));
  return (
    <div className="card" data-testid="customize-global">
      <h4>Global (every model)</h4>
      <p className="hint" style={{ marginTop: 0 }}>Used by every model that has no settings of its own below.</p>
      <StyleFields style={g.style ?? "default"} styleText={g.styleText} onStyle={(v) => setCustom({ style: v ?? "default" })} onText={(t) => setCustom({ styleText: t })} />
      <label className="field">
        <span>What should models know about you?</span>
        <textarea rows={3} aria-label="About you (global)" defaultValue={g.about ?? ""} placeholder="e.g. I'm a product manager in Berlin. I use metric units and British spelling." onBlur={(e) => e.target.value !== (g.about ?? "") && setCustom({ about: e.target.value })} />
      </label>
      <label className="field">
        <span>How should models respond? (standing instructions)</span>
        <textarea rows={4} aria-label="Instructions (global)" defaultValue={settings.systemPrompt} placeholder="e.g. Lead with the answer. Use tables for comparisons. Ask before long tasks." onBlur={(e) => e.target.value !== settings.systemPrompt && void updateSettings({ systemPrompt: e.target.value })} />
      </label>
    </div>
  );
}

/** One model's overrides. Every field starts at "Use Global". */
function OverrideEditor({ settings, k }: { settings: Settings; k: string }) {
  const ref = refOf(k);
  const found = findModel(settings, ref);
  const cur: ModelCustomization = settings.modelCustom?.[k] ?? {};
  const g = globalCustomization(settings);
  const write = (patch: Partial<ModelCustomization>) =>
    void updateSettings((s) => {
      const next = cleanOverride({ ...(s.modelCustom?.[k] ?? {}), ...patch });
      const all = { ...(s.modelCustom ?? {}) };
      if (next) all[k] = next;
      else delete all[k];
      return { modelCustom: all };
    });
  const r = resolveCustomization(settings, ref);
  const instrMode = cur.instructions === undefined ? "global" : (cur.instructionsMode ?? "replace");
  return (
    <div className="subcard" data-testid="override-editor">
      <StyleFields style={cur.style} styleText={cur.styleText} inherit={styleName(g.style)} onStyle={(v) => write({ style: v, ...(v === undefined ? { styleText: undefined } : {}) })} onText={(t) => write({ styleText: t })} />
      <label className="field">
        <span>What should {found?.model.name ?? "this model"} know about you?</span>
        <select aria-label="About you source" value={cur.about === undefined ? "global" : "own"} onChange={(e) => write({ about: e.target.value === "own" ? (cur.about ?? g.about ?? "") : undefined })}>
          <option value="global">Use Global</option>
          <option value="own">Its own text</option>
        </select>
        {cur.about !== undefined && <textarea rows={2} aria-label="About you (this model)" defaultValue={cur.about} onBlur={(e) => e.target.value !== cur.about && write({ about: e.target.value })} style={{ marginTop: 6 }} />}
      </label>
      <label className="field">
        <span>Instructions</span>
        <select
          aria-label="Instructions source"
          value={instrMode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "global") write({ instructions: undefined, instructionsMode: undefined });
            else write({ instructions: cur.instructions ?? "", instructionsMode: v as "replace" | "add" });
          }}
        >
          <option value="global">Use Global</option>
          <option value="replace">Replace the global instructions</option>
          <option value="add">Add to the global instructions</option>
        </select>
        {cur.instructions !== undefined && (
          <textarea rows={3} aria-label="Instructions (this model)" defaultValue={cur.instructions} placeholder={instrMode === "add" ? "Added after the global instructions" : "Used instead of the global instructions"} onBlur={(e) => e.target.value !== cur.instructions && write({ instructions: e.target.value })} style={{ marginTop: 6 }} />
        )}
      </label>
      <details>
        <summary className="hint">What {found?.model.name ?? "this model"} receives</summary>
        <div className="hint" style={{ whiteSpace: "pre-wrap", marginTop: 6 }} data-testid="effective">
          Style: {styleName(r.style.id)} ({r.style.from === "model" ? "its own" : "global"}){"\n"}
          About you: {r.about.text ? `${r.about.text.slice(0, 120)}${r.about.text.length > 120 ? "…" : ""}` : "(none)"} ({r.about.from === "model" ? "its own" : "global"}){"\n"}
          Instructions: {r.instructions.text ? `${r.instructions.text.slice(0, 160)}${r.instructions.text.length > 160 ? "…" : ""}` : "(none)"} ({r.instructions.from === "model" ? "its own" : r.instructions.from === "both" ? "global + its own" : "global"})
        </div>
      </details>
    </div>
  );
}

function summary(c: ModelCustomization): string[] {
  const out: string[] = [];
  if (c.style !== undefined) out.push(`Style: ${styleName(c.style)}`);
  if (c.about !== undefined) out.push("About you: own");
  if (c.instructions !== undefined) out.push(c.instructionsMode === "add" ? "Instructions: added to global" : "Instructions: own");
  return out;
}

export function CustomizeTab({ settings }: { settings: Settings }) {
  const focus = useApp((s) => s.customizeModel);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [adding, setAdding] = useState<ModelRef | undefined>();
  // pending: a model chosen in "Customize another model" that has no override yet
  const [pending, setPending] = useState<string[]>(focus && !settings.modelCustom?.[focus] ? [focus] : []);
  useEffect(() => {
    if (focus) useApp.setState({ customizeModel: undefined });
  }, [focus]);
  const keys = useMemo(() => {
    const own = Object.keys(settings.modelCustom ?? {}).filter((k) => hasOverride(settings.modelCustom![k]));
    return [...own, ...pending.filter((k) => !own.includes(k))];
  }, [settings.modelCustom, pending]);
  const useGlobal = (k: string) => {
    void updateSettings((s) => {
      const all = { ...(s.modelCustom ?? {}) };
      delete all[k];
      return { modelCustom: all };
    });
    setPending((p) => p.filter((x) => x !== k));
    if (open === k) setOpen(null);
  };
  return (
    <>
      <h3>Customize</h3>
      <p>How models answer you: a style, what they should know about you, and standing instructions. Set them once for every model, then give any model its own where you want it to differ.</p>
      <GlobalCard settings={settings} />
      <div className="card" data-testid="customize-models">
        <h4>Per model</h4>
        <p className="hint" style={{ marginTop: 0 }}>
          A model listed here uses its own settings for whatever you change and <b>Global</b> for the rest. Models not listed use Global entirely.
        </p>
        {keys.map((k) => {
          const found = findModel(settings, refOf(k));
          const c = settings.modelCustom?.[k] ?? {};
          const chips = summary(c);
          return (
            <div key={k} className="override-row" data-testid="override-row">
              <div className="row">
                <div className="grow">
                  <b>{found?.model.name ?? refOf(k).modelId}</b> <span className="muted">· {found?.provider.name ?? refOf(k).providerId}</span>
                  <div className="row wrap" style={{ marginTop: 4 }}>
                    {chips.length ? chips.map((t) => <span key={t} className="badge">{t}</span>) : <span className="badge">Everything from Global</span>}
                  </div>
                </div>
                <button className="btn small" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
                  {open === k ? "Done" : "Edit"}
                </button>
                <button className="btn small" onClick={() => useGlobal(k)} title="Remove this model's own settings">
                  Use Global
                </button>
              </div>
              {open === k && <OverrideEditor settings={settings} k={k} />}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 10 }}>
          <ModelSelect value={adding} onChange={setAdding} empty="Customize another model…" />
          <button
            className="btn small primary"
            disabled={!adding}
            onClick={() => {
              if (!adding) return;
              const k = modelKey(adding);
              if (!keys.includes(k)) setPending((p) => [...p, k]);
              setOpen(k);
              setAdding(undefined);
            }}
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}
