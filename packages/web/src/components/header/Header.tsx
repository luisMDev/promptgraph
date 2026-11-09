import { GraphSelector } from "./GraphSelector";
import { RunSelector } from "./RunControls";

/**
 * Top bar (§13): the graph selector and the run menu (the editor or one of the graph's runs, §13.2). Pending approvals
 * and settings sit at the end of the tab strip, Claude's billing and setup at the start of the tab's bottom bar
 * (§13.4); Arrange, Undo / Redo, Run / Cancel and the save state float over the canvas.
 */
export function Header() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/80 px-3 backdrop-blur">
      <GraphSelector />
      <RunSelector />
    </header>
  );
}
