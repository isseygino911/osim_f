import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const POLL_MS = 800;
const AUTO_CLEAR_MS = 2500; // how long "done" lingers before disappearing
const ALL_POLL_MS = 3000; // the global list refreshes less aggressively than the per-symbol indicator

// Tracks POST /api/refresh's status for one symbol: polls GET /api/refresh/status
// while a run is in flight, stops once it lands on done/error, and auto-clears "done"
// after a beat so the indicator doesn't linger. Tradier refreshes finish in a few
// seconds, so this is a lightweight pill, not a progress bar.
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
  // a refresh requested just before navigating here is still in flight
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
    if (status?.status === "running") {
      pollRef.current = setInterval(async () => {
        const data = await fetchOnce();
        if (data) setStatus(data);
      }, POLL_MS);
    }
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, fetchOnce]);

  useEffect(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (status?.status === "done") {
      clearTimerRef.current = setTimeout(clear, AUTO_CLEAR_MS);
    }
    return () => clearTimeout(clearTimerRef.current);
  }, [status, clear]);

  return { status, setStatus, clear };
}

const bannerMotionProps = {
  initial: { opacity: 0, y: -8, height: 0 },
  animate: { opacity: 1, y: 0, height: "auto" },
  exit: { opacity: 0, y: -8, height: 0 },
  transition: { duration: 0.2, ease: "easeOut" },
};

// status.status: "running" | "done" | "error" | "cooldown"
// compact (mobile only): collapses to a single-line 28px strip; tapping it toggles an
// inline-expanded state showing the same content as the full (non-compact) banner.
export function RefreshProgressBanner({ status, onDismiss, compact = false }) {
  const { status: state, message, symbol } = status || {};
  const [expanded, setExpanded] = useState(false);

  if (compact) {
    const compactLabel =
      state === "error" ? `Refresh failed${symbol ? ` (${symbol})` : ""}` :
      state === "cooldown" ? message :
      state === "done" ? `✓ ${message || "Snapshot updated"}` :
      state === "running" ? `Refreshing${symbol ? ` ${symbol}` : ""}…` : null;
    return (
      <AnimatePresence>
        {status && (
          <motion.div {...bannerMotionProps} style={{ overflow: "hidden" }}>
            <button
              type="button"
              className="ghost refresh-strip"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
            >
              {state === "running" && <span className="spinner" />}
              <span className={`refresh-strip-label ${state === "error" ? "red" : state === "done" ? "green" : "muted"}`}>
                {compactLabel}
              </span>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
            </button>
            {expanded && (
              <div className="card refresh-banner" style={{ marginTop: 0, borderRadius: "0 0 8px 8px" }}>
                {state === "error" && (
                  <>
                    <div className="muted" style={{ fontSize: 13 }}>{message || "Unknown error"}</div>
                    <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
                      <button className="ghost" onClick={onDismiss}>Dismiss</button>
                    </div>
                  </>
                )}
                {state !== "error" && <div className="muted" style={{ fontSize: 13 }}>{message || compactLabel}</div>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {status && (
        <motion.div {...bannerMotionProps} style={{ overflow: "hidden" }}>
          {state === "error" && (
            <div className="card refresh-banner refresh-banner-error">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="red" style={{ fontWeight: 600 }}>Refresh failed{symbol ? ` for ${symbol}` : ""}</span>
                <button className="ghost" onClick={onDismiss}>Dismiss</button>
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{message || "Unknown error"}</div>
            </div>
          )}
          {state === "cooldown" && (
            <div className="card refresh-banner">
              <span className="muted" style={{ fontSize: 13 }}>{message}</span>
            </div>
          )}
          {state === "done" && (
            <div className="card refresh-banner">
              <span className="green" style={{ fontSize: 13 }}>✓ {message || "Snapshot updated"}</span>
            </div>
          )}
          {state === "running" && (
            <div className="card refresh-banner">
              <span className="row" style={{ gap: 8 }}>
                <span className="spinner" />
                <span style={{ fontWeight: 600 }}>Refreshing{symbol ? ` ${symbol}` : ""}…</span>
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Polls GET /api/refresh/all for every symbol currently refreshing, not just whichever
// one is active in the client — so a refresh for a symbol you've navigated away from
// still shows up.
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

  return { refreshes };
}

// Cross-symbol list of every refresh currently running.
export function ActiveRefreshesList({ serverUrl }) {
  const { refreshes } = useAllRefreshes(serverUrl);

  return (
    <AnimatePresence>
      {refreshes.length > 0 && (
        <motion.div className="card" style={{ marginBottom: 16, overflow: "hidden" }} {...bannerMotionProps}>
          <div className="section-title" style={{ marginBottom: 8 }}>Refreshing ({refreshes.length})</div>
          <AnimatePresence initial={false}>
            {refreshes.map((r) => (
              <motion.div
                key={r.symbol}
                className="row"
                style={{ justifyContent: "space-between", padding: "4px 0" }}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                <span className="row" style={{ gap: 8 }}>
                  <span className="spinner" />
                  <span style={{ fontWeight: 600 }}>{r.symbol}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{r.message}</span>
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
