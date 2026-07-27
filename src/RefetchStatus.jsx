import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";

// Ticks once per second so callers can derive a "next refetch in Ns" countdown
// from a fixed anchor timestamp + interval, without each panel running its own timer.
export function useCountdown(intervalMs, anchorAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!intervalMs || !anchorAt) return null;
  return Math.max(0, Math.round((anchorAt + intervalMs - now) / 1000));
}

// "7/25 11:00pm" in the browser's own local time zone — no fixed refresh cadence
// to count down to anymore, so this replaces the old "next in Ns" countdown.
function formatUpdatedAt(ms) {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${h}:${min}${ampm}`;
}

// status: "success" | "error" | null (null = no fetch has completed yet)
export function RefetchStatus({ secondsLeft, status, updatedAt }) {
  if (status == null && secondsLeft == null && updatedAt == null) return null;
  return (
    <span className="row mono muted" style={{ fontSize: 11, gap: 4 }}>
      <AnimatePresence mode="wait">
        {status && (
          <motion.span
            key={status}
            className={status === "success" ? "green" : "red"}
            title={status === "success" ? "Last refetch succeeded" : "Last refetch failed"}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ display: "inline-block" }}
          >
            {status === "success" ? "✓" : "✗"}
          </motion.span>
        )}
      </AnimatePresence>
      {secondsLeft != null && <span>next in {secondsLeft}s</span>}
      {updatedAt != null && <span>updated: {formatUpdatedAt(updatedAt)}</span>}
    </span>
  );
}
