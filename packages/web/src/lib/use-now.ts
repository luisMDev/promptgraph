import { useSyncExternalStore } from "react";

/** One shared 1 s ticker for elapsed-time displays; only ticks while something is subscribed. */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, re-rendering every second while `active`. */
export function useNow(active = true): number {
  return useSyncExternalStore(active ? subscribe : noopSubscribe, () => now);
}

function noopSubscribe(): () => void {
  return () => undefined;
}
