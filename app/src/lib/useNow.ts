import { useEffect, useState } from 'react';

/**
 * A once-a-second clock for a small leaf component. Keep it in the leaf that prints the time, not in a screen: every tick
 * re-renders whoever calls it.
 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Whether `expiresAtMs` has passed, worked out fresh on each render. While `active` it checks every second but only
 * re-renders once, when the time passes, so the screen is not re-rendered every second.
 */
export function useExpired(expiresAtMs: number | null, active: boolean): boolean {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!active || expiresAtMs === null || Date.now() >= expiresAtMs) return;
    const id = setInterval(() => {
      if (Date.now() < expiresAtMs) return;
      clearInterval(id);
      rerender((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtMs, active]);
  return expiresAtMs !== null && Date.now() >= expiresAtMs;
}
