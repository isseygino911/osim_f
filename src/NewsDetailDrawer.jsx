import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.jsx";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:8787";
const sentClass = (s) => (s === "bullish" ? "green" : s === "bearish" ? "red" : "amber");

export default function NewsDetailDrawer({ item, symbol, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // hold the last non-null item so content stays visible during the exit animation
  const itemRef = useRef(item);
  if (item) itemRef.current = item;
  const display = item ?? itemRef.current;

  useEffect(() => {
    if (!item) return;
    setDetail(null);
    setError(null);
    setLoading(true);
    const params = new URLSearchParams({
      symbol,
      link: item.link || "",
      title: item.title || "",
      summary: item.summary || "",
    });
    fetch(`${SERVER_URL}/api/news/detail?${params}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
        return data;
      })
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [item, symbol]);

  useEffect(() => {
    if (!item) return;
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, onClose]);

  if (!display) return null;

  return (
    <Modal open={!!item} onClose={onClose} className="help">
      <div className="section-title">
        <a href={display.link} target="_blank" rel="noreferrer" style={{ color: "#E7E9EA" }}>
          {display.title}
        </a>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{display.source}</div>

      {loading && <p className="muted">Reading full article…</p>}
      {error && <p className="muted">Couldn't analyze this article ({error}). Try the original link above.</p>}

      {detail && (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <span className={`mono ${sentClass(detail.direction)}`} style={{ fontSize: 13, fontWeight: 600 }}>
              {detail.direction.toUpperCase()}
            </span>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {"●".repeat(detail.magnitude)}{"○".repeat(3 - detail.magnitude)}
            </span>
          </div>

          <div className="section-title" style={{ marginTop: 12 }}>Key points</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {detail.keyPoints.map((point, i) => (
              <li key={i} style={{ fontSize: 13, marginBottom: 4 }}>{point}</li>
            ))}
          </ul>

          <div className="section-title" style={{ marginTop: 12 }}>Why {detail.direction} for {symbol}</div>
          <p style={{ fontSize: 13 }}>{detail.reason}</p>
        </>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
