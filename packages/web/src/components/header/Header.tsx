import { useEditor } from "../../store/view/context";
import { LinearIssueLinks } from "../common/LinearIssueLink";
import { GraphSelector } from "./GraphSelector";
import { RunSelector } from "./RunControls";

/**
 * Top bar (§13): the graph selector, the run menu (the editor or one of the graph's runs, §13.2) and, for a graph
 * linked to Linear issues, the issues with their current state as links to Linear (§24.3). Pending approvals
 * and settings sit at the end of the tab strip, Claude's billing and setup at the start of the tab's bottom bar
 * (§13.4); Arrange, Undo / Redo, Run / Cancel and the save state float over the canvas.
 */
export function Header() {
  const issues = useEditor((s) => s.graph?.issues);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/80 px-3 backdrop-blur">
      <GraphSelector />
      <RunSelector />
      {issues?.length ? <LinearIssueLinks issues={issues} variant="header" className="ml-auto" /> : null}
    </header>
  );
}
