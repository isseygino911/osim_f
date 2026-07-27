import { useEffect, useRef, useState } from "react";
import { INDICATORS } from "./indicatorConfig.js";

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
// interval: VWAP is a session-based indicator and degenerates to a no-op on daily bars
// (see indicators.service.js), so its chip is hidden entirely when interval === "1d".
export default function IndicatorToggles({ active = [], onToggle, onHelp, disabled = false, iv = null, interval = "1d" }) {
  const price = INDICATORS.filter((c) => c.pane === "price" && (c.key !== "vwap" || interval !== "1d"));
  const render = (cfg) => (
    <Chip key={cfg.key} cfg={cfg} on={active.includes(cfg.key)} disabled={disabled} onToggle={onToggle} onHelp={onHelp} />
  );

  const ivLabel = iv == null ? null : iv.insufficient ? `IV Rank — ${iv.days}d history` : `IV Rank ${iv.ivRank ?? "—"} · P${iv.ivPercentile ?? "—"}`;

  return (
    <div className="chip-row" title={disabled ? "Not enough candle data for indicators yet" : undefined}>
      {price.map(render)}
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

// Shared dropdown shell: a ghost button that toggles a floating panel below it,
// closing on outside click. Used by both IndicatorMenu and ChartActionsMenu so the
// Price module header can host several menus side-by-side without each one
// reimplementing open/close/outside-click handling.
export function DropdownMenu({ label, badge, panelClassName = "indicator-menu-panel", panelWidth, align = "left", disabledTitle, children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="indicator-menu" ref={rootRef} title={disabledTitle}>
      <button
        type="button"
        className={`ghost indicator-menu-btn ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {label}{badge != null && <span className="indicator-menu-count">{badge}</span>}
        <span className="indicator-menu-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          className={panelClassName}
          style={{
            left: align === "left" ? 0 : "auto",
            right: align === "right" ? 0 : "auto",
            ...(panelWidth ? { width: panelWidth } : null),
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Same toggles as IndicatorToggles, but tucked behind a single "Indicators" button
// so the Price module header doesn't have to permanently host 15 chips worth of
// horizontal space. Grouped into "Overlays" (drawn on the price pane) and
// "Oscillators" (own sub-pane) since that's the same split the chart itself uses.
export function IndicatorMenu({ active = [], onToggle, onHelp, disabled = false, iv = null, interval = "1d", align = "left" }) {
  const price = INDICATORS.filter((c) => c.pane === "price" && (c.key !== "vwap" || interval !== "1d"));
  const render = (cfg) => (
    <Chip key={cfg.key} cfg={cfg} on={active.includes(cfg.key)} disabled={disabled} onToggle={onToggle} onHelp={onHelp} />
  );

  const ivLabel = iv == null ? null : iv.insufficient ? `IV Rank — ${iv.days}d history` : `IV Rank ${iv.ivRank ?? "—"} · P${iv.ivPercentile ?? "—"}`;

  return (
    <DropdownMenu
      label="Indicators"
      badge={active.length > 0 ? active.length : null}
      disabledTitle={disabled ? "Not enough candle data for indicators yet" : undefined}
      panelWidth={420}
      align={align}
    >
      <div className="indicator-menu-group">
        <div className="indicator-menu-group-title">Overlays</div>
        <div className="chip-row">{price.map(render)}</div>
      </div>
      <div className="indicator-menu-group">
        <div className="indicator-menu-group-title">Oscillators</div>
        <div className="chip-row">{PANES.map(render)}</div>
      </div>
      {ivLabel && (
        <div className="indicator-menu-group">
          <div className="indicator-menu-group-title">Volatility</div>
          <div className="chip-row">
            <span className="iv-badge" style={iv.ivRank != null && iv.ivRank >= 50 ? { color: "#E8A33D", borderColor: "#E8A33D" } : undefined}>
              {ivLabel}
            </span>
            <button type="button" className="chip-help" title="About IV Rank / Percentile" onClick={() => onHelp("ivrank")}>
              ?
            </button>
          </div>
        </div>
      )}
    </DropdownMenu>
  );
}
