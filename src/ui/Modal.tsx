import { useEffect, type ReactNode } from "react";
import { useProviders } from "./BackendPicker";
import { Icon } from "./icons";

export function Modal({ title, onClose, children, footer, narrow }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${narrow ? "narrow" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icon.x />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ModelSelect({ value, onChange, empty, kind = "chat" }: { value?: { providerId: string; modelId: string }; onChange: (v?: { providerId: string; modelId: string }) => void; empty: string; kind?: "chat" | "image" | "video" }) {
  const providers = useProviders();
  return (
    <select
      value={value ? `${value.providerId}::${value.modelId}` : ""}
      onChange={(e) => {
        const [providerId, ...rest] = e.target.value.split("::");
        onChange(e.target.value ? { providerId, modelId: rest.join("::") } : undefined);
      }}
    >
      <option value="">{empty}</option>
      {providers.map((p) => {
        const models = p.models.filter((m) => m.kind === kind || (kind === "image" && m.caps.imageOutput));
        if (!models.length) return null;
        return (
          <optgroup key={p.id} label={p.name}>
            {models.map((m) => (
              <option key={m.id} value={`${p.id}::${m.id}`}>{m.name}</option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

