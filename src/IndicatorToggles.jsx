import { INDICATORS } from "./indicatorConfig.js";

const PRICE = INDICATORS.filter((c) => c.pane === "price");
const PANES = INDICATORS.filter((c) => c.pane !== "price");

function Chip({ cfg, on, disabled, onToggle, onHelp }) {
  return (
    <span className="chip-wrap">
      <button
        type="button"
        className={`chip ${on ? "on" : ""}`}
        disabled={disabled}
        title={on ? `Hide ${cfg.label}` : `Show ${cfg.label}`}
        onClick={() => onToggle(cfg.key)}
        style={on ? { background: cfg.color, borderColor: cfg.color } : { color: cfg.color, borderColor: "#2A2F35" }}
      >
        {cfg.label}
      </button>
      <button type="button" className="chip-help" title={`About ${cfg.label}`} onClick={(e) => { e.stopPropagation(); onHelp(cfg.key); }}>
        ?
      </button>
    </span>
  );
}

// active: array of indicator keys currently drawn. onToggle(key) flips one. onHelp(key)
// opens the explainer modal for that indicator — not gated by `disabled`, since it's
// useful to read about an indicator before any candle data has loaded.
export default function IndicatorToggles({ active = [], onToggle, onHelp, disabled = false, iv = null }) {
  const render = (cfg) => (
    <Chip key={cfg.key} cfg={cfg} on={active.includes(cfg.key)} disabled={disabled} onToggle={onToggle} onHelp={onHelp} />
  );

  const ivLabel = iv == null ? null : iv.insufficient ? `IV Rank — ${iv.days}d history` : `IV Rank ${iv.ivRank ?? "—"} · P${iv.ivPercentile ?? "—"}`;

  return (
    <div className="chip-row" title={disabled ? "Not enough candle data for indicators yet" : undefined}>
      {PRICE.map(render)}
      <span className="chip-sep" />
      {PANES.map(render)}
      {ivLabel && (
        <>
          <span className="chip-sep" />
          <span className="iv-badge" style={iv.ivRank != null && iv.ivRank >= 50 ? { color: "#E8A33D", borderColor: "#E8A33D" } : undefined}>
            {ivLabel}
          </span>
          <button type="button" className="chip-help" title="About IV Rank / Percentile" onClick={() => onHelp("ivrank")}>
            ?
          </button>
        </>
      )}
    </div>
  );
}
