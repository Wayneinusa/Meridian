import { useEffect, useRef, useState } from "react";
import { importChats, openChat, searchChats, updateSettings, usageStats, useApp, type UsageRow } from "../../state/store";
import type { ConvMeta } from "../../types";

export function SearchPage() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ meta: ConvMeta; snippet: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setBusy(true);
      setHits(await searchChats(q));
      setBusy(false);
    }, 250);
  }, [q]);
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Search</h1>
        <p className="lead">Every chat, including message text and file names.</p>
        <input type="search" autoFocus placeholder="Search all chats" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 14 }} />
        {busy && <div className="spinner" />}
        {hits.map((h) => (
          <button key={h.meta.id} className="search-hit" onClick={() => void openChat(h.meta.id)}>
            <b>{h.meta.title}</b>
            <span>{h.snippet}</span>
          </button>
        ))}
        {!busy && q.trim().length >= 2 && !hits.length && <p className="hint">Nothing found.</p>}
      </div>
    </div>
  );
}

export function UsagePage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ rows: UsageRow[]; days: { day: string; tokens: number; cost: number }[] } | null>(null);
  const prices = useApp((s) => s.settings.prices);
  useEffect(() => {
    void usageStats(days).then(setData);
  }, [days, prices]);
  const max = Math.max(1, ...(data?.days ?? []).map((d) => d.tokens));
  const total = (data?.rows ?? []).reduce((n, r) => n + (r.cost ?? 0), 0);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1>Usage</h1>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: "auto" }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
        <p className="lead">Tokens reported by the providers for answers on this device's chats{total ? `, about $${total.toFixed(2)} at the prices below` : ""}. Costs are estimates; your provider's bill is the authority.</p>
        {!data ? (
          <div className="spinner" />
        ) : (
          <>
            <div className="bar-chart" aria-label="Tokens per day">
              {data.days.map((d) => (
                <div key={d.day} style={{ height: `${(d.tokens / max) * 100}%` }} title={`${d.day}: ${d.tokens.toLocaleString()} tokens`} />
              ))}
            </div>
            <div className="table-wrap md">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Answers</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Est. cost</th>
                    <th>Price / M in · out</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.name}</td>
                      <td>{r.messages}</td>
                      <td>{r.input.toLocaleString()}</td>
                      <td>{r.output.toLocaleString()}</td>
                      <td>{r.cost != null ? `$${r.cost.toFixed(3)}` : "—"}</td>
                      <td>
                        <PriceInput rowKey={r.key} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.rows.length && <p className="hint">No usage recorded in this period.</p>}
          </>
        )}
        <h3 style={{ marginTop: 28 }}>Import chats</h3>
        <p className="hint">Bring in your history from ChatGPT, Claude or TypingMind: choose the conversations.json from their data export.</p>
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) await importChats(f).catch((err) => alert(String(err)));
          }}
        />
      </div>
    </div>
  );
}

function PriceInput({ rowKey }: { rowKey: string }) {
  const price = useApp((s) => s.settings.prices[rowKey]);
  const save = (input: string, output: string) => {
    const i = Number(input);
    const o = Number(output);
    void updateSettings((s) => {
      const prices = { ...s.prices };
      if (Number.isFinite(i) && Number.isFinite(o) && (i || o)) prices[rowKey] = { input: i, output: o };
      else delete prices[rowKey];
      return { prices };
    });
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      <input type="number" step="0.01" style={{ width: 70 }} defaultValue={price?.input ?? ""} placeholder="in" aria-label="Input price per million" onBlur={(e) => save(e.target.value, String(price?.output ?? 0))} />
      <input type="number" step="0.01" style={{ width: 70 }} defaultValue={price?.output ?? ""} placeholder="out" aria-label="Output price per million" onBlur={(e) => save(String(price?.input ?? 0), e.target.value)} />
    </span>
  );
}
