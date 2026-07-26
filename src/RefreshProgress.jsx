import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 1200;
const TIMEOUT_MS = 90_000; // no local watcher (or headless MCP access) picking up the request in time
const AUTO_CLEAR_MS = 2500; // how long "done"/"cooldown" banners linger before disappearing
const ALL_POLL_MS = 3000; // the global list refreshes less aggressively than the per-symbol banner

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
export function RefreshProgressBanner({ status, onDismiss, onCancel }) {
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
  const log = Array.isArray(status.log) ? status.log : [];
  return (
    <div className="card refresh-banner">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 8 }}>
          <span className="spinner" />
          <span style={{ fontWeight: 600 }}>Refreshing{status.symbol ? ` ${status.symbol}` : ""}…</span>
        </span>
        <span className="row" style={{ gap: 10 }}>
          <span className="muted mono" style={{ fontSize: 12 }}>{step}/{totalSteps}</span>
          {state === "pending" && onCancel && (
            <button className="ghost" style={{ fontSize: 12, padding: "2px 8px" }} title="Cancel before the watcher picks it up" onClick={onCancel}>
              Cancel
            </button>
          )}
        </span>
      </div>
      <div className="progress-track" style={{ marginTop: 8 }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{message || "Working…"}</div>
      {log.length > 0 && <RefreshStepLog log={log} />}
      {timedOut && (
        <div className="amber" style={{ fontSize: 12, marginTop: 8 }}>
          Still waiting after {Math.round(TIMEOUT_MS / 1000)}s — is the local refresh watcher (launchd) installed and
          running? You can also just ask Claude directly to refresh {status.symbol}.
        </div>
      )}
    </div>
  );
}

// Polls GET /api/refresh/all for every symbol with a pending/running refresh, not just
// whichever one is currently active in the client — so a job for a symbol you've
// navigated away from still shows up (and can be cleared) instead of running invisibly.
export function useAllRefreshes(serverUrl) {
  const [refreshes, setRefreshes] = useState([]);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch(`${serverUrl}/api/refresh/all`);
      const data = await res.json().catch(() => null);
      if (res.ok && data) setRefreshes(data.refreshes ?? []);
    } catch {
      // leave the last known list in place on a transient network error
    }
  }, [serverUrl]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, ALL_POLL_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  const remove = useCallback(
    async (symbol) => {
      try {
        await fetch(`${serverUrl}/api/refresh?symbol=${symbol}&force=1`, { method: "DELETE" });
      } catch {
        // best-effort — the next poll will just show it again if the delete failed
      }
      setRefreshes((cur) => cur.filter((r) => r.symbol !== symbol)); // optimistic
      fetchAll();
    },
    [serverUrl, fetchAll]
  );

  return { refreshes, remove };
}

// Cross-symbol list of every refresh currently pending/running, each with an X to
// clear its tracking. A "running" row's X can't stop the actual headless process (no
// PID is tracked anywhere) — it only clears the status, same limitation as Cancel above.
export function ActiveRefreshesList({ serverUrl }) {
  const { refreshes, remove } = useAllRefreshes(serverUrl);
  if (refreshes.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>Refreshing ({refreshes.length})</div>
      {refreshes.map((r) => (
        <div key={r.symbol} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
          <span className="row" style={{ gap: 8 }}>
            <span className={r.status === "running" ? "spinner" : undefined} style={r.status === "pending" ? { opacity: 0.4 } : undefined} />
            <span style={{ fontWeight: 600 }}>{r.symbol}</span>
            <span className="muted" style={{ fontSize: 12 }}>{r.status} · {r.step}/{r.totalSteps}</span>
            <span className="muted" style={{ fontSize: 12 }}>{r.message}</span>
          </span>
          <button
            className="ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            title={r.status === "running" ? "Clear tracking (can't stop the background fetch already in progress)" : "Cancel before the watcher picks it up"}
            onClick={() => remove(r.symbol)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// Every /api/refresh/progress call the skill makes (one per real Robinhood call/batch)
// lands here as its own line, so the user can watch the actual pipeline run live instead
// of a single message getting overwritten in place.
function RefreshStepLog({ log }) {
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <div ref={listRef} className="refresh-log mono" style={{ marginTop: 10 }}>
      {log.map((entry, i) => {
        const isLast = i === log.length - 1;
        return (
          <div key={`${entry.step}-${i}`} className="refresh-log-line" style={{ opacity: isLast ? 1 : 0.55 }}>
            <span className="muted" style={{ marginRight: 6 }}>{isLast ? "›" : "✓"}</span>
            {entry.message}
          </div>
        );
      })}
    </div>
  );
}
