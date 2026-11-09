import {
  DEFAULT_LINEAR_STATE_GROUPS,
  LINEAR_ERROR,
  MAX_GRAPH_ISSUES,
  LINEAR_STATE_GROUPS,
  stateTypesOfGroups,
  type GraphIssue,
  type LinearIssue,
  type LinearIssueScope,
  type LinearStateGroupId,
} from "@promptgraph/shared";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ApiRequestError, daemonApi, errorMessage } from "../../api/rest";
import { Icons } from "./icons";
import { Button, Modal } from "./ui";

/** Search delay after the last keystroke. */
export const ISSUE_SEARCH_DEBOUNCE_MS = 250;

/** localStorage keys of the search dialog's state and scope filters (per browser). */
export const LINEAR_STATES_STORAGE_KEY = "pg.linear.states";
export const LINEAR_SCOPE_STORAGE_KEY = "pg.linear.scope";

const GROUP_IDS = new Set<string>(LINEAR_STATE_GROUPS.map((g) => g.id));

/** The remembered state filter; the open groups when none is stored (or storage is unavailable). */
export function loadStateGroups(): LinearStateGroupId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LINEAR_STATES_STORAGE_KEY) ?? "null");
    if (Array.isArray(raw)) {
      const groups = raw.filter((g): g is LinearStateGroupId => typeof g === "string" && GROUP_IDS.has(g));
      if (groups.length) return groups;
    }
  } catch {
    // Unreadable or blocked storage: the defaults.
  }
  return [...DEFAULT_LINEAR_STATE_GROUPS];
}

function saveStateGroups(groups: readonly LinearStateGroupId[]): void {
  try {
    localStorage.setItem(LINEAR_STATES_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Not remembered: the filter still applies to this dialog.
  }
}

/** The remembered scope; "mine" when none is stored. */
export function loadScope(): LinearIssueScope {
  try {
    return localStorage.getItem(LINEAR_SCOPE_STORAGE_KEY) === "all" ? "all" : "mine";
  } catch {
    return "mine";
  }
}

function saveScope(scope: LinearIssueScope): void {
  try {
    localStorage.setItem(LINEAR_SCOPE_STORAGE_KEY, scope);
  } catch {
    // Not remembered.
  }
}

/** The part of a search result the graph file keeps. */
export function toGraphIssue(issue: LinearIssue): GraphIssue {
  const { state: _state, teamKey: _team, assignee: _assignee, ...ref } = issue;
  return ref;
}

function searchError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.body.code === LINEAR_ERROR.keyInvalid) return "Linear rejects the saved API key (Settings → Linear).";
    if (err.body.code === LINEAR_ERROR.notConnected) return "Linear is not connected.";
    if (err.body.code === LINEAR_ERROR.unavailable) return "Linear could not be reached.";
  }
  return errorMessage(err);
}

const SCOPES: readonly { value: LinearIssueScope; label: string }[] = [
  { value: "mine", label: "My issues" },
  { value: "all", label: "All issues" },
];

const TOGGLE = "h-6 px-2 text-[11px] data-[state=on]:bg-accent data-[state=on]:text-accent-foreground";

/**
 * "Link Linear issues" (DESIGN §24.2): a search dialog opened from the issue picker. The search field (typing searches
 * Linear after a short delay; an identifier such as ENG-123 or an issue URL looks the issue up; an empty field lists
 * the most recently updated issues), the scope (My issues / All issues, remembered in `pg.linear.scope`), the state
 * toggles (Backlog, Todo, In progress, Done, Canceled; the first three by default, remembered in `pg.linear.states`;
 * they filter the list and the search, not a lookup) and up to 25 results with identifier, title, assignee and state.
 * Clicking a result (or ↑/↓ and Enter) checks or unchecks it; checked issues stay selected across searches and are
 * listed above the buttons. Issues already linked are shown as such and cannot be picked again. **Add** hands the
 * selection to `onAccept` (in the order it was checked), **Cancel** or Escape discards it. The selection is limited so
 * that the graph keeps at most MAX_GRAPH_ISSUES.
 */
export function LinearIssueSearchDialog({ linked, onAccept, onClose }: { linked: readonly GraphIssue[]; onAccept: (issues: GraphIssue[]) => void; onClose: () => void }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<LinearIssueScope>(loadScope);
  const [groups, setGroups] = useState<LinearStateGroupId[]>(loadStateGroups);
  const [results, setResults] = useState<LinearIssue[]>([]);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LinearIssue[]>([]);
  const states = stateTypesOfGroups(groups).join(",");
  const linkedIds = new Set(linked.map((i) => i.id));
  const selectedIds = new Set(selected.map((i) => i.id));
  const room = MAX_GRAPH_ISSUES - linked.length;
  const full = selected.length >= room;

  // Debounced search; a newer search discards older answers.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      setSearching(true);
      daemonApi
        .linearIssues(query.trim(), states.split(","), scope)
        .then(({ issues }) => {
          if (!current) return;
          setResults(issues);
          setActive(-1);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!current) return;
          setResults([]);
          setError(searchError(err));
        })
        .finally(() => {
          if (current) setSearching(false);
        });
    }, ISSUE_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, states, scope]);

  const toggle = (issue: LinearIssue) => {
    if (linkedIds.has(issue.id)) return;
    if (selectedIds.has(issue.id)) setSelected((s) => s.filter((i) => i.id !== issue.id));
    else if (!full) setSelected((s) => [...s, issue]);
  };
  const accept = () => {
    if (selected.length === 0) return;
    onAccept(selected.map(toGraphIssue));
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      const last = results.length - 1;
      setActive((i) => (e.key === "ArrowDown" ? (i >= last ? 0 : i + 1) : i <= 0 ? last : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && results[active]) toggle(results[active]);
      else accept();
    }
  };

  const note = searching
    ? "Searching Linear…"
    : error
      ? error
      : full && room > 0
        ? `A graph links at most ${MAX_GRAPH_ISSUES} issues.`
        : room <= 0
          ? `This graph already links ${MAX_GRAPH_ISSUES} issues.`
          : results.length === 0
            ? "No Linear issue matches."
            : null;

  return (
    <Modal
      title="Link Linear issues"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted-foreground" role="status">
            {selected.length === 0 ? "Nothing selected" : `${selected.length} selected`}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={selected.length === 0} onClick={accept}>
            {selected.length > 1 ? `Add ${selected.length} issues` : "Add issue"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        <Input
          type="search"
          autoFocus
          autoComplete="off"
          aria-label="Search Linear issues"
          placeholder="Search by title, ENG-123 or an issue URL"
          value={query}
          aria-controls={`${listId}-list`}
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Whose issues"
            value={scope}
            onValueChange={(v) => {
              if (v !== "mine" && v !== "all") return;
              setScope(v);
              saveScope(v);
            }}
          >
            {SCOPES.map((s) => (
              <ToggleGroupItem key={s.value} value={s.value} className={TOGGLE}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={1}
            aria-label="Issue states"
            value={groups}
            onValueChange={(v) => {
              // At least one group stays selected.
              if (v.length === 0) return;
              const next = LINEAR_STATE_GROUPS.map((g) => g.id).filter((id) => v.includes(id));
              setGroups(next);
              saveStateGroups(next);
            }}
            className="flex-wrap"
          >
            {LINEAR_STATE_GROUPS.map((g) => (
              <ToggleGroupItem key={g.id} value={g.id} className={TOGGLE}>
                {g.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="rounded-md border">
          <ul id={`${listId}-list`} role="listbox" aria-label="Linear issues" aria-multiselectable="true" className="h-80 overflow-y-auto p-1">
            {results.map((issue, i) => {
              const isLinked = linkedIds.has(issue.id);
              const isSelected = isLinked || selectedIds.has(issue.id);
              const blocked = isLinked || (!isSelected && full);
              return (
                <li
                  key={issue.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={blocked || undefined}
                  onClick={() => toggle(issue)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
                    i === active && "bg-accent text-accent-foreground",
                    blocked && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                    aria-hidden
                  >
                    {isSelected && <Icons.check className="size-3" />}
                  </span>
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{issue.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  {isLinked && <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">Linked</span>}
                  {issue.assignee && <span className="hidden max-w-28 shrink-0 truncate text-[11px] text-muted-foreground sm:inline">{issue.assignee}</span>}
                  {issue.state && (
                    <span className="flex w-24 shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: issue.state.color }} aria-hidden />
                      <span className="truncate">{issue.state.name}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {note && (
            <p className={cn("border-t px-3 py-1.5 text-[11px]", error ? "text-red-700" : "text-muted-foreground")} role={error ? "alert" : undefined}>
              {note}
            </p>
          )}
        </div>
        {selected.length > 0 && (
          <ul aria-label="Selected issues" className="flex flex-wrap gap-1">
            {selected.map((issue) => (
              <li key={issue.id} className="flex items-center gap-1 rounded-sm bg-muted py-0.5 pr-0.5 pl-1.5 text-[11px]">
                <span className="font-mono">{issue.identifier}</span>
                <button
                  type="button"
                  aria-label={`Deselect ${issue.identifier}`}
                  className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setSelected((s) => s.filter((i) => i.id !== issue.id))}
                >
                  <Icons.x className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
