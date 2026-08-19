// Explainer content for the "?" button next to every indicator chip (IndicatorToggles.jsx)
// and the IV Rank badge. Each entry: { title, what, how, usage, Diagram }. Diagram is a
// zero-prop component rendering a small illustrative (not live-data) SVG sketch, sharing
// the palette below so every diagram reads as one system with the rest of the app.

const C = {
  bg: "#14171A",
  grid: "#1A1D21",
  axis: "#8A9099",
  up: "#3DDC84",
  down: "#FF5C5C",
  accent: "#4C8DFF",
  accent2: "#E8A33D",
  warn: "#E8A33D",
  text: "#C9CDD1",
};

const VB = "0 0 280 130";

function Frame({ children }) {
  return (
    <svg viewBox={VB} width="100%" style={{ display: "block", background: C.bg, borderRadius: 6 }}>
      {children}
    </svg>
  );
}

function Label({ x, y, children, color = C.axis, size = 9, anchor = "start" }) {
  return (
    <text x={x} y={y} fill={color} fontSize={size} textAnchor={anchor} fontFamily="ui-monospace, monospace">
      {children}
    </text>
  );
}

// A short arrow + text callout, e.g. pointing at a crossover or touch point. Anchors
// away from whichever viewBox edge tx is closest to, so the label text grows toward the
// open half of the frame instead of running off it.
function Note({ x, y, tx, ty, children, color = C.text }) {
  const towardRight = tx < 140;
  return (
    <g>
      <path d={`M${x},${y} L${tx},${ty}`} stroke={color} strokeWidth={1} markerEnd="url(#arrow)" opacity={0.8} />
      <Label x={tx + (towardRight ? 4 : -4)} y={ty} color={color} anchor={towardRight ? "start" : "end"}>
        {children}
      </Label>
    </g>
  );
}

function ArrowDefs() {
  return (
    <defs>
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill={C.text} opacity={0.8} />
      </marker>
    </defs>
  );
}

// A jagged but generally-trending price path, used as the backdrop for most diagrams.
const PRICE_PATH = "M10,90 L40,80 L60,88 L85,60 L110,68 L135,45 L160,52 L185,30 L210,38 L235,20 L260,26";

function PriceBackdrop({ opacity = 1 }) {
  return <path d={PRICE_PATH} fill="none" stroke={C.axis} strokeWidth={1.5} opacity={opacity} />;
}

// Parameterized moving-average diagram factory — every SMA/EMA chip shares this shape,
// just with a different smoothing color/period label.
function makeMaDiagram(color, periodLabel) {
  return function MaDiagram() {
    return (
      <Frame>
        <ArrowDefs />
        <PriceBackdrop opacity={0.5} />
        <path d="M10,85 L40,82 L60,80 L85,72 L110,66 L135,58 L160,52 L185,44 L210,38 L235,32 L260,27" fill="none" stroke={color} strokeWidth={2} />
        <Note x={200} y={45} tx={230} ty={70} color={color}>
          {periodLabel}-period average
        </Note>
        <Label x={12} y={16} color={C.axis}>price vs. its smoothed average</Label>
      </Frame>
    );
  };
}

function BbDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,50 L40,48 L70,55 L100,80 L130,88 L160,80 L190,55 L220,48 L260,45" fill="none" stroke={C.axis} strokeWidth={1} opacity={0.5} />
      <path d="M10,30 L260,30" stroke={C.accent} strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
      <path d="M10,95 L260,95" stroke={C.accent} strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
      <path d="M10,62 L260,62" stroke={C.accent} strokeWidth={1} strokeDasharray="2,4" opacity={0.4} />
      <circle cx={130} cy={88} r={3} fill={C.up} />
      <Note x={130} y={88} tx={90} ty={110} color={C.up}>price touches lower band</Note>
      <Label x={12} y={16}>±2σ band around a 20-period average</Label>
    </Frame>
  );
}

function VwapDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <PriceBackdrop opacity={0.6} />
      <path d="M10,75 L260,55" fill="none" stroke="#FF8FC7" strokeWidth={1.5} strokeDasharray="4,3" />
      <Note x={230} y={26} tx={230} ty={50} color="#FF8FC7">VWAP (from session/window start)</Note>
      <Label x={12} y={16}>cumulative volume-weighted average</Label>
    </Frame>
  );
}

function AvwapDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <PriceBackdrop opacity={0.6} />
      <path d="M110,68 L260,40" fill="none" stroke="#FFB86C" strokeWidth={1.5} strokeDasharray="4,3" />
      <path d="M106,78 L114,78 L110,68 Z" fill="#FFB86C" />
      <Note x={110} y={78} tx={80} ty={105} color="#FFB86C">anchor: click any candle</Note>
      <Label x={12} y={16}>VWAP re-based from a chosen event</Label>
    </Frame>
  );
}

function RsiDiagram() {
  const wave = "M10,60 L35,40 L60,75 L85,25 L110,80 L135,90 L160,45 L185,20 L210,60 L235,35 L260,55";
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,20 L260,20" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <path d="M10,100 L260,100" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={264} y={23} anchor="end">70</Label>
      <Label x={264} y={103} anchor="end">30</Label>
      <path d={wave} fill="none" stroke={C.accent} strokeWidth={1.5} />
      <circle cx={185} cy={20} r={3} fill={C.down} />
      <circle cx={135} cy={90} r={3} fill={C.up} />
      <Note x={135} y={90} tx={90} ty={112} color={C.up}>oversold — bounce candidate</Note>
      <Label x={12} y={16}>momentum oscillator, 0–100</Label>
    </Frame>
  );
}

function MacdDiagram() {
  const line1 = "M10,60 L60,50 L110,65 L160,35 L210,45 L260,25";
  const line2 = "M10,65 L60,58 L110,60 L160,50 L210,48 L260,40";
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,72 L260,72" stroke={C.grid} strokeWidth={1} />
      {[110, 135, 160, 185, 210, 235, 260].map((x, i) => {
        const h = [4, -3, 8, 14, 10, 5, -4][i];
        return <rect key={x} x={x - 8} y={h > 0 ? 72 - h : 72} width={16} height={Math.abs(h)} fill={h > 0 ? C.up : C.down} opacity={0.6} />;
      })}
      <path d={line1} fill="none" stroke={C.accent} strokeWidth={1.5} />
      <path d={line2} fill="none" stroke={C.accent2} strokeWidth={1.5} />
      <Note x={160} y={35} tx={195} ty={20} color={C.accent}>MACD crosses above signal</Note>
      <Label x={12} y={16}>EMA12 − EMA26, vs. its own 9-EMA signal</Label>
    </Frame>
  );
}

function StochDiagram() {
  const k = "M10,50 L35,20 L60,30 L85,95 L110,105 L135,60 L160,25 L185,20 L210,70 L235,100 L260,90";
  const d = "M10,55 L35,35 L60,25 L85,70 L110,100 L135,80 L160,40 L185,22 L210,50 L235,90 L260,95";
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,20 L260,20" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <path d="M10,105 L260,105" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={264} y={23} anchor="end">80</Label>
      <Label x={264} y={108} anchor="end">20</Label>
      <path d={k} fill="none" stroke={C.accent} strokeWidth={1.3} />
      <path d={d} fill="none" stroke={C.accent2} strokeWidth={1.3} />
      <Label x={12} y={16}>price's position in its recent range</Label>
    </Frame>
  );
}

function StochRsiDiagram() {
  const k = "M10,60 L30,15 L50,110 L70,25 L90,100 L110,20 L130,105 L150,25 L170,95 L190,20 L210,100 L230,30 L250,95";
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,20 L260,20" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <path d="M10,108 L260,108" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={264} y={23} anchor="end">80</Label>
      <Label x={264} y={111} anchor="end">20</Label>
      <path d={k} fill="none" stroke="#B57BFF" strokeWidth={1.3} />
      <Label x={12} y={16}>RSI's own Stochastic — fast, choppy</Label>
    </Frame>
  );
}

function AtrDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      {[
        [10, 40, 30], [45, 55, 40], [80, 35, 55], [115, 50, 35], [150, 30, 60], [185, 45, 45], [220, 32, 50],
      ].map(([x, top, h], i) => (
        <rect key={i} x={x} y={top} width={22} height={h} fill={C.axis} opacity={0.25} />
      ))}
      <path d="M20,55 L20,90" stroke={C.accent2} strokeWidth={2} />
      <path d="M14,55 L26,55" stroke={C.accent2} strokeWidth={2} />
      <path d="M14,90 L26,90" stroke={C.accent2} strokeWidth={2} />
      <Note x={30} y={72} tx={70} ty={100} color={C.accent2}>average high-low range per bar</Note>
      <Label x={12} y={16}>typical bar range — sizes strikes/stops</Label>
    </Frame>
  );
}

function AdxDiagram() {
  const trend = "M10,90 L50,80 L90,72 L130,55 L170,42 L210,28 L260,15";
  const adx = "M10,105 L50,102 L90,95 L130,80 L170,62 L210,45 L260,30";
  return (
    <Frame>
      <ArrowDefs />
      <path d={trend} fill="none" stroke={C.axis} strokeWidth={1.3} opacity={0.6} />
      <path d="M10,55 L260,55" stroke={C.grid} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={264} y={58} anchor="end">25</Label>
      <path d={adx} fill="none" stroke={C.accent2} strokeWidth={1.8} />
      <Note x={190} y={58} tx={220} ty={85} color={C.accent2}>ADX &gt; 25: trend confirmed</Note>
      <Label x={12} y={16}>trend strength (0–100), not direction</Label>
    </Frame>
  );
}

function VpvrDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <PriceBackdrop opacity={0.5} />
      {[18, 30, 46, 70, 50, 26, 14, 10, 16, 22].map((w, i) => (
        <rect key={i} x={260 - w} y={20 + i * 9} width={w} height={7} fill={i === 3 ? C.accent2 : C.accent} opacity={i === 3 ? 0.5 : 0.2} />
      ))}
      <Note x={170} y={100} tx={230} ty={50} color={C.accent2}>POC — heaviest volume shelf</Note>
      <Label x={12} y={16}>volume traded per price, not per time</Label>
    </Frame>
  );
}

function IvRankDiagram() {
  const squiggle = "M10,90 L35,70 L60,85 L85,55 L110,60 L135,30 L160,45 L185,25 L210,50 L235,35 L260,60";
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,25 L260,25" stroke={C.accent} strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
      <path d="M10,95 L260,95" stroke={C.accent} strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
      <Label x={264} y={28} anchor="end">52w high</Label>
      <Label x={264} y={98} anchor="end">52w low</Label>
      <path d={squiggle} fill="none" stroke={C.axis} strokeWidth={1.3} />
      <circle cx={235} cy={35} r={4} fill={C.warn} />
      <Note x={235} y={35} tx={200} ty={15} color={C.warn}>you are here — IV Rank ≈ 80</Note>
      <Label x={12} y={16}>today's IV vs. its own 52-week range</Label>
    </Frame>
  );
}

// The four SMC diagrams share one zig-zag price path so the concepts read as views of the
// same chart rather than four unrelated sketches.
const SMC_PATH = "M10,95 L45,55 L80,80 L115,30 L150,70 L185,25 L220,60 L260,40";

function SmcStructureDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <path d={SMC_PATH} fill="none" stroke={C.axis} strokeWidth={1.2} opacity={0.7} />
      <path d="M45,55 L115,55" stroke={C.up} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={80} y={51} color={C.up} size={8} anchor="middle">BOS</Label>
      <path d="M115,30 L185,30" stroke={C.up} strokeWidth={1} strokeDasharray="3,3" />
      <Label x={150} y={26} color={C.up} size={8} anchor="middle">BOS</Label>
      <Note x={150} y={70} tx={112} ty={112} color={C.text}>higher low = Strong Low</Note>
      <Label x={12} y={16}>each new high taken = trend intact</Label>
    </Frame>
  );
}

function SmcObDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <rect x={60} y={62} width={200} height={18} fill={C.accent} opacity={0.15} />
      <rect x={60} y={62} width={200} height={18} fill="none" stroke={C.accent} strokeWidth={1} opacity={0.4} />
      <path d="M10,100 L60,80 L100,35 L150,25 L200,68 L240,45" fill="none" stroke={C.axis} strokeWidth={1.2} opacity={0.7} />
      <Note x={200} y={70} tx={150} ty={105} color={C.accent}>price returns to the zone</Note>
      <Label x={12} y={16}>last opposing candle before the break</Label>
    </Frame>
  );
}

function SmcEqDiagram() {
  return (
    <Frame>
      <ArrowDefs />
      <path d="M10,90 L60,35 L110,75 L160,34 L210,80 L260,60" fill="none" stroke={C.axis} strokeWidth={1.2} opacity={0.7} />
      <path d="M60,34 L160,34" stroke="#B57BFF" strokeWidth={1} strokeDasharray="1,3" />
      <Label x={165} y={31} color="#B57BFF" size={8}>EQH</Label>
      <Note x={110} y={34} tx={95} ty={108} color={C.text}>stops resting just above</Note>
      <Label x={12} y={16}>two highs at the same price = liquidity</Label>
    </Frame>
  );
}

function SmcFvgDiagram() {
  const candles = [
    [40, 70, 40, C.up],
    [90, 40, 45, C.up],
    [140, 20, 35, C.up],
  ];
  return (
    <Frame>
      <ArrowDefs />
      <rect x={40} y={40} width={220} height={30} fill={C.accent2} opacity={0.14} />
      {candles.map(([x, y, h, color], i) => (
        <g key={i}>
          <rect x={x} y={y} width={18} height={h} fill={color} opacity={0.75} />
        </g>
      ))}
      <Note x={200} y={55} tx={185} ty={105} color={C.accent2}>untraded gap — often refilled</Note>
      <Label x={12} y={16}>candle 1's high never met candle 3's low</Label>
    </Frame>
  );
}

export const HELP = {
  sma20: {
    title: "SMA 20",
    what: "The simple average of the last 20 closes — a slower, smoother read on the trend.",
    read: "Look at whether price is above or below the line, and whether the line itself is sloping up or down. Price above a rising line = uptrend; price below a falling line = downtrend.",
    how: "Sum the last 20 closing prices and divide by 20. Every bar is weighted equally, so a single outlier day barely moves it.",
    usage: "A cross of price above/below the SMA20, or SMA20 above/below SMA50, is a common trend filter — trade calls only while price holds above it, puts only while below.",
    Diagram: makeMaDiagram("#4C8DFF", "20"),
  },
  sma50: {
    title: "SMA 50",
    what: "The simple average of the last 50 closes — the slower of the two moving averages on this chart.",
    read: "Same idea as SMA20, just slower to turn — treat it as the bigger-picture trend line. Is price mostly hovering above it (bullish) or below it (bearish) lately?",
    how: "Sum the last 50 closing prices and divide by 50.",
    usage: "SMA20/SMA50 crossovers ('golden cross' up, 'death cross' down) mark medium-term trend shifts — useful for picking which side of the chain (calls vs. puts) to favor over a multi-week swing.",
    Diagram: makeMaDiagram("#E8A33D", "50"),
  },
  ema12: {
    title: "EMA 12",
    what: "A 12-period average that weights recent closes more heavily than old ones.",
    read: "It hugs price more closely than an SMA. Price crossing above it is an early sign momentum just turned up; crossing below, momentum just turned down.",
    how: "Each new value blends today's close with yesterday's EMA using a fixed smoothing factor (2/(12+1)), so it reacts faster than an SMA of the same length.",
    usage: "The fast leg of MACD (EMA12 − EMA26). On its own, price crossing EMA12 is an early, noisier momentum flip signal — better for timing entries than for trend confirmation.",
    Diagram: makeMaDiagram("#B57BFF", "12"),
  },
  ema26: {
    title: "EMA 26",
    what: "A 26-period exponential average — the slow leg of MACD.",
    read: "Treat it like a plain trend line: price staying above it is bullish, staying below is bearish. It moves slower than EMA12, so it won't whipsaw as much.",
    how: "Same exponential-smoothing formula as EMA12, just with a longer period (alpha = 2/(26+1)), so it lags more and filters more noise.",
    usage: "Distance between EMA12 and EMA26 is literally the MACD line. Watching EMA12/EMA26 separation widen or narrow previews a MACD signal before the crossover prints.",
    Diagram: makeMaDiagram("#4BD6C8", "26"),
  },
  ema9: {
    title: "EMA 9",
    what: "A fast 9-period exponential average — reacts almost immediately to new price action.",
    read: "The most sensitive line on this chart — it basically hugs the last few days of closes. A quick way to check 'is price still going my way right now?'",
    how: "Exponential smoothing with alpha = 2/(9+1); the most recent bar dominates the value.",
    usage: "Popular for very short-dated (0-3 DTE) option scalps: price holding above/below EMA9 is used as a tight trailing stop line rather than a trend signal.",
    Diagram: makeMaDiagram("#FFE08A", "9"),
  },
  ema21: {
    title: "EMA 21",
    what: "A medium-fast exponential average, a common swing-trading pivot line.",
    read: "In an uptrend, watch for price to dip down and touch this line, then bounce — that pullback is what swing traders wait for. The reverse (touch-and-reject) happens in downtrends.",
    how: "Exponential smoothing with alpha = 2/(21+1).",
    usage: "Pullbacks to the EMA21 in an uptrend are a classic 'buy the dip' entry for weekly-expiration calls; the same line rejecting price is a put entry in a downtrend.",
    Diagram: makeMaDiagram("#7BD88F", "21"),
  },
  ema50: {
    title: "EMA 50",
    what: "The exponential counterpart to SMA50 — a medium-term trend line that reacts a bit faster.",
    read: "If you only remember one rule for this line: price above EMA50 = the medium-term trend is up; price below it = the medium-term trend is down.",
    how: "Exponential smoothing with alpha = 2/(50+1).",
    usage: "Used the same way as SMA50 for trend bias, but its faster reaction makes it flip sides slightly sooner around trend changes — useful when timing when to roll from puts to calls or vice versa.",
    Diagram: makeMaDiagram("#FF8A5C", "50"),
  },
  bb: {
    title: "Bollinger Bands",
    what: "A volatility envelope: a 20-period average with bands plotted 2 standard deviations above and below it.",
    read: "The middle line is just the average; the outer bands show how far price normally swings. When a candle pokes outside a band, that's an unusually big move — price often snaps back toward the middle afterward. Bands squeezing tight = a big move may be brewing.",
    how: "Mid = SMA(20). Upper/Lower = Mid ± 2×(standard deviation of the last 20 closes). Bands widen when volatility rises, narrow when it falls.",
    usage: "Prices tagging the lower band in a range-bound market flag a mean-reversion premium-selling setup (cash-secured puts / put credit spreads); a tight 'squeeze' (narrow bands) often precedes a big directional move worth buying options ahead of.",
    Diagram: BbDiagram,
  },
  vwap: {
    title: "VWAP",
    what: "The volume-weighted average price since the start of the visible window — where the 'average' trader actually paid.",
    read: "One line, one rule: price above VWAP means buyers have been in control since the window started; price below it means sellers have been in control.",
    how: "Cumulative (typical price × volume) divided by cumulative volume, running from the first bar in the window forward.",
    usage: "Institutions benchmark fills against VWAP. Price holding above VWAP all session favors calls/staying long; losing VWAP mid-session is a common signal to take profits or flip to puts.",
    Diagram: VwapDiagram,
  },
  avwap: {
    title: "Anchored VWAP",
    what: "The same volume-weighted average price as VWAP, but re-based from a specific event you choose instead of the start of the window.",
    read: "Same rule as VWAP, but starting from wherever you clicked (the little flag marker). Everyone who bought at or after that point is sitting on a profit if price is above the line, or a loss if it's below.",
    how: "Click any candle on the chart (e.g. an earnings gap, a breakout day, a swing low) to move the anchor there — the average then accumulates only from that bar forward.",
    usage: "Anchored to a major low, AVWAP approximates the average cost basis of everyone who bought since that event — price holding above it favors continuation; losing it is an early warning the move is running out of buyers.",
    Diagram: AvwapDiagram,
  },
  rsi: {
    title: "RSI (14)",
    what: "Relative Strength Index — measures how fast and how far price has moved recently, scaled 0–100.",
    read: "A single wavy line between 0 and 100. Above 70 = price has moved up a lot recently ('hot'); below 30 = it's moved down a lot recently ('cold'). Most of the time it just wanders in the middle, and that's normal.",
    how: "Wilder's smoothed ratio of average gains to average losses over the last 14 bars, converted to a 0–100 oscillator via 100 − 100/(1+RS).",
    usage: "Readings above 70 flag overbought conditions (favor put entries or taking profit on calls); below 30 flags oversold (favor call entries or covering puts) — classic reversal-option setups.",
    Diagram: RsiDiagram,
  },
  macd: {
    title: "MACD (12/26/9)",
    what: "Moving Average Convergence Divergence — the gap between a fast and slow EMA, used to catch momentum shifts.",
    read: "Two lines plus bars. When the faster line crosses above the slower one, momentum is turning up (the bars flip green); crossing below, momentum is turning down (bars flip red). Taller bars mean stronger momentum.",
    how: "MACD line = EMA(12) − EMA(26). Signal line = 9-period EMA of the MACD line. Histogram = MACD − Signal.",
    usage: "MACD crossing above its signal line (histogram flips positive) is a classic call-buy trigger; crossing below is a put-buy trigger — most reliable when it agrees with the broader trend (SMA20 > SMA50).",
    Diagram: MacdDiagram,
  },
  stoch: {
    title: "Stochastic (%K/%D)",
    what: "Measures where the current close sits within its recent high-low range, 0–100.",
    read: "Two lines bouncing between 0 and 100. Near the top (80+), price is sitting near the top of its recent range; near the bottom (20-), it's near the bottom. Watch for the two lines crossing near one of those extremes — that's the classic signal.",
    how: "%K = (close − 14-bar low) / (14-bar high − 14-bar low) × 100, smoothed by 3; %D is a 3-period average of %K.",
    usage: "%K crossing above %D below the 20 line is a bullish reversal cue; crossing below %D above 80 is bearish — used for short-dated reversal option entries in range-bound markets.",
    Diagram: StochDiagram,
  },
  stochrsi: {
    title: "Stochastic RSI",
    what: "The Stochastic formula applied to RSI instead of price — a hyper-sensitive oscillator that pins near its extremes often.",
    read: "Read it the same way as plain Stochastic (0-100, watch the 20/80 extremes) but expect it to move faster and jump around more — it'll spend more time pinned near 0 or 100 than the regular version.",
    how: "Same %K/%D math as Stochastic, but run over RSI's own recent range instead of price's high/low range, then smoothed 3/3.",
    usage: "Reacts faster than plain RSI or Stochastic, which suits very short-dated scalp trades — but it whipsaws more, so it's best combined with a trend filter (e.g. ADX, EMA21) rather than traded alone.",
    Diagram: StochRsiDiagram,
  },
  atr: {
    title: "ATR (14)",
    what: "Average True Range — the typical size of a bar's total price move, in dollars.",
    read: "Just one number, in dollars. A bigger number means the stock has been swinging around more than usual lately; a smaller number means it's been unusually calm. It doesn't tell you direction, only 'how much'.",
    how: "True range per bar = max(high−low, |high−prevClose|, |low−prevClose|), then smoothed over 14 bars (Wilder EMA).",
    usage: "Used to size realistic strikes and stops: a strike further from spot than ~1×ATR needs a real move to reach; stop-loss/take-profit levels are often set as a multiple of ATR rather than a fixed dollar amount.",
    Diagram: AtrDiagram,
  },
  adx: {
    title: "ADX (14) / ±DI",
    what: "Average Directional Index — how strongly the market is trending, regardless of direction; +DI/−DI show which direction.",
    read: "The orange ADX line answers 'is there a real trend right now?' — below 25, not really; above 25, yes. The green/red lines then tell you which way: green above red means up, red above green means down.",
    how: "Wilder-smoothed directional movement (+DM/−DM) normalized by true range gives +DI/−DI; DX = 100×|+DI−−DI|/(+DI+−DI); ADX is a further Wilder average of DX.",
    usage: "ADX below 25 flags a choppy, sideways market — a warning to avoid directional long-option trades that bleed theta while going nowhere. ADX above 25 with +DI > −DI favors calls; with −DI > +DI favors puts.",
    Diagram: AdxDiagram,
  },
  vpvr: {
    title: "Volume Profile (VPVR)",
    what: "How much volume traded at each price level over the visible window, shown as horizontal bars — not volume over time.",
    read: "These bars run sideways, not up-and-down — a longer bar means more shares changed hands at that price. The single longest bar (highlighted) is the price the stock has 'agreed on' the most, and it tends to act like a magnet, pulling price back toward it.",
    how: "Bins the visible price range and sums the volume of every bar whose typical price ((high+low+close)/3) falls in that bin. The tallest bin is the Point of Control (POC).",
    usage: "High-volume price shelves act as support/resistance — strikes placed just beyond a heavy node have a real barrier to break through; the POC is a common magnet price gravitates back toward.",
    Diagram: VpvrDiagram,
  },
  smc: {
    title: "Market Structure (SMC)",
    what: "Where the market last broke a prior swing high or low — the Smart Money Concepts read of whether the trend is continuing or turning.",
    read: "A dashed line marks the swing level that got taken out. BOS (Break of Structure) means price broke in the direction it was already going — the trend is intact. CHoCH (Change of Character) means it broke the other way — the first sign the trend may be flipping. Highs and lows are also tagged Strong or Weak: a Strong Low is one the market rallied from hard enough to break the last high; a Weak Low failed to.",
    how: "Confirmed swing pivots (a bar whose high/low is the extreme of the bars either side of it) are tracked at two scales — a fast internal one and a slower swing one. A close through the last unbroken pivot emits BOS when it continues the prevailing trend and CHoCH when it reverses it.",
    usage: "CHoCH on the swing scale is the earliest structural warning that a directional option position is on the wrong side; BOS after BOS is confirmation to stay with the trend. Strong lows/highs are the levels worth anchoring a stop beyond.",
    Diagram: SmcStructureDiagram,
  },
  smcOb: {
    title: "Order Blocks (SMC)",
    what: "The candle a big move originated from, drawn as a zone that stays on the chart until price trades back through it.",
    read: "A shaded band extending to the right edge. Blue bands sit below price (demand — where buyers stepped in), red bands above it (supply — where sellers did). Price returning to a band is the setup traders watch; a close straight through it means the zone failed and it disappears from the chart.",
    how: "On each structure break, the last candle opposing the impulse (between the broken pivot and the bar that broke it) becomes the zone, using its full high-low range. A later close beyond the zone counts as mitigation and removes it; only the newest few per side are kept.",
    usage: "Untouched zones are natural targets and reversal areas — useful for picking strikes to sell into, or for judging whether a long option still has room before it runs into supply.",
    Diagram: SmcObDiagram,
  },
  smcEq: {
    title: "Equal Highs / Lows (SMC)",
    what: "Two swing highs (or lows) that stalled at effectively the same price — a shelf of resting stop orders.",
    read: "A dotted line joining the two matching pivots, tagged EQH above price or EQL below. The idea is that obvious levels collect stop-loss orders just beyond them, and price often pushes through to trigger those before reversing.",
    how: "Consecutive swing pivots on the same side are compared; if they sit within 0.1 × ATR of each other they're reported as an equal pair, priced at their midpoint.",
    usage: "Treat an EQH just overhead as a likely magnet rather than a hard ceiling — a spike through it that immediately fails is the classic liquidity sweep, and a poor place to have just bought calls.",
    Diagram: SmcEqDiagram,
  },
  smcFvg: {
    title: "Fair Value Gaps (SMC)",
    what: "A price pocket that a fast move skipped over entirely, leaving an imbalance the market tends to come back and fill.",
    read: "A translucent amber band. It marks a range where, over three consecutive candles, the middle move was violent enough that the first and third candles' ranges never overlapped — nothing actually traded in between. Gaps price has since traded back through are removed, so what's drawn is what's still open.",
    how: "For each bar, an unfilled gap exists when bar i's low is above bar i−2's high (bullish) or bar i's high is below bar i−2's low (bearish). Any later bar trading into the pocket fills it and drops it from the list.",
    usage: "Open gaps below price are common pullback targets and above it common rally targets — helpful for setting a realistic profit target on a short-dated option rather than an arbitrary one.",
    Diagram: SmcFvgDiagram,
  },
  ivrank: {
    title: "IV Rank / Percentile",
    what: "Where today's implied volatility sits relative to its own past year — is options premium currently expensive or cheap for this underlying?",
    read: "One number, 0 to 100. Close to 100 means options are about as expensive (relative to their own history) as they've been all year — a hint that selling premium may be favorable. Close to 0 means they're about as cheap as they've been all year — a hint that buying premium may be favorable.",
    how: "IV Rank = (today's IV − 52-week low) / (52-week high − 52-week low) × 100. IV Percentile = the % of days in the last year with IV below today's. Built from a daily ATM-IV sample recorded on every snapshot refresh, so it needs weeks of history before it's meaningful.",
    usage: "High IV Rank (>50) favors selling premium (credit spreads, covered calls/puts) since options are rich; low IV Rank favors buying premium (long calls/puts, debit spreads) since options are cheap relative to their own history.",
    Diagram: IvRankDiagram,
  },
};
