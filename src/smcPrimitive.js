// Smart Money Concepts overlay, drawn as a lightweight-charts v5 series primitive —
// the library has no native box/label/segment types, so order blocks, fair value gaps,
// structure breaks and equal-level tags are all canvas-rendered here. Same three-class
// shape (primitive / pane view / renderer) as BandFillPrimitive and VpvrPrimitive in
// Candlestick.jsx.
//
// Data comes from GET /api/indicators -> smc, whose anchors are ISO timestamps rather
// than bar indices, so it survives the client's date-range trimming of the candles.

const BULL = "#3DDC84";
const BEAR = "#FF5C5C";
const DEMAND = "#4C8DFF";
const SUPPLY = "#FF5C5C";
const FVG_COLOR = "#E8A33D";
const EQUAL_COLOR = "#B57BFF";
const SWING_LABEL = "#8A9099";

const ZONE_FILL_ALPHA = 0.13;
const ZONE_BORDER_ALPHA = 0.4;
const FVG_FILL_ALPHA = 0.1;
const INTERNAL_ALPHA = 0.45; // minor-structure events are dimmed so the swing ones read first
const MAX_SWING_LABELS = 6; // only the most recent weak/strong tags, or the pane turns to soup

const font = (size) => `${size}px ui-monospace, monospace`;

// Unix seconds, matching Candlestick.jsx's own `toTime` — the value the chart keys on.
const toTime = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function withAlpha(ctx, alpha, draw) {
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  draw();
  ctx.globalAlpha = prev;
}

// Resolves an anchor timestamp to an x coordinate. Anchors are computed over the FULL
// interval history while the chart may show only a trailing slice of it, so a timestamp
// off the left edge clamps to 0 and one past the right edge to the plot width instead of
// dropping the whole shape (timeToCoordinate returns null for times absent from the data).
function makeXAt(times, timeScale, width) {
  return (iso) => {
    if (!times.length) return null;
    const t = toTime(iso);
    if (t <= times[0]) return 0;
    if (t >= times[times.length - 1]) return width;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return timeScale.timeToCoordinate(times[lo]);
  };
}

class SmcRenderer {
  constructor(primitive, layer) {
    this._p = primitive;
    this._layer = layer;
  }

  draw(target) {
    const p = this._p;
    const smc = p._smc;
    const series = p._series;
    const timeScale = p._chart?.timeScale();
    if (!smc || !series || !timeScale) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const xAt = makeXAt(p._times, timeScale, mediaSize.width);
      const y = (price) => series.priceToCoordinate(price);
      if (this._layer === "bottom") {
        this._drawZones(ctx, mediaSize, xAt, y);
      } else {
        this._drawStructure(ctx, xAt, y);
        this._drawEqualLevels(ctx, xAt, y);
        this._drawSwingTags(ctx, xAt, y);
      }
    });
  }

  // Order blocks and fair value gaps: rectangles anchored at the originating candle and
  // extended to the right edge, since an unmitigated zone stays live until price reaches it.
  _drawZones(ctx, mediaSize, xAt, y) {
    const p = this._p;
    const boxes = [];
    if (p.has("orderBlocks")) {
      for (const ob of p._smc.orderBlocks ?? []) {
        boxes.push({ ...ob, color: ob.direction === "bullish" ? DEMAND : SUPPLY, alpha: ZONE_FILL_ALPHA });
      }
    }
    if (p.has("fvg")) {
      for (const g of p._smc.fvg ?? []) boxes.push({ ...g, color: FVG_COLOR, alpha: FVG_FILL_ALPHA });
    }

    for (const box of boxes) {
      const x = xAt(box.startT);
      const yTop = y(box.top);
      const yBottom = y(box.bottom);
      if (x == null || yTop == null || yBottom == null) continue;
      const h = Math.max(Math.abs(yBottom - yTop), 1);
      const w = Math.max(mediaSize.width - x, 1);
      withAlpha(ctx, box.alpha, () => {
        ctx.fillStyle = box.color;
        ctx.fillRect(x, Math.min(yTop, yBottom), w, h);
      });
      withAlpha(ctx, ZONE_BORDER_ALPHA, () => {
        ctx.strokeStyle = box.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x, Math.min(yTop, yBottom), w, h);
      });
    }
  }

  // BOS/CHoCH: a horizontal line at the broken pivot's price, running from that pivot to
  // the bar that closed through it, labelled at the midpoint — the same read as the chart
  // in TradingView, where the line is the level and the tag says how it broke.
  _drawStructure(ctx, xAt, y) {
    const p = this._p;
    if (!p.has("structure")) return;
    for (const s of p._smc.structure ?? []) {
      const x1 = xAt(s.fromT);
      const x2 = xAt(s.toT);
      const yy = y(s.price);
      if (x1 == null || x2 == null || yy == null) continue;
      const color = s.direction === "bullish" ? BULL : BEAR;
      const swing = s.scale === "swing";
      withAlpha(ctx, swing ? 0.9 : INTERNAL_ALPHA, () => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, yy);
        ctx.lineTo(x2, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = font(swing ? 9 : 8);
        ctx.textAlign = "center";
        ctx.textBaseline = s.direction === "bullish" ? "bottom" : "top";
        ctx.fillText(s.kind, (x1 + x2) / 2, yy + (s.direction === "bullish" ? -2 : 2));
      });
    }
  }

  // EQH/EQL: dotted connector between the two matching pivots, tagged at the right end.
  _drawEqualLevels(ctx, xAt, y) {
    const p = this._p;
    if (!p.has("equalLevels")) return;
    for (const l of p._smc.equalLevels ?? []) {
      const x1 = xAt(l.fromT);
      const x2 = xAt(l.toT);
      const yy = y(l.price);
      if (x1 == null || x2 == null || yy == null) continue;
      withAlpha(ctx, 0.85, () => {
        ctx.strokeStyle = EQUAL_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, yy);
        ctx.lineTo(x2, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = EQUAL_COLOR;
        ctx.font = font(8);
        ctx.textAlign = "left";
        ctx.textBaseline = l.kind === "EQH" ? "bottom" : "top";
        ctx.fillText(l.kind, x2 + 3, yy + (l.kind === "EQH" ? -1 : 1));
      });
    }
  }

  // Strong/weak high & low tags on the major swings only — the minor ones flip too often
  // to be worth labelling, and the pane has no room for both.
  _drawSwingTags(ctx, xAt, y) {
    const p = this._p;
    if (!p.has("structure")) return;
    const tags = (p._smc.swings ?? []).filter((s) => s.scale === "swing").slice(-MAX_SWING_LABELS);
    for (const s of tags) {
      const x = xAt(s.t);
      const yy = y(s.price);
      if (x == null || yy == null) continue;
      const isHigh = s.kind === "high";
      withAlpha(ctx, 0.75, () => {
        ctx.fillStyle = SWING_LABEL;
        ctx.font = font(8);
        ctx.textAlign = "center";
        ctx.textBaseline = isHigh ? "bottom" : "top";
        const label = `${s.strength === "strong" ? "Strong" : "Weak"} ${isHigh ? "High" : "Low"}`;
        ctx.fillText(label, x, yy + (isHigh ? -3 : 3));
      });
    }
  }
}

class SmcPaneView {
  constructor(primitive, layer) {
    this._primitive = primitive;
    this._layer = layer;
  }
  zOrder() {
    return this._layer;
  }
  renderer() {
    const p = this._primitive;
    if (!p._smc || !p._series || !p._chart || p._parts.size === 0) return null;
    return new SmcRenderer(p, this._layer);
  }
}

export class SmcPrimitive {
  constructor() {
    this._smc = null;
    this._parts = new Set();
    this._times = [];
    this._series = null;
    this._chart = null;
    this._requestUpdate = null;
    // zones sit under the candles, lines and labels over them
    this._paneViews = [new SmcPaneView(this, "bottom"), new SmcPaneView(this, "top")];
  }
  // parts: which of "structure" | "orderBlocks" | "equalLevels" | "fvg" are toggled on.
  // times: the chart's own bar times (unix seconds, ascending) — anchors are resolved
  // against these rather than assumed present in the visible data.
  setData(smc, parts, times) {
    this._smc = smc ?? null;
    this._parts = new Set(parts ?? []);
    this._times = times ?? [];
    this._requestUpdate?.();
  }
  has(part) {
    return this._parts.has(part);
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
