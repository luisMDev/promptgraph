import type { UsageLimits } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { mergeUsageLimits, UsageLimitsTracker } from "../src/daemon/usage-limits.js";
import { EventBus } from "../src/events/bus.js";
import { openDatabase, Store } from "../src/store/store.js";

const RESET_S = 2_000_000;
const RESET_MS = RESET_S * 1000;

describe("mergeUsageLimits (DESIGN §23.3)", () => {
  it("reads the unified windows of a rate_limit_event as captured from Claude Code 2.1.319", () => {
    const info = {
      status: "allowed",
      resetsAt: RESET_S,
      rateLimitType: "seven_day",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
      unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: RESET_S, status: "allowed" } },
    };
    expect(mergeUsageLimits(null, info, 5)).toEqual({
      status: "allowed",
      windows: { seven_day: { utilization: 0.1, resetsAt: RESET_MS, status: "allowed" } },
      overage: { status: "rejected", inUse: false },
      observedAt: 5,
    });
  });

  it("reads a single-window event (rateLimitType + utilization) and keeps the other windows until they reset", () => {
    const previous: UsageLimits = {
      status: "allowed",
      windows: {
        seven_day: { utilization: 0.1, resetsAt: RESET_MS, status: "allowed" },
        five_hour: { utilization: 0.2, resetsAt: 10, status: "allowed" },
      },
      overage: { status: "rejected", inUse: false },
      observedAt: 1,
    };
    const next = mergeUsageLimits(previous, { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: RESET_S }, 20);
    expect(next).toEqual({
      status: "allowed_warning",
      windows: {
        seven_day: { utilization: 0.1, resetsAt: RESET_MS, status: "allowed" },
        five_hour: { utilization: 0.9, resetsAt: RESET_MS, status: "allowed_warning" },
      },
      overage: { status: "rejected", inUse: false },
      observedAt: 20,
    });
    // An expired window is dropped when nothing replaces it.
    const later = mergeUsageLimits(previous, { status: "allowed" }, 20);
    expect(Object.keys(later!.windows)).toEqual(["seven_day"]);
  });

  it("ignores an observation without a status or a window", () => {
    expect(mergeUsageLimits(null, {}, 1)).toBeNull();
    expect(mergeUsageLimits(null, { rateLimitType: "five_hour" }, 1)).toBeNull();
  });
});

describe("UsageLimitsTracker", () => {
  it("persists observations in meta, emits usage:limits and reloads them on a new daemon start", () => {
    const store = new Store(openDatabase(":memory:"));
    const bus = new EventBus();
    const emitted: UsageLimits[] = [];
    bus.on("usage:limits", ({ limits }) => emitted.push(limits));
    const tracker = new UsageLimitsTracker(store, bus, () => 42);
    expect(tracker.current()).toBeNull();

    tracker.observe({});
    expect(emitted).toEqual([]);
    tracker.observe({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: RESET_S } } });
    expect(emitted).toHaveLength(1);
    expect(tracker.current()).toEqual(emitted[0]);
    expect(new UsageLimitsTracker(store, bus).current()).toEqual(emitted[0]);

    store.setMeta("usage_limits", "{not json");
    expect(new UsageLimitsTracker(store, bus).current()).toBeNull();
  });
});
