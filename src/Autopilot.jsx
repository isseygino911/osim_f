import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { narrateAutopilot } from "./narrator.js";
import { useCountdown, RefetchStatus } from "./RefetchStatus.jsx";
import NewsDetailDrawer from "./NewsDetailDrawer.jsx";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";
const NEWS_POLL_MS = 2 * 60 * 1000;
const AUTOPILOT_POLL_MS = 10 * 1000;
const fmt$ = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n > 0 ? "+" : "") + n.toFixed(2) + "%";
// gemini-2.5-flash-lite Developer API standard tier, $/token (ai.google.dev/gemini-api/docs/pricing)
const GEMINI_PRICING = { input: 0.1 / 1e6, output: 0.4 / 1e6 };
const estCost = (u) => (u ? u.promptTokens * GEMINI_PRICING.input + u.outputTokens * GEMINI_PRICING.output : 0);

async function api(path, opts) {
  const res = await fetch(`${SERVER_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

const sentClass = (s) => (s === "positive" || s === "bullish" ? "green" : s === "negative" || s === "bearish" ? "red" : "amber");

function scoreColor(score) {
  if (score >= 12) return "green";
  if (score <= -12) return "red";
  return "amber";
}

// Presentational: App.jsx owns the /api/indicators fetch so the chart overlays
// and this table share a single request per poll.
export function IndicatorsPanel({ data, error, secondsLeft, status, active = null }) {
  if (error) {
    return (
      <div className="module">
        <div className="module-header row" style={{ justifyContent: "space-between" }}>
          <div className="section-title" style={{ margin: 0 }}>Indicators</div>
          <RefetchStatus secondsLeft={secondsLeft} status={status} />
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12 }}>{error}</div>
        </div>
      </div>
    );
  }
  if (!data || data.insufficientData) {
    return (
      <div className="module">
        <div className="module-header row" style={{ justifyContent: "space-between" }}>
          <div className="section-title" style={{ margin: 0 }}>Indicators</div>
          <RefetchStatus secondsLeft={secondsLeft} status={status} />
        </div>
        <div className="card">
          <div className="muted">Loading…</div>
        </div>
      </div>
    );
  }

  const { latest, composite, iv } = data;
  const dirClass = (d) => (d === "bullish" ? "green" : d === "bearish" ? "red" : "muted");
  const allRows = [
    ["rsi", "RSI (14)", latest.rsi14?.toFixed(1), Number.isFinite(latest.rsi14) && latest.rsi14 < 30 ? "green" : Number.isFinite(latest.rsi14) && latest.rsi14 > 70 ? "red" : ""],
    ["macd", "MACD", latest.macd?.toFixed(2), latest.macd > latest.macdSignal ? "green" : "red"],
    ["macd", "MACD signal", latest.macdSignal?.toFixed(2), ""],
    ["sma20", "SMA 20 / 50", `${latest.sma20?.toFixed(1)} / ${latest.sma50?.toFixed(1)}`, Number.isFinite(latest.sma20) && Number.isFinite(latest.sma50) ? (latest.sma20 > latest.sma50 ? "green" : "red") : ""],
    ["ema9", "EMA 9 / 21 / 50", `${latest.ema9?.toFixed(1)} / ${latest.ema21?.toFixed(1)} / ${latest.ema50?.toFixed(1)}`, Number.isFinite(latest.ema9) && Number.isFinite(latest.ema21) ? (latest.ema9 > latest.ema21 ? "green" : "red") : ""],
    ["bb", "Bollinger", `${latest.bbLower?.toFixed(1)} – ${latest.bbUpper?.toFixed(1)}`, ""],
    ["vwap", "VWAP", latest.vwap?.toFixed(2), latest.price > latest.vwap ? "green" : "red"],
    ["atr", "ATR (14)", latest.atr14?.toFixed(2), ""],
    ["adx", "ADX (14)", latest.adx14?.toFixed(1), Number.isFinite(latest.adx14) && latest.adx14 >= 25 ? "amber" : ""],
    ["adx", "+DI / -DI", `${latest.plusDI?.toFixed(1)} / ${latest.minusDI?.toFixed(1)}`, Number.isFinite(latest.plusDI) && Number.isFinite(latest.minusDI) ? (latest.plusDI > latest.minusDI ? "green" : "red") : ""],
    ["stoch", "Stochastic %K", latest.stochK?.toFixed(1), Number.isFinite(latest.stochK) && latest.stochK < 20 ? "green" : Number.isFinite(latest.stochK) && latest.stochK > 80 ? "red" : ""],
    ["stochrsi", "StochRSI %K / %D", `${latest.stochRsiK?.toFixed(1)} / ${latest.stochRsiD?.toFixed(1)}`, Number.isFinite(latest.stochRsiK) && latest.stochRsiK < 20 ? "green" : Number.isFinite(latest.stochRsiK) && latest.stochRsiK > 80 ? "red" : ""],
    [null, "IV Rank / %ile", iv == null ? "—" : iv.insufficient ? `insufficient history (${iv.days}d)` : `${iv.ivRank ?? "—"} / ${iv.ivPercentile ?? "—"}`, ""],
  ];
  // null key (IV Rank) is always shown — it's not a chart-overlay indicator, just informational
  const rows = (active == null ? allRows : allRows.filter(([key]) => key == null || active.includes(key))).map(
    ([, label, val, cls]) => [label, val, cls]
  );

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Indicators</div>
        <div className="row">
          <RefetchStatus secondsLeft={secondsLeft} status={status} />
          <span className={`mono ${scoreColor(composite.score)}`} style={{ fontWeight: 600, fontSize: 13 }}>
            {composite.label.replace("_", " ").toUpperCase()} ({composite.score > 0 ? "+" : ""}{composite.score})
          </span>
        </div>
      </div>
      <div className="card">
        <table>
          <tbody>
            {rows.map(([label, val, cls]) => (
              <tr key={label}>
                <td className="muted" style={{ textAlign: "left" }}>{label}</td>
                <td className={`mono ${cls}`}>{val ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {composite.reasons?.length > 0 && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Why {composite.label.replace("_", " ").toUpperCase()}: each indicator&rsquo;s vote
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {composite.reasons.map((r) => (
              <li key={r.indicator} style={{ fontSize: 12 }}>
                <span className={dirClass(r.direction)} style={{ fontWeight: 600 }}>{r.indicator}</span>
                {" "}
                <span className={dirClass(r.direction)}>({r.direction}{r.direction !== "neutral" ? `, ${r.vote > 0 ? "+" : ""}${r.vote}` : ""})</span>
                {" — "}
                <span className="muted">{r.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function NewsPanel({ symbol = "QQQ" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastFetchAt, setLastFetchAt] = useState(null);
  const [lastFetchOk, setLastFetchOk] = useState(null);
  const [openItem, setOpenItem] = useState(null);
  // sequence guard: the poll effect and the manual Refresh button can both have a
  // request in flight at once (each /api/news call can take up to ~8s), so track
  // which call is the latest and drop any response that resolves after it, the
  // same "cancelled" guard used for App.jsx's data-fetching effects. It also drops
  // in-flight responses for a symbol the user has since switched away from.
  const requestIdRef = useRef(0);

  const load = useCallback(async (refresh) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const result = await api(`/api/news?symbol=${symbol}${refresh ? "&refresh=1" : ""}`);
      if (requestIdRef.current !== requestId) return;
      setData(result);
      setError(null);
      setLastFetchOk(true);
    } catch (e) {
      if (requestIdRef.current === requestId) {
        setError(e.message);
        setLastFetchOk(false);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        setLastFetchAt(Date.now());
      }
    }
  }, [symbol]);

  useEffect(() => {
    setData(null); // load's identity changes with the symbol — never show the old symbol's headlines
    load(false);
    const t = setInterval(() => load(false), NEWS_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const secondsLeft = useCountdown(NEWS_POLL_MS, lastFetchAt);
  const status = lastFetchOk == null ? null : lastFetchOk ? "success" : "error";

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>{symbol}-relevant news</div>
        <div className="row">
          <RefetchStatus secondsLeft={secondsLeft} status={status} />
          {data?.analysisMode === "gemini" && (
            <span
              className="mono"
              style={{ color: "#4C8DFF", fontSize: 10, fontWeight: 600 }}
              title={data.aiUsage ? `${data.aiUsage.calls} Gemini call(s), ${data.aiUsage.totalTokens.toLocaleString()} tokens total (${data.aiUsage.model})` : undefined}
            >
              GEMINI{data.aiUsage && ` · ${data.aiUsage.totalTokens.toLocaleString()}tok · $${estCost(data.aiUsage).toFixed(4)}`}
            </span>
          )}
          {data?.overall && (
            <span className={`mono ${sentClass(data.overall.sentiment)}`} style={{ fontSize: 12, fontWeight: 600 }}>
              {data.overall.sentiment.toUpperCase()} ({data.overall.score > 0 ? "+" : ""}{data.overall.score})
            </span>
          )}
          <button className="ghost" onClick={() => load(true)} disabled={loading}>{loading ? "…" : "Refresh"}</button>
        </div>
      </div>
      <div className="card">
        {error && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{error}</div>}
        <div className="trade-log">
          <AnimatePresence initial={false}>
            {(data?.relevantItems ?? []).slice(0, 20).map((item) => (
              <motion.div
                key={item.link || item.title}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                style={{ padding: "6px 0", borderBottom: "1px solid #1A1D21" }}
              >
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                  title={item.aiReason || undefined}
                  style={{ color: "#E7E9EA", textDecoration: "none", fontSize: 13, cursor: "pointer" }}
                  onClick={(e) => { e.preventDefault(); setOpenItem(item); }}
                >
                  {item.title}
                </a>
                <div className="row" style={{ marginTop: 2, fontSize: 11 }}>
                  {item.relevanceScore != null && (
                    <span className="mono muted" style={{ border: "1px solid #2A2F35", borderRadius: 4, padding: "0 4px" }}>
                      R{item.relevanceScore}
                    </span>
                  )}
                  <span className="muted">{item.source}</span>
                  <span className={sentClass(item.direction ?? item.sentiment)}>{item.direction ?? item.sentiment}</span>
                  {item.analysisSource === "gemini" && (
                    <span className="mono" style={{ color: "#4C8DFF", fontSize: 10 }}>AI</span>
                  )}
                  {item.publishedAt && <span className="muted">{new Date(item.publishedAt).toLocaleTimeString()}</span>}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {data?.items?.length > 0 && !data?.relevantItems?.length && (
            <div className="muted" style={{ fontSize: 12 }}>
              No {symbol}-relevant headlines right now (relevance ≥ 25) — {data.items.length} headlines scanned.
            </div>
          )}
          {!data?.items?.length && !error && <div className="muted">Loading news…</div>}
        </div>
      </div>
      {openItem && <NewsDetailDrawer item={openItem} symbol={symbol} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

// Presentational: compares news direction against options-market positioning.
// Fed from signalData.newsVsOptions, which App.jsx already fetches each poll.
export function DivergencePanel({ signal, error }) {
  const nvo = signal?.newsVsOptions;
  const verdictStyle =
    nvo?.verdict === "aligned" ? "green" : nvo?.verdict === "divergent" ? "amber" : "muted";
  const biasLabel = (bias) =>
    bias > 15 ? "bullish positioning" : bias < -15 ? "pricing downside" : "balanced";
  const pct = (x, dp = 1) => (x == null ? "—" : (x * 100).toFixed(dp));

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>News vs options</div>
        {nvo && (
          <span className={`mono ${verdictStyle}`} style={{ fontSize: 12, fontWeight: 600 }}>
            {nvo.verdict.toUpperCase()}
          </span>
        )}
      </div>
      <div className="card">
        {error && <div className="muted" style={{ fontSize: 12 }}>{error}</div>}
        {!nvo && !error && <div className="muted">Loading…</div>}
        {nvo && (
          <>
            <div className="mono" style={{ fontSize: 12 }}>
              news <span className={sentClass(nvo.newsSentiment)}>{nvo.newsScore > 0 ? "+" : ""}{nvo.newsScore} ({nvo.newsSentiment})</span>
              <span className="muted"> vs </span>
              options <span className={nvo.optionsBias > 15 ? "green" : nvo.optionsBias < -15 ? "red" : "amber"}>
                {nvo.optionsBias > 0 ? "+" : ""}{nvo.optionsBias} ({biasLabel(nvo.optionsBias)})
              </span>
            </div>
            <table style={{ marginTop: 10 }}>
              <tbody>
                <tr>
                  <td className="muted" style={{ textAlign: "left" }}>25Δ IV skew (put − call)</td>
                  <td className="mono">{nvo.factors ? `${pct(nvo.factors.ivSkew)} pts` : "—"}</td>
                </tr>
                <tr>
                  <td className="muted" style={{ textAlign: "left" }}>Put/Call open interest</td>
                  <td className="mono">{nvo.factors?.oiRatio?.toFixed(2) ?? "—"}</td>
                </tr>
                <tr>
                  <td className="muted" style={{ textAlign: "left" }}>ATM implied vol</td>
                  <td className="mono">{nvo.factors?.atmIv != null ? pct(nvo.factors.atmIv, 0) + "%" : "—"}</td>
                </tr>
                <tr>
                  <td className="muted" style={{ textAlign: "left" }}>News sample</td>
                  <td className="mono">{nvo.sampleSize} headlines</td>
                </tr>
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{nvo.implication}</div>
          </>
        )}
      </div>
    </div>
  );
}

// Presentational: fed from signalData.volSurface (App.jsx's existing /api/signal poll).
// Skew/term-structure/VRP context, distinct from the single ATM-IV read GreeksPanel
// already shows — informational only, same as DivergencePanel.
export function VolSurfacePanel({ signal, error }) {
  const vs = signal?.volSurface;
  const pct = (x, dp = 1) => (x == null ? "—" : (x * 100).toFixed(dp) + "%");
  const pts = (x, dp = 1) => (x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(dp) + "pts");
  const slopeLabel = vs?.term?.slope == null ? "" : vs.term.slope >= 0 ? "contango (calm)" : "inverted (stress priced in)";
  const vrpLabel = vs?.vol?.vrp == null ? "" : vs.vol.vrp >= 0 ? "richer than realized" : "cheaper than realized";

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Volatility surface</div>
      </div>
      <div className="card">
        {error && <div className="muted" style={{ fontSize: 12 }}>{error}</div>}
        {!vs && !error && <div className="muted">Loading…</div>}
        {vs && (
          <table>
            <tbody>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>Skew (25Δ put − call)</td>
                <td className="mono">
                  {vs.skew?.put25d != null && vs.skew?.call25d != null ? pts(vs.skew.put25d - vs.skew.call25d) : "—"}
                </td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>Wing skew (10Δ put − call)</td>
                <td className="mono">
                  {vs.skew?.put10d != null && vs.skew?.call10d != null ? pts(vs.skew.put10d - vs.skew.call10d) : "—"}
                </td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>Term structure</td>
                <td className="mono">
                  {vs.term ? (
                    <>
                      {pct(vs.term.nearAtmIv, 0)} ({vs.term.nearExpiration}) → {pct(vs.term.farAtmIv, 0)} ({vs.term.farExpiration})
                      <span className="muted"> · {slopeLabel}</span>
                    </>
                  ) : "—"}
                </td>
              </tr>
              <tr>
                <td className="muted" style={{ textAlign: "left" }}>ATM IV vs realized (20d)</td>
                <td className="mono">
                  {vs.vol ? (
                    <>
                      {pct(vs.vol.atmIv, 0)} vs {pct(vs.vol.realizedVol20d, 0)}
                      {vs.vol.vrp != null && <span className="muted"> · VRP {pts(vs.vol.vrp)} ({vrpLabel})</span>}
                    </>
                  ) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Presentational: fed from signalData.gammaExposure. Dealer gamma positioning —
// positive net GEX suggests hedging flows dampen moves (pinning near high-gamma
// strikes); negative suggests hedging amplifies moves. Informational only.
export function GammaExposurePanel({ signal, error }) {
  const gex = signal?.gammaExposure;
  const fmtGex = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + (n / 1e6).toFixed(2) + "M");
  const regimeLabel = gex?.netGex == null ? "" : gex.netGex >= 0 ? "positive (dampening / pinning)" : "negative (amplifying)";
  const regimeCls = gex?.netGex == null ? "" : gex.netGex >= 0 ? "green" : "red";
  const topStrikes = gex?.byStrike?.length
    ? [...gex.byStrike].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 3)
    : [];

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Gamma exposure</div>
        {gex?.netGex != null && (
          <span className={`mono ${regimeCls}`} style={{ fontSize: 12, fontWeight: 600 }}>
            {fmtGex(gex.netGex)}
          </span>
        )}
      </div>
      <div className="card">
        {error && <div className="muted" style={{ fontSize: 12 }}>{error}</div>}
        {!gex && !error && <div className="muted">Loading…</div>}
        {gex && gex.netGex == null && <div className="muted">Not enough gamma/open-interest data on this chain yet.</div>}
        {gex && gex.netGex != null && (
          <>
            <div className="mono" style={{ fontSize: 12 }}>
              Net dealer gamma <span className={regimeCls}>{regimeLabel}</span>
            </div>
            <table style={{ marginTop: 10 }}>
              <tbody>
                <tr>
                  <td className="muted" style={{ textAlign: "left" }}>Zero-gamma strike</td>
                  <td className="mono">{gex.zeroGammaStrike ?? "—"}</td>
                </tr>
                {topStrikes.map((s) => (
                  <tr key={s.strike}>
                    <td className="muted" style={{ textAlign: "left" }}>Strike {s.strike}</td>
                    <td className={`mono ${s.gex >= 0 ? "green" : "red"}`}>{fmtGex(s.gex)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// Presentational: App.jsx owns the /api/greeks + /api/signal fetches so this panel
// and the chain-table pick highlighting share one request per poll.
export function GreeksPanel({ greeks, signal, error, secondsLeft, status }) {
  const shell = (body) => (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Options analysis</div>
        <div className="row">
          <RefetchStatus secondsLeft={secondsLeft} status={status} />
          {signal && Number.isFinite(signal.optionsScore) && (
            <span className={`mono ${signal.optionsScore <= -40 ? "red" : signal.optionsScore < 0 ? "amber" : "green"}`} style={{ fontSize: 12, fontWeight: 600 }}>
              {signal.optionsScore === 0 ? "CONDITIONS CLEAR" : `CONDITIONS ${signal.optionsScore.toFixed(1)}`}
            </span>
          )}
        </div>
      </div>
      <div className="card">{body}</div>
    </div>
  );
  if (error) return shell(<div className="muted" style={{ fontSize: 12 }}>{error}</div>);
  if (!greeks || !signal) return shell(<div className="muted">Loading…</div>);

  const factors = signal.optionsFactors;
  const exp = factors?.expiration ?? greeks.preview?.expiration ?? null;
  const quality = exp ? greeks.summary?.[exp] : null;
  const penalties = factors?.penalties;
  const base = signal.techScore * 0.75 + signal.newsScore * 0.25;
  const multiplier = 1 + (signal.optionsScore ?? 0) / 200;
  const actionCls = signal.action === "buy_call" ? "green" : signal.action === "buy_put" ? "red" : "amber";
  const pct = (x, dp = 1) => (x == null ? "—" : (x * 100).toFixed(dp) + "%");

  const pickRow = (label, p, cls) => (
    <tr>
      <td className="muted" style={{ textAlign: "left" }}>{label}</td>
      {p?.strike != null ? (
        <td className="mono">
          <span className={cls}>{p.strike}{label === "Call pick" ? "C" : "P"}</span>
          {p.mid != null && ` @ ${p.mid.toFixed(2)}`}
          {p.delta != null && ` · Δ${p.delta.toFixed(2)}`}
          {p.iv != null && ` · IV ${pct(p.iv, 0)}`}
          <span className="muted"> ({p.mode})</span>
        </td>
      ) : (
        <td className="mono muted">{p?.mode ?? "—"}</td>
      )}
    </tr>
  );

  return shell(
    <>
      <div className="mono" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        tech {signal.techScore.toFixed(1)}×0.75 + news {signal.newsScore.toFixed(1)}×0.25 = {base.toFixed(1)}
        <span className="muted"> → dampener ×{multiplier.toFixed(3)} → </span>
        <span style={{ fontWeight: 600 }}>{signal.combinedScore.toFixed(1)}</span>
        <span className={actionCls} style={{ fontWeight: 600 }}> {signal.action.replace("_", " ").toUpperCase()}</span>
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          <tr><td className="muted" style={{ textAlign: "left" }}>Expiration analyzed</td><td className="mono">{exp ?? "—"}</td></tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>ATM implied vol</td>
            <td className={`mono ${penalties?.iv > 0 ? "amber" : ""}`}>{pct(quality?.atmIv)}{penalties?.iv > 0 && ` (−${penalties.iv})`}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>Avg bid/ask spread</td>
            <td className={`mono ${penalties?.spread > 0 ? "amber" : ""}`}>{pct(quality?.avgSpreadPct, 2)}{penalties?.spread > 0 && ` (−${penalties.spread})`}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>ATM theta burn</td>
            <td className="mono">{quality?.dailyThetaPctAtm != null ? pct(quality.dailyThetaPctAtm) + "/day" : "—"}</td>
          </tr>
          <tr>
            <td className="muted" style={{ textAlign: "left" }}>Liquidity (open interest)</td>
            <td className={`mono ${quality?.liquidityOk === false ? "red" : "green"}`}>
              {quality?.liquidityOk === false ? `THIN (−${penalties?.oi ?? 20})` : "OK"}
            </td>
          </tr>
          {pickRow("Call pick", greeks.preview?.call, "green")}
          {pickRow("Put pick", greeks.preview?.put, "red")}
        </tbody>
      </table>
      {quality?.flags?.length > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          ⚠ {quality.flags.slice(0, 4).join(" · ")}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Greeks {greeks.schemaVersion >= 2 ? "from data provider" : "computed via Black-Scholes from quotes"} · r={greeks.riskFreeRate}
      </div>
    </>
  );
}

export function AutopilotPanel({ symbol = "QQQ" }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastFetchAt, setLastFetchAt] = useState(null);
  const [lastFetchOk, setLastFetchOk] = useState(null);
  const pollRef = useRef(null);
  const symbolRef = useRef(symbol); // always-current symbol so in-flight responses for a switched-away symbol get dropped
  symbolRef.current = symbol;

  const refresh = useCallback(async () => {
    try {
      const result = await api(`/api/autopilot?symbol=${symbol}`);
      if (symbolRef.current !== symbol) return;
      setStatus(result);
      setError(null);
      setLastFetchOk(true);
    } catch (e) {
      if (symbolRef.current !== symbol) return;
      setError(e.message);
      setLastFetchOk(false);
    } finally {
      if (symbolRef.current === symbol) setLastFetchAt(Date.now());
    }
  }, [symbol]);

  useEffect(() => {
    setStatus(null); // refresh's identity changes with the symbol — never show the old symbol's portfolio
    refresh();
    pollRef.current = setInterval(refresh, AUTOPILOT_POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const secondsLeft = useCountdown(AUTOPILOT_POLL_MS, lastFetchAt);
  const fetchStatus = lastFetchOk == null ? null : lastFetchOk ? "success" : "error";

  async function toggle() {
    setBusy(true);
    try {
      await api(`${status?.enabled ? "/api/autopilot/disable" : "/api/autopilot/enable"}?symbol=${symbol}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      await api(`/api/autopilot/run-now?symbol=${symbol}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm(`Reset the ${symbol} autopilot portfolio to $10,000 and clear all history?`)) return;
    setBusy(true);
    try {
      await api(`/api/autopilot/reset?symbol=${symbol}`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="module">
        <div className="module-header"><div className="section-title" style={{ margin: 0 }}>Autopilot</div></div>
        <div className="card"><div className="muted">{error || "Loading…"}</div></div>
      </div>
    );
  }

  const progressColor = status.weekPnlPct >= 10 ? "#3DDC84" : status.weekPnlPct >= 0 ? "#E8A33D" : "#FF5C5C";
  const barPct = Math.max(0, Math.min(100, status.weekProgressPct));

  return (
    <div className="module">
      <div className="module-header row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <span className={`dot ${status.enabled ? "" : "off"}`} />
          <div className="section-title" style={{ margin: 0 }}>Autopilot &middot; goal 10%/week</div>
        </div>
        <div className="row">
          <RefetchStatus secondsLeft={secondsLeft} status={fetchStatus} />
          <button className="ghost" onClick={runNow} disabled={busy}>Run now</button>
          <button className={status.enabled ? "sell" : "buy"} onClick={toggle} disabled={busy}>
            {status.enabled ? "Stop" : "Start"}
          </button>
        </div>
      </div>

      <div className="card">
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{narrateAutopilot(status)}</div>

      {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
          <span className="muted">This week</span>
          <span className="mono" style={{ color: progressColor }}>{fmtPct(status.weekPnlPct)} of 10% goal</span>
        </div>
        <div style={{ background: "#1A1D21", borderRadius: 6, height: 8, marginTop: 6, overflow: "hidden" }}>
          <motion.div
            style={{ height: "100%" }}
            animate={{ width: `${barPct}%`, backgroundColor: progressColor }}
            transition={{ width: { type: "spring", stiffness: 120, damping: 20 }, backgroundColor: { duration: 0.3, ease: "easeOut" } }}
          />
        </div>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
        <span className="muted">Equity</span>
        <span className="mono">{fmt$(status.equity)}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Cash</span>
        <span className="mono">{fmt$(status.cash)}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Open positions</span>
        <span className="mono">{status.positions.length}</span>
      </div>

      {status.lastDecision && (
        <div style={{ marginTop: 12, fontSize: 12 }} className="muted">
          Last check: {status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : "—"} &middot; {status.lastDecision.reason || status.lastDecision.type}
        </div>
      )}

      {status.positions.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Contract</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&amp;L</th></tr></thead>
          <tbody>
            <AnimatePresence initial={false}>
              {status.positions.map((p) => {
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
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      )}

      {status.weekHistory?.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 18 }}>Weekly history</div>
          <table>
            <thead><tr><th>Week of</th><th>P&amp;L %</th></tr></thead>
            <tbody>
              {status.weekHistory.map((w, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(w.weekStart).toLocaleDateString()}</td>
                  <td className={`mono ${w.pnlPct >= 0 ? "green" : "red"}`}>{fmtPct(w.pnlPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {status.trades?.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 18 }}>Autopilot trade log</div>
          <div className="trade-log">
            <AnimatePresence initial={false}>
            {status.trades.slice(0, 30).map((t) => (
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
                {t.reason && <div className="muted" style={{ fontSize: 11 }}>{t.reason}</div>}
              </motion.div>
            ))}
            </AnimatePresence>
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button className="ghost" onClick={reset} disabled={busy}>Reset autopilot</button>
      </div>
      </div>
    </div>
  );
}
