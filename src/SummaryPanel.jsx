import { narrateMarket, narrateOptions, narrateDecision } from "./narrator.js";
import { RefetchStatus, LoadingScreen } from "./RefetchStatus.jsx";

const TONE_CLS = { good: "green", caution: "amber", poor: "red", muted: "muted" };

// Wraps chosen substrings of a narrator sentence in colored/bold <span>s so the
// key figures (price moves, scores, verdicts, penalties) pop out at a glance.
// Matching is done against the plain-English text narrator.js already produced —
// this is presentation only, it never changes what the sentence says.
function highlight(text, rules) {
  const matches = [];
  for (const { pattern, cls } of rules) {
    const re = new RegExp(pattern, "g");
    let m;
    while ((m = re.exec(text))) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], cls });
    }
  }
  if (matches.length === 0) return text;
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      kept.push(m);
      lastEnd = m.end;
    }
  }
  const nodes = [];
  let cursor = 0;
  kept.forEach((m, i) => {
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start));
    nodes.push(
      <span key={i} className={m.cls ? `hl ${m.cls}` : "hl"}>{m.text}</span>
    );
    cursor = m.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const MARKET_RULES = [
  { pattern: "up \\d[\\d.]*% \\(\\$[\\d,.]+\\)", cls: "green" },
  { pattern: "down \\d[\\d.]*% \\(\\$[\\d,.]+\\)", cls: "red" },
  { pattern: "\\$[\\d,]+\\.\\d{2}", cls: "" },
];

const OPTIONS_RULES = [
  { pattern: "docked (the )?(the )?signal \\d+ points", cls: "red" },
  { pattern: "\\d[\\d.]*% annual swing", cls: "amber" },
  { pattern: "\\d[\\d.]*% of its value per day", cls: "amber" },
  { pattern: "Few contracts trade at these strikes", cls: "red" },
  { pattern: "Plenty of contracts trade at these strikes", cls: "green" },
  { pattern: "very little trading activity", cls: "amber" },
  { pattern: "may be stale", cls: "amber" },
];

const DECISION_RULES = [
  { pattern: "bullish \\([+][\\d.]+\\)", cls: "green" },
  { pattern: "bearish \\(-[\\d.]+\\)", cls: "red" },
  { pattern: "neutral \\([+-][\\d.]+\\)", cls: "muted" },
  { pattern: "raw score of [+-]\\d+\\.\\d+", cls: "" },
  { pattern: "shrank that score to [+-]\\d+\\.\\d+", cls: "red" },
  { pattern: "score stands at [+-]\\d+\\.\\d+", cls: "" },
  { pattern: "Verdict: BUY CALL", cls: "green" },
  { pattern: "Verdict: BUY PUT", cls: "red" },
  { pattern: "Verdict: HOLD", cls: "amber" },
  { pattern: "No (call|put) contract qualified", cls: "red" },
];

// Beginner-facing translation of the numbers shown elsewhere on the page.
// Purely presentational — App.jsx owns the snapshot/greeks/signal fetches.
export default function SummaryPanel({ quote, greeks, signal, symbol = "QQQ", isMobile = false, secondsLeft = null, status = null, updatedAt = null, noData = false }) {
  const market = narrateMarket(quote, symbol);
  const exp = signal?.optionsFactors?.expiration ?? greeks?.preview?.expiration ?? null;
  const quality = exp ? greeks?.summary?.[exp] : null;
  const options = narrateOptions(quality, exp, signal?.optionsFactors?.penalties, symbol);
  const decision = narrateDecision(signal, greeks?.preview, symbol);
  const nvoImplication = signal?.newsVsOptions?.implication;

  if (!market && !quality && decision.length === 0) {
    return (
      <div className="module">
        <div className="module-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="section-title" style={{ margin: 0 }}>What&rsquo;s happening (plain English)</div>
          <RefetchStatus secondsLeft={secondsLeft} status={status} updatedAt={updatedAt} />
        </div>
        <div className={isMobile ? undefined : "card"} style={isMobile ? { margin: 5 } : undefined}>
          {noData ? (
            <div className="muted">Waiting for data — start the server and click &ldquo;Go&rdquo; to fetch a snapshot.</div>
          ) : (
            <LoadingScreen />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="module">
        <div className="module-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="section-title" style={{ margin: 0 }}>What&rsquo;s happening (plain English)</div>
          <RefetchStatus secondsLeft={secondsLeft} status={status} updatedAt={updatedAt} />
        </div>
        <div className={isMobile ? "summary" : "card summary"} style={isMobile ? { margin: 5 } : undefined}>

        {market && (
          <>
            <div className="sub">Market summary</div>
            <p>{highlight(market, MARKET_RULES)}</p>
          </>
        )}

        <div className="sub">
          Options conditions{options.label && <>: <span className={TONE_CLS[options.tone]}>{options.label}</span></>}
        </div>
        {options.sentences.map((s, i) => <p key={i}>{highlight(s, OPTIONS_RULES)}</p>)}

        {decision.length > 0 && (
          <>
            <div className="sub">What the app would do</div>
            {decision.map((s, i) => <p key={i}>{highlight(s, DECISION_RULES)}</p>)}
          </>
        )}

        {nvoImplication && (
          <>
            <div className="sub">Worth noting</div>
            <p>{nvoImplication}</p>
          </>
        )}
      </div>
    </div>
  );
}
