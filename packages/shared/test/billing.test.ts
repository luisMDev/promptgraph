import { describe, expect, it } from "vitest";
import { billingModeLabel, costLabel, formatPlan, usageWindowsOf, type UsageLimits } from "../src/index.js";

describe("billing (DESIGN §23)", () => {
  it("formats plans and badge labels", () => {
    expect(formatPlan({ plan: "max", planTier: "max_20x" })).toBe("Max 20x");
    expect(formatPlan({ plan: "pro", planTier: null })).toBe("Pro");
    expect(formatPlan({ plan: null, planTier: "max_5x" })).toBeNull();
    const base = { plan: null, planTier: null, apiProvider: null };
    expect(billingModeLabel({ ...base, billingMode: "subscription" })).toBe("Subscription");
    expect(billingModeLabel({ ...base, billingMode: "subscription", plan: "team" })).toBe("Team");
    expect(billingModeLabel({ ...base, billingMode: "api" })).toBe("API key");
    expect(billingModeLabel({ ...base, billingMode: "cloud", apiProvider: "bedrock" })).toBe("Amazon Bedrock");
    expect(billingModeLabel({ ...base, billingMode: "cloud", apiProvider: "other" })).toBe("Cloud provider");
    expect(billingModeLabel({ ...base, billingMode: "none" })).toBe("Signed out");
  });

  it("shows a subscription cost as an API-price equivalent and an API cost as billed", () => {
    expect(costLabel(0.42, "subscription")).toEqual({ text: "≈$0.42", title: expect.stringContaining("Included in your Claude subscription") });
    expect(costLabel(0.42, "api")).toEqual({ text: "$0.42", title: expect.stringContaining("billed to your Anthropic API key") });
    expect(costLabel(0.004, null)).toEqual({ text: "<$0.01", title: "<$0.01 estimated at Anthropic API list prices" });
    expect(costLabel(0, "cloud").text).toBe("$0");
  });

  it("lists usage windows in display order without expired ones", () => {
    const limits: UsageLimits = {
      status: "allowed",
      windows: {
        custom_window: { utilization: 0.5, resetsAt: null, status: null },
        seven_day: { utilization: 0.1, resetsAt: 2000, status: "allowed" },
        five_hour: { utilization: 0.3, resetsAt: 500, status: "allowed" },
        seven_day_opus: { utilization: 0.2, resetsAt: 3000, status: null },
      },
      overage: null,
      observedAt: 1,
    };
    expect(usageWindowsOf(limits, 100).map((w) => [w.name, w.label])).toEqual([
      ["five_hour", "5-hour"],
      ["seven_day", "Weekly"],
      ["seven_day_opus", "Weekly (Opus)"],
      ["custom_window", "custom window"],
    ]);
    expect(usageWindowsOf(limits, 1000).map((w) => w.name)).toEqual(["seven_day", "seven_day_opus", "custom_window"]);
  });
});
