import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Candlestick from "./Candlestick.jsx";
import IndicatorHelpModal from "./IndicatorHelpModal.jsx";
import IndicatorToggles from "./IndicatorToggles.jsx";
import { DEFAULT_ACTIVE, sanitizeActive } from "./indicatorConfig.js";
import { loadKey, saveKey } from "./storage.js";
import { IndicatorsPanel, NewsPanel, AutopilotPanel, GreeksPanel, DivergencePanel, VolSurfacePanel, GammaExposurePanel } from "./Autopilot.jsx";
import { Modal } from "./Modal.jsx";
import SummaryPanel from "./SummaryPanel.jsx";
import { useCountdown, RefetchStatus } from "./RefetchStatus.jsx";
import { useRefreshStatusPoll, ActiveRefreshesList, RefreshProgressBanner } from "./RefreshProgress.jsx";

// Keeps rendering the last non-null value while `value` is null, so a modal's content
// stays on screen during its exit animation instead of vanishing before the fade completes.
function useLingering(value) {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value != null) setHeld(value);
  }, [value]);
  return value ?? held;
}

// Flashes green/red briefly when `value` changes (up vs down), then settles back to
// the neutral text color — used on the price quote so a poll tick is visible, not
// just a silent DOM swap.
function usePriceFlash(value) {
  const [flash, setFlash] = useState(null); // "up" | "down" | null
  const prevRef = useRef(value);
  useEffect(() => {
    if (value == null || prevRef.current == null) {
      prevRef.current = value;
      return;
    }
    if (value !== prevRef.current) {
      setFlash(value > prevRef.current ? "up" : "down");
      prevRef.current = value;
      const t = setTimeout(() => setFlash(null), 600);
      return () => clearTimeout(t);
    }
  }, [value]);
  return flash;
}

const CASH_START = 10000;
const POLL_DEFAULT = 5; // seconds
const AUTO_REFETCH_MS = 5 * 60 * 1000; // how often to pull a fresh snapshot for the active symbol
const K_INDICATORS = "qqq-sim-indicators"; // chart-layout pref, deliberately global (not per-symbol)
const K_RECENT = "sim-recent-symbols";
const LEGACY_K_PORTFOLIO = "qqq-sim-portfolio"; // pre-multi-symbol key, migrated (copied) to sim-QQQ-portfolio
const RECENT_CAP = 8;
const SYMBOL_RE = /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/; // mirrors the server's stocks/ETFs-only rule
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";
const CANDLE_INTERVALS = ["5m", "15m", "30m", "1h", "4h", "1d"];
const CANDLE_INTERVAL_DEFAULT = "1d";

// Date-range options for the chart. Tradier's intraday timesales endpoint rejects any
// lookback older than ~2 months (empirically confirmed), so "3m"/"1y" can only ever be
// served from daily candles — any intraday interval is force-switched to "1d" when one
// of those two ranges is picked (see the range <select> below).
const CANDLE_RANGES = [
  { key: "1d", label: "1D", days: 1 },
  { key: "1w", label: "1W", days: 7 },
  { key: "1m", label: "1M", days: 30 },
  { key: "3m", label: "3M", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
];
const CANDLE_RANGE_DEFAULT = "1m";
const INTRADAY_ONLY_RANGES = new Set(["1d", "1w", "1m"]); // ranges an intraday interval can actually cover

// Finds the first index whose bar falls within the last `days` of data. Candles are
// already sorted oldest-first (as returned by the server). Returns an index, not a
// filtered array, because indicator series (computed server-side over the FULL
// history) are positionally aligned to the full candle array — slicing candles and
// series independently (e.g. by a timestamp filter on each separately) would desync
// them the moment their lengths differ, which is exactly what produced the "jumping
// lines" bug: overlays rendered against the wrong bar entirely.
function rangeStartIndex(bars, days) {
  if (!Array.isArray(bars) || !bars.length) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const idx = bars.findIndex((b) => new Date(b.t).getTime() >= cutoff);
  if (idx === -1) return Math.max(0, bars.length - 1); // whole array is older than cutoff — keep just the last bar
  return idx;
}

// Slices a candle array to the last `days` of data.
function sliceByRange(bars, days) {
  if (!Array.isArray(bars) || !bars.length) return bars;
  return bars.slice(rangeStartIndex(bars, days));
}

// Slices every array in an indicator `series` object by the same start index used to
// slice `bars`, so overlays stay positionally aligned to the candles they're drawn
// against — see rangeStartIndex's comment for why this can't be done independently.
function sliceSeriesByRange(series, bars, days) {
  if (!series || !Array.isArray(bars) || !bars.length) return series;
  const start = rangeStartIndex(bars, days);
  const out = {};
  for (const [key, values] of Object.entries(series)) {
    out[key] = Array.isArray(values) ? values.slice(start) : values;
  }
  return out;
}

const portfolioKey = (symbol) => `sim-${symbol}-portfolio`;

// Snapshots may still hold a legacy flat candles array (pre-multi-interval) — treat
// that as "1d" data, mirroring the server's candlesFor in indicators.service.js.
function candlesFor(snapshot, interval) {
  const c = snapshot?.candles;
  if (Array.isArray(c)) return interval === "1d" ? c : [];
  return c?.[interval] || [];
}

function rangeDays(rangeKey) {
  return (CANDLE_RANGES.find((r) => r.key === rangeKey) ?? CANDLE_RANGES.find((r) => r.key === CANDLE_RANGE_DEFAULT)).days;
}

const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";

// Data comes from a JSON snapshot the server fetches directly from Tradier's API and
// writes to disk. This app never calls a market-data provider itself — it just polls
// that snapshot via GET /api/snapshot.
async function fetchSnapshot(symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/snapshot?symbol=${symbol}`, { signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Request timed out after 10s (is the backend server running?)" : `Network error: ${e.message} (is the backend server running on ${SERVER_URL}?)`);
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Server returned ${res.status}`);
    err.status = res.status; // 404 = "no snapshot for this symbol yet", rendered as awaiting-data, not an error
    throw err;
  }
  return data;
}

export default function App() {
  const [symbol, setSymbol] = useState(null); // resolved from GET /api/symbol on mount
  const [searchInput, setSearchInput] = useState("");
  const [searchError, setSearchError] = useState(null);
  const [recentSymbols, setRecentSymbols] = useState(() => loadKey(K_RECENT, []));
  const [noData, setNoData] = useState(false); // snapshot 404 — awaiting a refresh for this symbol
  const [cash, setCash] = useState(CASH_START);
  const [positions, setPositions] = useState([]); // {id, type: 'call'|'put', strike, expiration, qty, entryPrice}
  const [trades, setTrades] = useState([]);
  const [candles, setCandles] = useState([]); // {t, open, high, low, close, volume}
  const [candleInterval, setCandleInterval] = useState(CANDLE_INTERVAL_DEFAULT);
  const [candleRange, setCandleRange] = useState(CANDLE_RANGE_DEFAULT);
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
  const [portfolioSymbol, setPortfolioSymbol] = useState(null); // which symbol the in-memory manual portfolio belongs to
  const [pollCount, setPollCount] = useState(0);
  const [indicators, setIndicators] = useState(null); // { series, latest, composite }
  const [indError, setIndError] = useState(null);
  const [greeksData, setGreeksData] = useState(null); // /api/greeks: enriched chains + summary + preview
  const [signalData, setSignalData] = useState(null); // /api/signal: scores + options factors
  const [greeksError, setGreeksError] = useState(null);
  const [activeInd, setActiveInd] = useState(() => sanitizeActive(loadKey(K_INDICATORS, DEFAULT_ACTIVE)));
  const [helpKey, setHelpKey] = useState(null); // indicatorHelp.jsx key for the open explainer modal, or null
  const [lastFetchAt, setLastFetchAt] = useState(null); // ms timestamp of last completed snapshot poll (success or failure)
  const [lastFetchOk, setLastFetchOk] = useState(null); // true | false | null (no fetch completed yet)
  const pollRef = useRef(null);
  const chainsRef = useRef({}); // { [expiration]: {strikes:[...]} } from the last snapshot pull
  const lastSnapshotRef = useRef(null); // raw snapshot from the last successful pull, for re-slicing candles on interval change
  const selectedExpRef = useRef(selectedExp); // always-current mirror of selectedExp for async closures below
  const candleIntervalRef = useRef(candleInterval); // always-current mirror of candleInterval for pullSnapshot's async closure
  const symbolRef = useRef(symbol); // always-current symbol so in-flight pulls for a switched-away symbol get dropped
  symbolRef.current = symbol;
  const { status: refreshStatus, setStatus: setRefreshStatus, clear: clearRefreshStatus } = useRefreshStatusPoll(symbol, SERVER_URL);

  // resolve the server-side active symbol once on mount — stays null (no symbol
  // selected yet) until the server has one or the user searches and hits "Go"
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/symbol`);
        const data = await res.json().catch(() => ({}));
        if (typeof data.activeSymbol === "string" && SYMBOL_RE.test(data.activeSymbol)) {
          setSymbol(data.activeSymbol);
        }
      } catch {
        // no active symbol resolved — leave `symbol` null, the empty state prompts a search
      }
    })();
  }, []);

  // load the symbol's manual portfolio from storage whenever the symbol changes
  useEffect(() => {
    if (!symbol) return;
    let p = loadKey(portfolioKey(symbol), null);
    if (!p && symbol === "QQQ") {
      // one-time migration from the pre-multi-symbol key (copy, never delete)
      p = loadKey(LEGACY_K_PORTFOLIO, null);
      if (p) saveKey(portfolioKey(symbol), p);
    }
    p = p || { cash: CASH_START, positions: [], trades: [] };
    setCash(p.cash);
    setPositions(p.positions);
    setTrades(p.trades);
    setPortfolioSymbol(symbol);
  }, [symbol]);

  // persist portfolio on change — keyed by the symbol the in-memory portfolio belongs
  // to (portfolioSymbol updates in the same batch as cash/positions, so a symbol
  // switch can never write one symbol's portfolio under another's key)
  useEffect(() => {
    if (!portfolioSymbol) return;
    saveKey(portfolioKey(portfolioSymbol), { cash, positions, trades });
  }, [cash, positions, trades, portfolioSymbol]);

  // persist which indicators are drawn on the chart
  useEffect(() => {
    saveKey(K_INDICATORS, activeInd);
  }, [activeInd]);

  // Indicators are computed server-side from the same snapshot the chart uses.
  // Fetched here (not inside IndicatorsPanel) so the chart overlays and the
  // panel share one request per poll.
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/indicators?symbol=${symbol}&interval=${candleInterval}`);
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
  }, [pollCount, symbol, candleInterval]);

  // Options analysis refreshes on the same poll cadence as the snapshot. The chain
  // table reuses this data to highlight the strikes the autopilot would pick.
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    (async () => {
      try {
        const fetchJson = async (path) => {
          const res = await fetch(`${SERVER_URL}${path}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
          return data;
        };
        const [g, sig] = await Promise.all([fetchJson(`/api/greeks?symbol=${symbol}`), fetchJson(`/api/signal?symbol=${symbol}`)]);
        if (cancelled) return;
        setGreeksData(g);
        setSignalData(sig);
        setGreeksError(null);
      } catch (e) {
        if (!cancelled) setGreeksError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollCount, symbol]);

  const toggleIndicator = useCallback((key) => {
    setActiveInd((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);

  // keep selectedExpRef current so async continuations (pullSnapshot) can read the
  // latest user selection instead of whatever was captured when they started
  useEffect(() => {
    selectedExpRef.current = selectedExp;
  }, [selectedExp]);

  // 3m/1y ranges exceed Tradier's ~2-month intraday lookback cap — force the interval
  // to daily candles whenever one of those ranges is picked, since that's the only data
  // that can actually cover them (see CANDLE_RANGES' comment above).
  useEffect(() => {
    if (!INTRADAY_ONLY_RANGES.has(candleRange) && candleInterval !== "1d") setCandleInterval("1d");
  }, [candleRange, candleInterval]);

  // re-slice candles from the last snapshot pull when the user switches interval —
  // no need to refetch the whole snapshot, it already carries every interval. `candles`
  // deliberately stays the FULL (unsliced) interval history here — date-range trimming
  // happens once, at render time, applied identically to candles and indicator series
  // together (see the chartBars/chartSeries useMemo below) so the two can never desync.
  useEffect(() => {
    candleIntervalRef.current = candleInterval;
    if (lastSnapshotRef.current) setCandles(candlesFor(lastSnapshotRef.current, candleInterval));
  }, [candleInterval]);

  const pullSnapshot = useCallback(async () => {
    if (!symbol) return;
    // only show the loading placeholder when there's nothing cached yet (first load /
    // symbol switch) — routine polls that already have a chain on screen should update
    // it in place instead of unmounting the table every cycle
    if (Object.keys(chainsRef.current).length === 0) setChainLoading(true);
    try {
      const snap = await fetchSnapshot(symbol);
      if (symbolRef.current !== symbol) return; // user switched symbols while this pull was in flight
      // pre-multi-symbol snapshots (always QQQ) carry no symbol field; any other
      // mismatch means an old server process is ignoring ?symbol= entirely
      if ((snap.symbol ?? "QQQ") !== symbol) {
        setError(`Server returned ${snap.symbol ?? "QQQ"} data for ${symbol} — restart the backend server to pick up multi-symbol support.`);
        setLastFetchOk(false);
        return;
      }
      const price = snap.underlying.price;
      const change = price - snap.underlying.priorClose;
      const changePct = (change / snap.underlying.priorClose) * 100;
      setQuote({ price, change, changePct, asOf: snap.fetchedAt || new Date().toISOString() });
      setError(null);

      if (snap.candles) {
        lastSnapshotRef.current = snap;
        setCandles(candlesFor(snap, candleIntervalRef.current));
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
        // read the latest selection via ref, not the `selectedExp` captured when this
        // async call started — otherwise an in-flight poll can overwrite a chain the
        // user has since switched away from with stale data for the old expiration
        const currentExp = selectedExpRef.current;
        const activeExp = currentExp && exps.includes(currentExp) ? currentExp : exps.find((d) => chains[d]) ?? exps[0];
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
      setLastFetchOk(true);
      setNoData(false);
    } catch (e) {
      if (symbolRef.current !== symbol) return;
      if (e.status === 404) {
        // not an error — this symbol just has no snapshot yet; keep polling so the
        // page self-heals once Claude POSTs one
        setNoData(true);
        setError(null);
      } else {
        setError("Snapshot fetch failed: " + e.message);
      }
      setLastFetchOk(false);
    } finally {
      if (symbolRef.current === symbol) {
        setChainLoading(false);
        setLastFetchAt(Date.now());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExp, symbol]);

  // fetch one expiration's chain (server-enriched with computed greeks/IV) when the
  // user picks a date — fresher than whatever the last snapshot poll cached, and the
  // 404 copy tells them to refresh for expirations the snapshot doesn't cover yet
  const fetchChain = useCallback(async (expiration) => {
    if (!symbol || !expiration) return;
    setChainLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/chain?symbol=${symbol}&expiration=${expiration}`);
      const data = await res.json().catch(() => ({}));
      if (symbolRef.current !== symbol || selectedExpRef.current !== expiration) return; // switched away mid-flight
      if (res.ok && data.chain) {
        chainsRef.current = { ...chainsRef.current, [expiration]: data.chain };
        setChain(data.chain);
      }
      // 404 → leave the current chain; the "No data yet for {date}" hint renders
    } catch {
      // network error → the snapshot poll keeps the chain fresh; nothing extra to show
    } finally {
      if (symbolRef.current === symbol && selectedExpRef.current === expiration) setChainLoading(false);
    }
  }, [symbol]);

  // on symbol switch (and first resolve): clear the old symbol's market data so it
  // never renders under the new symbol, then pull immediately
  useEffect(() => {
    if (!symbol) return;
    setQuote(null);
    setCandles([]);
    lastSnapshotRef.current = null;
    setExpirations([]);
    setSelectedExp(null);
    setChain(null);
    chainsRef.current = {};
    setIndicators(null);
    setGreeksData(null);
    setSignalData(null);
    setError(null);
    setNoData(false);
    setLastFetchOk(null);
    pullSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // polling loop
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (polling) pollRef.current = setInterval(pullSnapshot, intervalSec * 1000);
    return () => clearInterval(pollRef.current);
  }, [polling, intervalSec, pullSnapshot]);

  // switch every panel to a new symbol; the server-side active symbol is kept in
  // sync so a refresh with no ?symbol= targets the right one
  const selectSymbol = useCallback((raw) => {
    const sym = String(raw || "").trim().toUpperCase();
    if (!SYMBOL_RE.test(sym)) {
      setSearchError("Symbols are 1–6 letters (stocks/ETFs only), e.g. AAPL or BRK.B");
      return;
    }
    setSearchError(null);
    setSearchInput("");
    setRecentSymbols((cur) => {
      const next = [sym, ...cur.filter((s) => s !== sym)].slice(0, RECENT_CAP);
      saveKey(K_RECENT, next);
      return next;
    });
    if (sym === symbolRef.current) return;
    setSymbol(sym);
    // fire-and-forget: data endpoints get ?symbol= explicitly, so a failed PUT only
    // affects which symbol gets refreshed by default
    fetch(`${SERVER_URL}/api/symbol`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym }),
    }).catch(() => {});
  }, []);

  // "Go" calls this to pull a fresh snapshot: POSTs a refresh request, which the
  // server fetches directly from Tradier in-process (a few seconds).
  const triggerRefresh = useCallback(async (sym) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/refresh?symbol=${sym}`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!data) return;
      if (res.status === 409) {
        if (data.status?.status === "running") {
          setRefreshStatus(data.status); // already in flight — track its real status
        } else {
          const secs = data.retryAfterMs ? Math.ceil(data.retryAfterMs / 1000) : null;
          setRefreshStatus({
            symbol: sym,
            status: "cooldown",
            message: secs ? `Refreshed ${sym} recently — try again in ${secs}s` : `Refreshed ${sym} recently — try again shortly`,
          });
        }
      } else if (res.ok) {
        setRefreshStatus(data);
      }
    } catch {
      // network error requesting a refresh — the regular snapshot poll still works normally
    }
  }, [setRefreshStatus]);

  // "Reset snapshot" — deletes the symbol's fetched snapshot server-side (so
  // the next refresh starts clean instead of layering onto stale strikes/candles)
  // and clears everything derived from it locally, same fields the symbol-switch
  // effect above resets. Confirms first since this discards real fetched data.
  const resetSnapshot = useCallback(async () => {
    if (!symbol) return;
    if (!window.confirm(`Delete the fetched snapshot for ${symbol}? You'll need to fetch it again to see data.`)) return;
    try {
      await fetch(`${SERVER_URL}/api/snapshot?symbol=${symbol}`, { method: "DELETE" });
    } catch {
      // best-effort — clear local state regardless so the UI doesn't show stale data
    }
    setQuote(null);
    setCandles([]);
    lastSnapshotRef.current = null;
    setExpirations([]);
    setSelectedExp(null);
    setChain(null);
    chainsRef.current = {};
    setIndicators(null);
    setGreeksData(null);
    setSignalData(null);
    setError(null);
    setNoData(true);
    setLastFetchOk(null);
    clearRefreshStatus();
  }, [symbol, clearRefreshStatus]);

  // once a refresh finishes, pull the fresh snapshot immediately instead of waiting
  // for the next 5s poll tick
  useEffect(() => {
    if (refreshStatus?.status === "done" && refreshStatus?.symbol === symbol) {
      pullSnapshot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus?.status, refreshStatus?.updatedAt]);

  // keep the active symbol's fetched snapshot from going stale — separate from
  // the 5s/30s/etc "Poll every" cadence above, which only re-reads the last snapshot
  // already on disk. requestRefresh's 15s server-side cooldown makes this safe even
  // if the user also clicks "Fetch snapshot" manually around the same time.
  useEffect(() => {
    if (!symbol) return;
    const id = setInterval(() => triggerRefresh(symbol), AUTO_REFETCH_MS);
    return () => clearInterval(id);
  }, [symbol, triggerRefresh]);

  function confirmBuy() {
    if (!buyTarget || buyQty < 1) return;
    const cost = buyTarget.price * 100 * buyQty;
    if (cost > cash) {
      setError("Not enough simulated cash for that order.");
      return;
    }
    const pos = {
      id: crypto.randomUUID(),
      symbol,
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
    if (symbol) saveKey(portfolioKey(symbol), { cash: CASH_START, positions: [], trades: [] });
  }

  // Date-range trimming happens here, once, applied identically to candles and every
  // indicator series array — both `candles` and `indicators.series` are positionally
  // aligned to the FULL (unsliced) interval history, so they must be sliced by the same
  // start index or overlays render against the wrong bar (the original bug: slicing
  // candles alone left indicator series full-length, desyncing the two arrays).
  const days = rangeDays(candleRange);
  const chartBars = useMemo(() => sliceByRange(candles, days), [candles, days]);
  const chartSeries = useMemo(() => sliceSeriesByRange(indicators?.series, candles, days), [indicators, candles, days]);

  const secondsLeft = useCountdown(polling ? intervalSec * 1000 : null, lastFetchAt);
  const fetchStatus = lastFetchOk == null ? null : lastFetchOk ? "success" : "error";
  const indStatus = indError ? "error" : indicators ? "success" : null;
  const greeksStatus = greeksError ? "error" : greeksData && signalData ? "success" : null;

  const positionsValue = positions.reduce((sum, p) => sum + (p.mark ?? p.entryPrice) * 100 * p.qty, 0);
  const totalValue = cash + positionsValue;
  const totalPnl = totalValue - CASH_START;
  const up = quote && quote.change >= 0;
  const priceFlash = usePriceFlash(quote?.price);
  const buyTargetDisplay = useLingering(buyTarget);

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
        .module { margin-bottom:24px; }
        .module:last-child { margin-bottom:0; }
        .module-header { margin-bottom:10px; }
        .row { display:flex; align-items:center; gap:10px; }
        .header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:18px; }
        .dot { width:8px; height:8px; border-radius:50%; background:#3DDC84; box-shadow:0 0 8px #3DDC84; animation: dot-pulse 2s ease-in-out infinite; }
        .dot.off { background:#565C63; box-shadow:none; animation:none; }
        @keyframes dot-pulse { 0%, 100% { opacity:1; } 50% { opacity:.45; } }
        .price-big { font-size:40px; font-weight:600; letter-spacing:-0.5px; transition: color .5s ease; }
        .price-big.flash-up { color:#3DDC84; transition: color 60ms ease; }
        .price-big.flash-down { color:#FF5C5C; transition: color 60ms ease; }
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
        select, input[type=number], input[type=text] { background:#1B1F24; color:#E7E9EA; border:1px solid #2A2F35; border-radius:6px; padding:5px 8px; font-family:inherit; font-size:13px; }
        .search-input { width:90px; text-transform:uppercase; }
        .search-input::placeholder { text-transform:none; color:#565C63; }
        .section-title { font-size:18px; text-transform:uppercase; letter-spacing:1px; color:#8A9099; margin-bottom:10px; font-weight: 600; }
        .chip-row { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
        .chip { font-size:11px; line-height:1.4; padding:3px 8px; border-radius:99px; border:1px solid #2A2F35; background:transparent; letter-spacing:.3px; }
        .chip:hover:not(:disabled) { filter:brightness(1.2); }
        .chip.on { color:#0B0D0F; font-weight:600; }
        .chip:disabled { opacity:.35; cursor:default; filter:none; }
        .chip-sep { width:1px; align-self:stretch; background:#2A2F35; margin:2px 4px; }
        .chip-wrap { display:inline-flex; align-items:center; gap:2px; }
        .chip-help { width:15px; height:15px; padding:0; border-radius:50%; border:1px solid #2A2F35; background:transparent; color:#8A9099; font-size:9px; line-height:1; }
        .chip-help:hover { color:#E7E9EA; border-color:#3A3F46; }
        .iv-badge { font-size:11px; color:#8A9099; font-family:ui-monospace, monospace; padding:3px 8px; border:1px solid #2A2F35; border-radius:99px; }
        .pane-stack { display:flex; flex-direction:column; gap:14px; margin-top:10px; }
        .pane-card { background:#101316; border:1px solid #1E2227; border-radius:8px; padding:10px 0 8px; overflow:hidden; transition:opacity .15s, border-color .15s; }
        .pane-card.dragging { opacity:.35; }
        .pane-card.drag-over { border-color:#4C8DFF; }
        .pane-card-header { display:flex; align-items:center; gap:6px; padding:0 10px 8px; }
        .pane-card-title { font-size:11px; letter-spacing:.6px; text-transform:uppercase; color:#8A9099; font-family: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace; }
        .drag-handle { cursor:grab; color:#565C63; font-size:13px; line-height:1; padding:2px; user-select:none; }
        .drag-handle:active { cursor:grabbing; }
        .chart-tooltip { background:#14171A; border:1px solid #22262B; border-radius:8px; padding:8px 10px; font-size:11px; line-height:1.6; box-shadow:0 4px 14px rgba(0,0,0,.45); min-width:150px; }
        .chart-tooltip-date { font-size:10px; margin-bottom:4px; }
        .chart-tooltip-row { display:flex; gap:6px; flex-wrap:wrap; }
        .chart-tooltip-indicators { margin-top:6px; padding-top:6px; border-top:1px solid #1E2227; display:flex; flex-direction:column; gap:2px; }
        .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:10; }
        .modal { background:#14171A; border:1px solid #2A2F35; border-radius:10px; padding:20px; width:280px; }
        .modal.help { width:420px; max-width:92vw; max-height:82vh; overflow-y:auto; }
        .modal.help p { font-size:13px; line-height:1.6; color:#C9CDD1; margin:4px 0 12px; }
        .err { background:#3B1717; border:1px solid #6B1E1E; color:#FF9B9B; padding:8px 12px; border-radius:6px; font-size:13px; margin-bottom:14px; }
        .refresh-banner { margin-bottom: 16px; padding: 12px 16px; }
        .refresh-banner-error { border-color:#6B1E1E; }
        .spinner { width:12px; height:12px; border-radius:50%; border:2px solid #2A2F35; border-top-color:#4C8DFF; animation: spin .7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .progress-track { height:6px; border-radius:99px; background:#1B1F24; overflow:hidden; }
        .progress-fill { height:100%; background:#4C8DFF; transition: width .3s ease; }
        .refresh-log { max-height:140px; overflow-y:auto; background:#0F1114; border:1px solid #1E2227; border-radius:6px; padding:8px 10px; font-size:11px; line-height:1.7; }
        .refresh-log-line { white-space:pre-wrap; word-break:break-word; }
        .summary p { margin:4px 0 0; font-size:13px; line-height:1.6; color:#C9CDD1; }
        .summary .sub { font-weight:600; color:#E7E9EA; font-size:13px; margin-top:12px; }
        .trade-log { max-height:220px; overflow-y:auto; }
        @media (prefers-reduced-motion: reduce) {
          .dot { animation:none; }
          .price-big, .price-big.flash-up, .price-big.flash-down { transition:none; }
        }
      `}</style>

      <ActiveRefreshesList serverUrl={SERVER_URL} />

      <div className="header">
        <div>
          <div className="row">
            <span className={`dot ${polling ? "" : "off"}`} />
            <span className="section-title" style={{ margin: 0 }}>{symbol ?? "…"} paper trading &middot; live market data</span>
            <form
              className="row"
              style={{ gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                const sym = String(searchInput || "").trim().toUpperCase();
                selectSymbol(searchInput);
                if (SYMBOL_RE.test(sym)) triggerRefresh(sym);
              }}
            >
              <input
                className="search-input"
                type="text"
                placeholder="Symbol…"
                maxLength={8}
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  if (searchError) setSearchError(null);
                }}
              />
              <button type="submit" className="ghost" title="Fetch fresh market data for this symbol">Go</button>
            </form>
            <a
              href="/docs/how-it-works.html"
              target="_blank"
              rel="noopener noreferrer"
              className="ghost"
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              title="How the signal score is computed"
            >
              How it works
            </a>
          </div>
          {searchError && <div style={{ color: "#FF9B9B", fontSize: 12, marginTop: 4 }}>{searchError}</div>}
          {recentSymbols.length > 0 && (
            <div className="chip-row" style={{ marginTop: 8 }}>
              {recentSymbols.map((s) => (
                <button
                  key={s}
                  className={`chip ${s === symbol ? "on" : ""}`}
                  style={s === symbol ? { background: "#4C8DFF", borderColor: "#4C8DFF" } : undefined}
                  onClick={() => selectSymbol(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={symbol}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {quote ? (
                <div className="row" style={{ marginTop: 6 }}>
                  <span className={`price-big mono ${priceFlash === "up" ? "flash-up" : priceFlash === "down" ? "flash-down" : ""}`}>{fmt$(quote.price)}</span>
                  <span className={`mono ${up ? "green" : "red"}`}>{fmtPct(quote.changePct)} ({up ? "+" : ""}{quote.change.toFixed(2)})</span>
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 10 }}>{noData ? "No data yet." : "Loading quote…"}</div>
              )}
              {quote && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>as of {new Date(quote.asOf).toLocaleTimeString()}</div>}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="module" style={{ minWidth: 220, marginBottom: 0 }}>
          <div className="module-header"><div className="section-title" style={{ margin: 0 }}>Simulated account</div></div>
          <div className="card">
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
      </div>

      {!symbol && (
        <div className="card" style={{ marginBottom: 16, textAlign: "center", padding: 40 }}>
          <div className="section-title" style={{ marginBottom: 6 }}>No symbol selected</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Search for a stock or ETF above and click &ldquo;Go&rdquo; to fetch live market data and start paper trading.
          </div>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <IndicatorToggles active={activeInd} onToggle={toggleIndicator} onHelp={setHelpKey} disabled={false} interval={candleInterval} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Pick which indicators to track now — only the ones checked here get fetched once you select a symbol.
          </div>
        </div>
      )}

      {symbol && (
        <>
      {refreshStatus && <RefreshProgressBanner status={refreshStatus} onDismiss={clearRefreshStatus} />}

      {error && <div className="err">{error}</div>}

      {noData && (
        <div className="card" style={{ marginBottom: 16, textAlign: "center", padding: 28 }}>
          <div className="section-title" style={{ marginBottom: 6 }}>No data for {symbol} yet</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Click &ldquo;Go&rdquo; above to fetch live data for {symbol}. This page keeps polling and will
            pick the data up automatically.
          </div>
        </div>
      )}

      <div className="module">
        <div className="module-header row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Price</div>
          <IndicatorToggles active={activeInd} onToggle={toggleIndicator} onHelp={setHelpKey} disabled={false} iv={indicators?.iv} interval={candleInterval} />
          <div className="row">
            <RefetchStatus secondsLeft={polling ? secondsLeft : null} status={fetchStatus} />
            <div className="chip-row" title="Date range">
              {CANDLE_RANGES.map((r) => (
                <button
                  key={r.key}
                  className={`chip ${r.key === candleRange ? "on" : ""}`}
                  style={r.key === candleRange ? { background: "#4C8DFF", borderColor: "#4C8DFF" } : undefined}
                  onClick={() => setCandleRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <label className="muted" style={{ fontSize: 12 }}>Interval</label>
            <select
              value={candleInterval}
              onChange={(e) => setCandleInterval(e.target.value)}
              disabled={!INTRADAY_ONLY_RANGES.has(candleRange)}
              title={!INTRADAY_ONLY_RANGES.has(candleRange) ? "3M/1Y history is only available as daily candles" : undefined}
            >
              {CANDLE_INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
            </select>
            <label className="muted" style={{ fontSize: 12 }}>Poll every</label>
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>
              <option value={5}>5s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
              <option value={120}>2m</option>
            </select>
            <button className="ghost" onClick={() => setPolling((p) => !p)}>{polling ? "Pause" : "Resume"}</button>
            <button className="ghost" onClick={pullSnapshot}>Refresh now</button>
            <button className="ghost" title="Fetch fresh market data for this symbol" onClick={() => symbol && triggerRefresh(symbol)} disabled={!symbol}>
              Fetch snapshot
            </button>
            <button className="ghost" title="Delete this symbol's fetched data and start over" onClick={resetSnapshot} disabled={!symbol}>
              Reset snapshot
            </button>
          </div>
        </div>
        <div className="card">
          {chartBars.length ? (
            <Candlestick bars={chartBars} height={280} series={chartSeries} active={activeInd} interval={candleInterval} />
          ) : (
            <div className="muted" style={{ padding: 20, textAlign: "center" }}>
              No {candleInterval} candles yet for {symbol ?? "this symbol"} — click &ldquo;Go&rdquo; to refresh it.
            </div>
          )}
        </div>
      </div>

      <SummaryPanel quote={quote} greeks={greeksData} signal={signalData} symbol={symbol} />

      <div className="module-header"><div className="section-title" style={{ margin: "0 0 10px" }}>Option chain</div></div>
      <div className="grid module">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <select
              value={selectedExp || ""}
              onChange={(e) => {
                const date = e.target.value;
                setSelectedExp(date);
                selectedExpRef.current = date; // update now — fetchChain's stale guard reads it before the effect runs
                if (chainsRef.current[date]) setChain(chainsRef.current[date]); // instant paint from cache…
                fetchChain(date); // …then refresh that expiration from the server
              }}
            >
              {expirations.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {chainLoading && <div className="muted" style={{ marginTop: 10 }}>Loading chain…</div>}
          {!chainLoading && selectedExp && !chainsRef.current[selectedExp] && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              No data yet for {selectedExp}.{chain ? " Showing last loaded expiration below." : " Click “Go” to refresh."}
            </div>
          )}
          {chain && !chainLoading && (() => {
            // prefer the server-enriched chain (computed greeks/IV) when available for this
            // expiration; fall back to the raw snapshot rows otherwise
            const view = greeksData?.chains?.[selectedExp] ?? chain;
            const hasGreeks = view.strikes.some((s) => s.call?.delta != null || s.put?.delta != null);
            // highlight the strikes the autopilot would buy (only for the expiration it analyzed)
            const preview = greeksData?.preview?.expiration === selectedExp ? greeksData.preview : null;
            const pickOf = (strike) =>
              preview?.call?.strike === strike ? "call" : preview?.put?.strike === strike ? "put" : null;
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
                  {view.strikes.map((s) => (
                    <motion.tr
                      key={s.strike}
                      animate={{ backgroundColor: pickOf(s.strike) ? "rgba(76,141,255,.07)" : "rgba(76,141,255,0)" }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                      title={pickOf(s.strike) ? `autopilot ${pickOf(s.strike)} pick (${preview[pickOf(s.strike)].mode})` : undefined}
                    >
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
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>

        <div>
          <div className="module-header"><div className="section-title" style={{ margin: 0 }}>Open positions</div></div>
          <div className="card">
          {positions.length === 0 && <div className="muted">No open positions.</div>}
          {positions.length > 0 && (
            <table>
              <thead><tr><th>Contract</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&amp;L</th><th></th></tr></thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {positions.map((p) => {
                    const mark = p.mark ?? p.entryPrice;
                    const pnl = (mark - p.entryPrice) * 100 * p.qty;
                    return (
                      <motion.tr
                        key={p.id}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                      >
                        <td className="mono">{p.symbol ?? symbol} {p.strike}{p.type === "call" ? "C" : "P"} {p.expiration}</td>
                        <td className="mono">{p.qty}</td>
                        <td className="mono">{p.entryPrice.toFixed(2)}</td>
                        <td className="mono">{mark.toFixed(2)}</td>
                        <td className={`mono ${pnl >= 0 ? "green" : "red"}`}>{fmt$(pnl)}</td>
                        <td><button className="ghost" onClick={() => closePosition(p)}>Close</button></td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          )}

          <div className="section-title" style={{ marginTop: 18 }}>Trade log</div>
          <div className="trade-log">
            {trades.length === 0 && <div className="muted">No trades yet.</div>}
            <AnimatePresence initial={false}>
              {trades.map((t) => (
                <motion.div
                  key={`${t.id}-${t.action}`}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="mono"
                  style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid #1A1D21" }}
                >
                  <span className={t.action === "BUY" ? "green" : "red"}>{t.action}</span> {t.qty}x {t.symbol ?? symbol} {t.strike}{t.type === "call" ? "C" : "P"} {t.expiration} @ {(t.action === "BUY" ? t.entryPrice : t.closePrice).toFixed(2)}
                  <span className="muted"> &middot; {new Date(t.at).toLocaleTimeString()}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 24 }}>
        <div>
          <AutopilotPanel symbol={symbol} />
          <GreeksPanel greeks={greeksData} signal={signalData} error={greeksError} secondsLeft={polling ? secondsLeft : null} status={greeksStatus} />
          <VolSurfacePanel signal={signalData} error={greeksError} />
          <GammaExposurePanel signal={signalData} error={greeksError} />
        </div>
        <div>
          <IndicatorsPanel data={indicators} error={indError} secondsLeft={polling ? secondsLeft : null} status={indStatus} active={activeInd} />
          <NewsPanel symbol={symbol} />
          <DivergencePanel signal={signalData} error={greeksError} />
        </div>
      </div>

      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button className="ghost" onClick={resetSim}>Reset simulator (manual paper account)</button>
      </div>
        </>
      )}

      <Modal open={!!buyTarget} onClose={() => setBuyTarget(null)}>
        {buyTargetDisplay && (
          <>
            <div className="section-title">Buy to open</div>
            <div style={{ marginBottom: 10 }}>
              {symbol} {buyTargetDisplay.strike}{buyTargetDisplay.type === "call" ? "C" : "P"} {selectedExp}
              <div className="mono muted">mid {buyTargetDisplay.price.toFixed(2)}</div>
            </div>
            <label className="muted" style={{ fontSize: 12 }}>Contracts</label>
            <input type="number" min={1} value={buyQty} onChange={(e) => setBuyQty(Math.max(1, Number(e.target.value)))} style={{ width: "100%", marginTop: 4, marginBottom: 12 }} />
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
              <span className="muted">Cost</span>
              <span className="mono">{fmt$(buyTargetDisplay.price * 100 * buyQty)}</span>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="ghost" onClick={() => setBuyTarget(null)}>Cancel</button>
              <button className="buy" onClick={confirmBuy}>Confirm</button>
            </div>
          </>
        )}
      </Modal>

      <IndicatorHelpModal helpKey={helpKey} onClose={() => setHelpKey(null)} />
    </div>
  );
}
