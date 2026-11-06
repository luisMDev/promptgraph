import { UsageLimitsSchema, type UsageLimits, type UsageWindow } from "@promptgraph/shared";
import type { RateLimitInfo } from "../chat/protocol.js";
import type { EventBus } from "../events/bus.js";
import type { Store } from "../store/store.js";

const META_KEY = "usage_limits";

const secondsToMs = (s: number | undefined) => (s === undefined ? null : s * 1000);

/**
 * Merges one observation into the previous limits: windows it reports replace the old ones, the others are kept
 * until their reset time passes. Returns null when the observation carries nothing usable.
 */
export function mergeUsageLimits(previous: UsageLimits | null, info: RateLimitInfo, now: number): UsageLimits | null {
  const windows: Record<string, UsageWindow> = {};
  for (const [name, w] of Object.entries(previous?.windows ?? {})) {
    if (w.resetsAt === null || w.resetsAt > now) windows[name] = w;
  }
  let reported = false;
  for (const [name, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w.utilization === undefined) continue;
    windows[name] = { utilization: w.utilization, resetsAt: secondsToMs(w.resetsAt), status: w.status ?? null };
    reported = true;
  }
  if (info.rateLimitType && info.utilization !== undefined && !info.unifiedWindows?.[info.rateLimitType]) {
    windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: secondsToMs(info.resetsAt), status: info.status ?? null };
    reported = true;
  }
  if (!reported && info.status === undefined) return null;
  const overage =
    info.overageStatus !== undefined || info.isUsingOverage !== undefined
      ? { status: info.overageStatus ?? null, inUse: info.isUsingOverage ?? false }
      : (previous?.overage ?? null);
  return { status: info.status ?? previous?.status ?? "allowed", windows, overage, observedAt: now };
}

/** The daemon's last observed usage limits (account-wide), persisted in `meta` and broadcast as `usage:limits`. */
export class UsageLimitsTracker {
  private limits: UsageLimits | null;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {
    const saved = store.getMeta(META_KEY);
    let parsed: UsageLimits | null = null;
    try {
      parsed = saved ? UsageLimitsSchema.parse(JSON.parse(saved)) : null;
    } catch {
      // A value written by another version: start over.
    }
    this.limits = parsed;
  }

  current(): UsageLimits | null {
    return this.limits;
  }

  /** A `rate_limit_info` from a Claude process. Unusable observations are ignored. */
  observe(info: RateLimitInfo): void {
    const next = mergeUsageLimits(this.limits, info, this.now());
    if (!next) return;
    this.limits = next;
    this.store.setMeta(META_KEY, JSON.stringify(next));
    this.bus.emit("usage:limits", { limits: next });
  }
}
