import type { GraphIssue, LinearIssue } from "@promptgraph/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useLinearIssueState } from "../../store/linear-issue-store";
import { Icons } from "./icons";

/** The part of a linked issue every list carries (GraphListItem.issues, Graph.issues). */
export type IssueRef = Pick<GraphIssue, "id" | "identifier" | "title" | "url">;

export function IssueStateDot({ state, className }: { state: LinearIssue["state"]; className?: string }) {
  if (!state) return null;
  return <span className={cn("size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: state.color }} aria-hidden />;
}

/**
 * A linked Linear issue as a link to it (DESIGN §24.3), with its current state from Linear (useLinearIssueState) when
 * known: the title Linear has now, else the snapshot in the graph file. `canvas`: floating over the top left of the
 * diagram's canvas (identifier, title, state); `badge`: an overview card (identifier and state), raised above the card's
 * cover link.
 */
export function LinearIssueLink({ issue, variant, className }: { issue: IssueRef; variant: "canvas" | "badge"; className?: string }) {
  const live = useLinearIssueState(issue.id)?.issue ?? null;
  const title = live?.title ?? issue.title;
  const url = live?.url ?? issue.url;
  const state = live?.state ?? null;
  const tooltip = `${issue.identifier} ${title}${state ? ` · ${state.name}` : ""} (open in Linear)`;
  const label = `${issue.identifier} in Linear${state ? `: ${state.name}` : ""}`;
  if (variant === "badge") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={tooltip}
        aria-label={label}
        className={cn(
          "relative z-10 inline-flex min-w-0 shrink items-center gap-1 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <IssueStateDot state={state} className="size-1.5" />
        <span className="shrink-0 font-mono">{issue.identifier}</span>
        {state && <span className="truncate">{state.name}</span>}
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={tooltip}
      aria-label={label}
      className={cn(
        "inline-flex h-8 min-w-0 max-w-96 items-center gap-2 rounded-lg bg-card px-2.5 text-sm shadow-soft ring-1 ring-border hover:bg-accent",
        className,
      )}
    >
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
      <span className="min-w-0 truncate">{title}</span>
      {state && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <IssueStateDot state={state} />
          {state.name}
        </span>
      )}
      <Icons.externalLink className="shrink-0 text-muted-foreground" />
    </a>
  );
}

/** How many issues show before "+N" (the rest are in its popover). */
const VISIBLE = { canvas: 3, badge: 2 } as const;

/**
 * A graph's linked issues (DESIGN §24.3). One issue over the canvas shows in full (identifier, title, state); several
 * show as compact links (identifier and state). The first VISIBLE[variant] show; "+N" opens a popover with the rest.
 */
export function LinearIssueLinks({ issues, variant, className }: { issues: readonly IssueRef[]; variant: "canvas" | "badge"; className?: string }) {
  if (issues.length === 1 && variant === "canvas") return <LinearIssueLink issue={issues[0]!} variant="canvas" className={className} />;
  const shown = issues.slice(0, VISIBLE[variant]);
  const rest = issues.slice(VISIBLE[variant]);
  const compact = variant === "canvas" ? "h-6 px-1.5 text-[11px]" : undefined;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1",
        variant === "badge" && "relative z-10",
        // Over the canvas: one floating card holding the compact links.
        variant === "canvas" && "h-8 rounded-lg bg-card px-1 shadow-soft ring-1 ring-border",
        className,
      )}
      aria-label="Linear issues"
    >
      {shown.map((issue) => (
        <LinearIssueLink key={issue.id} issue={issue} variant="badge" className={compact} />
      ))}
      {rest.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`${rest.length} more Linear issues`}
              className={cn("shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground", compact)}
            >
              +{rest.length}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1">
            <ul className="flex flex-col gap-0.5">
              {rest.map((issue) => (
                <li key={issue.id} className="flex items-center gap-2 px-1 py-0.5 text-xs">
                  <LinearIssueLink issue={issue} variant="badge" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{issue.title}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
