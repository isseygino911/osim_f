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

// status: "success" | "error" | null (null = no fetch has completed yet)
export function RefetchStatus({ secondsLeft, status }) {
  if (status == null && secondsLeft == null) return null;
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
    </span>
  );
}
