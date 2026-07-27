import { useState, useEffect } from "react";

// Subscribes to a CSS media query via matchMedia, re-rendering the caller whenever
// it flips. SSR-safe (falls back to `false` when `window` isn't available, though
// this app is client-only so that path never actually runs in practice).
export default function useMediaQuery(query) {
  const getMatch = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
