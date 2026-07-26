import { narrateMarket, narrateOptions, narrateDecision } from "./narrator.js";

const TONE_CLS = { good: "green", caution: "amber", poor: "red", muted: "muted" };

// Beginner-facing translation of the numbers shown elsewhere on the page.
// Purely presentational — App.jsx owns the snapshot/greeks/signal fetches.
export default function SummaryPanel({ quote, greeks, signal }) {
  const market = narrateMarket(quote);
  const exp = signal?.optionsFactors?.expiration ?? greeks?.preview?.expiration ?? null;
  const quality = exp ? greeks?.summary?.[exp] : null;
  const options = narrateOptions(quality, exp, signal?.optionsFactors?.penalties);
  const decision = narrateDecision(signal, greeks?.preview);
  const nvoImplication = signal?.newsVsOptions?.implication;

  if (!market && !quality && decision.length === 0) {
    return (
      <div className="card summary" style={{ marginBottom: 16 }}>
        <div className="section-title">What&rsquo;s happening (plain English)</div>
        <div className="muted">Waiting for data — start the server and ask Claude to refresh a snapshot.</div>
      </div>
    );
  }

  return (
    <div className="card summary" style={{ marginBottom: 16 }}>
      <div className="section-title">What&rsquo;s happening (plain English)</div>

      {market && (
        <>
          <div className="sub">Market summary</div>
          <p>{market}</p>
        </>
      )}

      <div className="sub">
        Options conditions{options.label && <>: <span className={TONE_CLS[options.tone]}>{options.label}</span></>}
      </div>
      {options.sentences.map((s, i) => <p key={i}>{s}</p>)}

      {decision.length > 0 && (
        <>
          <div className="sub">What the app would do</div>
          {decision.map((s, i) => <p key={i}>{s}</p>)}
        </>
      )}

      {nvoImplication && (
        <>
          <div className="sub">Worth noting</div>
          <p>{nvoImplication}</p>
        </>
      )}
    </div>
  );
}
