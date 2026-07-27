import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
} from "lightweight-charts";
import { INDICATORS, PANE_HEIGHT } from "./indicatorConfig.js";
import { loadKey, saveKey } from "./storage.js";

const UP = "#3DDC84";
const DOWN = "#FF5C5C";
const AXIS = "#8A9099";
const GRID = "#1A1D21";
const BG = "#0B0D0F";

const K_PANE_ORDER = "qqq-sim-pane-order";
const K_PANE_HEIGHTS = "qqq-sim-pane-heights";
const K_AVWAP_ANCHOR = "qqq-sim-avwap-anchor";

const VPVR_BIN_COUNT = 24;
const VPVR_MAX_WIDTH_FRAC = 0.25; // widest bin reaches this fraction of the plot width
const VPVR_POC_COLOR = "#E8A33D";
const VPVR_BIN_COLOR = "#4C8DFF";
const AVWAP_COLOR = "#FFB86C";

// clamp range for drag-to-resize, per pane type
const PRICE_HEIGHT_RANGE = [160, 900];
const OSC_HEIGHT_RANGE = [50, 400];

const HEADER_H = 26; // height of the overlay drag-handle/title strip at the top of each pane

// "price" (the candle/volume chart) plus one entry per oscillator sub-pane
const OSC_PANES = [...new Set(INDICATORS.filter((c) => c.pane !== "price").map((c) => c.pane))];
const ALL_PANES = ["price", ...OSC_PANES];

const isNum = (v) => v != null && Number.isFinite(v);

// Drops pane keys that no longer exist and appends any new ones at the end,
// so a stale/partial localStorage value never hides a pane.
function sanitizeOrder(order) {
  const known = Array.isArray(order) ? order.filter((k) => ALL_PANES.includes(k)) : [];
  for (const k of ALL_PANES) if (!known.includes(k)) known.push(k);
  return known;
}

function moveItem(arr, fromKey, toKey) {
  const from = arr.indexOf(fromKey);
  const to = arr.indexOf(toKey);
  if (from === -1 || to === -1 || from === to) return arr;
  const next = arr.slice();
  next.splice(from, 1);
  next.splice(to, 0, fromKey);
  return next;
}

// Drops heights for panes that no longer exist / non-numeric junk from a stale value.
function sanitizeHeights(h) {
  const out = {};
  if (h && typeof h === "object") {
    for (const k of Object.keys(h)) {
      if (ALL_PANES.includes(k) && Number.isFinite(h[k])) out[k] = h[k];
    }
  }
  return out;
}

// Unix seconds for lightweight-charts' `Time` type. `bars[i].t` <-> `series[key][i]` index
// alignment is used only here, at the data boundary, to derive each point's own timestamp —
// nothing downstream keys off array position again (the library keys everything by `time`).
const toTime = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function paneDomain(cfg, series, n) {
  if (cfg.domain) return cfg.domain;
  const keys = cfg.histogram ? [...cfg.series, cfg.histogram] : cfg.series;
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of keys) {
    const arr = series?.[k];
    if (!arr) continue;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (!isNum(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) return [0, 1];
  if (cfg.symmetric) {
    const m = (Math.max(Math.abs(lo), Math.abs(hi)) || 1) * 1.15;
    return [-m, m];
  }
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  return [lo - pad, hi + pad];
}

// Line series don't accept `null` values — omit the point entirely to create a gap,
// equivalent to the old SVG build's "pen lift" behavior on null-padded/short arrays.
function toLineData(values, bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values?.[i];
    if (!isNum(v)) continue;
    out.push({ time: toTime(bars[i].t), value: v });
  }
  return out;
}

function DragHandle({ onDragStart, onDragEnd, onTouchStart, onTouchMove, onTouchEnd, pulse }) {
  return (
    <span
      className={`drag-handle ${pulse ? "drag-handle-pulse" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      title="Drag to reorder"
    >
      ⠿
    </span>
  );
}

const TOOLTIP_W = 190; // estimated rendered width, used only for edge-flip math
const TOOLTIP_H = 120; // estimated rendered height, used only for vertical edge-flip math
const TOOLTIP_MARGIN = 12;
const TOUCH_HOLD_CLEAR_DELAY_MS = 400; // tap-and-hold: linger after release so a quick tap is still readable
const LONG_PRESS_MS = 300; // touch long-press threshold to enter pane-reorder mode
const LONG_PRESS_MOVE_TOLERANCE = 10; // px of finger movement allowed before the long-press timer is cancelled

// clamps a tooltip's position to stay within [0, containerW] x [0, containerH], flipping
// above the touch/cursor point when there isn't room below (containerH is only supplied
// by touch callers today — mouse hover keeps the original "always below" placement since
// desktop tooltips have more room and no finger to avoid occluding).
function tooltipPos(clientX, clientY, containerW, containerH) {
  let left = clientX + TOOLTIP_MARGIN;
  if (left + TOOLTIP_W > containerW) left = clientX - TOOLTIP_MARGIN - TOOLTIP_W;
  left = Math.max(4, left);
  let top = clientY + TOOLTIP_MARGIN;
  if (containerH != null) {
    // offset above the touch point by default (so the tooltip never sits under the
    // finger), flipping below only if there isn't room above
    top = clientY - TOOLTIP_MARGIN - TOOLTIP_H;
    if (top < 4) top = Math.min(clientY + TOOLTIP_MARGIN + 16, containerH - TOOLTIP_H - 4);
  }
  return { left, top };
}

// Hover tooltip: full OHLCV + every active indicator's value at the hovered bar, shown
// near the cursor regardless of which pane (price or an oscillator) is being hovered.
function ChartTooltip({ bar, interval, legend, x, y, containerW, containerH }) {
  const up = bar.close >= bar.open;
  const { left, top } = tooltipPos(x, y, containerW, containerH);
  const dateLabel =
    interval === "1d"
      ? new Date(bar.t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : new Date(bar.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="chart-tooltip mono" style={{ position: "absolute", left, top, pointerEvents: "none", zIndex: 5 }}>
      <div className="chart-tooltip-date muted">{dateLabel}</div>
      <div className="chart-tooltip-row">
        <span className="muted">O</span> <span className={up ? "green" : "red"}>{bar.open.toFixed(2)}</span>
        <span className="muted">H</span> <span className={up ? "green" : "red"}>{bar.high.toFixed(2)}</span>
        <span className="muted">L</span> <span className={up ? "green" : "red"}>{bar.low.toFixed(2)}</span>
        <span className="muted">C</span> <span className={up ? "green" : "red"}>{bar.close.toFixed(2)}</span>
      </div>
      <div className="chart-tooltip-row muted">Vol {bar.volume.toLocaleString()}</div>
      {legend.length > 0 && (
        <div className="chart-tooltip-indicators">
          {legend.map((l) => (
            <div key={l.key} style={{ color: l.color }}>
              {l.label} <span style={{ opacity: 0.85 }}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Series primitives (v5 Series Primitives API) — lightweight-charts has no
// native series type for either of these, so both are canvas-rendered and
// attached directly to the candlestick series.
// ---------------------------------------------------------------------------

// Bollinger-style translucent fill between two line series (e.g. bbUpper/bbLower).
// The lines themselves are still drawn as regular LineSeries for crisp strokes +
// crosshair snapping; this primitive only paints the band fill beneath them.
class BandFillPrimitive {
  constructor(color) {
    this._color = color;
    this._upper = [];
    this._lower = [];
    this._series = null;
    this._chart = null;
    this._requestUpdate = null;
    this._paneViews = [new BandFillPaneView(this)];
  }
  setData(upper, lower) {
    this._upper = upper;
    this._lower = lower;
    this._requestUpdate?.();
  }
  attached({ series, chart, requestUpdate }) {
    this._series = series;
    this._chart = chart;
    this._requestUpdate = requestUpdate;
  }
  detached() {
    this._series = null;
    this._chart = null;
  }
  updateAllViews() {}
  paneViews() {
    return this._paneViews;
  }
}

class BandFillPaneView {
  constructor(primitive) {
    this._primitive = primitive;
  }
  zOrder() {
    return "bottom";
  }
  renderer() {
    const p = this._primitive;
    if (!p._series || !p._chart) return null;
    return new BandFillRenderer(p._upper, p._lower, p._series, p._chart, p._color);
  }
}

class BandFillRenderer {
  constructor(upper, lower, series, chart, color) {
    this._upper = upper;
    this._lower = lower;
    this._series = series;
    this._chart = chart;
    this._color = color;
  }
  draw(target) {
    const { _upper: upper, _lower: lower, _series: series, _chart: chart, _color: color } = this;
    if (!upper.length || !lower.length) return;
    const timeScale = chart.timeScale();
    const lowerByTime = new Map(lower.map((p) => [p.time, p.value]));
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      // one filled subpath per contiguous run of (upper,lower) points that both resolve
      // to on-screen coordinates — mirrors the old SVG's per-run band polygon behavior.
      let run = [];
      const flush = () => {
        if (run.length < 2) {
          run = [];
          return;
        }
        ctx.beginPath();
        ctx.moveTo(run[0].x, run[0].yu);
        for (const pt of run) ctx.lineTo(pt.x, pt.yu);
        for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(run[i].x, run[i].yl);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 1;
        run = [];
      };
      for (const point of upper) {
        const lowerValue = lowerByTime.get(point.time);
        const x = timeScale.timeToCoordinate(point.time);
        const yu = series.priceToCoordinate(point.value);
        const yl = lowerValue != null ? series.priceToCoordinate(lowerValue) : null;
        if (x == null || yu == null || yl == null) {
          flush();
          continue;
        }
        run.push({ x, yu, yl });
      }
      flush();
    });
  }
}

// Volume Profile (VPVR): bins the *visible* price range into VPVR_BIN_COUNT buckets by
// each bar's typical price, accumulates volume per bin, and renders horizontal bars
// right-aligned to the price pane's edge with the point-of-control bin highlighted.
class VpvrPrimitive {
  constructor() {
    this._bars = [];
    this._series = null;
    this._requestUpdate = null;
    this._paneViews = [new VpvrPaneView(this)];
  }
  setData(bars) {
    this._bars = bars;
    this._requestUpdate?.();
  }
  attached({ series, requestUpdate }) {
    this._series = series;
    this._requestUpdate = requestUpdate;
  }
  detached() {
    this._series = null;
  }
  updateAllViews() {}
  paneViews() {
    return this._paneViews;
  }
  // Computed lazily against whatever the price scale currently shows, so the bins
  // always reflect the live (possibly overlay-stretched) visible price range.
  compute() {
    const series = this._series;
    const bars = this._bars;
    if (!series || !bars.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    if (!(hi > lo)) return null;
    const binSize = (hi - lo) / VPVR_BIN_COUNT;
    const bins = Array.from({ length: VPVR_BIN_COUNT }, (_, i) => ({ lo: lo + i * binSize, hi: lo + (i + 1) * binSize, volume: 0 }));
    for (const b of bars) {
      const typical = (b.high + b.low + b.close) / 3;
      let idx = Math.floor((typical - lo) / binSize);
      if (idx < 0) idx = 0;
      if (idx >= VPVR_BIN_COUNT) idx = VPVR_BIN_COUNT - 1;
      bins[idx].volume += b.volume;
    }
    const maxBinVol = Math.max(...bins.map((b) => b.volume), 1);
    let pocIdx = 0;
    for (let i = 1; i < bins.length; i++) if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
    return { bins, maxBinVol, pocIdx };
  }
}

class VpvrPaneView {
  constructor(primitive) {
    this._primitive = primitive;
  }
  zOrder() {
    return "top";
  }
  renderer() {
    const p = this._primitive;
    const data = p.compute();
    return data ? new VpvrRenderer(data, p._series) : null;
  }
}

class VpvrRenderer {
  constructor(data, series) {
    this._data = data;
    this._series = series;
  }
  draw(target) {
    const { bins, maxBinVol, pocIdx } = this._data;
    const series = this._series;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const plotW = mediaSize.width;
      for (let i = 0; i < bins.length; i++) {
        const bin = bins[i];
        if (bin.volume <= 0) continue;
        const yTop = series.priceToCoordinate(bin.hi);
        const yBottom = series.priceToCoordinate(bin.lo);
        if (yTop == null || yBottom == null) continue;
        const w = (bin.volume / maxBinVol) * plotW * VPVR_MAX_WIDTH_FRAC;
        const isPoc = i === pocIdx;
        ctx.fillStyle = isPoc ? VPVR_POC_COLOR : VPVR_BIN_COLOR;
        ctx.globalAlpha = isPoc ? 0.4 : 0.15;
        ctx.fillRect(plotW - w, Math.min(yTop, yBottom), w, Math.max(Math.abs(yBottom - yTop), 1));
      }
      ctx.globalAlpha = 1;
    });
  }
}

// bars: [{ t: ISO string, open, high, low, close, volume }], oldest first
// series: the `series` object from GET /api/indicators (optional)
// active: array of indicator keys from indicatorConfig to draw (optional)
export default function Candlestick({ bars, height = 280, series = null, active = [], interval = "1d", isMobile = false }) {
  const hostRef = useRef(null); // element lightweight-charts renders into
  const outerRef = useRef(null); // outer wrapper, used for tooltip/header positioning
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const overlayLinesRef = useRef(new Map()); // indicator key -> ISeriesApi[]
  const bandFillRef = useRef(null); // BandFillPrimitive for the active `fill`-config overlay (BB), if any
  const oscSeriesRef = useRef(new Map()); // pane key -> { lines: ISeriesApi[], histogram: ISeriesApi|null, priceLines: IPriceLine[] }
  const avwapSeriesRef = useRef(null);
  const avwapMarkersRef = useRef(null);
  const vpvrPrimitiveRef = useRef(null);
  const resizeObserversRef = useRef(new Map()); // pane key -> ResizeObserver
  const suppressResizePersistRef = useRef(false);
  const avwapOnRef = useRef(false);
  const timeToIsoRef = useRef(new Map());
  const paneHeightsRef = useRef({});

  const [order, setOrder] = useState(() => sanitizeOrder(loadKey(K_PANE_ORDER, ALL_PANES)));
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [paneHeights, setPaneHeights] = useState(() => sanitizeHeights(loadKey(K_PANE_HEIGHTS, {})));
  const [hover, setHover] = useState(null); // { index, clientX, clientY }
  const [anchorT, setAnchorT] = useState(() => loadKey(K_AVWAP_ANCHOR, null)?.t ?? null);
  const [paneRects, setPaneRects] = useState({}); // paneKey -> { top, height } in px, relative to outerRef — drives header overlay position
  const [reorderPulseKey, setReorderPulseKey] = useState(null); // pane key showing the brief long-press-entry border flash
  const touchHoldClearRef = useRef(null); // timer id: delays clearing `hover` after touch release
  const longPressRef = useRef(null); // { timer, key, startY, startX, active }

  const avwapOn = active.includes("avwap");
  const vpvrOn = active.includes("vpvr");
  const activeCfgs = series ? INDICATORS.filter((c) => active.includes(c.key)) : [];
  const overlays = activeCfgs.filter((c) => c.pane === "price" && !c.type);
  const oscCfgByPane = new Map(activeCfgs.filter((c) => c.pane !== "price").map((c) => [c.pane, c]));
  const visiblePanes = order.filter((k) => k === "price" || oscCfgByPane.has(k));
  const visiblePanesKey = visiblePanes.join(",");
  const overlayKeys = overlays.map((c) => c.key).join(",");

  // lightweight-charts' `autoSize: true` fills whatever height the host div's own CSS
  // box resolves to — an empty div with no explicit height collapses to ~0, which
  // squashes every pane regardless of pane.setHeight() calls made after creation. The
  // host must be given the sum of all visible panes' heights explicitly.
  const totalHeight = visiblePanes.reduce((sum, key) => sum + (paneHeights[key] ?? (key === "price" ? height : PANE_HEIGHT)), 0);

  avwapOnRef.current = avwapOn;
  paneHeightsRef.current = paneHeights;

  // don't spam localStorage on every dragover tick — only once the drag settles
  useEffect(() => {
    if (dragKey) return;
    saveKey(K_PANE_ORDER, order);
  }, [order, dragKey]);

  // Anchored VWAP: default to the highest-volume bar in the window until the user clicks
  // one. If a previously-anchored timestamp has scrolled out of the current window (new
  // snapshot, symbol switch), fall back the same way rather than pinning to a stale index.
  const anchorIdx = useMemo(() => {
    if (!bars.length) return -1;
    const stored = anchorT ? bars.findIndex((b) => b.t === anchorT) : -1;
    if (stored !== -1) return stored;
    let best = 0;
    for (let i = 1; i < bars.length; i++) if (bars[i].volume > bars[best].volume) best = i;
    return best;
  }, [bars, anchorT]);

  const avwapValues = useMemo(() => {
    if (!avwapOn || anchorIdx < 0) return null;
    const out = new Array(bars.length).fill(null);
    let cumPV = 0;
    let cumVol = 0;
    for (let i = anchorIdx; i < bars.length; i++) {
      const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
      cumPV += typical * bars[i].volume;
      cumVol += bars[i].volume;
      out[i] = cumVol > 0 ? cumPV / cumVol : null;
    }
    return out;
  }, [avwapOn, bars, anchorIdx]);

  // Recomputes each visible pane's on-screen {top, height} (relative to outerRef) so the
  // HTML header overlay (drag handle + title) can be positioned right above it. Called
  // after any layout-affecting change; a rAF is used because pane DOM geometry settles
  // asynchronously after setHeight()/moveTo() calls.
  function syncPaneRects() {
    const chart = chartRef.current;
    const outer = outerRef.current;
    if (!chart || !outer) return;
    requestAnimationFrame(() => {
      if (!chartRef.current || !outerRef.current) return;
      const outerRect = outerRef.current.getBoundingClientRect();
      const next = {};
      chartRef.current.panes().forEach((pane, i) => {
        const key = visiblePanesRef.current[i];
        const el = pane.getHTMLElement();
        if (!key || !el) return;
        const r = el.getBoundingClientRect();
        next[key] = { top: r.top - outerRect.top, height: r.height };
      });
      setPaneRects(next);
    });
  }
  const visiblePanesRef = useRef(visiblePanes);
  visiblePanesRef.current = visiblePanes;

  // ---- chart creation (mount only) -----------------------------------------------
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const chart = createChart(hostRef.current, {
      autoSize: true,
      localization: { locale: "en-US" }, // pin explicitly — otherwise falls back to navigator.language
      layout: {
        background: { color: BG },
        textColor: AXIS,
        fontFamily: "ui-monospace, monospace",
        panes: { enableResize: true, separatorColor: "#1E2227", separatorHoverColor: "rgba(76,141,255,0.15)" },
        attributionLogo: false,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: "#22262B" },
      // maxBarSpacing caps how wide fitContent() can stretch each candle when there are
      // very few bars (e.g. the "1D"/"1W" date-range options) — without it, a handful of
      // bars filling the full chart width blows up the candle body to hundreds of px while
      // the wick stays pinned to ~1-2px (a fixed-width render, not scaled with barSpacing),
      // making the wick effectively invisible next to the oversized body.
      timeScale: { borderColor: "#22262B", timeVisible: true, secondsVisible: false, maxBarSpacing: 40 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(
      CandlestickSeries,
      { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceScaleId: "right" },
      0
    );
    candleSeriesRef.current = candleSeries;
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });

    const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, base: 0, lastValueVisible: false, priceLineVisible: false }, 0);
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeriesRef.current = volumeSeries;

    const vpvr = new VpvrPrimitive();
    candleSeries.attachPrimitive(vpvr);
    vpvrPrimitiveRef.current = vpvr;

    const bandFill = new BandFillPrimitive("#8A9099");
    candleSeries.attachPrimitive(bandFill);
    bandFillRef.current = bandFill;

    chart.subscribeClick((param) => {
      if (!avwapOnRef.current || !param.time) return;
      const t = timeToIsoRef.current.get(param.time);
      if (t) {
        setAnchorT(t);
        saveKey(K_AVWAP_ANCHOR, { t });
      }
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.logical == null) {
        setHover(null);
        return;
      }
      const idx = Math.max(0, Math.min(barsRef.current.length - 1, Math.round(param.logical)));
      const paneTop = paneRectsRef.current[visiblePanesRef.current[param.paneIndex ?? 0]]?.top ?? 0;
      setHover({ index: idx, clientX: param.point.x, clientY: paneTop + param.point.y });
    });

    const ro = new ResizeObserver(() => syncPaneRects());
    ro.observe(hostRef.current);
    resizeObserversRef.current.set("__host", ro);

    const resizeObservers = resizeObserversRef.current;
    const overlayLines = overlayLinesRef.current;
    const oscSeries = oscSeriesRef.current;
    return () => {
      resizeObservers.forEach((r) => r.disconnect());
      resizeObservers.clear();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlayLines.clear();
      oscSeries.clear();
      avwapSeriesRef.current = null;
      avwapMarkersRef.current = null;
      vpvrPrimitiveRef.current = null;
      bandFillRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const barsRef = useRef(bars);
  barsRef.current = bars;
  const paneRectsRef = useRef(paneRects);
  paneRectsRef.current = paneRects;

  // a stale hover index from a longer previous series (e.g. switching from a symbol
  // with 60 candles to one with 19) would otherwise index past the end of `bars`
  useEffect(() => {
    setHover(null);
  }, [bars]);

  // ---- candles + volume data -------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;
    const timeMap = new Map();
    const candleData = bars.map((b) => {
      const time = toTime(b.t);
      timeMap.set(time, b.t);
      return { time, open: b.open, high: b.high, low: b.low, close: b.close };
    });
    const volumeData = bars.map((b) => ({
      time: toTime(b.t),
      value: b.volume,
      color: b.close >= b.open ? "rgba(61,220,132,0.35)" : "rgba(255,92,92,0.35)",
    }));
    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);
    timeToIsoRef.current = timeMap;
    vpvrPrimitiveRef.current?.setData(vpvrOn ? bars : []);
    // new bar data (symbol switch, interval/range change) should reset the visible
    // window to fit it — without this the time scale keeps whatever range it had
    // before, which can leave most of a shorter/differently-ranged series off-screen.
    chart.timeScale().fitContent();
  }, [bars, vpvrOn]);

  // ---- price-pane line overlays (SMA/EMA/BB lines/VWAP) + BB band fill -------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = overlayLinesRef.current;
    const wantedKeys = new Set(overlays.map((c) => c.key));

    for (const [key, handles] of map) {
      if (!wantedKeys.has(key)) {
        for (const s of handles) chart.removeSeries(s);
        map.delete(key);
      }
    }

    for (const cfg of overlays) {
      let handles = map.get(cfg.key);
      if (!handles) {
        handles = cfg.series.map((k) =>
          chart.addSeries(
            LineSeries,
            {
              color: cfg.color,
              lineWidth: 1.5,
              priceScaleId: "right",
              lineStyle: cfg.dashed?.includes(k) ? LineStyle.Dashed : LineStyle.Solid,
              lastValueVisible: false,
              priceLineVisible: false,
              crosshairMarkerVisible: false,
            },
            0
          )
        );
        map.set(cfg.key, handles);
      }
      cfg.series.forEach((k, i) => handles[i]?.setData(toLineData(series?.[k], bars)));
    }

    const bbCfg = overlays.find((c) => c.fill);
    if (bbCfg) {
      bandFillRef.current?.setData(toLineData(series?.[bbCfg.fill[0]], bars), toLineData(series?.[bbCfg.fill[1]], bars));
    } else {
      bandFillRef.current?.setData([], []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, series, overlayKeys]);

  // ---- AVWAP overlay (dashed orange line + triangular anchor marker) --------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!avwapValues) {
      if (avwapSeriesRef.current) {
        avwapMarkersRef.current?.setMarkers([]);
        chart.removeSeries(avwapSeriesRef.current);
        avwapSeriesRef.current = null;
        avwapMarkersRef.current = null;
      }
      return;
    }
    if (!avwapSeriesRef.current) {
      const s = chart.addSeries(
        LineSeries,
        {
          color: AVWAP_COLOR,
          lineWidth: 1.5,
          lineStyle: LineStyle.Dashed,
          priceScaleId: "right",
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        },
        0
      );
      avwapSeriesRef.current = s;
      avwapMarkersRef.current = createSeriesMarkers(s, []);
    }
    avwapSeriesRef.current.setData(toLineData(avwapValues, bars));
    if (anchorIdx >= 0 && bars[anchorIdx]) {
      avwapMarkersRef.current.setMarkers([
        { time: toTime(bars[anchorIdx].t), position: "belowBar", shape: "arrowUp", color: AVWAP_COLOR, size: 1 },
      ]);
    } else {
      avwapMarkersRef.current.setMarkers([]);
    }
  }, [avwapValues, bars, anchorIdx]);

  // ---- oscillator sub-panes: create/destroy series on membership change, always
  // refresh data + fixed-domain scale + guide lines -----------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = oscSeriesRef.current;

    for (const [paneKey, handles] of map) {
      if (!oscCfgByPane.has(paneKey)) {
        for (const s of handles.lines) chart.removeSeries(s);
        if (handles.histogram) chart.removeSeries(handles.histogram);
        map.delete(paneKey);
      }
    }

    const paneIndexOf = new Map(visiblePanes.map((k, i) => [k, i]));

    for (const paneKey of visiblePanes) {
      if (paneKey === "price") continue;
      const cfg = oscCfgByPane.get(paneKey);
      const paneIndex = paneIndexOf.get(paneKey);
      let handles = map.get(paneKey);
      if (!handles) {
        handles = { lines: [], histogram: null, priceLines: [] };
        if (cfg.histogram) {
          handles.histogram = chart.addSeries(
            HistogramSeries,
            { priceScaleId: paneKey, base: 0, lastValueVisible: false, priceLineVisible: false },
            paneIndex
          );
        }
        cfg.series.forEach((k, i) => {
          const color = cfg.seriesColors?.[k] ?? (i === 0 ? cfg.color : cfg.signalColor || cfg.color);
          handles.lines.push(
            chart.addSeries(
              LineSeries,
              { color, lineWidth: 1.3, priceScaleId: paneKey, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false },
              paneIndex
            )
          );
        });
        map.set(paneKey, handles);
      }

      const [d0, d1] = paneDomain(cfg, series, bars.length);
      const anchorSeries = handles.lines[0] ?? handles.histogram;
      const priceScale = anchorSeries?.priceScale();
      priceScale?.applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
      // fixed (non-auto-scaling) domain — oscillator panes with a known range (RSI 0-100
      // etc.) must show that fixed range rather than autoscale to whatever's visible
      priceScale?.setVisibleRange({ from: d0, to: d1 });

      if (handles.histogram) {
        handles.histogram.setData(
          bars
            .map((b, i) => {
              const v = series?.[cfg.histogram]?.[i];
              return isNum(v) ? { time: toTime(b.t), value: v, color: v >= 0 ? UP : DOWN } : null;
            })
            .filter(Boolean)
        );
      }
      cfg.series.forEach((k, i) => handles.lines[i]?.setData(toLineData(series?.[k], bars)));

      // guide lines (30/70, 20/80, 25, zero-line) via createPriceLine
      for (const pl of handles.priceLines) anchorSeries?.removePriceLine?.(pl);
      handles.priceLines = [];
      const guideValues = [...(cfg.guides ?? []), ...(cfg.zeroLine ? [0] : [])];
      for (const g of guideValues) {
        const pl = anchorSeries?.createPriceLine({
          price: g,
          color: GRID,
          lineWidth: 1,
          lineStyle: cfg.zeroLine && g === 0 ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: "",
        });
        if (pl) handles.priceLines.push(pl);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, series, visiblePanesKey]);

  // maps a PaneApi to its logical key by matching series identity — panes carry no
  // custom id, so "price" is identified by owning the candle series and every
  // oscillator pane by owning one of its configured line/histogram series.
  function keyForPane(pane) {
    if (!pane) return null;
    const paneSeries = pane.getSeries();
    if (paneSeries.includes(candleSeriesRef.current)) return "price";
    for (const [key, handles] of oscSeriesRef.current) {
      if (handles.lines.some((s) => paneSeries.includes(s)) || (handles.histogram && paneSeries.includes(handles.histogram))) return key;
    }
    return null;
  }

  // ---- reconcile chart pane order + restore persisted heights ---------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (let target = 0; target < visiblePanes.length; target++) {
      const panes = chart.panes();
      if (keyForPane(panes[target]) === visiblePanes[target]) continue;
      const fromIdx = panes.findIndex((p) => keyForPane(p) === visiblePanes[target]);
      if (fromIdx !== -1 && fromIdx !== target) panes[fromIdx].moveTo(target);
    }

    // pane.setHeight() computes a stretch factor from a live snapshot of every pane's
    // CURRENT height at the moment it's called — so calling it in a loop across panes
    // is order-dependent and never converges to the requested pixel values (a known
    // lightweight-charts limitation, see tradingview/lightweight-charts#1847).
    // setStretchFactor() has no such dependency: passing the desired pixel heights
    // directly as stretch-factor ratios is deterministic and order-independent.
    suppressResizePersistRef.current = true;
    chart.panes().forEach((pane, i) => {
      const key = visiblePanes[i];
      if (!key) return;
      const fallback = key === "price" ? height : PANE_HEIGHT;
      pane.setStretchFactor(paneHeightsRef.current[key] ?? fallback);
    });
    // ResizeObserver callbacks fire after layout, on a later animation frame — a
    // microtask clears the suppress flag too early and lets the observer see this
    // programmatic setStretchFactor() as a "drag", persist its (slightly different)
    // measured height, which changes paneHeights state, which changes totalHeight,
    // which resizes the host div, re-triggering the observer — a feedback loop that
    // walks the price pane down to PRICE_HEIGHT_RANGE's floor a few px at a time.
    // Wait two rAFs (past the layout + observer's own callback frame) before re-arming.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressResizePersistRef.current = false;
      });
    });

    // (re)watch each visible pane's HTML element for native drag-resize changes
    const observers = resizeObserversRef.current;
    for (const [key, ro] of observers) {
      if (key !== "__host" && !visiblePanes.includes(key)) {
        ro.disconnect();
        observers.delete(key);
      }
    }
    chart.panes().forEach((pane, i) => {
      const key = visiblePanes[i];
      if (!key || observers.has(key)) return;
      const el = pane.getHTMLElement();
      if (!el) return;
      const ro = new ResizeObserver(() => {
        syncPaneRects();
        if (suppressResizePersistRef.current) return;
        const [min, max] = key === "price" ? PRICE_HEIGHT_RANGE : OSC_HEIGHT_RANGE;
        const h = Math.min(max, Math.max(min, Math.round(pane.getHeight())));
        setPaneHeights((prev) => {
          if (prev[key] === h) return prev;
          const next = { ...prev, [key]: h };
          saveKey(K_PANE_HEIGHTS, next);
          return next;
        });
      });
      ro.observe(el);
      observers.set(key, ro);
    });

    syncPaneRects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePanesKey, order]);

  // keep header overlay positions in sync with anything that can move panes around
  // (new bars/series changing pane count indirectly via visiblePanesKey is covered above;
  // this also covers plain window resizes since ResizeObserver on the host handles that)
  useLayoutEffect(() => {
    syncPaneRects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePanesKey, paneHeights]);

  // ---- drag-and-drop pane reordering (HTML5 DnD on each pane's header) ------------
  function handleDragStart(e, key) {
    setDragKey(key);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key); // required by Firefox to start a drag
  }
  function handleDragOver(e, overKey) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(overKey);
    if (dragKey && dragKey !== overKey) {
      setOrder((o) => moveItem(o, dragKey, overKey));
    }
  }
  function handleDrop(e) {
    e.preventDefault();
    setDragKey(null);
    setDragOverKey(null);
  }
  function handleDragEnd() {
    setDragKey(null);
    setDragOverKey(null);
  }

  // ---- touch: tap-and-hold crosshair (replaces mouse hover on touch devices) -------
  // Only handles single-finger touches — two-finger pinch/pan is left alone so
  // lightweight-charts' own native touch handling (pinch-zoom, two-finger pan) still
  // reaches the chart untouched.
  function pointFromTouch(e) {
    const outer = outerRef.current;
    if (!outer) return null;
    const rect = outer.getBoundingClientRect();
    const touch = e.touches[0] ?? e.changedTouches[0];
    if (!touch) return null;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }
  function indexFromX(x) {
    const chart = chartRef.current;
    if (!chart || !barsRef.current.length) return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    if (logical == null) return null;
    return Math.max(0, Math.min(barsRef.current.length - 1, Math.round(logical)));
  }
  function handleChartTouchStart(e) {
    if (e.touches.length !== 1) return;
    if (touchHoldClearRef.current) {
      clearTimeout(touchHoldClearRef.current);
      touchHoldClearRef.current = null;
    }
    const p = pointFromTouch(e);
    if (!p) return;
    const idx = indexFromX(p.x);
    if (idx == null) return;
    setHover({ index: idx, clientX: p.x, clientY: p.y });
  }
  function handleChartTouchMove(e) {
    if (e.touches.length !== 1) return;
    const p = pointFromTouch(e);
    if (!p) return;
    const idx = indexFromX(p.x);
    if (idx == null) return;
    setHover({ index: idx, clientX: p.x, clientY: p.y });
  }
  function handleChartTouchEnd() {
    // linger briefly after release so a quick tap-to-check-a-bar doesn't feel like it
    // vanished before it was read
    if (touchHoldClearRef.current) clearTimeout(touchHoldClearRef.current);
    touchHoldClearRef.current = setTimeout(() => setHover(null), TOUCH_HOLD_CLEAR_DELAY_MS);
  }

  // ---- touch: long-press-to-reorder (replaces HTML5 drag-and-drop on touch) --------
  function handleHandleTouchStart(e, key) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const lp = { startX: touch.clientX, startY: touch.clientY, key, active: false };
    longPressRef.current = lp;
    lp.timer = setTimeout(() => {
      lp.active = true;
      setDragKey(key);
      setReorderPulseKey(key);
      setTimeout(() => setReorderPulseKey((k) => (k === key ? null : k)), 150);
    }, LONG_PRESS_MS);
  }
  function handleHandleTouchMove(e) {
    const lp = longPressRef.current;
    if (!lp || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - lp.startX;
    const dy = touch.clientY - lp.startY;
    if (!lp.active) {
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
        clearTimeout(lp.timer);
        longPressRef.current = null;
      }
      return;
    }
    // in reorder mode: find which visible pane header the finger is currently over
    // by Y position and swap it into place, mirroring the mouse dragover swap logic
    e.preventDefault();
    const outer = outerRef.current;
    if (!outer) return;
    const outerRect = outer.getBoundingClientRect();
    const y = touch.clientY - outerRect.top;
    let overKey = null;
    for (const k of visiblePanesRef.current) {
      const rect = paneRectsRef.current[k];
      if (!rect) continue;
      if (y >= rect.top && y <= rect.top + rect.height) {
        overKey = k;
        break;
      }
    }
    if (overKey && overKey !== lp.key) {
      setDragOverKey(overKey);
      setOrder((o) => moveItem(o, lp.key, overKey));
      lp.key = overKey; // track the pane's new position so subsequent swaps compare correctly
    }
  }
  function handleHandleTouchEnd() {
    const lp = longPressRef.current;
    if (lp?.timer) clearTimeout(lp.timer);
    longPressRef.current = null;
    setDragKey(null);
    setDragOverKey(null);
  }

  if (!bars.length) {
    return <div className="muted" style={{ padding: "20px 0" }}>No candle data yet.</div>;
  }

  const n = bars.length;
  const readIdx = hover && hover.index < n ? hover.index : n - 1;
  const h = bars[readIdx];
  const hUp = h.close >= h.open;

  const legend = activeCfgs.map((cfg) => {
    const dec = cfg.domain ? 1 : 2;
    let text;
    if (cfg.type === "avwap") {
      const v = avwapValues?.[readIdx];
      text = isNum(v) ? v.toFixed(2) : "—";
    } else if (cfg.type === "profile") {
      const vpvr = vpvrPrimitiveRef.current?.compute();
      const poc = vpvr?.bins[vpvr.pocIdx];
      text = poc ? ((poc.lo + poc.hi) / 2).toFixed(2) + " POC" : "—";
    } else {
      text = cfg.series
        .map((k) => {
          const v = series?.[k]?.[readIdx];
          return isNum(v) ? v.toFixed(dec) : "—";
        })
        .join(" / ");
    }
    return { key: cfg.key, label: cfg.label, color: cfg.color, text };
  });

  const paneTitle = (paneKey) => (paneKey === "price" ? "Chart" : oscCfgByPane.get(paneKey)?.paneLabel || oscCfgByPane.get(paneKey)?.label || paneKey);
  const paneColor = (paneKey) => (paneKey === "price" ? undefined : oscCfgByPane.get(paneKey)?.color);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {isMobile ? (
        <>
          <div className="mono muted" style={{ marginBottom: 4, fontSize: 12 }}>
            {interval === "1d"
              ? new Date(h.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              : new Date(h.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </div>
          <div className="muted mono" style={{ marginBottom: 4, fontSize: 12 }}>
            vol {h.volume.toLocaleString()}
          </div>
          <div className="mono" style={{ marginBottom: 4, fontSize: 12 }}>
            O <span className={hUp ? "green" : "red"}>{h.open.toFixed(2)}</span>{"  "}
            H <span className={hUp ? "green" : "red"}>{h.high.toFixed(2)}</span>{"  "}
            L <span className={hUp ? "green" : "red"}>{h.low.toFixed(2)}</span>{"  "}
            C <span className={hUp ? "green" : "red"}>{h.close.toFixed(2)}</span>
          </div>

          {legend.length > 0 && (
            <div className="mono" style={{ marginBottom: 8, fontSize: 11 }}>
              {legend.map((l) => (
                <div key={l.key} style={{ display: "block", color: l.color }}>
                  {l.label} <span style={{ opacity: 0.85 }}>{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
            <span className="mono">
              O <span className={hUp ? "green" : "red"}>{h.open.toFixed(2)}</span>{"  "}
              H <span className={hUp ? "green" : "red"}>{h.high.toFixed(2)}</span>{"  "}
              L <span className={hUp ? "green" : "red"}>{h.low.toFixed(2)}</span>{"  "}
              C <span className={hUp ? "green" : "red"}>{h.close.toFixed(2)}</span>
            </span>
            <span className="muted mono">
              {interval === "1d"
                ? new Date(h.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                : new Date(h.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {" "}&middot; vol {h.volume.toLocaleString()}
            </span>
          </div>

          {legend.length > 0 && (
            <div className="row mono" style={{ flexWrap: "wrap", gap: 10, marginBottom: 8, fontSize: 11 }}>
              {legend.map((l) => (
                <span key={l.key} style={{ color: l.color }}>
                  {l.label} <span style={{ opacity: 0.85 }}>{l.text}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div ref={outerRef} className="pane-card" style={{ position: "relative", width: "100%", padding: 0, overflow: "visible" }}>
        <div
          ref={hostRef}
          style={{ width: "100%", height: totalHeight }}
          onTouchStart={handleChartTouchStart}
          onTouchMove={handleChartTouchMove}
          onTouchEnd={handleChartTouchEnd}
        />

        {visiblePanes.map((paneKey) => {
          const rect = paneRects[paneKey];
          if (!rect) return null;
          const dragging = dragKey === paneKey;
          const isOver = dragOverKey === paneKey && dragKey && dragKey !== paneKey;
          const pulsing = reorderPulseKey === paneKey;
          return (
            <div
              key={paneKey}
              className={`pane-card-header ${dragging ? "dragging" : ""} ${isOver ? "drag-over" : ""} ${pulsing ? "reorder-pulse" : ""}`}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: rect.top,
                height: HEADER_H,
                background: "linear-gradient(180deg, rgba(16,19,22,0.92), rgba(16,19,22,0))",
                pointerEvents: "none",
                zIndex: 3,
              }}
              onDragOver={(e) => handleDragOver(e, paneKey)}
              onDrop={handleDrop}
            >
              <div style={{ pointerEvents: "auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px" }}>
                <DragHandle
                  onDragStart={(e) => handleDragStart(e, paneKey)}
                  onDragEnd={handleDragEnd}
                  onTouchStart={(e) => handleHandleTouchStart(e, paneKey)}
                  onTouchMove={handleHandleTouchMove}
                  onTouchEnd={handleHandleTouchEnd}
                  pulse={pulsing}
                />
                <span className="pane-card-title" style={{ color: paneColor(paneKey) }}>{paneTitle(paneKey)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {hover && (
        <ChartTooltip
          bar={bars[readIdx]}
          interval={interval}
          legend={legend}
          x={hover.clientX}
          y={hover.clientY}
          containerW={outerRef.current?.clientWidth ?? 600}
          containerH={outerRef.current?.clientHeight ?? 600}
        />
      )}
    </div>
  );
}
