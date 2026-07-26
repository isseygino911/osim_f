// Single source of truth for chart indicator overlays. Both the chip row
// (IndicatorToggles.jsx) and the chart (Candlestick.jsx) read from this list,
// so adding an indicator is a one-line change here.
//
// series keys must match the arrays returned by GET /api/indicators -> series
// (see server/indicators.js). Every array is index-aligned with the candles and
// null-padded at the head.

export const PANE_HEIGHT = 92;

// pane "price" draws over the candles; anything else gets its own sub-pane.
export const INDICATORS = [
  { key: "sma20", label: "SMA 20", pane: "price", color: "#4C8DFF", series: ["sma20"] },
  { key: "sma50", label: "SMA 50", pane: "price", color: "#E8A33D", series: ["sma50"] },
  { key: "ema12", label: "EMA 12", pane: "price", color: "#B57BFF", series: ["ema12"] },
  { key: "ema26", label: "EMA 26", pane: "price", color: "#4BD6C8", series: ["ema26"] },
  {
    key: "bb",
    label: "BB",
    pane: "price",
    color: "#8A9099",
    series: ["bbUpper", "bbMid", "bbLower"],
    dashed: ["bbMid"],
    fill: ["bbUpper", "bbLower"],
  },
  { key: "vwap", label: "VWAP", pane: "price", color: "#FF8FC7", series: ["vwap"], dashed: ["vwap"] },

  {
    key: "rsi",
    label: "RSI",
    paneLabel: "RSI 14",
    pane: "rsi",
    color: "#4C8DFF",
    series: ["rsi14"],
    domain: [0, 100],
    guides: [30, 70],
  },
  {
    key: "macd",
    label: "MACD",
    paneLabel: "MACD 12/26/9",
    pane: "macd",
    color: "#4C8DFF",
    signalColor: "#E8A33D",
    series: ["macdLine", "signalLine"],
    histogram: "histogram",
    symmetric: true,
    zeroLine: true,
  },
  {
    key: "stoch",
    label: "STOCH",
    paneLabel: "Stoch %K/%D",
    pane: "stoch",
    color: "#4C8DFF",
    signalColor: "#E8A33D",
    series: ["stochK", "stochD"],
    domain: [0, 100],
    guides: [20, 80],
  },
  { key: "atr", label: "ATR", paneLabel: "ATR 14", pane: "atr", color: "#8A9099", series: ["atr14"] },
];

export const DEFAULT_ACTIVE = ["sma20", "sma50"];

const BY_KEY = new Map(INDICATORS.map((c) => [c.key, c]));

export const getIndicator = (key) => BY_KEY.get(key);

// Drops keys that no longer exist (e.g. a stale localStorage value).
export const sanitizeActive = (keys) =>
  Array.isArray(keys) ? keys.filter((k) => BY_KEY.has(k)) : [...DEFAULT_ACTIVE];
