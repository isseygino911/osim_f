import { useState, useEffect, useCallback, useRef } from "react";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";
const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";

async function api(path, opts) {
  const res = await fetch(`${SERVER_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

function scoreColor(score) {
  if (score >= 12) return "green";
  if (score <= -12) return "red";
  return "amber";
}

// Presentational: App.jsx owns the /api/indicators fetch so the chart overlays
// and this table share a single request per poll.
export function IndicatorsPanel({ data, error }) {
  if (error) return <div className="card"><div className="section-title">Indicators</div><div className="muted" style={{ fontSize: 12 }}>{error}</div></div>;
  if (!data || data.insufficientData) return <div className="card"><div className="section-title">Indicators</div><div className="muted">Loading…</div></div>;

  const { latest, composite } = data;
  const rows = [
    ["RSI (14)", latest.rsi14?.toFixed(1), latest.rsi14 < 30 ? "green" : latest.rsi14 > 70 ? "red" : ""],
    ["MACD", latest.macd?.toFixed(2), latest.macd > latest.macdSignal ? "green" : "red"],
    ["MACD signal", latest.macdSignal?.toFixed(2), ""],
    ["SMA 20 / 50", `${latest.sma20?.toFixed(1)} / ${latest.sma50?.toFixed(1)}`, latest.sma20 > latest.sma50 ? "green" : "red"],
    ["Bollinger", `${latest.bbLower?.toFixed(1)} – ${latest.bbUpper?.toFixed(1)}`, ""],
    ["VWAP", latest.vwap?.toFixed(2), latest.price > latest.vwap ? "green" : "red"],
    ["ATR (14)", latest.atr14?.toFixed(2), ""],
    ["Stochastic %K", latest.stochK?.toFixed(1), latest.stochK < 20 ? "green" : latest.stochK > 80 ? "red" : ""],
  ];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Indicators</div>
        <span className={`mono ${scoreColor(composite.score)}`} style={{ fontWeight: 600, fontSize: 13 }}>
          {composite.label.replace("_", " ").toUpperCase()} ({composite.score > 0 ? "+" : ""}{composite.score})
        </span>
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          {rows.map(([label, val, cls]) => (
            <tr key={label}>
              <td className="muted" style={{ textAlign: "left" }}>{label}</td>
              <td className={`mono ${cls}`}>{val ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NewsPanel({ pollKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh) => {
    setLoading(true);
    try {
      setData(await api(`/api/news${refresh ? "?refresh=1" : ""}`));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load, pollKey]);

  const sentClass = (s) => (s === "positive" || s === "bullish" ? "green" : s === "negative" || s === "bearish" ? "red" : "amber");

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Market news</div>
        <div className="row">
          {data?.overall && (
            <span className={`mono ${sentClass(data.overall.sentiment)}`} style={{ fontSize: 12, fontWeight: 600 }}>
              {data.overall.sentiment.toUpperCase()} ({data.overall.score > 0 ? "+" : ""}{data.overall.score})
            </span>
          )}
          <button className="ghost" onClick={() => load(true)} disabled={loading}>{loading ? "…" : "Refresh"}</button>
        </div>
      </div>
      {error && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div className="trade-log" style={{ marginTop: 10 }}>
        {(data?.relevantItems?.length ? data.relevantItems : data?.items ?? []).slice(0, 20).map((item, i) => (
          <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #1A1D21" }}>
            <a href={item.link} target="_blank" rel="noreferrer" style={{ color: "#E7E9EA", textDecoration: "none", fontSize: 13 }}>
              {item.title}
            </a>
            <div className="row" style={{ marginTop: 2, fontSize: 11 }}>
              <span className="muted">{item.source}</span>
              <span className={sentClass(item.sentiment)}>{item.sentiment}</span>
              {item.publishedAt && <span className="muted">{new Date(item.publishedAt).toLocaleTimeString()}</span>}
            </div>
          </div>
        ))}
        {!data?.items?.length && !error && <div className="muted">Loading news…</div>}
      </div>
    </div>
  );
}

export function AutopilotPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api("/api/autopilot"));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 15000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  async function toggle() {
    setBusy(true);
    try {
      await api(status?.enabled ? "/api/autopilot/disable" : "/api/autopilot/enable", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      await api("/api/autopilot/run-now", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm("Reset autopilot portfolio to $10,000 and clear all history?")) return;
    setBusy(true);
    try {
      await api("/api/autopilot/reset", { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="card"><div className="section-title">Autopilot</div><div className="muted">{error || "Loading…"}</div></div>;

  const progressColor = status.weekPnlPct >= 10 ? "#3DDC84" : status.weekPnlPct >= 0 ? "#E8A33D" : "#FF5C5C";
  const barPct = Math.max(0, Math.min(100, status.weekProgressPct));

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <span className={`dot ${status.enabled ? "" : "off"}`} />
          <div className="section-title" style={{ margin: 0 }}>Autopilot &middot; goal 10%/week</div>
        </div>
        <div className="row">
          <button className="ghost" onClick={runNow} disabled={busy}>Run now</button>
          <button className={status.enabled ? "sell" : "buy"} onClick={toggle} disabled={busy}>
            {status.enabled ? "Stop" : "Start"}
          </button>
        </div>
      </div>

      {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
          <span className="muted">This week</span>
          <span className="mono" style={{ color: progressColor }}>{fmtPct(status.weekPnlPct)} of 10% goal</span>
        </div>
        <div style={{ background: "#1A1D21", borderRadius: 6, height: 8, marginTop: 6, overflow: "hidden" }}>
          <div style={{ width: `${barPct}%`, background: progressColor, height: "100%", transition: "width .3s" }} />
        </div>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
        <span className="muted">Equity</span>
        <span className="mono">{fmt$(status.equity)}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Cash</span>
        <span className="mono">{fmt$(status.cash)}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Open positions</span>
        <span className="mono">{status.positions.length}</span>
      </div>

      {status.lastDecision && (
        <div style={{ marginTop: 12, fontSize: 12 }} className="muted">
          Last check: {status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : "—"} &middot; {status.lastDecision.reason || status.lastDecision.type}
        </div>
      )}

      {status.positions.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Contract</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&amp;L</th></tr></thead>
          <tbody>
            {status.positions.map((p) => {
              const mark = p.mark ?? p.entryPrice;
              const pnl = (mark - p.entryPrice) * 100 * p.qty;
              return (
                <tr key={p.id}>
                  <td className="mono">QQQ {p.strike}{p.type === "call" ? "C" : "P"} {p.expiration}</td>
                  <td className="mono">{p.qty}</td>
                  <td className="mono">{p.entryPrice.toFixed(2)}</td>
                  <td className="mono">{mark.toFixed(2)}</td>
                  <td className={`mono ${pnl >= 0 ? "green" : "red"}`}>{fmt$(pnl)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {status.weekHistory?.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 18 }}>Weekly history</div>
          <table>
            <thead><tr><th>Week of</th><th>P&amp;L %</th></tr></thead>
            <tbody>
              {status.weekHistory.map((w, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(w.weekStart).toLocaleDateString()}</td>
                  <td className={`mono ${w.pnlPct >= 0 ? "green" : "red"}`}>{fmtPct(w.pnlPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {status.trades?.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 18 }}>Autopilot trade log</div>
          <div className="trade-log">
            {status.trades.slice(0, 30).map((t, i) => (
              <div key={i} className="mono" style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid #1A1D21" }}>
                <span className={t.action === "BUY" ? "green" : "red"}>{t.action}</span> {t.qty}x QQQ {t.strike}{t.type === "call" ? "C" : "P"} {t.expiration} @ {(t.action === "BUY" ? t.entryPrice : t.closePrice).toFixed(2)}
                <span className="muted"> &middot; {new Date(t.at).toLocaleTimeString()}</span>
                {t.reason && <div className="muted" style={{ fontSize: 11 }}>{t.reason}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button className="ghost" onClick={reset} disabled={busy}>Reset autopilot</button>
      </div>
    </div>
  );
}
