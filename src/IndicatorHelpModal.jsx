import { useEffect } from "react";
import { HELP } from "./indicatorHelp.jsx";

export default function IndicatorHelpModal({ helpKey, onClose }) {
  const entry = helpKey ? HELP[helpKey] : null;

  useEffect(() => {
    if (!entry) return;
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entry, onClose]);

  if (!entry) return null;
  const { title, what, read, how, usage, Diagram } = entry;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <div className="section-title">{title}</div>
        <Diagram />
        <div className="section-title" style={{ marginTop: 12 }}>What it measures</div>
        <p>{what}</p>
        <div className="section-title">How to read it</div>
        <p>{read}</p>
        <div className="section-title">How it's computed</div>
        <p>{how}</p>
        <div className="section-title">How options traders use it</div>
        <p>{usage}</p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
