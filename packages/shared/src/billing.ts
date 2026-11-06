import { z } from "zod";
import { formatCostUsd } from "./pricing.js";

/**
 * How Claude Code is billed for the sessions promptgraph starts (DESIGN §23):
 * - `subscription`: a claude.ai login (Pro, Max, Team, Enterprise) or a `claude setup-token` token; usage counts
 *   against the plan's limits and the cost promptgraph shows is only an API-price equivalent.
 * - `api`: an Anthropic API key (`ANTHROPIC_API_KEY` or `apiKeyHelper`); every token is paid at API prices.
 * - `cloud`: Amazon Bedrock, Google Vertex AI or Microsoft Foundry; billed by the cloud provider.
 * - `unknown`: a bearer token (`ANTHROPIC_AUTH_TOKEN`, usually an LLM gateway) or a method this version does not know.
 * - `none`: not signed in.
 */
export const BillingModeSchema = z.enum(["subscription", "api", "cloud", "unknown", "none"]);
export type BillingMode = z.infer<typeof BillingModeSchema>;

/**
 * GET /api/repos/:repoId/claude-auth: what `claude auth status` reports in the repository's main checkout with the
 * daemon's environment (the environment and settings of its Claude sessions). Account identifiers (email,
 * organization) are never included.
 */
export const ClaudeAuthInfoSchema = z.object({
  billingMode: BillingModeSchema,
  /** `authMethod` as reported: `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`, `none`, … */
  authMethod: z.string(),
  /** `firstParty`, `bedrock`, `vertex`, `foundry`, … */
  apiProvider: z.string().nullable(),
  /** Where the API key comes from (`ANTHROPIC_API_KEY`, `apiKeyHelper`); null without one. */
  apiKeySource: z.string().nullable(),
  /** Subscription type (`pro`, `max`, `team`, `enterprise`); null when not on a subscription or not reported. */
  plan: z.string().nullable(),
  /** Plan tier (`max_20x`, `max_5x`, …); null when not reported. */
  planTier: z.string().nullable(),
  /**
   * An API key takes precedence over a stored claude.ai login: headless runs and the chat (`claude -p`) are billed
   * to the API although a subscription is available; interactive terminals ask once whether to use the key.
   */
  apiKeyOverridesLogin: z.boolean(),
  /** The check failed (claude not found, timeout, unreadable output); the other fields are then best effort. */
  error: z.string().nullable(),
  /** Epoch ms of the check. */
  checkedAt: z.number(),
});
export type ClaudeAuthInfo = z.infer<typeof ClaudeAuthInfoSchema>;

/** One subscription usage window (`five_hour`, `seven_day`, `seven_day_opus`, …). */
export const UsageWindowSchema = z.object({
  /** Fraction of the window used, 0..1. */
  utilization: z.number(),
  /** Epoch ms when the window resets; null when not reported. */
  resetsAt: z.number().nullable(),
  /** `allowed`, `allowed_warning`, `rejected`; null when not reported. */
  status: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/**
 * The last subscription usage limits Claude Code reported (`rate_limit_event` of the chat's stream-json, §23.3).
 * Account-wide, so kept per daemon; persisted so it survives a restart. Observations, not a live query: `observedAt`
 * says how old they are.
 */
export const UsageLimitsSchema = z.object({
  /** Overall status: `allowed`, `allowed_warning` (close to a limit) or `rejected` (limit reached). */
  status: z.string(),
  /** Window name → window. Windows whose reset time has passed are dropped. */
  windows: z.record(z.string(), UsageWindowSchema),
  /** Extra usage beyond the plan: its status (`allowed`, `rejected`, …) and whether it is being used now. */
  overage: z.object({ status: z.string().nullable(), inUse: z.boolean() }).nullable(),
  /** Epoch ms of the last observation. */
  observedAt: z.number(),
});
export type UsageLimits = z.infer<typeof UsageLimitsSchema>;

/** GET /api/daemon/usage-limits; also the body of the `usage:limits` WebSocket message. */
export const UsageLimitsResponseSchema = z.object({ limits: UsageLimitsSchema.nullable() });
export type UsageLimitsResponse = z.infer<typeof UsageLimitsResponseSchema>;

/** Display order of the known windows; unknown ones follow in name order. */
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  overage: "Extra usage",
};

/** Windows of `limits` in display order, without those whose reset time is before `now`. */
export function usageWindowsOf(limits: UsageLimits, now: number): Array<{ name: string; label: string; window: UsageWindow }> {
  const rank = (name: string) => {
    const i = WINDOW_ORDER.indexOf(name);
    return i === -1 ? WINDOW_ORDER.length : i;
  };
  return Object.entries(limits.windows)
    .filter(([, w]) => w.resetsAt === null || w.resetsAt > now)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, window]) => ({ name, label: WINDOW_LABELS[name] ?? name.replace(/_/g, " "), window }));
}

/** "Max 20x", "Pro", "Team"; null when there is no plan. */
export function formatPlan(info: Pick<ClaudeAuthInfo, "plan" | "planTier">): string | null {
  if (!info.plan) return null;
  const name = info.plan.charAt(0).toUpperCase() + info.plan.slice(1);
  const multiplier = info.planTier?.match(/(\d+x)$/i)?.[1];
  return multiplier ? `${name} ${multiplier.toLowerCase()}` : name;
}

/** Short label of a billing mode, e.g. for a badge. */
export function billingModeLabel(info: Pick<ClaudeAuthInfo, "billingMode" | "plan" | "planTier" | "apiProvider">): string {
  switch (info.billingMode) {
    case "subscription":
      return formatPlan(info) ?? "Subscription";
    case "api":
      return "API key";
    case "cloud":
      return CLOUD_PROVIDERS[info.apiProvider ?? ""] ?? "Cloud provider";
    case "unknown":
      return "Custom auth";
    case "none":
      return "Signed out";
  }
}

const CLOUD_PROVIDERS: Record<string, string> = { bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry" };

/**
 * How to show an estimated cost (list API prices, `pricing.ts`) for a billing mode. On a subscription it is not money spent,
 * so it reads as an equivalent ("≈$0.42"); with an API key it is what the API bills. Unknown mode (runs recorded
 * before §23, or an unknown method): the plain estimate.
 */
export function costLabel(usd: number, mode: BillingMode | null | undefined): { text: string; title: string } {
  const amount = formatCostUsd(usd);
  switch (mode) {
    case "subscription":
      return { text: `≈${amount}`, title: `${amount} at API prices. Included in your Claude subscription: not billed, it counts against your plan's usage limits` };
    case "api":
      return { text: amount, title: `${amount} estimated at API list prices, billed to your Anthropic API key` };
    case "cloud":
      return { text: amount, title: `${amount} estimated at Anthropic API list prices; your cloud provider bills its own prices` };
    default:
      return { text: amount, title: `${amount} estimated at Anthropic API list prices` };
  }
}
