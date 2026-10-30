import type { Store } from "../store/store.js";

/**
 * §8.6 at startup: node runs in running/idle/waiting_* (and ready) → interrupted (ready → pending);
 * their runs (status running) → paused, error "Server stopped during the run". Returns affected run ids.
 */
export function markInterrupted(store: Store, now?: number): string[] {
  throw new Error("not implemented");
}
