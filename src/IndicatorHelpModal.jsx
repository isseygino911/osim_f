import { useEffect, useRef } from "react";
import { HELP } from "./indicatorHelp.jsx";
import { Modal } from "./Modal.jsx";

export default function IndicatorHelpModal({ helpKey, onClose }) {
  const entry = helpKey ? HELP[helpKey] : null;
  // hold the last non-null entry so content stays visible during the exit animation
  const entryRef = useRef(entry);
  if (entry) entryRef.current = entry;
  const display = entry ?? entryRef.current;

  useEffect(() => {
    if (!entry) return;
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entry, onClose]);

  if (!display) return null;
  const { title, what, read, how, usage, Diagram } = display;

  return (
    <Modal open={!!entry} onClose={onClose} className="help">
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
    </Modal>
  );
}
