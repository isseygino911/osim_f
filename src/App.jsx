import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Candlestick from "./Candlestick.jsx";
import IndicatorHelpModal from "./IndicatorHelpModal.jsx";
import IndicatorToggles, { IndicatorMenu, DropdownMenu } from "./IndicatorToggles.jsx";
import { DEFAULT_ACTIVE, sanitizeActive } from "./indicatorConfig.js";
import { loadKey, saveKey } from "./storage.js";
import { IndicatorsPanel, NewsPanel, AutopilotPanel, GreeksPanel, DivergencePanel, VolSurfacePanel, GammaExposurePanel } from "./Autopilot.jsx";
import { Modal } from "./Modal.jsx";
import SummaryPanel from "./SummaryPanel.jsx";
import { useCountdown, RefetchStatus, LoadingScreen } from "./RefetchStatus.jsx";
import { useRefreshStatusPoll, ActiveRefreshesList, RefreshProgressBanner } from "./RefreshProgress.jsx";
import useMediaQuery from "./useMediaQuery.js";

// Collapsible section for the lower-priority "deep analytics" panels (vol surface,
// gamma exposure, divergence) — collapsed by default so the page doesn't force a
// scroll past dense tables most users only check occasionally. Exported so the mobile
// Signal tab's "Advanced analytics" accordion can reuse it (see App()).
export function CollapsibleSection({ title, subtitle, defaultOpen = false, children, secondsLeft = null, status = null, updatedAt = null }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="module">
      <button
        className="ghost collapsible-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}
      >
        <span>
          <span className="collapsible-caret">{open ? "▾" : "▸"}</span>
          <span className="collapsible-title">{title}</span>
          {subtitle && <span className="muted collapsible-subtitle">{subtitle}</span>}
        </span>
        <RefetchStatus secondsLeft={secondsLeft} status={status} updatedAt={updatedAt} />
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

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
const POLL_DEFAULT = 180; // seconds; matches the server's 3min snapshot auto-refresh cadence
const AUTO_REFETCH_MS = 3 * 60 * 1000; // matches the server's AUTO_REFRESH_INTERVAL_MS (refresh.service.js)
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

const K_ACTIVE_TAB = "sim-active-tab"; // sessionStorage: survives a refresh, not a fresh tab/window

// Inline SVG icons for the bottom tab bar — no icon library dependency, styled to
// match the existing mono/line aesthetic (stroke-based, currentColor).
function ChartTabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="5" y1="18" x2="5" y2="10" />
      <line x1="12" y1="18" x2="12" y2="6" />
      <line x1="19" y1="18" x2="19" y2="13" />
      <line x1="12" y1="6" x2="12" y2="3" opacity="0.6" />
    </svg>
  );
}
function SignalTabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14l4-4 3 3 6-8 5 6" />
      <circle cx="21" cy="11" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function NewsTabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function RefreshIcon({ spinning }) {
  return (
    <svg
      viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={spinning ? { animation: "spin .7s linear infinite", transformOrigin: "center" } : undefined}
    >
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <polyline points="20 4 20 11 13 11" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const TABS = [
  { key: "chart", label: "Chart", Icon: ChartTabIcon },
  { key: "signal", label: "Signal", Icon: SignalTabIcon },
  { key: "news", label: "News", Icon: NewsTabIcon },
];

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
  const lastSnapshotRef = useRef(null); // raw snapshot from the last successful pull, for re-slicing candles on interval change
  const candleIntervalRef = useRef(candleInterval); // always-current mirror of candleInterval for pullSnapshot's async closure
  const symbolRef = useRef(symbol); // always-current symbol so in-flight pulls for a switched-away symbol get dropped
  symbolRef.current = symbol;
  const { status: refreshStatus, setStatus: setRefreshStatus, clear: clearRefreshStatus } = useRefreshStatusPoll(symbol, SERVER_URL);
  // bumped by triggerRefresh so NewsPanel force-refreshes as part of one "Refresh all" action —
  // there's no other automatic news poll anymore (see Autopilot.jsx's commented-out NEWS_POLL_MS interval).
  const [newsRefreshToken, setNewsRefreshToken] = useState(0);

  // mobile shell state — see the design spec (§4) for the 767px breakpoint
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [activeTab, setActiveTab] = useState(() => {
    const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(K_ACTIVE_TAB) : null;
    return TABS.some((t) => t.key === stored) ? stored : "chart";
  });
  const [mSearchOpen, setMSearchOpen] = useState(false); // header ticker tap → slide-down search panel
  const [mAccountOpen, setMAccountOpen] = useState(false); // header account icon → account drawer sheet
  const [mChartSettingsOpen, setMChartSettingsOpen] = useState(false); // "..." button → chart settings sheet

  useEffect(() => {
    sessionStorage.setItem(K_ACTIVE_TAB, activeTab);
  }, [activeTab]);

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
        setLastFetchAt(Date.now());
      }
    }
  }, [symbol]);

  // on symbol switch (and first resolve): clear the old symbol's market data so it
  // never renders under the new symbol, then pull immediately
  useEffect(() => {
    if (!symbol) return;
    setQuote(null);
    setCandles([]);
    lastSnapshotRef.current = null;
    setIndicators(null);
    setGreeksData(null);
    setSignalData(null);
    setError(null);
    setNoData(false);
    setLastFetchOk(null);
    pullSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // Auto-polling loop disabled for now — data only refreshes on "Go"/"Refresh all" clicks.
  // Was: useEffect(() => {
  //   if (pollRef.current) clearInterval(pollRef.current);
  //   if (polling) pollRef.current = setInterval(pullSnapshot, intervalSec * 1000);
  //   return () => clearInterval(pollRef.current);
  // }, [polling, intervalSec, pullSnapshot]);

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

  // Only one symbol's worth of data should exist at a time — wipe every OTHER
  // symbol's snapshot + autopilot portfolio before fetching a new one, so switching
  // symbols never leaves stale sets sitting around on disk.
  const clearOtherSymbols = useCallback(async (keepSymbol) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/symbols`);
      const data = await res.json().catch(() => null);
      const others = (data?.symbols ?? []).map((s) => s.symbol).filter((s) => s !== keepSymbol);
      await Promise.all(
        others.flatMap((s) => [
          fetch(`${SERVER_URL}/api/snapshot?symbol=${s}`, { method: "DELETE" }).catch(() => {}),
          fetch(`${SERVER_URL}/api/autopilot?symbol=${s}`, { method: "DELETE" }).catch(() => {}),
        ])
      );
    } catch {
      // best-effort — a failed cleanup shouldn't block fetching the symbol the user actually asked for
    }
  }, []);

  // "Go" and "Refresh all" both call this — the one action that updates everything:
  // clear any other symbol's data (see clearOtherSymbols above), then a real Tradier
  // fetch for this symbol + snapshot/indicators/greeks/signal/chain (via the
  // refreshStatus "done" effect below) + news (bumping newsRefreshToken forces NewsPanel
  // to refetch even though its own automatic poll is disabled).
  const triggerRefresh = useCallback(async (sym) => {
    await clearOtherSymbols(sym);
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
        setNewsRefreshToken((n) => n + 1);
      }
    } catch {
      // network error requesting a refresh — there's no background poll to fall back on anymore
    }
  }, [setRefreshStatus, clearOtherSymbols]);

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
    setIndicators(null);
    setGreeksData(null);
    setSignalData(null);
    setError(null);
    setNoData(true);
    setLastFetchOk(null);
    clearRefreshStatus();
  }, [symbol, clearRefreshStatus]);

  // once a refresh finishes, pull the fresh snapshot immediately instead of waiting
  // for the next scheduled "Poll every" tick
  useEffect(() => {
    if (refreshStatus?.status === "done" && refreshStatus?.symbol === symbol) {
      pullSnapshot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshStatus?.status, refreshStatus?.updatedAt]);

  // Background auto-refetch disabled for now — the active symbol's snapshot only
  // updates via an explicit "Go"/"Refresh all" click (triggerRefresh).
  // Was: useEffect(() => {
  //   if (!symbol) return;
  //   const id = setInterval(() => triggerRefresh(symbol), AUTO_REFETCH_MS);
  //   return () => clearInterval(id);
  // }, [symbol, triggerRefresh]);

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
      expiration: null, // manual buy flow is disabled — option chain (and its expiration selection) was removed
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
    <div className={`wrap ${isMobile ? "mobile-shell" : ""}`}>
      <style>{`
        :root {
          /* ---- Color: backgrounds ---- */
          --bg-page: #0B0D0F;
          --bg-card: #14171A;
          --bg-pane: #101316;
          --bg-input: #1B1F24;
          --bg-log: #0F1114;

          /* ---- Color: borders ---- */
          --border-default: #22262B;
          --border-strong: #2A2F35;
          --border-hover: #3A3F46;
          --border-pane: #1E2227;
          --border-hairline: #1A1D21;

          /* ---- Color: text ---- */
          --text-primary: #E7E9EA;
          --text-secondary: #C9CDD1;
          --text-muted: #8A9099;
          --text-disabled: #565C63;

          /* ---- Color: semantic ---- */
          --green: #3DDC84;
          --red: #FF5C5C;
          --amber: #E8A33D;
          --accent-blue: #4C8DFF;

          --buy-bg: #123B26;
          --buy-border: #1E6B3F;
          --buy-text: #3DDC84;
          --sell-bg: #3B1717;
          --sell-border: #6B1E1E;
          --sell-text: #FF5C5C;
          --err-text: #FF9B9B;

          /* ---- Typography ---- */
          --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          --font-mono: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace;

          --text-price-lg: 40px;
          --text-price-lg-mobile: 28px;
          --text-section-title: 18px;
          --text-body: 13px;
          --text-label: 12px;
          --text-chip: 11px;
          --text-micro: 10px;

          /* ---- Spacing scale (4px base) ---- */
          --space-1: 4px;
          --space-2: 8px;
          --space-3: 12px;
          --space-4: 16px;
          --space-5: 20px;
          --space-6: 24px;
          --space-8: 32px;

          /* ---- Radius scale ---- */
          --radius-sm: 6px;
          --radius-md: 8px;
          --radius-lg: 10px;
          --radius-pill: 99px;

          /* ---- Layout / mobile chrome ---- */
          --header-height: 56px;
          --tabbar-height: 56px;
          --safe-top: env(safe-area-inset-top, 0px);
          --safe-bottom: env(safe-area-inset-bottom, 0px);
          --tabbar-float-gap: var(--space-3); /* gap between the floating pill nav and the safe-area edge */
          --tabbar-total-height: calc(var(--tabbar-height) + var(--safe-bottom) + var(--tabbar-float-gap));
          --content-bottom-clearance: calc(var(--tabbar-total-height) + var(--space-3));
          --tap-target-min: 44px;

          /* ---- Z-index scale ---- */
          --z-base: 0;
          --z-sticky-column: 1;
          --z-chart-tooltip: 5;
          --z-sticky-header: 10;
          --z-tabbar: 20;
          --z-banner: 25;
          --z-sheet-backdrop: 40;
          --z-sheet: 41;
          --z-modal-backdrop: 50;
          --z-modal: 51;
          --z-toast: 60;
        }
        /* matches .wrap so iOS Safari's toolbar-collapse/bounce never reveals a white gap below the fixed mobile nav */
        html, body { background:var(--bg-page); }
        .wrap { background:var(--bg-page); color:var(--text-primary); font-family: var(--font-sans); min-height:100vh; padding:20px; box-sizing:border-box; }
        .mono { font-family: var(--font-mono); }
        .muted { color:var(--text-muted); }
        .green { color:var(--green); }
        .red { color:var(--red); }
        .amber { color:var(--amber); }
        .hl { font-weight:700; }
        .card { background:var(--bg-card); border:1px solid var(--border-default); border-radius:var(--radius-lg); padding:16px; }
        .module { margin-bottom:24px; }
        .module:last-child { margin-bottom:0; }
        .module-header { margin-bottom:10px; }
        .row { display:flex; align-items:center; gap:10px; }
        .header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:18px; }
        .dot { width:8px; height:8px; border-radius:50%; background:var(--green); box-shadow:0 0 8px var(--green); animation: dot-pulse 2s ease-in-out infinite; }
        .dot.off { background:var(--text-disabled); box-shadow:none; animation:none; }
        @keyframes dot-pulse { 0%, 100% { opacity:1; } 50% { opacity:.45; } }
        .price-big { font-size:var(--text-price-lg); font-weight:600; letter-spacing:-0.5px; transition: color .5s ease; }
        .price-big.flash-up { color:var(--green); transition: color 60ms ease; }
        .price-big.flash-down { color:var(--red); transition: color 60ms ease; }
        table { width:100%; border-collapse:collapse; font-size:13px; }
        th { text-align:right; color:var(--text-muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--border-default); }
        th:first-child, td:first-child { text-align:left; }
        td { text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-hairline); }
        .strike-cell { color:var(--amber); font-weight:600; }
        button, a.ghost { font-family:inherit; cursor:pointer; border-radius:var(--radius-sm); border:1px solid var(--border-strong); background:var(--bg-input); color:var(--text-primary); padding:5px 10px; font-size:12px; }
        button:hover, a.ghost:hover { border-color:var(--border-hover); }
        button.buy { background:var(--buy-bg); border-color:var(--buy-border); color:var(--buy-text); }
        button.sell { background:var(--sell-bg); border-color:var(--sell-border); color:var(--sell-text); }
        button.ghost, a.ghost { background:transparent; }
        a.ghost { text-decoration:none; display:inline-flex; align-items:center; line-height:1.4; }
        button.small, a.small { padding:3px 8px; font-size:11px; }
        select, input[type=number], input[type=text] { background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-strong); border-radius:var(--radius-sm); padding:5px 8px; font-family:inherit; font-size:13px; }
        .search-input { width:90px; text-transform:uppercase; }
        .search-input::placeholder { text-transform:none; color:var(--text-disabled); }
        .section-title { font-size:var(--text-section-title); text-transform:uppercase; letter-spacing:1px; color:var(--text-muted); margin-bottom:10px; font-weight: 600; }
        .subsection-title { font-size:var(--text-label); text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); font-weight:600; padding-top:14px; margin-top:14px; border-top:1px solid var(--border-pane); }
        .chip-row { display:flex; flex-wrap:wrap; align-items:center; gap:4px; }
        .chip { font-size:var(--text-chip); line-height:1.4; padding:3px 8px; border-radius:var(--radius-pill); border:1px solid var(--border-strong); background:transparent; letter-spacing:.3px; }
        .chip:hover:not(:disabled) { filter:brightness(1.2); }
        .chip.on { color:var(--bg-page); font-weight:600; }
        .chip:disabled { opacity:.35; cursor:default; filter:none; }
        .chip-sep { width:1px; align-self:stretch; background:var(--border-strong); margin:2px 4px; }
        .range-chip { font-size:var(--text-chip); line-height:1.4; padding:4px 8px; margin:0 2px; border:none; background:transparent; color:var(--text-muted); letter-spacing:.3px; border-radius:var(--radius-sm); }
        .range-chip:hover:not(:disabled) { color:var(--text-primary); }
        .range-chip.on { color:var(--accent-blue); font-weight:600; }
        .range-chip:disabled { opacity:.35; cursor:default; }
        .chip-wrap { display:inline-flex; align-items:center; gap:2px; }
        .chip-help { width:15px; height:15px; padding:0; border-radius:50%; border:1px solid var(--border-strong); background:transparent; color:var(--text-muted); font-size:9px; line-height:1; }
        .chip-help:hover { color:var(--text-primary); border-color:var(--border-hover); }
        .iv-badge { font-size:var(--text-chip); color:var(--text-muted); font-family:var(--font-mono); padding:3px 8px; border:1px solid var(--border-strong); border-radius:var(--radius-pill); }
        .indicator-menu { position:relative; }
        .indicator-menu-btn { display:inline-flex; align-items:center; gap:6px; }
        .indicator-menu-btn.on { border-color:var(--accent-blue); color:var(--text-primary); }
        .indicator-menu-count { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; padding:0 4px; border-radius:var(--radius-pill); background:var(--accent-blue); color:#fff; font-size:10px; font-weight:600; }
        .indicator-menu-caret { font-size:9px; opacity:.7; }
        .indicator-menu-panel { position:absolute; top:calc(100% + 6px); left:0; z-index:var(--z-sticky-header); width:min(420px, 80vw); background:var(--bg-card); border:1px solid var(--border-default); border-radius:var(--radius-lg); padding:14px; box-shadow:0 12px 32px rgba(0,0,0,.45); }
        .indicator-menu-group + .indicator-menu-group { margin-top:12px; }
        .indicator-menu-group-title { font-size:var(--text-label); text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); font-weight:600; margin-bottom:6px; }
        .indicator-menu-panel .chip-row { row-gap:6px; }
        .pane-stack { display:flex; flex-direction:column; gap:14px; margin-top:10px; }
        .pane-card { background:var(--bg-pane); border:1px solid var(--border-pane); border-radius:var(--radius-md); padding:10px 0 8px; overflow:hidden; transition:opacity .15s, border-color .15s, transform .15s, box-shadow .15s; }
        .pane-card.dragging { opacity:.35; }
        .pane-card.drag-over { border-color:var(--accent-blue); }
        .pane-card-header { display:flex; align-items:center; gap:6px; padding:0 10px 8px; }
        .pane-card-header.dragging { transform:scale(1.02); box-shadow:0 6px 18px rgba(0,0,0,.4); }
        .pane-card-title { font-size:11px; letter-spacing:.6px; text-transform:uppercase; color:var(--text-muted); font-family: var(--font-mono); }
        .drag-handle { cursor:grab; color:var(--text-disabled); font-size:13px; line-height:1; padding:2px; user-select:none; touch-action:none; }
        .drag-handle:active { cursor:grabbing; }
        .drag-handle-pulse, .reorder-pulse .drag-handle { animation: reorder-flash .15s ease-out; }
        @keyframes reorder-flash { 0% { box-shadow:0 0 0 0 var(--accent-blue); } 100% { box-shadow:0 0 0 4px rgba(76,141,255,0); } }
        .chart-tooltip { background:var(--bg-card); border:1px solid var(--border-default); border-radius:var(--radius-md); padding:8px 10px; font-size:11px; line-height:1.6; box-shadow:0 4px 14px rgba(0,0,0,.45); min-width:150px; }
        .chart-tooltip-date { font-size:10px; margin-bottom:4px; }
        .chart-tooltip-row { display:flex; gap:6px; flex-wrap:wrap; }
        .chart-tooltip-indicators { margin-top:6px; padding-top:6px; border-top:1px solid var(--border-pane); display:flex; flex-direction:column; gap:2px; }
        .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; z-index:var(--z-modal-backdrop); }
        .modal { background:var(--bg-card); border:1px solid var(--border-strong); border-radius:var(--radius-lg); padding:20px; width:280px; }
        .modal.help { width:420px; max-width:92vw; max-height:82vh; overflow-y:auto; }
        .modal.help p { font-size:13px; line-height:1.6; color:var(--text-secondary); margin:4px 0 12px; }
        .err { background:var(--sell-bg); border:1px solid var(--sell-border); color:var(--err-text); padding:8px 12px; border-radius:var(--radius-sm); font-size:13px; margin-bottom:14px; }
        .refresh-banner { margin-bottom: 16px; padding: 12px 16px; }
        .refresh-banner-error { border-color:var(--sell-border); }
        .spinner { width:12px; height:12px; border-radius:50%; border:2px solid var(--border-strong); border-top-color:var(--accent-blue); animation: spin .7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .progress-track { height:6px; border-radius:var(--radius-pill); background:var(--bg-input); overflow:hidden; }
        .progress-fill { height:100%; background:var(--accent-blue); transition: width .3s ease; }
        .refresh-log { max-height:140px; overflow-y:auto; background:var(--bg-log); border:1px solid var(--border-pane); border-radius:var(--radius-sm); padding:8px 10px; font-size:11px; line-height:1.7; }
        .refresh-log-line { white-space:pre-wrap; word-break:break-word; }
        .summary p { margin:4px 0 0; font-size:13px; line-height:1.6; color:var(--text-secondary); }
        .summary .sub { font-weight:600; color:var(--text-primary); font-size:13px; margin-top:12px; }
        .trade-log { max-height:220px; overflow-y:auto; }
        .news-log-full { max-height:none; overflow-y:visible; }
        /* compact NewsPanel: no card shell, stacked header instead of one crowded row */
        .news-compact-header { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
        .news-compact-title { font-size:14px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); font-weight:600; }
        .news-compact-header .row { flex-wrap:wrap; gap:8px; }
        .collapsible-header { display:flex; align-items:center; flex-wrap:wrap; row-gap:2px; gap:8px; width:100%; justify-content:flex-start; background:var(--bg-card); border:1px solid var(--border-default); border-radius:var(--radius-lg); padding:12px 16px; }
        .collapsible-header:hover { border-color:var(--border-hover); }
        .collapsible-header:hover .collapsible-title { color:var(--text-secondary); }
        .collapsible-caret { color:var(--text-muted); font-size:11px; width:10px; }
        .collapsible-title { font-size:14px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-muted); font-weight:600; }
        .collapsible-subtitle { font-size:12px; font-weight:400; flex-basis:100%; margin-left:18px; }
        @media (prefers-reduced-motion: reduce) {
          .dot { animation:none; }
          .price-big, .price-big.flash-up, .price-big.flash-down { transition:none; }
        }

        /* =====================================================================
           Mobile shell (<=767px) + tablet band (768-1023px) — additive layer.
           Desktop (>=1024px) renders none of this; the mobile shell components
           are simply not mounted above 767px (see isMobile in App()).
           ===================================================================== */

        /* ---- sheet variant of Modal (mobile bottom sheet) ---- */
        .modal-sheet, .modal.modal-sheet, .modal.help.modal-sheet {
          position: fixed; left: 5px; right: 5px; bottom: 0; width: auto; max-width: none;
          border-radius: 16px 16px 0 0;
          max-height: 85vh; overflow-y: auto;
          padding-top: 22px;
          padding-bottom: calc(20px + var(--safe-bottom));
          box-sizing: border-box;
        }
        .sheet-handle { position:absolute; top:8px; left:50%; transform:translateX(-50%); width:36px; height:4px; border-radius:var(--radius-pill); background:var(--border-strong); }
        .modal-bg:has(.modal-sheet) { align-items: flex-end; }

        @media (max-width: 767px) {
          .desktop-only { display: none !important; }
          body { padding-bottom: 0; }
          .wrap.mobile-shell { padding: 0 var(--space-3) var(--content-bottom-clearance); }

          .summary:not(.card) p { margin:4px 0 16px; }
          .summary:not(.card) .sub { font-size:14px; }

          /* sticky compact header */
          .m-header {
            position: sticky; top: 0; z-index: var(--z-sticky-header);
            display: flex; align-items: center; justify-content: space-between;
            height: var(--header-height);
            margin: 0 calc(-1 * var(--space-3)) 0;
            padding: 0 var(--space-3);
            background: var(--bg-page);
            border-bottom: 1px solid var(--border-hairline);
          }
          .m-header-left { display:flex; align-items:center; gap:6px; min-height:44px; padding:4px 6px 4px 2px; color:var(--text-muted); border-radius:var(--radius-pill); }
          .m-header-left:active { background:var(--bg-input); }
          .m-header-search-icon { display:flex; flex-shrink:0; color:var(--text-muted); }
          .m-ticker { font-size:15px; font-weight:700; color:var(--text-primary); }
          .m-chg-pill { font-size:10px; font-weight:600; padding:2px 6px; border-radius:var(--radius-pill); }
          .m-chg-pill.up { background:rgba(61,220,132,.15); color:var(--green); }
          .m-chg-pill.down { background:rgba(255,92,92,.15); color:var(--red); }
          .m-header-right { display:flex; align-items:center; gap:8px; }
          .m-price { font-size:15px; font-family:var(--font-mono); font-weight:600; transition:color .5s ease; }
          .m-price.flash-up { color:var(--green); transition:color 60ms ease; }
          .m-price.flash-down { color:var(--red); transition:color 60ms ease; }
          .m-account-btn { width:44px; height:44px; display:flex; align-items:center; justify-content:center; background:transparent; border:none; color:var(--text-muted); }
          .m-refresh-btn {
            display:flex; align-items:center; gap:5px; flex-shrink:0;
            height:30px; padding:0 10px; border-radius:var(--radius-pill);
            background:var(--bg-input); border:1px solid var(--border-strong); color:var(--text-primary);
            font-size:11px; font-weight:600;
          }
          .m-refresh-btn:disabled { opacity:.5; }
          .m-refresh-label { white-space:nowrap; }

          /* search slide-down panel */
          .m-search-panel { padding: var(--space-3); background:var(--bg-card); border-bottom:1px solid var(--border-hairline); margin: 0 calc(-1 * var(--space-3)); }

          /* compact refresh strip */
          .refresh-strip { display:flex; align-items:center; gap:8px; width:100%; height:28px; padding:0 var(--space-3); font-size:11px; border-radius:0; border:none; border-bottom:1px solid var(--border-hairline); background:var(--bg-card); margin: 0 calc(-1 * var(--space-3)); box-sizing:border-box; z-index: var(--z-banner); }
          .refresh-strip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

          /* bottom tab bar — floating rounded-pill dock, not a full-width bar pinned to the raw edge */
          .m-tabbar {
            position: fixed; left: var(--space-4); right: var(--space-4);
            bottom: calc(var(--safe-bottom) + var(--tabbar-float-gap));
            z-index: var(--z-tabbar);
            display: flex;
            gap: 2px;
            height: var(--tabbar-height);
            padding: 5px;
            border-radius: var(--radius-pill);
            background: var(--bg-card);
            border: 1px solid var(--border-default);
            box-shadow: 0 10px 28px rgba(0,0,0,.45);
          }
          .m-tab {
            flex: 1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
            background:transparent; border:none; border-radius:var(--radius-pill); color:var(--text-muted);
            height: 100%; padding: 0;
            position: relative;
          }
          .m-tab svg { width:20px; height:20px; }
          .m-tab-label { font-size:10px; text-transform:uppercase; letter-spacing:.4px; }
          .m-tab.active { color: var(--text-primary); background: var(--bg-input); }

          /* tab content */
          .m-tab-content { padding-top: var(--space-3); }

          /* chart tab */
          .m-chart-card { position: relative; }
          .m-chart-settings-btn {
            position:absolute; top:8px; right:8px; z-index:2;
            height:30px; border-radius:var(--radius-pill);
            display:flex; align-items:center; gap:5px; padding:0 10px 0 8px;
            font-size:11px; font-weight:600;
          }

          /* trade tab: expiration chip row scroll-snap */
          .m-exp-row { display:flex; gap:6px; overflow-x:auto; -webkit-overflow-scrolling:touch; scroll-snap-type:x proximity; padding-bottom:4px; }
          .m-exp-row .range-chip { scroll-snap-align:start; flex:0 0 auto; }
          .m-exp-chip { font-size:12px; }

          /* position cards (mobile "Open positions") */
          .m-position-card { background:var(--bg-card); border:1px solid var(--border-default); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:8px; }
          .m-position-card:last-child { margin-bottom:0; }
          .m-position-line1 { font-size:13px; font-family:var(--font-mono); }
          .m-position-line2 { font-size:12px; color:var(--text-muted); margin-top:2px; }
          .m-position-pnl { font-size:15px; font-weight:600; font-family:var(--font-mono); }
          .m-position-pnl.green { color:var(--accent-blue); }
          .m-buy-label { color:var(--accent-blue); }
          .m-position-row { display:flex; justify-content:space-between; align-items:center; margin-top:6px; }

          /* accordion group in Signal tab */
          .m-accordion-group .module { margin-bottom:10px; }

          /* touch target padding — visible size unchanged, tap area expanded */
          .chip { min-height: var(--tap-target-min); padding: 8px 12px; display:inline-flex; align-items:center; box-sizing:border-box; }
          .chip-help { position:relative; }
          .chip-help::after { content:""; position:absolute; inset:-8.5px; }
          .m-tab, .m-account-btn, .m-chart-settings-btn { min-width: var(--tap-target-min); min-height: var(--tap-target-min); }
        }

      `}</style>

      {isMobile ? (
        <>
          <div className="m-header">
            <button
              type="button"
              className="m-header-left"
              style={{ background: "transparent" }}
              onClick={() => setMSearchOpen((o) => !o)}
              aria-expanded={mSearchOpen}
              aria-label="Search for a symbol"
              title="Search symbol"
            >
              <span className="m-header-search-icon"><SearchIcon /></span>
              <span className="m-ticker">{symbol ?? "Search"}</span>
              {quote && (
                <span className={`m-chg-pill ${up ? "up" : "down"}`}>{fmtPct(quote.changePct)}</span>
              )}
            </button>
            <div className="m-header-right">
              <span className={`m-price mono ${priceFlash === "up" ? "flash-up" : priceFlash === "down" ? "flash-down" : ""}`}>
                {quote ? fmt$(quote.price) : "—"}
              </span>
              <button
                type="button"
                className="m-refresh-btn"
                onClick={() => symbol && triggerRefresh(symbol)}
                disabled={!symbol}
                aria-label="Refresh all data for this symbol"
                title="Clear any other symbol's data and fetch fresh market data for this symbol"
              >
                <RefreshIcon spinning={refreshStatus?.status === "running"} />
                <span className="m-refresh-label">Refresh</span>
              </button>
            </div>
            {/* Trading disabled for now — account/positions button hidden from UI */}
          </div>

          {mSearchOpen && (
            <div className="m-search-panel">
              <form
                className="row"
                style={{ gap: 6 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const sym = String(searchInput || "").trim().toUpperCase();
                  selectSymbol(searchInput);
                  if (SYMBOL_RE.test(sym)) triggerRefresh(sym);
                  setMSearchOpen(false);
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
                  style={{ flex: 1 }}
                  autoFocus
                />
                <button type="submit" className="ghost" title="Fetch fresh market data for this symbol">Go</button>
              </form>
              {searchError && <div style={{ color: "#FF9B9B", fontSize: 12, marginTop: 4 }}>{searchError}</div>}
              {recentSymbols.length > 0 && (
                <div className="chip-row" style={{ marginTop: 10 }}>
                  {recentSymbols.map((s) => (
                    <button
                      key={s}
                      className={`chip ${s === symbol ? "on" : ""}`}
                      style={s === symbol ? { background: "#4C8DFF", borderColor: "#4C8DFF" } : undefined}
                      onClick={() => {
                        selectSymbol(s);
                        setMSearchOpen(false);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {refreshStatus && <RefreshProgressBanner status={refreshStatus} onDismiss={clearRefreshStatus} compact />}

          <div className="m-tab-content">
            {!symbol && (
              <div className="card" style={{ marginTop: 12, textAlign: "center", padding: 40 }}>
                <div className="section-title" style={{ marginBottom: 6 }}>No symbol selected</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Tap the ticker above to search for a stock or ETF and start paper trading.
                </div>
              </div>
            )}

            {symbol && error && <div className="err" style={{ marginTop: 12 }}>{error}</div>}

            {symbol && noData && (
              <div className="card" style={{ marginTop: 12, textAlign: "center", padding: 28 }}>
                <div className="section-title" style={{ marginBottom: 6 }}>No data for {symbol} yet</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Tap the ticker above and hit &ldquo;Go&rdquo; to fetch live data for {symbol}.
                </div>
              </div>
            )}

            {symbol && !noData && activeTab === "chart" && (
              <>
                <div className="chip-row" style={{ justifyContent: "space-between" }}>
                  {CANDLE_RANGES.map((r) => (
                    <button
                      key={r.key}
                      className={`range-chip ${r.key === candleRange ? "on" : ""}`}
                      onClick={() => setCandleRange(r.key)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <div className="m-chart-card" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="ghost m-chart-settings-btn"
                    onClick={() => setMChartSettingsOpen(true)}
                    title="Chart settings"
                    aria-label="Chart settings"
                  >
                    <SettingsIcon />
                    <span>Settings</span>
                  </button>
                  {chartBars.length ? (
                    <Candlestick bars={chartBars} height={280} series={chartSeries} active={activeInd} interval={candleInterval} isMobile />
                  ) : (
                    <LoadingScreen />
                  )}
                </div>
                <div style={{ marginTop: 12 }}>
                  <SummaryPanel quote={quote} greeks={greeksData} signal={signalData} symbol={symbol} isMobile secondsLeft={null} updatedAt={lastFetchAt} status={fetchStatus} noData={noData} />
                </div>
              </>
            )}

            {symbol && !noData && activeTab === "signal" && (
              <>
                {/* Trading disabled for now — Autopilot hidden from UI, see server refresh.service.js/autopilot.service.js AUTO_REFRESH_ENABLED/AUTOPILOT_LOOP_ENABLED */}
                {/* <AutopilotPanel symbol={symbol} /> */}
                <div style={{ marginTop: 20 }}>
                  <IndicatorsPanel data={indicators} error={indError} secondsLeft={null} updatedAt={lastFetchAt} status={indStatus} active={activeInd} />
                </div>
                <div className="m-accordion-group" style={{ marginTop: 20 }}>
                  <CollapsibleSection title="Greeks" secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus}>
                    <GreeksPanel greeks={greeksData} signal={signalData} error={greeksError} secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus} hideHeader />
                  </CollapsibleSection>
                  <CollapsibleSection title="News vs options" secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus}>
                    <DivergencePanel signal={signalData} error={greeksError} hideHeader />
                  </CollapsibleSection>
                  <CollapsibleSection title="Volatility surface" secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus}>
                    <VolSurfacePanel signal={signalData} error={greeksError} hideHeader />
                  </CollapsibleSection>
                  <CollapsibleSection title="Gamma exposure" secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus}>
                    <GammaExposurePanel signal={signalData} error={greeksError} hideHeader />
                  </CollapsibleSection>
                </div>
              </>
            )}

            {symbol && !noData && activeTab === "news" && <NewsPanel symbol={symbol} compact fullHeight refreshToken={newsRefreshToken} />}
          </div>

          <nav className="m-tabbar">
            {TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={`m-tab ${activeTab === key ? "active" : ""}`}
                onClick={() => setActiveTab(key)}
              >
                <Icon />
                <span className="m-tab-label">{label}</span>
              </button>
            ))}
          </nav>

          {/* Trading disabled for now — Simulated account sheet hidden from UI (its trigger button is also removed) */}

          <Modal open={mChartSettingsOpen} onClose={() => setMChartSettingsOpen(false)} variant="sheet">
            <div className="section-title">Chart settings</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 4 }}>Interval</div>
            <div className="chip-row">
              {CANDLE_INTERVALS.map((iv) => (
                <button
                  key={iv}
                  className={`chip ${iv === candleInterval ? "on" : ""}`}
                  style={iv === candleInterval ? { background: "#4C8DFF", borderColor: "#4C8DFF" } : undefined}
                  disabled={!INTRADAY_ONLY_RANGES.has(candleRange)}
                  onClick={() => setCandleInterval(iv)}
                >
                  {iv}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 4 }}>Indicators</div>
            <IndicatorToggles active={activeInd} onToggle={toggleIndicator} onHelp={setHelpKey} disabled={false} iv={indicators?.iv} interval={candleInterval} />
            {/* Auto-polling disabled for now — "Poll every"/Pause-Resume controls hidden from UI */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-pane)", display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                className="buy"
                style={{ width: "100%", fontSize: 15, fontWeight: 700, padding: "12px 0" }}
                title="Clear any other symbol's data and fetch fresh market data for this symbol"
                onClick={() => symbol && triggerRefresh(symbol)}
                disabled={!symbol}
              >
                Refresh all
              </button>
              {/* "Reset snapshot" disabled for now — Refresh all already clears any other symbol's
                  data (see clearOtherSymbols in triggerRefresh) before fetching, so a separate manual
                  wipe of the CURRENT symbol isn't needed for the "1 set of data" workflow. */}
            </div>
          </Modal>

          {/* Trading disabled for now — Buy sheet hidden from UI (its triggers are all removed/no-op'd) */}

          <IndicatorHelpModal helpKey={helpKey} onClose={() => setHelpKey(null)} variant="sheet" />
        </>
      ) : (
      <>
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
            <button
              className="buy"
              style={{ fontSize: 15, fontWeight: 700, padding: "10px 20px" }}
              title="Clear any other symbol's data and fetch fresh market data for this symbol"
              onClick={() => symbol && triggerRefresh(symbol)}
              disabled={!symbol}
            >
              Refresh all
            </button>
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
              ) : noData ? (
                <div className="muted" style={{ marginTop: 10 }}>No data yet.</div>
              ) : (
                <LoadingScreen />
              )}
              {quote && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>as of {new Date(quote.asOf).toLocaleTimeString()}</div>}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Trading disabled for now — Simulated account panel hidden from UI */}
        {false && (
        <div className="module" style={{ minWidth: 220, marginBottom: 0 }}>
          <div className="module-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="section-title" style={{ margin: 0 }}>Simulated account</div>
            <RefetchStatus secondsLeft={null} updatedAt={lastFetchAt} status={fetchStatus} />
          </div>
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
        )}
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
          <div className="row">
            <RefetchStatus secondsLeft={null} updatedAt={lastFetchAt} status={fetchStatus} />
            <div className="chip-row" title="Date range">
              {CANDLE_RANGES.map((r) => (
                <button
                  key={r.key}
                  className={`range-chip ${r.key === candleRange ? "on" : ""}`}
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
            <IndicatorMenu active={activeInd} onToggle={toggleIndicator} onHelp={setHelpKey} disabled={false} iv={indicators?.iv} interval={candleInterval} align="right" />
            {/* Auto-polling controls and Reset snapshot disabled for now — "Refresh all" (header, above)
                is now the one prominent action; it already clears any other symbol's data first. */}
          </div>
        </div>
        <div className="card">
          {chartBars.length ? (
            <Candlestick bars={chartBars} height={520} series={chartSeries} active={activeInd} interval={candleInterval} />
          ) : noData ? (
            <div className="muted" style={{ padding: 20, textAlign: "center" }}>
              No {candleInterval} candles yet for {symbol ?? "this symbol"} — click &ldquo;Go&rdquo; to refresh it.
            </div>
          ) : (
            <LoadingScreen />
          )}
        </div>
      </div>

      <SummaryPanel quote={quote} greeks={greeksData} signal={signalData} symbol={symbol} secondsLeft={null} updatedAt={lastFetchAt} status={fetchStatus} noData={noData} />

      <div style={{ marginTop: 24 }}>
        <NewsPanel symbol={symbol} fullHeight refreshToken={newsRefreshToken} />
      </div>

      {/* Trading disabled for now — Autopilot hidden from UI, see server refresh.service.js/autopilot.service.js AUTO_REFRESH_ENABLED/AUTOPILOT_LOOP_ENABLED */}
      {/* <div style={{ marginTop: 24 }}>
        <AutopilotPanel symbol={symbol} />
      </div> */}

      <div style={{ marginTop: 24 }}>
        <IndicatorsPanel data={indicators} error={indError} secondsLeft={null} updatedAt={lastFetchAt} status={indStatus} active={activeInd} />
        <div style={{ marginTop: 24 }}>
          <GreeksPanel greeks={greeksData} signal={signalData} error={greeksError} secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus} />
        </div>
        <div style={{ marginTop: 24 }}>
          <VolSurfacePanel signal={signalData} error={greeksError} secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus} />
        </div>
        <div style={{ marginTop: 24 }}>
          <DivergencePanel signal={signalData} error={greeksError} secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus} />
        </div>
        <div style={{ marginTop: 24 }}>
          <GammaExposurePanel signal={signalData} error={greeksError} secondsLeft={null} updatedAt={lastFetchAt} status={greeksStatus} />
        </div>
      </div>

      {/* Trading disabled for now — Reset simulator button and Buy sheet hidden from UI */}
        </>
      )}

      <IndicatorHelpModal helpKey={helpKey} onClose={() => setHelpKey(null)} />
      </>
      )}
    </div>
  );
}
