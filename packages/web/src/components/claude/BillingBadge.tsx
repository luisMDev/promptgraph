import { billingModeLabel, usageWindowsOf, type ClaudeAuthInfo, type UsageLimits } from "@promptgraph/shared";
import { AlertTriangleIcon, CloudIcon, CreditCardIcon, GaugeIcon, KeyRoundIcon, RefreshCwIcon, UserXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { formatDateTime, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useDaemonStore } from "../../store/daemon-store";
import { getRepoCache, useRepoCache } from "../../store/repo-cache";
import { useView } from "../../store/view/context";
import { Button } from "../common/ui";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** A window above this fraction is shown as a warning. */
const WARN_UTILIZATION = 0.8;

/**
 * Header badge (DESIGN §23.4): how Claude is billed in this repository (subscription plan, API key, cloud) and, on a
 * subscription, the last observed usage limits. Opening it re-checks `claude auth status`.
 */
export function BillingBadge() {
  const { repoId } = useView();
  const auth = useRepoCache(repoId, (s) => s.claudeAuth);
  const limits = useDaemonStore((s) => s.usageLimits);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void getRepoCache(repoId).getState().loadClaudeAuth();
    void useDaemonStore.getState().loadUsageLimits();
  }, [repoId]);

  const refresh = async () => {
    setRefreshing(true);
    await getRepoCache(repoId).getState().loadClaudeAuth(true);
    setRefreshing(false);
  };

  if (!auth) return null;
  const warn = needsAttention(auth, limits);
  const label = billingModeLabel(auth);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Claude billing: ${label}`}
          className={cn("gap-1.5", warn ? "text-amber-700" : "text-muted-foreground")}
        >
          {warn ? <AlertTriangleIcon /> : <ModeIcon auth={auth} />}
          <span className="hidden lg:inline">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        <div className="flex items-start gap-2">
          <ModeIcon auth={auth} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{label}</div>
            <p className="text-xs text-muted-foreground">{modeDescription(auth)}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Check again" title="Check again" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
        {auth.apiKeyOverridesLogin && (
          <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700">
            You are signed in to claude.ai, but <code>{auth.apiKeySource ?? "an API key"}</code> is set in promptgraph's environment.
            Chat and generated messages use the key and are billed to the API; node terminals ask once whether to use it. To use your
            subscription, remove the key from your shell profile and restart promptgraph (<code>promptgraph stop</code>).
          </p>
        )}
        {auth.error && <p className="text-xs text-destructive">Could not check: {auth.error}</p>}
        {auth.billingMode === "subscription" && <UsageLimitsView limits={limits} />}
      </PopoverContent>
    </Popover>
  );
}

function ModeIcon({ auth }: { auth: ClaudeAuthInfo }) {
  const className = "size-4 shrink-0";
  switch (auth.billingMode) {
    case "subscription":
      return <GaugeIcon className={className} />;
    case "api":
      return <KeyRoundIcon className={className} />;
    case "cloud":
      return <CloudIcon className={className} />;
    case "none":
      return <UserXIcon className={className} />;
    default:
      return <CreditCardIcon className={className} />;
  }
}

function modeDescription(auth: ClaudeAuthInfo): string {
  switch (auth.billingMode) {
    case "subscription":
      return "Claude subscription: runs count against your plan's usage limits. Costs are shown as an API-price equivalent (≈).";
    case "api":
      return `Anthropic API key (${auth.apiKeySource ?? auth.authMethod}): every token is billed at API prices.`;
    case "cloud":
      return "Billed by your cloud provider. Costs are estimated at Anthropic list prices.";
    case "none":
      return "Claude Code is not signed in: run `claude` in a terminal and sign in.";
    default:
      return `Authenticated with ${auth.authMethod}: billing depends on that token (often an LLM gateway).`;
  }
}

function needsAttention(auth: ClaudeAuthInfo, limits: UsageLimits | null): boolean {
  if (auth.apiKeyOverridesLogin || auth.billingMode === "none") return true;
  if (auth.billingMode !== "subscription" || !limits) return false;
  return limits.status !== "allowed" || Object.values(limits.windows).some((w) => w.utilization >= WARN_UTILIZATION);
}

/** The last observed usage windows; observations, so their age is shown. */
export function UsageLimitsView({ limits }: { limits: UsageLimits | null }) {
  const now = useNow(limits !== null);
  const windows = limits ? usageWindowsOf(limits, now) : [];
  if (!limits || windows.length === 0) {
    return <p className="text-xs text-muted-foreground">Usage limits appear after the chat's first reply.</p>;
  }
  return (
    <div className="space-y-2">
      {limits.status === "rejected" && <p className="text-xs font-medium text-destructive">Usage limit reached: Claude will refuse new turns until it resets.</p>}
      {windows.map(({ name, label, window }) => {
        const pct = Math.min(100, Math.round(window.utilization * 100));
        const high = window.utilization >= WARN_UTILIZATION || window.status === "rejected";
        return (
          <div key={name} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span>{label}</span>
              <span className={cn("font-mono", high ? "text-amber-700" : "text-muted-foreground")}>{pct}%</span>
            </div>
            <div
              role="meter"
              aria-label={`${label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className={cn("h-full rounded-full", high ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
            </div>
            {window.resetsAt !== null && <div className="text-[11px] text-muted-foreground">Resets {formatDateTime(window.resetsAt)}</div>}
          </div>
        );
      })}
      {limits.overage?.inUse && <p className="text-xs text-amber-700">Using extra usage beyond your plan.</p>}
      <p className="text-[11px] text-muted-foreground">Last reported {formatDuration(Math.max(0, now - limits.observedAt))} ago, by the chat.</p>
    </div>
  );
}
