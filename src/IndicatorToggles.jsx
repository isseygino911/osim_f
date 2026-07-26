import { INDICATORS } from "./indicatorConfig.js";

const PRICE = INDICATORS.filter((c) => c.pane === "price");
const PANES = INDICATORS.filter((c) => c.pane !== "price");

function Chip({ cfg, on, disabled, onToggle }) {
  return (
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
  );
}

// active: array of indicator keys currently drawn. onToggle(key) flips one.
export default function IndicatorToggles({ active = [], onToggle, disabled = false }) {
  const render = (cfg) => (
    <Chip key={cfg.key} cfg={cfg} on={active.includes(cfg.key)} disabled={disabled} onToggle={onToggle} />
  );

  return (
    <div className="chip-row" title={disabled ? "Not enough candle data for indicators yet" : undefined}>
      {PRICE.map(render)}
      <span className="chip-sep" />
      {PANES.map(render)}
    </div>
  );
}
