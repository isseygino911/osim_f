import { useState, useEffect, useRef, useCallback } from "react";
import Candlestick from "./Candlestick.jsx";
import IndicatorToggles from "./IndicatorToggles.jsx";
import { DEFAULT_ACTIVE, sanitizeActive } from "./indicatorConfig.js";
import { loadKey, saveKey } from "./storage.js";
import { IndicatorsPanel, NewsPanel, AutopilotPanel } from "./Autopilot.jsx";

const CASH_START = 10000;
const POLL_DEFAULT = 60; // seconds
const K_PORTFOLIO = "qqq-sim-portfolio";
const K_INDICATORS = "qqq-sim-indicators";
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";

const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";

// Data comes from Robinhood via an MCP connection only Claude (Desktop/Code) can
// authenticate to. This app never calls Robinhood or Anthropic itself — it just
// polls a local JSON snapshot that Claude refreshes with POST /api/snapshot.
async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/snapshot`, { signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Request timed out after 10s (is the backend server running?)" : `Network error: ${e.message} (is the backend server running on ${SERVER_URL}?)`);
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Server returned ${res.status}`);
  }
  return data;
}

export default function App() {
  const [cash, setCash] = useState(CASH_START);
  const [positions, setPositions] = useState([]); // {id, type: 'call'|'put', strike, expiration, qty, entryPrice}
  const [trades, setTrades] = useState([]);
  const [candles, setCandles] = useState([]); // {t, open, high, low, close, volume}
  const [quote, setQuote] = useState(null); // {price, change, changePct, asOf}
  const [expirations, setExpirations] = useState([]);
  const [selectedExp, setSelectedExp] = useState(null);
  const [chain, setChain] = useState(null); // {strikes:[{strike,call:{bid,ask},put:{bid,ask}}]}
  const [chainLoading, setChainLoading] = useState(false);
  const [polling, setPolling] = useState(true);
  const [intervalSec, setIntervalSec] = useState(POLL_DEFAULT);
  const [error, setError] = useState(null);
  const [buyTarget, setBuyTarget] = useState(null); // {type, strike, price}
  const [buyQty, setBuyQty] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [indicators, setIndicators] = useState(null); // { series, latest, composite }
  const [indError, setIndError] = useState(null);
  const [activeInd, setActiveInd] = useState(() => sanitizeActive(loadKey(K_INDICATORS, DEFAULT_ACTIVE)));
  const pollRef = useRef(null);
  const chainsRef = useRef({}); // { [expiration]: {strikes:[...]} } from the last snapshot pull

  // initial load from storage
  useEffect(() => {
    const p = loadKey(K_PORTFOLIO, { cash: CASH_START, positions: [], trades: [] });
    setCash(p.cash);
    setPositions(p.positions);
    setTrades(p.trades);
    setLoaded(true);
  }, []);

  // persist portfolio on change
  useEffect(() => {
    if (!loaded) return;
    saveKey(K_PORTFOLIO, { cash, positions, trades });
  }, [cash, positions, trades, loaded]);

  // persist which indicators are drawn on the chart
  useEffect(() => {
    saveKey(K_INDICATORS, activeInd);
  }, [activeInd]);

  // Indicators are computed server-side from the same snapshot the chart uses.
  // Fetched here (not inside IndicatorsPanel) so the chart overlays and the
  // panel share one request per poll.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/indicators`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
        if (cancelled) return;
        setIndicators(data);
        setIndError(null);
      } catch (e) {
        if (!cancelled) setIndError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollCount]);

  const toggleIndicator = useCallback((key) => {
    setActiveInd((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);

  const pullSnapshot = useCallback(async () => {
    setChainLoading(true);
    try {
      const snap = await fetchSnapshot();
      const price = snap.underlying.price;
      const change = price - snap.underlying.priorClose;
      const changePct = (change / snap.underlying.priorClose) * 100;
      setQuote({ price, change, changePct, asOf: snap.fetchedAt || new Date().toISOString() });
      setError(null);

      if (Array.isArray(snap.candles) && snap.candles.length) {
        setCandles(snap.candles);
      }

      const exps = snap.expirations || [];
      setExpirations(exps);

      const chains = snap.chains || {};
      chainsRef.current = chains;

      setSelectedExp((cur) => {
        if (cur && exps.includes(cur)) return cur;
        // prefer the first expiration we actually have chain data for
        return exps.find((d) => chains[d]) ?? exps[0] ?? null;
      });
      setChain((cur) => {
        const activeExp = selectedExp && exps.includes(selectedExp) ? selectedExp : exps.find((d) => chains[d]) ?? exps[0];
        return activeExp && chains[activeExp] ? chains[activeExp] : cur;
      });

      // mark held positions from whichever chain(s) are present in this snapshot
      setPositions((prev) =>
        prev.map((pos) => {
          const c = chains[pos.expiration];
          const row = c?.strikes?.find((s) => s.strike === pos.strike);
          const q = row?.[pos.type];
          return q ? { ...pos, mark: (q.bid + q.ask) / 2 } : pos;
        })
      );
      setPollCount((c) => c + 1);
    } catch (e) {
      setError("Snapshot fetch failed: " + e.message);
    } finally {
      setChainLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExp]);

  // first pull once storage is loaded
  useEffect(() => {
    if (!loaded) return;
    pullSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // polling loop
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (polling) pollRef.current = setInterval(pullSnapshot, intervalSec * 1000);
    return () => clearInterval(pollRef.current);
  }, [polling, intervalSec, pullSnapshot]);

  function confirmBuy() {
    if (!buyTarget || buyQty < 1) return;
    const cost = buyTarget.price * 100 * buyQty;
    if (cost > cash) {
      setError("Not enough simulated cash for that order.");
      return;
    }
    const pos = {
      id: crypto.randomUUID(),
      type: buyTarget.type,
      strike: buyTarget.strike,
      expiration: selectedExp,
      qty: buyQty,
      entryPrice: buyTarget.price,
      mark: buyTarget.price,
    };
    setPositions((p) => [...p, pos]);
    setCash((c) => c - cost);
    setTrades((t) => [{ id: pos.id, action: "BUY", ...pos, at: new Date().toISOString() }, ...t]);
    setBuyTarget(null);
    setBuyQty(1);
  }

  function closePosition(pos) {
    const proceeds = (pos.mark ?? pos.entryPrice) * 100 * pos.qty;
    setCash((c) => c + proceeds);
    setPositions((prev) => prev.filter((p) => p.id !== pos.id));
    setTrades((t) => [{ id: pos.id, action: "SELL", ...pos, closePrice: pos.mark ?? pos.entryPrice, at: new Date().toISOString() }, ...t]);
  }

  function resetSim() {
    setCash(CASH_START);
    setPositions([]);
    setTrades([]);
    saveKey(K_PORTFOLIO, { cash: CASH_START, positions: [], trades: [] });
  }

  const positionsValue = positions.reduce((sum, p) => sum + (p.mark ?? p.entryPrice) * 100 * p.qty, 0);
  const totalValue = cash + positionsValue;
  const totalPnl = totalValue - CASH_START;
  const up = quote && quote.change >= 0;

  return (
    <div className="wrap">
      <style>{`
        .wrap { background:#0B0D0F; color:#E7E9EA; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; min-height:100vh; padding:20px; box-sizing:border-box; }
        .mono { font-family: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace; }
        .muted { color:#8A9099; }
        .green { color:#3DDC84; }
        .red { color:#FF5C5C; }
        .amber { color:#E8A33D; }
        .card { background:#14171A; border:1px solid #22262B; border-radius:10px; padding:16px; }
        .row { display:flex; align-items:center; gap:10px; }
        .header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:18px; }
        .dot { width:8px; height:8px; border-radius:50%; background:#3DDC84; box-shadow:0 0 8px #3DDC84; }
        .dot.off { background:#565C63; box-shadow:none; }
        .price-big { font-size:40px; font-weight:600; letter-spacing:-0.5px; }
        .grid { display:grid; grid-template-columns: 1.1fr 1fr; gap:16px; }
        @media (max-width:860px) { .grid { grid-template-columns: 1fr; } }
        table { width:100%; border-collapse:collapse; font-size:13px; }
        th { text-align:right; color:#8A9099; font-weight:500; padding:6px 8px; border-bottom:1px solid #22262B; }
        th:first-child, td:first-child { text-align:left; }
        td { text-align:right; padding:6px 8px; border-bottom:1px solid #1A1D21; }
        .strike-cell { color:#E8A33D; font-weight:600; }
        button { font-family:inherit; cursor:pointer; border-radius:6px; border:1px solid #2A2F35; background:#1B1F24; color:#E7E9EA; padding:5px 10px; font-size:12px; }
        button:hover { border-color:#3A3F46; }
        button.buy { background:#123B26; border-color:#1E6B3F; color:#3DDC84; }
        button.sell { background:#3B1717; border-color:#6B1E1E; color:#FF5C5C; }
        button.ghost { background:transparent; }
        select, input[type=number] { background:#1B1F24; color:#E7E9EA; border:1px solid #2A2F35; border-radius:6px; padding:5px 8px; font-family:inherit; font-size:13px; }
        .section-title { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:#8A9099; margin-bottom:10px; }
        .chip-row { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
        .chip { font-size:11px; line-height:1.4; padding:3px 8px; border-radius:99px; border:1px solid #2A2F35; background:transparent; letter-spacing:.3px; }
        .chip:hover:not(:disabled) { filter:brightness(1.2); }
        .chip.on { color:#0B0D0F; font-weight:600; }
        .chip:disabled { opacity:.35; cursor:default; filter:none; }
        .chip-sep { width:1px; align-self:stretch; background:#2A2F35; margin:2px 4px; }
        .pane-stack { display:flex; flex-direction:column; gap:14px; margin-top:10px; }
        .pane-card { background:#101316; border:1px solid #1E2227; border-radius:8px; padding:10px 0 8px; overflow:hidden; transition:opacity .15s, border-color .15s; }
        .pane-card.dragging { opacity:.35; }
        .pane-card.drag-over { border-color:#4C8DFF; }
        .pane-card-header { display:flex; align-items:center; gap:6px; padding:0 10px 8px; }
        .pane-card-title { font-size:11px; letter-spacing:.6px; text-transform:uppercase; color:#8A9099; font-family: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace; }
        .drag-handle { cursor:grab; color:#565C63; font-size:13px; line-height:1; padding:2px; user-select:none; }
        .drag-handle:active { cursor:grabbing; }
        .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:10; }
        .modal { background:#14171A; border:1px solid #2A2F35; border-radius:10px; padding:20px; width:280px; }
        .err { background:#3B1717; border:1px solid #6B1E1E; color:#FF9B9B; padding:8px 12px; border-radius:6px; font-size:13px; margin-bottom:14px; }
        .trade-log { max-height:220px; overflow-y:auto; }
      `}</style>

      <div className="header">
        <div>
          <div className="row">
            <span className={`dot ${polling ? "" : "off"}`} />
            <span className="section-title" style={{ margin: 0 }}>QQQ paper trading &middot; live via Robinhood</span>
          </div>
          {quote ? (
            <div className="row" style={{ marginTop: 6 }}>
              <span className="price-big mono">{fmt$(quote.price)}</span>
              <span className={`mono ${up ? "green" : "red"}`}>{fmtPct(quote.changePct)} ({up ? "+" : ""}{quote.change.toFixed(2)})</span>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>Loading quote…</div>
          )}
          {quote && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>as of {new Date(quote.asOf).toLocaleTimeString()}</div>}
        </div>

        <div className="card" style={{ minWidth: 220 }}>
          <div className="section-title">Simulated account</div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">Cash</span><span className="mono">{fmt$(cash)}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">Positions value</span><span className="mono">{fmt$(positionsValue)}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between", fontWeight: 600 }}>
            <span>Total</span>
            <span className={`mono ${totalPnl >= 0 ? "green" : "red"}`}>{fmt$(totalValue)}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted">Since start</span>
            <span className={`mono ${totalPnl >= 0 ? "green" : "red"}`}>{fmt$(totalPnl)}</span>
          </div>
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Price</div>
          <IndicatorToggles active={activeInd} onToggle={toggleIndicator} disabled={!indicators?.series} />
          <div className="row">
            <label className="muted" style={{ fontSize: 12 }}>Poll every</label>
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
              <option value={120}>2m</option>
            </select>
            <button className="ghost" onClick={() => setPolling((p) => !p)}>{polling ? "Pause" : "Resume"}</button>
            <button className="ghost" onClick={pullSnapshot}>Refresh now</button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <Candlestick bars={candles} height={280} series={indicators?.series} active={activeInd} />
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="section-title" style={{ margin: 0 }}>Option chain</div>
            <select
              value={selectedExp || ""}
              onChange={(e) => {
                const date = e.target.value;
                setSelectedExp(date);
                if (chainsRef.current[date]) setChain(chainsRef.current[date]);
              }}
            >
              {expirations.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {chainLoading && <div className="muted" style={{ marginTop: 10 }}>Loading chain…</div>}
          {!chainLoading && selectedExp && !chainsRef.current[selectedExp] && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              No data yet for {selectedExp}.{chain ? " Showing last loaded expiration below." : " Ask Claude to refresh."}
            </div>
          )}
          {chain && !chainLoading && (() => {
            // greek columns only appear when the snapshot actually carries greeks (schema v2
            // or server-computed) — v1 snapshots render the original table untouched
            const hasGreeks = chain.strikes.some((s) => s.call?.delta != null || s.put?.delta != null);
            const sideTip = (q) =>
              [
                q?.theta != null && `θ ${q.theta.toFixed(3)}/day`,
                q?.openInterest != null && `OI ${q.openInterest}`,
                q?.volume != null && `vol ${q.volume}`,
              ].filter(Boolean).join(" · ") || undefined;
            return (
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    {hasGreeks && <th>Δ</th>}
                    {hasGreeks && <th>IV</th>}
                    <th>Call bid/ask</th><th>Strike</th><th>Put bid/ask</th>
                    {hasGreeks && <th>IV</th>}
                    {hasGreeks && <th>Δ</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {chain.strikes.map((s) => (
                    <tr key={s.strike}>
                      {hasGreeks && <td className="mono" title={sideTip(s.call)}>{s.call?.delta != null ? s.call.delta.toFixed(2) : "–"}</td>}
                      {hasGreeks && <td className="mono">{s.call?.iv != null ? (s.call.iv * 100).toFixed(0) + "%" : "–"}</td>}
                      <td className="mono">{s.call.bid.toFixed(2)}/{s.call.ask.toFixed(2)}</td>
                      <td className="strike-cell mono">{s.strike}</td>
                      <td className="mono">{s.put.bid.toFixed(2)}/{s.put.ask.toFixed(2)}</td>
                      {hasGreeks && <td className="mono">{s.put?.iv != null ? (s.put.iv * 100).toFixed(0) + "%" : "–"}</td>}
                      {hasGreeks && <td className="mono" title={sideTip(s.put)}>{s.put?.delta != null ? s.put.delta.toFixed(2) : "–"}</td>}
                      <td>
                        <div className="row">
                          <button className="buy" onClick={() => setBuyTarget({ type: "call", strike: s.strike, price: (s.call.bid + s.call.ask) / 2 })}>C</button>
                          <button className="sell" onClick={() => setBuyTarget({ type: "put", strike: s.strike, price: (s.put.bid + s.put.ask) / 2 })}>P</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>

        <div className="card">
          <div className="section-title">Open positions</div>
          {positions.length === 0 && <div className="muted">No open positions.</div>}
          {positions.length > 0 && (
            <table>
              <thead><tr><th>Contract</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&amp;L</th><th></th></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const mark = p.mark ?? p.entryPrice;
                  const pnl = (mark - p.entryPrice) * 100 * p.qty;
                  return (
                    <tr key={p.id}>
                      <td className="mono">QQQ {p.strike}{p.type === "call" ? "C" : "P"} {p.expiration}</td>
                      <td className="mono">{p.qty}</td>
                      <td className="mono">{p.entryPrice.toFixed(2)}</td>
                      <td className="mono">{mark.toFixed(2)}</td>
                      <td className={`mono ${pnl >= 0 ? "green" : "red"}`}>{fmt$(pnl)}</td>
                      <td><button className="ghost" onClick={() => closePosition(p)}>Close</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="section-title" style={{ marginTop: 18 }}>Trade log</div>
          <div className="trade-log">
            {trades.length === 0 && <div className="muted">No trades yet.</div>}
            {trades.map((t, i) => (
              <div key={i} className="mono" style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid #1A1D21" }}>
                <span className={t.action === "BUY" ? "green" : "red"}>{t.action}</span> {t.qty}x QQQ {t.strike}{t.type === "call" ? "C" : "P"} {t.expiration} @ {(t.action === "BUY" ? t.entryPrice : t.closePrice).toFixed(2)}
                <span className="muted"> &middot; {new Date(t.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <AutopilotPanel />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <IndicatorsPanel data={indicators} error={indError} />
          <NewsPanel pollKey={pollCount} />
        </div>
      </div>

      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button className="ghost" onClick={resetSim}>Reset simulator (manual paper account)</button>
      </div>

      {buyTarget && (
        <div className="modal-bg" onClick={() => setBuyTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">Buy to open</div>
            <div style={{ marginBottom: 10 }}>
              QQQ {buyTarget.strike}{buyTarget.type === "call" ? "C" : "P"} {selectedExp}
              <div className="mono muted">mid {buyTarget.price.toFixed(2)}</div>
            </div>
            <label className="muted" style={{ fontSize: 12 }}>Contracts</label>
            <input type="number" min={1} value={buyQty} onChange={(e) => setBuyQty(Math.max(1, Number(e.target.value)))} style={{ width: "100%", marginTop: 4, marginBottom: 12 }} />
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
              <span className="muted">Cost</span>
              <span className="mono">{fmt$(buyTarget.price * 100 * buyQty)}</span>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="ghost" onClick={() => setBuyTarget(null)}>Cancel</button>
              <button className="buy" onClick={confirmBuy}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
