// Generation parameters, editable at three levels: this chat, this model, all chats.
import { useState } from "react";
import { PARAM_SPECS, paramUnsupportedReason, resolveParams, type ParamSpec } from "../providers/params";
import { findModel } from "../providers/registry";
import { currentModelRef, draftParams, setChatParams, setChatSystemPrompt, updateSettings, useApp } from "../state/store";
import type { ModelParams } from "../types";
import { modelKey } from "../types";
import { Icon } from "./icons";

type Scope = "chat" | "model" | "all";

function JsonField({ value, onChange, placeholder }: { value: unknown; onChange: (v: unknown) => void; placeholder: string }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  return (
    <>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 13 }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim()) {
            setError("");
            return onChange(undefined);
          }
          try {
            const parsed = JSON.parse(t);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
            setError("");
            onChange(parsed);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid JSON");
          }
        }}
      />
      {error && <div className="hint" style={{ color: "var(--danger)" }}>{error} (not applied yet)</div>}
    </>
  );
}

function ParamRow({ spec, value, inherited, reason, onChange }: { spec: ParamSpec; value: unknown; inherited: unknown; reason: string | null; onChange: (v: unknown) => void }) {
  const isSet = value !== undefined;
  const shown = isSet ? value : inherited;
  const display =
    shown === undefined ? "default" : Array.isArray(shown) ? `${shown.length} set` : typeof shown === "object" ? "custom" : typeof shown === "boolean" ? (shown ? "on" : "off") : String(shown);
  let control: React.ReactNode = null;

  if (spec.type === "number" || spec.type === "integer") {
    const slider = spec.type === "number" || (spec.max !== undefined && spec.max <= 1000 && spec.key !== "contextMessages");
    const parse = (raw: string) => {
      if (raw === "") return onChange(undefined);
      let n = Number(raw);
      if (!Number.isFinite(n)) return;
      if (spec.type === "integer") n = Math.round(n);
      if (spec.min !== undefined) n = Math.max(spec.min, n);
      if (spec.max !== undefined) n = Math.min(spec.max, n);
      onChange(n);
    };
    control = (
      <div className="controls">
        {slider && (
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={typeof shown === "number" ? shown : spec.key === "temperature" || spec.key === "topP" || spec.key === "repetitionPenalty" ? 1 : (spec.min ?? 0)}
            onChange={(e) => parse(e.target.value)}
            aria-label={spec.label}
          />
        )}
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={isSet ? String(value) : ""}
          placeholder={inherited !== undefined ? String(inherited) : "default"}
          onChange={(e) => parse(e.target.value)}
          aria-label={`${spec.label} value`}
          style={slider ? undefined : { width: "100%", flex: 1 }}
        />
      </div>
    );
  } else if (spec.type === "select") {
    control = (
      <select value={isSet ? String(value) : ""} onChange={(e) => onChange(e.target.value || undefined)} aria-label={spec.label}>
        <option value="">{inherited !== undefined ? `Inherit (${String(inherited)})` : "Provider default"}</option>
        {spec.options!.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  } else if (spec.type === "boolean") {
    control = (
      <select value={isSet ? String(value) : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")} aria-label={spec.label}>
        <option value="">{inherited !== undefined ? `Inherit (${inherited ? "on" : "off"})` : "Provider default"}</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  } else if (spec.type === "list") {
    control = (
      <textarea
        rows={2}
        placeholder={Array.isArray(inherited) ? (inherited as string[]).join("\n") : "One per line"}
        value={Array.isArray(value) ? (value as string[]).join("\n") : ""}
        onChange={(e) => {
          const lines = e.target.value.split("\n");
          const kept = lines.filter((l, i) => l !== "" || i === lines.length - 1);
          onChange(kept.some((l) => l !== "") ? kept : undefined);
        }}
        aria-label={spec.label}
      />
    );
  } else {
    control = <JsonField value={value} onChange={onChange} placeholder={spec.key === "logitBias" ? '{"1734": -100}' : '{"some_option": true}'} />;
  }

  return (
    <div className={`param ${reason ? "off" : ""}`}>
      <div className="param-head">
        <span className="name">{spec.label}</span>
        <span className="val">{display}</span>
        {isSet && (
          <button className="icon-btn" style={{ width: 26, height: 26 }} title="Reset to default" onClick={() => onChange(undefined)}>
            <Icon.x />
          </button>
        )}
      </div>
      {control}
      <div className="hint" style={{ marginTop: 4 }}>{reason ? `${reason}` : spec.help}</div>
    </div>
  );
}

export function ParamsPanel() {
  const settings = useApp((s) => s.settings);
  const active = useApp((s) => s.active);
  useApp((s) => s.metas);
  const [scope, setScope] = useState<Scope>("chat");
  const ref = currentModelRef(active);
  const found = findModel(settings, ref);
  const key = modelKey(ref);

  const chatParams = active ? (active.params ?? {}) : (draftParams() ?? {});
  const values: ModelParams = scope === "chat" ? chatParams : scope === "model" ? (settings.modelParams[key] ?? {}) : settings.params;
  // what the next level down would supply if this level leaves a field unset
  const inherited: ModelParams =
    scope === "all" ? {} : scope === "model" ? settings.params : resolveParams(settings, ref, undefined);

  const write = (next: ModelParams) => {
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as ModelParams;
    if (scope === "chat") void setChatParams(cleaned);
    else if (scope === "model") {
      void updateSettings((s) => {
        const modelParams = { ...s.modelParams };
        if (Object.keys(cleaned).length) modelParams[key] = cleaned;
        else delete modelParams[key];
        return { modelParams };
      });
    } else void updateSettings({ params: cleaned });
  };

  const setCount = Object.keys(values).length;
  const groups = ["Sampling", "Length", "Reasoning", "Tools", "Advanced"] as const;

  return (
    <aside className="sheet" aria-label="Model parameters">
      <div className="modal-head">
        <h2>Parameters</h2>
        <button className="icon-btn" title="Close" onClick={() => useApp.setState({ paramsOpen: false })}>
          <Icon.x />
        </button>
      </div>
      <div className="sheet-body">
        <div className="seg" role="tablist">
          {(
            [
              ["chat", "This chat"],
              ["model", "This model"],
              ["all", "All chats"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={scope === id} className={scope === id ? "sel" : ""} onClick={() => setScope(id)}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint" style={{ margin: "10px 0 0" }}>
          {scope === "chat" && "Applies to this conversation only and travels with it when synced."}
          {scope === "model" && `Applies whenever ${found?.model.name ?? "this model"} is used.`}
          {scope === "all" && "Defaults for every chat and model."}{" "}
          A more specific level wins. Anything left on default is not sent, so the provider's own default applies.
        </p>
        {setCount > 0 && (
          <button className="btn small" style={{ marginTop: 10 }} onClick={() => write({})}>
            Reset {setCount} setting{setCount === 1 ? "" : "s"} at this level
          </button>
        )}

        {scope === "chat" && (
          <label className="field" style={{ marginTop: 14 }}>
            <span>Instructions for this chat (system prompt)</span>
            <textarea
              rows={3}
              placeholder="e.g. Answer in French. Be brief."
              defaultValue={active?.systemPrompt ?? ""}
              key={active?.id ?? "new"}
              onBlur={(e) => {
                if ((active?.systemPrompt ?? "") !== e.target.value) void setChatSystemPrompt(e.target.value);
              }}
            />
          </label>
        )}

        {groups.map((g) => (
          <div key={g}>
            <div className="param-group">{g}</div>
            {PARAM_SPECS.filter((s) => s.group === g).map((spec) => (
              <ParamRow
                key={`${scope}-${key}-${active?.id ?? "new"}-${spec.key}`}
                spec={spec}
                value={(values as Record<string, unknown>)[spec.key]}
                inherited={(inherited as Record<string, unknown>)[spec.key]}
                reason={found && scope !== "all" ? paramUnsupportedReason(spec.key, found.provider.kind, found.model) : null}
                onChange={(v) => write({ ...values, [spec.key]: v })}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
