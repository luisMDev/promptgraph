import { useEffect } from "react";
import { create } from "zustand";
import { errorMessage } from "../api/rest";
import { DESKTOP_RELOGIN_AFTER_MS, DESKTOP_RELOGIN_COOLDOWN_MS, currentPagePath, type DesktopBridge } from "../lib/desktop";
import type { ConnectionState } from "../api/ws";

/** Why the desktop window asks the shell to sign it in again (DESIGN §13.5). */
export type ReloginReason = "signedOut" | "unreachable";

/**
 * Desktop window only: the `relogin` calls of this page. Each reason triggers at most one automatic call
 * per page load (for `unreachable`: per outage, since an open socket resets it), and none if one ran for it
 * within DESKTOP_RELOGIN_COOLDOWN_MS (remembered in sessionStorage, so it outlives the navigation a
 * successful call causes). After that the user retries with a button. sessionStorage is per origin, so the
 * record does not follow a relogin to another port; the sticky port bounds that (DESIGN §13.5).
 */
interface ReloginState {
  pending: boolean;
  error: string | null;
  /** The automatic attempt was made (or skipped) for this reason on this page (this outage, for unreachable). */
  tried: Record<ReloginReason, boolean>;
  /** Calls `relogin` with the current path; `auto` attempts run once per reason. */
  relogin(bridge: DesktopBridge, opts?: { auto?: ReloginReason }): Promise<void>;
}

const initial = { pending: false, error: null, tried: { signedOut: false, unreachable: false } };

/** sessionStorage key: when the last automatic attempt per reason started (ms since the epoch). */
export const AUTO_RELOGIN_KEY = "pg.relogin.auto";

type AutoAttempts = Partial<Record<ReloginReason, number>>;

function readAutoAttempts(): AutoAttempts {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(AUTO_RELOGIN_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as AutoAttempts) : {};
  } catch {
    return {};
  }
}

function writeAutoAttempts(attempts: AutoAttempts): void {
  try {
    window.sessionStorage.setItem(AUTO_RELOGIN_KEY, JSON.stringify(attempts));
  } catch {
    // No storage: the per-page guard still applies.
  }
}

function autoAttemptedRecently(reason: ReloginReason, now = Date.now()): boolean {
  const at = readAutoAttempts()[reason];
  return typeof at === "number" && now >= at && now - at < DESKTOP_RELOGIN_COOLDOWN_MS;
}

/** The connection is back: a later outage may relogin automatically again, on this page and the next. */
function forgetUnreachableAttempt(): void {
  if (useReloginStore.getState().tried.unreachable) useReloginStore.setState((s) => ({ tried: { ...s.tried, unreachable: false } }));
  const attempts = readAutoAttempts();
  if (attempts.unreachable === undefined) return;
  delete attempts.unreachable;
  writeAutoAttempts(attempts);
}

export const useReloginStore = create<ReloginState>()((set, get) => ({
  ...initial,
  async relogin(bridge, opts = {}) {
    if (!bridge.isDesktop || get().pending) return;
    if (opts.auto) {
      if (get().tried[opts.auto]) return;
      set({ tried: { ...get().tried, [opts.auto]: true } });
      if (autoAttemptedRecently(opts.auto)) return;
      writeAutoAttempts({ ...readAutoAttempts(), [opts.auto]: Date.now() });
    }
    set({ pending: true, error: null });
    try {
      await bridge.relogin(currentPagePath());
      set({ pending: false });
    } catch (err) {
      set({ pending: false, error: errorMessage(err) });
    }
  },
}));

/** Tests: forget every attempt, including the ones remembered across page loads. */
export function resetReloginStore(): void {
  useReloginStore.setState(initial);
  try {
    window.sessionStorage.removeItem(AUTO_RELOGIN_KEY);
  } catch {
    // No storage.
  }
}

/** Signed out in the desktop window: ask the shell to sign in again, once. */
export function useAutoReloginWhenSignedOut(bridge: DesktopBridge, signedOut: boolean): void {
  useEffect(() => {
    if (signedOut && bridge.isDesktop) void useReloginStore.getState().relogin(bridge, { auto: "signedOut" });
  }, [bridge, signedOut]);
}

/**
 * No connection for 10 s in the desktop window: ask the shell to sign in again, once (its CLI call starts
 * the daemon if needed and follows a new port). Any state but `open` counts, including a socket that never
 * opened after a page load (`connecting`). The countdown restarts whenever the socket opens, which also
 * resets the unreachable attempt, so the next outage relogins automatically again.
 *
 * The signed-out record is not cleared when the socket opens: a page whose socket opens but whose requests
 * keep failing with 401 would otherwise loop; it simply expires.
 */
export function useAutoReloginWhenUnreachable(bridge: DesktopBridge, connection: ConnectionState): void {
  const down = connection !== "open";
  useEffect(() => {
    if (!bridge.isDesktop) return;
    if (!down) {
      forgetUnreachableAttempt();
      return;
    }
    const timer = setTimeout(() => void useReloginStore.getState().relogin(bridge, { auto: "unreachable" }), DESKTOP_RELOGIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [bridge, down]);
}
