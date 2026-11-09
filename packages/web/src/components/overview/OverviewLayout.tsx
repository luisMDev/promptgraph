import type { RepoSummary } from "@promptgraph/shared";
import { Icons } from "../common/icons";
import { Button } from "../common/ui";
import type { OverviewItem, OverviewModel } from "./data";
import { LinearIssueLinks } from "../common/LinearIssueLink";
import { Counters, GraphLink, GroupHeading, GroupToggle, LastOpenedBadge, LastRun, RepoAvatar, SearchField, StatsLine, Thumb } from "./parts";
import { RepoSidebar } from "./RepoSidebar";

export interface OverviewActions {
  newGraph: () => void;
  addRepo: () => void;
  removeRepo: (repo: RepoSummary) => void;
  deleteGraph: (item: OverviewItem) => void;
}

/**
 * The overview's layout (DESIGN §13.3): the repositories column on the left (`RepoSidebar`, the filter), and on the right the selected scope's title,
 * search, grouping (only under All graphs) and its graphs as thumbnail cards in grouped grids.
 */
export function OverviewLayout({ m, actions }: { m: OverviewModel; actions: OverviewActions }) {
  const repos = m.repos ?? [];
  return (
    <div className="flex min-h-0 flex-1">
      <RepoSidebar m={m} onAddRepo={actions.addRepo} />

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-8 pt-7 pb-12">
          <header className="flex items-start justify-between gap-4 pb-4">
            <ScopeTitle repo={m.repo} />
            <div className="flex shrink-0 items-center gap-1">
              {m.repo && (
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.repo.name}`} title="Remove from promptgraph" className="text-muted-foreground" onClick={() => actions.removeRepo(m.repo!)}>
                  <Icons.trash />
                </Button>
              )}
              <Button variant="primary" onClick={actions.newGraph}>
                <Icons.plus /> New graph
              </Button>
            </div>
          </header>
          <div className="flex items-center gap-3 pb-6">
            <SearchField className="max-w-sm flex-1" value={m.query} onChange={(e) => m.setQuery(e.target.value)} />
            {/* Inside one repository the graphs are not grouped. */}
            {m.repoId === null && <GroupToggle value={m.group} onChange={m.setGroup} />}
          </div>
          {m.repo?.error && (
            <p role="alert" className="pb-4 text-xs text-red-700">
              {m.repo.error}
            </p>
          )}
          {m.loading && m.items.length === 0 && <p className="py-6 text-xs text-muted-foreground">Loading…</p>}
          {!m.loading && m.items.length === 0 && <NoResults query={m.query} unavailable={m.repo !== null && !m.repo.available} onNew={actions.newGraph} />}
          <section aria-label="Graphs" className="space-y-8">
            {m.groups.map((g) => (
              <div key={g.key} className="space-y-3">
                {m.group !== "none" && <GroupHeading label={g.label} count={g.items.length} />}
                <ul className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {g.items.map((item) => (
                    <Card key={item.key} item={item} showRepo={m.repoId === null && m.group !== "repo"} onDelete={() => actions.deleteGraph(item)} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}

function ScopeTitle({ repo }: { repo: RepoSummary | null }) {
  // As tall as the repository's avatar and two-line title, so the toolbar below sits at the same height.
  if (!repo) return <h1 className="text-4xl leading-10 font-semibold tracking-tight">All graphs</h1>;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <RepoAvatar repo={repo} size="lg" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold tracking-tight">{repo.name}</h1>
          <Counters repo={repo} />
        </div>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={repo.path}>
          {repo.path}
        </p>
      </div>
    </div>
  );
}

function Card({ item, showRepo, onDelete }: { item: OverviewItem; showRepo: boolean; onDelete: () => void }) {
  const name = item.graph.name ?? item.graph.id;
  return (
    <li aria-label={name} className="group relative flex flex-col gap-2">
      <div className="relative">
        <Thumb item={item} className="aspect-[16/10] transition-colors group-hover:bg-muted/70" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${name}`}
          title="Delete graph"
          className="absolute top-1.5 right-1.5 z-10 bg-background/80 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onDelete}
        >
          <Icons.trash />
        </Button>
      </div>
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <GraphLink item={item} />
          {item.graph.issues?.length ? <LinearIssueLinks issues={item.graph.issues} variant="badge" /> : null}
          <LastOpenedBadge item={item} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {showRepo && <span className="truncate text-[11px] text-muted-foreground">{item.repo.name} ·</span>}
          <StatsLine item={item} />
        </div>
        <LastRun item={item} withTime />
      </div>
    </li>
  );
}

function NoResults({ query, unavailable, onNew }: { query: string; unavailable: boolean; onNew: () => void }) {
  if (unavailable) return <p className="py-16 text-center text-sm text-muted-foreground">This repository is not available.</p>;
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{query.trim() ? `No graph matches “${query.trim()}”` : "No graphs here yet"}</p>
      <p className="text-xs text-muted-foreground">A graph is a set of steps (prompts, commands, commits, pull requests…) run with Claude Code.</p>
      <Button variant="primary" className="mt-2" onClick={onNew}>
        <Icons.plus /> New graph
      </Button>
    </div>
  );
}
