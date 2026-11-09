import { MAX_GRAPH_ISSUES, type GraphIssue } from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { useLinearStore } from "../../store/linear-store";
import { Icons } from "./icons";
import { LinearIssueLink } from "./LinearIssueLink";
import { LinearIssueSearchDialog } from "./LinearIssueSearchDialog";
import { Button } from "./ui";

/**
 * The linked Linear issues of a graph (DESIGN §24.2): a list in the order they were linked (identifier with its
 * current state, linking to Linear; title; × to unlink) and **Link Linear issues…**, which opens the search dialog
 * (LinearIssueSearchDialog); the issues it returns are appended. The button needs a Linear connection and room under
 * MAX_GRAPH_ISSUES; without a connection a hint points at Settings (nothing when `hideWhenDisconnected`), the linked
 * issues still show. `disabled`: read-only list.
 */
export function LinearIssuePicker({
  selected,
  onChange,
  disabled = false,
  hideWhenDisconnected = false,
}: {
  selected: readonly GraphIssue[];
  onChange: (issues: GraphIssue[]) => void;
  disabled?: boolean;
  hideWhenDisconnected?: boolean;
}) {
  const status = useLinearStore((s) => s.status);
  const connected = status?.connected === true;
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void useLinearStore.getState().load();
  }, []);

  if (!connected && selected.length === 0) {
    if (hideWhenDisconnected || !status) return null;
    return <span className="block text-[11px] leading-snug text-muted-foreground/80">Connect Linear in Settings → Linear to link the graph to issues.</span>;
  }

  const full = selected.length >= MAX_GRAPH_ISSUES;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="block text-xs font-medium text-muted-foreground">Linear issues</span>
      {selected.length > 0 && (
        <ul aria-label="Linked Linear issues" className="flex flex-col gap-1">
          {selected.map((issue) => (
            <li key={issue.id} className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs">
              <LinearIssueLink issue={issue} variant="badge" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={issue.title}>
                {issue.title}
              </span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Unlink ${issue.identifier}`}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onChange(selected.filter((i) => i.id !== issue.id))}
                >
                  <Icons.x />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {connected && !disabled && (
        <Button variant="secondary" size="sm" className="self-start" disabled={full} title={full ? `A graph links at most ${MAX_GRAPH_ISSUES} issues` : undefined} onClick={() => setSearching(true)}>
          <Icons.plus /> {selected.length ? "Link more issues…" : "Link Linear issues…"}
        </Button>
      )}
      {searching && (
        <LinearIssueSearchDialog
          linked={selected}
          onAccept={(issues) => onChange([...selected, ...issues.filter((i) => !selected.some((s) => s.id === i.id))])}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}
