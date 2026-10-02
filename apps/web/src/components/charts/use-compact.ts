import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 639px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/**
 * Phone-width charts (#49): fewer ticks, narrower axes, no legend; values come from a tap (the
 * tooltip follows touch). False on the server, so the first paint matches the desktop markup.
 */
export function useCompactChart(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}

/** Axis props for the current width. */
export function compactAxis(compact: boolean) {
  return { x: { minTickGap: compact ? 40 : 16 }, y: { width: compact ? 44 : 64, tickCount: compact ? 4 : 5 } };
}
