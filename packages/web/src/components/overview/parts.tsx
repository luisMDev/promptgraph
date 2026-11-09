import { formatCostUsd, isFinalRunStatus, webRoutes, type RepoSummary } from "@promptgraph/shared";
import { forwardRef, type ComponentProps } from "react";
import { create } from "zustand";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Link } from "../../lib/router/Link";
import { RUN_STATUS_STYLE } from "../../lib/status-style";
import { Icons } from "../common/icons";
import { GraphThumbnail } from "../graphs/GraphThumbnail";
import type { GroupMode, OverviewItem } from "./data";

/** "just now", "5m ago", "3h ago", "2d ago", else the date. */
export function formatRelative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The search text survives moving between `/` and `/r/<repoId>` (the filter is the route, which remounts the view). */
export const useOverviewQuery = create<{ query: string; setQuery: (q: string) => void }>((set) => ({ query: "", setQuery: (query) => set({ query }) }));

/** Where a repository filter points: Home for every repository, else the repository's route. */
export function filterHref(repoId: string | null): string {
  return repoId === null ? webRoutes.home() : webRoutes.repo(repoId);
}

export function RepoAvatar({ repo, size = "md" }: { repo: RepoSummary; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm font-semibold uppercase",
        size === "sm" && "size-5 text-[10px]",
        size === "md" && "size-7 text-xs",
        size === "lg" && "size-10 text-base",
        repo.available ? "bg-muted text-foreground/80" : "bg-red-500/15 text-red-700",
      )}
    >
      {repo.name.charAt(0) || "?"}
    </span>
  );
}

/** Running / paused / approval / input counters of a repository (nothing when all are 0). */
export function Counters({ repo, compact = false }: { repo: RepoSummary; compact?: boolean }) {
  const items: { label: string; short: string; value: number; className: string }[] = [
    { label: "running", short: "running", value: repo.runs.running, className: "bg-blue-500/15 text-blue-700" },
    { label: "paused", short: "paused", value: repo.runs.paused, className: "bg-amber-500/15 text-amber-700" },
    { label: "awaiting approval", short: "approval", value: repo.waiting.approval, className: "bg-violet-500/15 text-violet-700" },
    { label: "waiting for input", short: "input", value: repo.waiting.input, className: "bg-amber-500/15 text-amber-700" },
  ];
  const shown = items.filter((i) => i.value > 0);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((i) => (
        <Badge key={i.label} title={`${i.value} ${i.label}`} className={`h-4 rounded-sm px-1 text-[10px] font-normal ${i.className}`}>
          {i.value} {compact ? i.short : i.label}
        </Badge>
      ))}
    </span>
  );
}

/** A dot when the repository has something running or waiting for the user. */
export function RepoPulse({ repo }: { repo: RepoSummary }) {
  const waiting = repo.waiting.approval + repo.waiting.input;
  const running = repo.runs.running + repo.runs.paused;
  if (!waiting && !running) return null;
  return <span title={waiting ? "Waiting for you" : "Running"} className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-amber-500" : "bg-blue-500")} />;
}

/** The graph's thumbnail on a dotted ground (its parse error icon when the file does not load). */
export function Thumb({ item, className, dots = true }: { item: OverviewItem; className?: string; dots?: boolean }) {
  const { graph } = item;
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted/40",
        dots && "bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:12px_12px]",
        className,
      )}
    >
      {graph.loadError ? (
        <div className="flex h-full items-center justify-center text-red-700" title={graph.loadError}>
          <Icons.alert />
        </div>
      ) : graph.preview && graph.preview.nodes.length > 0 ? (
        <GraphThumbnail preview={graph.preview} className="h-full w-full p-1.5" />
      ) : graph.preview ? (
        <div className="flex h-full items-center justify-center text-muted-foreground/40" title="Empty graph">
          <Icons.layers />
        </div>
      ) : null}
      {graph.runs.active > 0 && <span className="absolute top-1 left-1 size-1.5 rounded-full bg-blue-500" title={`${graph.runs.active} active`} />}
    </div>
  );
}

/** The graph's name as a link to its editor covering the whole item (after:inset-0); links and buttons inside sit above. */
export function GraphLink({ item, className, cover = true }: { item: OverviewItem; className?: string; cover?: boolean }) {
  const name = item.graph.name ?? item.graph.id;
  return (
    <Link
      to={webRoutes.graph(item.repo.id, item.graph.id)}
      aria-label={`Open ${name}`}
      className={cn(
        "truncate font-medium outline-none",
        cover && "after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
        item.graph.loadError ? "text-red-700" : "text-foreground",
        className,
      )}
    >
      {name}
    </Link>
  );
}

export function LastOpenedBadge({ item }: { item: OverviewItem }) {
  if (!item.lastOpened) return null;
  return <Badge className="h-4 shrink-0 rounded-sm bg-muted px-1 text-[10px] font-normal text-muted-foreground">last opened</Badge>;
}

export function stepsOf(item: OverviewItem): number | null {
  return item.graph.preview?.nodes.length ?? null;
}

export function costOf(item: OverviewItem): string | null {
  return item.graph.runs.costUsd > 0 ? formatCostUsd(item.graph.runs.costUsd) : null;
}

/** "7 steps · 3 runs · $1.20" */
export function StatsLine({ item, className }: { item: OverviewItem; className?: string }) {
  const steps = stepsOf(item);
  const parts = [steps !== null ? `${steps} ${steps === 1 ? "step" : "steps"}` : null, `${item.graph.runs.total} ${item.graph.runs.total === 1 ? "run" : "runs"}`, costOf(item)].filter(Boolean);
  return <span className={cn("truncate text-[11px] text-muted-foreground tabular-nums", className)}>{parts.join(" · ")}</span>;
}

/** The last run's status, a link while it is active; "Never run" otherwise. */
export function LastRun({ item, withTime = false }: { item: OverviewItem; withTime?: boolean }) {
  const last = item.graph.runs.lastRun;
  if (!last) return <span className="text-[11px] text-muted-foreground">Never run</span>;
  const style = RUN_STATUS_STYLE[last.status];
  const active = !isFinalRunStatus(last.status);
  const content = (
    <>
      <span className={`size-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span>{style.label}</span>
      {withTime && <span className="text-muted-foreground">· {formatRelative(last.startedAt)}</span>}
    </>
  );
  return active ? (
    <Link to={webRoutes.run(item.repo.id, last.id)} className={cn("relative z-10 inline-flex items-center gap-1 rounded-sm px-1 text-[11px] hover:bg-accent", style.text)}>
      {content}
    </Link>
  ) : (
    <span className={cn("inline-flex items-center gap-1 text-[11px]", style.text)}>{content}</span>
  );
}

/** A search field with a leading icon. */
export const SearchField = forwardRef<HTMLInputElement, ComponentProps<"input"> & { large?: boolean }>(function SearchField({ className, large = false, ...props }, ref) {
  return (
    <label className={cn("relative flex min-w-0 items-center", className)}>
      <Icons.search className={cn("pointer-events-none absolute text-muted-foreground", large ? "left-3.5 text-base" : "left-2.5 text-xs")} />
      <input
        ref={ref}
        type="search"
        aria-label="Search graphs"
        placeholder="Search graphs and repositories…"
        className={cn(
          "w-full rounded-sm bg-muted/50 text-foreground outline-none placeholder:text-muted-foreground focus:bg-muted focus-visible:ring-1 focus-visible:ring-ring",
          large ? "h-12 pr-4 pl-10 text-base" : "h-8 pr-2 pl-8 text-xs",
        )}
        {...props}
      />
    </label>
  );
});

const GROUP_LABELS: Record<GroupMode, string> = { recent: "Recent", repo: "Repository", none: "None" };

/** Group by: Recent · Repository · None. */
export function GroupToggle({ value, onChange }: { value: GroupMode; onChange: (m: GroupMode) => void }) {
  const modes = Object.keys(GROUP_LABELS) as GroupMode[];
  return (
    <div role="radiogroup" aria-label="Group by" className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-muted/50 p-0.5 text-[11px]">
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn("rounded-[2px] px-2 py-1 transition-colors", value === m ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
        >
          {GROUP_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

/** A group's heading: its label and count. */
export function GroupHeading({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <h3 className={cn("flex items-center gap-2 text-[11px] font-medium text-muted-foreground", className)}>
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </h3>
  );
}
