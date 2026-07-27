// Turns the raw options-analysis data into plain-English sentences for beginners.
// Pure functions, deterministic — no AI, no network. Every input field is optional;
// missing data degrades to fewer sentences, never a crash.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(1) : "0.0");

// "2026-07-31" → "Jul 31" (string math, so no timezone off-by-one)
function expLabel(exp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exp || "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : exp;
}

const lean = (score) => (score > 12 ? "bullish" : score < -12 ? "bearish" : "neutral");

export function narrateMarket(quote, symbol = "QQQ") {
  if (!quote || quote.price == null) return null;
  if (quote.changePct == null || Math.abs(quote.changePct) < 0.05) {
    return `${symbol} is trading at ${fmt$(quote.price)}, roughly flat versus the prior close.`;
  }
  const dir = quote.changePct > 0 ? "up" : "down";
  return `${symbol} is trading at ${fmt$(quote.price)}, ${dir} ${Math.abs(quote.changePct).toFixed(2)}% (${fmt$(Math.abs(quote.change))}) from the prior close.`;
}

// quality = greeks.summary[expiration]; penalties = signal.optionsFactors.penalties.
// Severity wording keys off the server's actual penalties, so it can never
// disagree with the score the strategy computed.
export function narrateOptions(quality, expiration, penalties, symbol = "QQQ") {
  if (!quality) {
    return {
      tone: "muted",
      label: null,
      sentences: ["No options analytics yet — click “Go” to fetch a snapshot with option quotes."],
    };
  }
  const pen = { iv: 0, spread: 0, oi: 0, ...(penalties || {}) };
  const total = pen.iv + pen.spread + pen.oi;
  const tone = total === 0 ? "good" : total < 40 ? "caution" : "poor";
  const sentences = [];
  const expText = expiration ? `Options expiring ${expLabel(expiration)}` : "These options";

  if (quality.atmIv != null) {
    const ivWord = pen.iv >= 10 ? "look expensive" : pen.iv > 0 ? "look a bit pricey" : "look reasonably priced";
    let s = `${expText} ${ivWord} — the market is pricing in about a ${(quality.atmIv * 100).toFixed(1)}% annual swing for ${symbol} (that's "implied volatility"; the higher it is, the more you pay for the same bet).`;
    if (pen.iv > 0) s += ` That expensiveness cost the buy/sell signal ${pen.iv} points.`;
    sentences.push(s);
  }
  if (quality.avgSpreadPct != null) {
    const spreadWord = pen.spread >= 10 ? "wide" : pen.spread > 0 ? "a bit wide" : "small";
    let s = `The gap between the buying and selling price (the bid/ask spread) is ${spreadWord} at ~${(quality.avgSpreadPct * 100).toFixed(2)}% — that gap is a cost you pay the moment you trade.`;
    if (pen.spread > 0) s += ` That docked the signal ${pen.spread} points.`;
    sentences.push(s);
  }
  if (quality.dailyThetaPctAtm != null) {
    sentences.push(
      `Holding an at-the-money option here loses about ${(quality.dailyThetaPctAtm * 100).toFixed(1)}% of its value per day purely from time passing (time decay) — even if ${symbol} doesn't move.`
    );
  }
  if (quality.liquidityOk === false) {
    sentences.push(
      `Few contracts trade at these strikes (thin "open interest"), so real fills would be worse than the on-screen prices — that docked the signal ${pen.oi || 20} points.`
    );
  } else if (quality.liquidityOk === true) {
    sentences.push("Plenty of contracts trade at these strikes, so getting in and out at a fair price is easy.");
  }
  const flags = quality.flags || [];
  if (flags.some((f) => f.startsWith("iv-divergence"))) {
    sentences.push("Heads-up: some quotes disagree with the theoretical pricing math — the data may be stale.");
  }
  const lowOi = flags.filter((f) => f.startsWith("low-oi")).length;
  if (lowOi > 0) {
    sentences.push(`${lowOi} strike${lowOi > 1 ? "s have" : " has"} very little trading activity.`);
  }
  return { tone, label: tone === "poor" ? "poor" : tone, sentences };
}

function pickModeNote(mode) {
  if (mode === "delta-targeted") return " (Chosen by targeting a delta near 0.4 — balancing the odds of winning against the cost.)";
  if (mode === "1%-OTM fallback") return " (Fallback rule: a strike about 1% away from the current price.)";
  return "";
}

export function narrateDecision(signal, preview, symbol = "QQQ") {
  if (!signal || !Number.isFinite(signal.combinedScore)) return [];
  const sentences = [];
  const base = signal.techScore * 0.75 + signal.newsScore * 0.25;
  sentences.push(
    `Chart indicators lean ${lean(signal.techScore)} (${signed(signal.techScore)}) and news sentiment is ${lean(signal.newsScore)} (${signed(signal.newsScore)}). Blended — 75% chart, 25% news — that's a raw score of ${signed(base)}.`
  );
  const drivers = signal.indicators?.composite?.topDrivers;
  if (drivers?.length > 0) {
    const top = drivers.slice(0, 2);
    const parts = top.map((d) => `${d.indicator} is ${d.direction} (${d.why.charAt(0).toLowerCase()}${d.why.slice(1).replace(/\.$/, "")})`);
    sentences.push(`Biggest drivers of that chart lean: ${parts.join("; ")}.`);
  }
  if ((signal.optionsScore ?? 0) < 0 && Math.abs(base - signal.combinedScore) >= 0.05) {
    sentences.push(
      `Because option conditions are working against buyers right now, the app shrank that score to ${signed(signal.combinedScore)}.`
    );
  } else if ((signal.optionsScore ?? 0) < 0) {
    sentences.push(`Option conditions apply a small penalty, leaving the score at ${signed(signal.combinedScore)}.`);
  } else {
    sentences.push(`Option conditions look clear, so the score stands at ${signed(signal.combinedScore)}.`);
  }
  if (signal.action === "buy_call") sentences.push(`Verdict: BUY CALL — a bet that ${symbol} rises.`);
  else if (signal.action === "buy_put") sentences.push(`Verdict: BUY PUT — a bet that ${symbol} falls.`);
  else sentences.push("Verdict: HOLD — the signal isn't strong enough to justify paying for an option right now.");

  const side = signal.action === "buy_put" ? "put" : "call";
  const p = preview?.[side];
  if (p) {
    if (p.strike != null) {
      const lead = signal.action === "hold" ? "If it were to buy, it would pick" : "It would buy";
      let s = `${lead} the $${p.strike} ${side}`;
      if (p.mid != null) s += ` at ${p.mid.toFixed(2)} per share (${fmt$(p.mid * 100)} per contract)`;
      if (p.delta != null) {
        s += ` — its delta of ${p.delta.toFixed(2)} means roughly a ${Math.round(Math.abs(p.delta) * 100)}% chance of finishing in the money`;
      }
      sentences.push(s + "." + pickModeNote(p.mode));
    } else if (p.mode) {
      const reason = p.mode.startsWith("all strikes filtered")
        ? "every strike was rejected for thin trading or wide spreads."
        : p.mode + ".";
      sentences.push(`No ${side} contract qualified — ${reason}`);
    }
  }
  return sentences;
}

export function narrateAutopilot(status) {
  if (!status) return null;
  const parts = [];
  parts.push(
    status.enabled
      ? "Autopilot is on — it re-checks the signal on a schedule and trades its own paper account."
      : "Autopilot is off — it won't place any trades until you press Start."
  );
  if (status.weekPnlPct != null) {
    const dir = status.weekPnlPct >= 0 ? "up" : "down";
    parts.push(`This week its account is ${dir} ${Math.abs(status.weekPnlPct).toFixed(1)}% against the 10% weekly goal.`);
  }
  const n = status.positions?.length ?? 0;
  parts.push(n === 0 ? "It holds no positions right now." : `It holds ${n} open position${n > 1 ? "s" : ""}.`);
  return parts.join(" ");
}
