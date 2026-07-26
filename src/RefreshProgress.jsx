import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 1200;
const TIMEOUT_MS = 90_000; // no local watcher (or headless MCP access) picking up the request in time
const AUTO_CLEAR_MS = 2500; // how long "done"/"cooldown" banners linger before disappearing

// Tracks POST /api/refresh's progress for one symbol: polls GET /api/refresh/status
// while a run is pending/running, stops once it lands on done/error, and auto-clears
// terminal states after a beat so the banner doesn't linger forever.
export function useRefreshStatusPoll(symbol, serverUrl) {
  const [status, setStatus] = useState(null);
  const pollRef = useRef(null);
  const clearTimerRef = useRef(null);

  const fetchOnce = useCallback(async () => {
    if (!symbol) return null;
    try {
      const res = await fetch(`${serverUrl}/api/refresh/status?symbol=${symbol}`);
      const data = await res.json().catch(() => null);
      return res.ok && data ? data : null;
    } catch {
      return null;
    }
  }, [symbol, serverUrl]);

  const clear = useCallback(() => setStatus(null), []);

  // seed from whatever the server already knows whenever the symbol changes, in case
  // a refresh requested earlier (or by the launchd watcher directly) is still in flight
  useEffect(() => {
    if (!symbol) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const data = await fetchOnce();
      if (!cancelled) setStatus(data && data.status !== "idle" ? data : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, fetchOnce]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (status && (status.status === "pending" || status.status === "running")) {
      pollRef.current = setInterval(async () => {
        const data = await fetchOnce();
        if (data) setStatus(data);
      }, POLL_MS);
    }
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, fetchOnce]);

  // auto-hide terminal states after a beat
  useEffect(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (status && (status.status === "done" || status.status === "cooldown")) {
      clearTimerRef.current = setTimeout(clear, AUTO_CLEAR_MS);
    }
    return () => clearTimeout(clearTimerRef.current);
  }, [status, clear]);

  return { status, setStatus, clear };
}

// status.status: "pending" | "running" | "done" | "error" | "cooldown"
export function RefreshProgressBanner({ status, onDismiss }) {
  if (!status) return null;
  const { status: state, step = 0, totalSteps = 1, message, requestedAt } = status;

  if (state === "error") {
    return (
      <div className="card refresh-banner refresh-banner-error">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="red" style={{ fontWeight: 600 }}>Refresh failed{status.symbol ? ` for ${status.symbol}` : ""}</span>
          <button className="ghost" onClick={onDismiss}>Dismiss</button>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{message || "Unknown error"}</div>
      </div>
    );
  }

  if (state === "cooldown") {
    return (
      <div className="card refresh-banner">
        <span className="muted" style={{ fontSize: 13 }}>{message}</span>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="card refresh-banner">
        <span className="green" style={{ fontSize: 13 }}>✓ {message || "Snapshot updated"}</span>
      </div>
    );
  }

  // pending / running
  const pct = Math.round((Math.min(step, totalSteps) / totalSteps) * 100);
  const timedOut = requestedAt && Date.now() - new Date(requestedAt).getTime() > TIMEOUT_MS;
  return (
    <div className="card refresh-banner">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 8 }}>
          <span className="spinner" />
          <span style={{ fontWeight: 600 }}>Refreshing{status.symbol ? ` ${status.symbol}` : ""}…</span>
        </span>
        <span className="muted mono" style={{ fontSize: 12 }}>{step}/{totalSteps}</span>
      </div>
      <div className="progress-track" style={{ marginTop: 8 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{message || "Working…"}</div>
      {timedOut && (
        <div className="amber" style={{ fontSize: 12, marginTop: 8 }}>
          Still waiting after {Math.round(TIMEOUT_MS / 1000)}s — is the local refresh watcher (launchd) installed and
          running? You can also just ask Claude directly to refresh {status.symbol}.
        </div>
      )}
    </div>
  );
}
