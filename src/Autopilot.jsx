import { useState, useEffect, useCallback, useRef } from "react";
import { narrateAutopilot } from "./narrator.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";
const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";

async function api(path, opts) {
  const res = await fetch(`${SERVER_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

const sentClass = (s) => (s === "positive" || s === "bullish" ? "green" : s === "negative" || s === "bearish" ? "red" : "amber");

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

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>QQQ-relevant news</div>
        <div className="row">
          {data?.analysisMode === "gemini" && (
            <span className="mono" style={{ color: "#4C8DFF", fontSize: 10, fontWeight: 600 }}>GEMINI</span>
          )}
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
        {(data?.relevantItems ?? []).slice(0, 20).map((item, i) => (
          <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #1A1D21" }}>
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer"
              title={item.aiReason || undefined}
              style={{ color: "#E7E9EA", textDecoration: "none", fontSize: 13 }}
            >
              {item.title}
            </a>
            <div className="row" style={{ marginTop: 2, fontSize: 11 }}>
              {item.relevanceScore != null && (
                <span className="mono muted" style={{ border: "1px solid #2A2F35", borderRadius: 4, padding: "0 4px" }}>
                  R{item.relevanceScore}
                </span>
              )}
              <span className="muted">{item.source}</span>
              <span className={sentClass(item.direction ?? item.sentiment)}>{item.direction ?? item.sentiment}</span>
              {item.analysisSource === "gemini" && (
                <span className="mono" style={{ color: "#4C8DFF", fontSize: 10 }}>AI</span>
              )}
              {item.publishedAt && <span className="muted">{new Date(item.publishedAt).toLocaleTimeString()}</span>}
            </div>
          </div>
        ))}
        {data?.items?.length > 0 && !data?.relevantItems?.length && (
          <div className="muted" style={{ fontSize: 12 }}>
            No QQQ-relevant headlines right now (relevance ≥ 25) — {data.items.length} headlines scanned.
          </div>
        )}
        {!data?.items?.length && !error && <div className="muted">Loading news…</div>}
      </div>
    </div>
  );
}

// Presentational: compares news direction against options-market positioning.
// Fed from signalData.newsVsOptions, which App.jsx already fetches each poll.
export function DivergencePanel({ signal, error }) {
  const nvo = signal?.newsVsOptions;
  const verdictStyle =
    nvo?.verdict === "aligned" ? "green" : nvo?.verdict === "divergent" ? "amber" : "muted";
  const biasLabel = (bias) =>
    bias > 15 ? "bullish positioning" : bias < -15 ? "pricing downside" : "balanced";
  const pct = (x, dp = 1) => (x == null ? "—" : (x * 100).toFixed(dp));

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>News vs options</div>
        {nvo && (
          <span className={`mono ${verdictStyle}`} style={{ fontSize: 12, fontWeight: 600 }}>
            {nvo.verdict.toUpperCase()}
          </span>
        )}
      </div>
      {error && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{error}</div>}
      {!nvo && !error && <div className="muted" style={{ marginTop: 8 }}>Loading…</div>}
      {nvo && (
        <>
          <div className="mono" style={{ fontSize: 12, marginTop: 10 }}>
            news <span className={sentClass(nvo.newsSentiment)}>{nvo.newsScore > 0 ? "+" : ""}{nvo.newsScore} ({nvo.newsSentiment})</span>
            <span className="muted"> vs </span>
            options <span className={nvo.optionsBias > 15 ? "green" : nvo.optionsBias < -15 ? "red" : "amber"}>
              {nvo.optionsBias > 0 ? "+" : ""}{nvo.optionsBias} ({biasLabel(nvo.optionsBias)})
            </span>
          </div>
          <table style={{ marginTop: 10 }}>
            <tbody>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>25Δ IV skew (put − call)</td>
                <td className="mono">{nvo.factors ? `${pct(nvo.factors.ivSkew)} pts` : "—"}</td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>Put/Call open interest</td>
                <td className="mono">{nvo.factors?.oiRatio?.toFixed(2) ?? "—"}</td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>ATM implied vol</td>
                <td className="mono">{nvo.factors?.atmIv != null ? pct(nvo.factors.atmIv, 0) + "%" : "—"}</td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>News sample</td>
                <td className="mono">{nvo.sampleSize} headlines</td>
              </tr>
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{nvo.implication}</div>
        </>
      )}
    </div>
  );
}

// Presentational: App.jsx owns the /api/greeks + /api/signal fetches so this panel
// and the chain-table pick highlighting share one request per poll.
export function GreeksPanel({ greeks, signal, error }) {
  const shell = (body) => (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Options analysis</div>
        {signal && Number.isFinite(signal.optionsScore) && (
          <span className={`mono ${signal.optionsScore <= -40 ? "red" : signal.optionsScore < 0 ? "amber" : "green"}`} style={{ fontSize: 12, fontWeight: 600 }}>
            {signal.optionsScore === 0 ? "CONDITIONS CLEAR" : `CONDITIONS ${signal.optionsScore.toFixed(1)}`}
          </span>
        )}
      </div>
      {body}
    </div>
  );
  if (error) return shell(<div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{error}</div>);
  if (!greeks || !signal) return shell(<div className="muted" style={{ marginTop: 8 }}>Loading…</div>);

  const factors = signal.optionsFactors;
  const exp = factors?.expiration ?? greeks.preview?.expiration ?? null;
  const quality = exp ? greeks.summary?.[exp] : null;
  const penalties = factors?.penalties;
  const base = signal.techScore * 0.75 + signal.newsScore * 0.25;
  const multiplier = 1 + (signal.optionsScore ?? 0) / 200;
  const actionCls = signal.action === "buy_call" ? "green" : signal.action === "buy_put" ? "red" : "amber";
  const pct = (x, dp = 1) => (x == null ? "—" : (x * 100).toFixed(dp) + "%");

  const pickRow = (label, p, cls) => (
    <tr>
      <td className="muted" style={{ textAlign: "left" }}>{label}</td>
      {p?.strike != null ? (
        <td className="mono">
          <span className={cls}>{p.strike}{label === "Call pick" ? "C" : "P"}</span>
          {p.mid != null && ` @ ${p.mid.toFixed(2)}`}
          {p.delta != null && ` · Δ${p.delta.toFixed(2)}`}
          {p.iv != null && ` · IV ${pct(p.iv, 0)}`}
          <span className="muted"> ({p.mode})</span>
        </td>
      ) : (
        <td className="mono muted">{p?.mode ?? "—"}</td>
      )}
    </tr>
  );

  return shell(
    <>
      <div className="mono" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        tech {signal.techScore.toFixed(1)}×0.75 + news {signal.newsScore.toFixed(1)}×0.25 = {base.toFixed(1)}
        <span className="muted"> → dampener ×{multiplier.toFixed(3)} → </span>
        <span style={{ fontWeight: 600 }}>{signal.combinedScore.toFixed(1)}</span>
        <span className={actionCls} style={{ fontWeight: 600 }}> {signal.action.replace("_", " ").toUpperCase()}</span>
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          <tr><td className="muted" style={{ textAlign: "left" }}>Expiration analyzed</td><td className="mono">{exp ?? "—"}</td></tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>ATM implied vol</td>
            <td className={`mono ${penalties?.iv > 0 ? "amber" : ""}`}>{pct(quality?.atmIv)}{penalties?.iv > 0 && ` (−${penalties.iv})`}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>Avg bid/ask spread</td>
            <td className={`mono ${penalties?.spread > 0 ? "amber" : ""}`}>{pct(quality?.avgSpreadPct, 2)}{penalties?.spread > 0 && ` (−${penalties.spread})`}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>ATM theta burn</td>
            <td className="mono">{quality?.dailyThetaPctAtm != null ? pct(quality.dailyThetaPctAtm) + "/day" : "—"}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>Liquidity (open interest)</td>
            <td className={`mono ${quality?.liquidityOk === false ? "red" : "green"}`}>
              {quality?.liquidityOk === false ? `THIN (−${penalties?.oi ?? 20})` : "OK"}
            </td>
          </tr>
          {pickRow("Call pick", greeks.preview?.call, "green")}
          {pickRow("Put pick", greeks.preview?.put, "red")}
        </tbody>
      </table>
      {quality?.flags?.length > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          ⚠ {quality.flags.slice(0, 4).join(" · ")}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Greeks {greeks.schemaVersion >= 2 ? "from Robinhood" : "computed via Black-Scholes from quotes"} · r={greeks.riskFreeRate}
      </div>
    </>
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

      <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{narrateAutopilot(status)}</div>

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
