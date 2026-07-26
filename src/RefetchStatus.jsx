import { useState, useEffect } from "react";

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
      {status === "success" && <span className="green" title="Last refetch succeeded">✓</span>}
      {status === "error" && <span className="red" title="Last refetch failed">✗</span>}
      {secondsLeft != null && <span>next in {secondsLeft}s</span>}
    </span>
  );
}
