import { useState, useMemo, useRef, useEffect } from "react";
import { INDICATORS, PANE_HEIGHT } from "./indicatorConfig.js";
import { loadKey, saveKey } from "./storage.js";

const UP = "#3DDC84";
const DOWN = "#FF5C5C";
const AXIS = "#8A9099";
const GRID = "#1A1D21";

const K_PANE_ORDER = "qqq-sim-pane-order";
const K_PANE_HEIGHTS = "qqq-sim-pane-heights";

// clamp range for drag-to-resize, per pane type
const PRICE_HEIGHT_RANGE = [160, 900];
const OSC_HEIGHT_RANGE = [50, 400];

// left/right must match across every pane's svg so bars line up vertically
const PAD_X = { left: 56, right: 8 };
const PRICE_PAD = { ...PAD_X, top: 10, bottom: 20 };
const OSC_PAD = { ...PAD_X, top: 10, bottom: 10 };

// "price" (the candle/volume chart) plus one entry per oscillator sub-pane
const OSC_PANES = [...new Set(INDICATORS.filter((c) => c.pane !== "price").map((c) => c.pane))];
const ALL_PANES = ["price", ...OSC_PANES];

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

const isNum = (v) => v != null && Number.isFinite(v);

// Indicator series are null-padded at the head (SMA 50 has 49 leading nulls) and
// may be shorter than `bars` if the two endpoints briefly disagree, so the pen
// lifts on every gap rather than drawing a line down to zero.
function buildPath(values, n, xFn, yFn) {
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = values?.[i];
    if (!isNum(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${xFn(i).toFixed(1)},${yFn(v).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

// Closed polygon between two series — one subpath per contiguous run.
function buildBandPath(upper, lower, n, xFn, yFn) {
  let d = "";
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      d += "M" + run.map((i) => `${xFn(i).toFixed(1)},${yFn(upper[i]).toFixed(1)}`).join("L");
      d += "L" + run.slice().reverse().map((i) => `${xFn(i).toFixed(1)},${yFn(lower[i]).toFixed(1)}`).join("L");
      d += "Z ";
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (isNum(upper?.[i]) && isNum(lower?.[i])) run.push(i);
    else flush();
  }
  flush();
  return d.trim();
}

function DragHandle({ onDragStart, onDragEnd }) {
  return (
    <span className="drag-handle" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} title="Drag to reorder">
      ⠿
    </span>
  );
}

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

// bars: [{ t: ISO string, open, high, low, close, volume }], oldest first
// series: the `series` object from GET /api/indicators (optional)
// active: array of indicator keys from indicatorConfig to draw (optional)
export default function Candlestick({ bars, height = 280, series = null, active = [] }) {
  const outerRef = useRef(null);
  const [hover, setHover] = useState(null); // { index, x }
  const [width, setWidth] = useState(600);
  const [order, setOrder] = useState(() => sanitizeOrder(loadKey(K_PANE_ORDER, ALL_PANES)));
  const [dragKey, setDragKey] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [paneHeights, setPaneHeights] = useState(() => sanitizeHeights(loadKey(K_PANE_HEIGHTS, {})));
  // guards against a leaked mousemove/mouseup pair if a previous drag's mouseup
  // never fires (mouse released outside the window, tab-switch mid-drag, etc.) —
  // without this a stale listener keeps resizing its old pane on every future
  // mouse move, and can even stack with a later legitimate drag
  const activeResizeRef = useRef(null);

  // don't spam localStorage on every dragover tick — only once the drag settles
  useEffect(() => {
    if (dragKey) return;
    saveKey(K_PANE_ORDER, order);
  }, [order, dragKey]);

  // unmount safety net: cancel any drag still in flight
  useEffect(() => () => activeResizeRef.current?.(), []);

  // resync chart width on window resize — the render-time check below only fires
  // when something else causes a re-render, so a resize with no other state change
  // would otherwise leave the SVG at its stale width
  useEffect(() => {
    function onResize() {
      if (outerRef.current) setWidth(outerRef.current.clientWidth || width);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  // Drag vertically anywhere inside a pane to grow/shrink it — the plotted
  // content stretches to fill the new height, so e.g. the RSI wave reads more
  // dramatically the taller you make its pane.
  function beginResize(e, paneKey, startHeight, [min, max]) {
    e.preventDefault();
    activeResizeRef.current?.(); // force-clean any dangling previous drag first
    const startY = e.clientY;
    function onMove(ev) {
      const next = Math.min(max, Math.max(min, Math.round(startHeight + (ev.clientY - startY))));
      setPaneHeights((h) => (h[paneKey] === next ? h : { ...h, [paneKey]: next }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      activeResizeRef.current = null;
      setPaneHeights((h) => {
        saveKey(K_PANE_HEIGHTS, h);
        return h;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    activeResizeRef.current = onUp;
  }

  if (outerRef.current && outerRef.current.clientWidth !== width) {
    // sync on render without an extra effect/layout pass
    queueMicrotask(() => setWidth(outerRef.current?.clientWidth || width));
  }

  const plotW = Math.max(width - PAD_X.left - PAD_X.right, 0);

  const activeCfgs = series ? INDICATORS.filter((c) => active.includes(c.key)) : [];
  const overlays = activeCfgs.filter((c) => c.pane === "price");
  const oscCfgByPane = new Map(activeCfgs.filter((c) => c.pane !== "price").map((c) => [c.pane, c]));

  const overlayKeys = overlays.map((c) => c.key).join(",");
  const { min, max, candleW, gap } = useMemo(() => {
    if (!bars.length) return { min: 0, max: 1, candleW: 4, gap: 2 };
    let lo = Math.min(...bars.map((b) => b.low));
    let hi = Math.max(...bars.map((b) => b.high));
    // fold in the enabled price-scale overlays, or Bollinger bands clip
    for (const cfg of overlays) {
      for (const k of cfg.series) {
        const arr = series?.[k];
        if (!arr) continue;
        for (let i = 0; i < bars.length; i++) {
          const v = arr[i];
          if (!isNum(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    const pad = (hi - lo) * 0.06 || 1;
    const slot = plotW / bars.length;
    return {
      min: lo - pad,
      max: hi + pad,
      candleW: Math.max(Math.min(slot * 0.6, 14), 2),
      gap: slot,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, plotW, series, overlayKeys]);

  const maxVol = useMemo(() => Math.max(...bars.map((b) => b.volume), 1), [bars]);

  // volume strip stays a fixed-height footer; growing the pane extends the
  // candle area above it, which is what actually makes the chart "longer"
  const priceHeight = paneHeights.price ?? height;
  const volH = 44;
  const priceH = priceHeight - volH - PRICE_PAD.top - PRICE_PAD.bottom;
  const yPrice = (p) => PRICE_PAD.top + priceH - ((p - min) / (max - min || 1)) * priceH;
  const yVol = (v) => PRICE_PAD.top + priceH + volH - (v / maxVol) * (volH - 4);
  const xCenter = (i) => PAD_X.left + gap * i + gap / 2;

  function handleMove(e) {
    if (!outerRef.current) return;
    const rect = outerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - PAD_X.left;
    const idx = Math.max(0, Math.min(bars.length - 1, Math.round((x - gap / 2) / gap)));
    setHover({ index: idx, x: xCenter(idx) });
  }

  function handleDragStart(e, key) {
    setDragKey(key);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key); // required by Firefox to start a drag
    const card = e.currentTarget.closest(".pane-card");
    if (card) e.dataTransfer.setDragImage(card, 20, 20);
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

  if (!bars.length) {
    return <div className="muted" style={{ padding: "20px 0" }}>No candle data yet.</div>;
  }

  const n = bars.length;
  const readIdx = hover ? hover.index : n - 1;
  const h = bars[readIdx];
  const hUp = h.close >= h.open;

  // y-axis ticks (5 evenly spaced price levels)
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);

  const legend = activeCfgs.map((cfg) => {
    const dec = cfg.domain ? 1 : 2;
    const text = cfg.series
      .map((k) => {
        const v = series?.[k]?.[readIdx];
        return isNum(v) ? v.toFixed(dec) : "—";
      })
      .join(" / ");
    return { key: cfg.key, label: cfg.label, color: cfg.color, text };
  });

  const visiblePanes = order.filter((k) => k === "price" || oscCfgByPane.has(k));

  return (
    <div ref={outerRef} style={{ position: "relative", width: "100%" }} onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
        <span className="mono">
          O <span className={hUp ? "green" : "red"}>{h.open.toFixed(2)}</span>{"  "}
          H <span className={hUp ? "green" : "red"}>{h.high.toFixed(2)}</span>{"  "}
          L <span className={hUp ? "green" : "red"}>{h.low.toFixed(2)}</span>{"  "}
          C <span className={hUp ? "green" : "red"}>{h.close.toFixed(2)}</span>
        </span>
        <span className="muted mono">{new Date(h.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })} &middot; vol {h.volume.toLocaleString()}</span>
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

      <div className="pane-stack">
        {visiblePanes.map((paneKey) => {
          const dragging = dragKey === paneKey;
          const isOver = dragOverKey === paneKey && dragKey && dragKey !== paneKey;
          const cardClass = `pane-card ${dragging ? "dragging" : ""} ${isOver ? "drag-over" : ""}`;

          if (paneKey === "price") {
            return (
              <div key="price" className={cardClass} onDragOver={(e) => handleDragOver(e, "price")} onDrop={handleDrop}>
                <div className="pane-card-header">
                  <DragHandle onDragStart={(e) => handleDragStart(e, "price")} onDragEnd={handleDragEnd} />
                  <span className="pane-card-title">Chart</span>
                </div>
                <svg
                  width={width}
                  height={priceHeight}
                  style={{ display: "block", cursor: "ns-resize" }}
                  onMouseDown={(e) => beginResize(e, "price", priceHeight, PRICE_HEIGHT_RANGE)}
                >
                  <title>Drag vertically to resize</title>
                  {ticks.map((t, i) => (
                    <g key={i}>
                      <line x1={PAD_X.left} x2={width - PAD_X.right} y1={yPrice(t)} y2={yPrice(t)} stroke={GRID} strokeWidth={1} />
                      <text x={PAD_X.left - 8} y={yPrice(t)} fill={AXIS} fontSize={10} textAnchor="end" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
                        {t.toFixed(0)}
                      </text>
                    </g>
                  ))}

                  {overlays.map((cfg) => (
                    <g key={cfg.key}>
                      {cfg.fill && (
                        <path d={buildBandPath(series[cfg.fill[0]], series[cfg.fill[1]], n, xCenter, yPrice)} fill={cfg.color} opacity={0.08} stroke="none" />
                      )}
                      {cfg.series.map((k) => (
                        <path
                          key={k}
                          d={buildPath(series[k], n, xCenter, yPrice)}
                          fill="none"
                          stroke={cfg.color}
                          strokeWidth={1.5}
                          strokeLinejoin="round"
                          strokeDasharray={cfg.dashed?.includes(k) ? "4,3" : undefined}
                          opacity={cfg.fill ? 0.85 : 1}
                        />
                      ))}
                    </g>
                  ))}

                  {bars.map((b, i) => {
                    const up = b.close >= b.open;
                    const color = up ? UP : DOWN;
                    const cx = xCenter(i);
                    const bodyTop = yPrice(Math.max(b.open, b.close));
                    const bodyBottom = yPrice(Math.min(b.open, b.close));
                    const bodyH = Math.max(bodyBottom - bodyTop, 1);
                    return (
                      <g key={b.t}>
                        <line x1={cx} x2={cx} y1={yPrice(b.high)} y2={yPrice(b.low)} stroke={color} strokeWidth={1} />
                        <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} rx={1} />
                        <rect x={cx - candleW / 2} y={yVol(b.volume)} width={candleW} height={PRICE_PAD.top + priceH + volH - yVol(b.volume)} fill={color} opacity={0.35} />
                      </g>
                    );
                  })}

                  {hover && <line x1={hover.x} x2={hover.x} y1={0} y2={priceHeight} stroke={AXIS} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />}
                </svg>
              </div>
            );
          }

          const cfg = oscCfgByPane.get(paneKey);
          const paneHeight = paneHeights[paneKey] ?? PANE_HEIGHT;
          const [d0, d1] = paneDomain(cfg, series, n);
          const plotTop = OSC_PAD.top;
          const plotH = paneHeight - OSC_PAD.top - OSC_PAD.bottom;
          const y = (v) => plotTop + plotH - ((v - d0) / (d1 - d0 || 1)) * plotH;
          const edgeLabels = cfg.guides ?? [d1, d0];

          return (
            <div key={paneKey} className={cardClass} onDragOver={(e) => handleDragOver(e, paneKey)} onDrop={handleDrop}>
              <div className="pane-card-header">
                <DragHandle onDragStart={(e) => handleDragStart(e, paneKey)} onDragEnd={handleDragEnd} />
                <span className="pane-card-title" style={{ color: cfg.color }}>{cfg.paneLabel || cfg.label}</span>
              </div>
              <svg
                width={width}
                height={paneHeight}
                style={{ display: "block", cursor: "ns-resize" }}
                onMouseDown={(e) => beginResize(e, paneKey, paneHeight, OSC_HEIGHT_RANGE)}
              >
                <title>Drag vertically to resize</title>
                {edgeLabels.map((g, i) => (
                  <text key={`l${i}`} x={PAD_X.left - 8} y={y(g)} fill={AXIS} fontSize={9} textAnchor="end" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
                    {Math.abs(g) >= 100 || Number.isInteger(g) ? g.toFixed(0) : g.toFixed(2)}
                  </text>
                ))}
                {cfg.guides?.map((g) => (
                  <line key={`g${g}`} x1={PAD_X.left} x2={width - PAD_X.right} y1={y(g)} y2={y(g)} stroke={GRID} strokeWidth={1} strokeDasharray="3,3" />
                ))}
                {cfg.zeroLine && <line x1={PAD_X.left} x2={width - PAD_X.right} y1={y(0)} y2={y(0)} stroke={GRID} strokeWidth={1} />}

                {cfg.histogram &&
                  bars.map((b, i) => {
                    const v = series[cfg.histogram]?.[i];
                    if (!isNum(v)) return null;
                    const yv = y(v);
                    const y0 = y(0);
                    return (
                      <rect
                        key={b.t}
                        x={xCenter(i) - candleW / 2}
                        y={Math.min(yv, y0)}
                        width={candleW}
                        height={Math.max(Math.abs(yv - y0), 1)}
                        fill={v >= 0 ? UP : DOWN}
                        opacity={0.6}
                      />
                    );
                  })}

                {cfg.series.map((k, i) => (
                  <path
                    key={k}
                    d={buildPath(series[k], n, xCenter, y)}
                    fill="none"
                    stroke={i === 0 ? cfg.color : cfg.signalColor || cfg.color}
                    strokeWidth={1.3}
                    strokeLinejoin="round"
                  />
                ))}

                {hover && <line x1={hover.x} x2={hover.x} y1={0} y2={paneHeight} stroke={AXIS} strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />}
              </svg>
            </div>
          );
        })}
      </div>
    </div>
  );
}
