import { webRoutes } from "@promptgraph/shared";
import { useEditor, useRun, useView, useViewUi } from "../../store/view/context";
import type { LeftPanel } from "../../store/view/ui-store";
import { Button } from "../common/ui";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { Separator } from "../ui/separator";
import { SettingsMenu } from "../settings/SettingsMenu";
import { GraphSelector } from "./GraphSelector";
import { PendingApprovals, RunSelector } from "./RunControls";

/**
 * Top bar (§13): the left sidebar's Nodes / Runs switch, graph selector, run selector, pending approvals,
 * settings. Claude's billing and setup sit at the start of the tab's bottom bar (ClaudeStatus). The app logo sits in the tab strip (§13.4); Run/Cancel and the save state float over the canvas.
 */
export function Header() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/80 px-3 backdrop-blur">
      <LeftPanelSwitch />
      <Separator orientation="vertical" className="data-vertical:h-5 data-vertical:self-center" />
      <GraphSelector />
      <RunSelector />
      <div className="ml-auto flex items-center gap-2">
        <PendingApprovals />
        <SettingsMenu />
      </div>
    </header>
  );
}

const SEGMENT_ITEM =
  "h-full min-w-16 rounded-md px-3 text-xs text-foreground/60 hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/30";

/**
 * Nodes / Runs: which panel the left sidebar shows. A run shown on the canvas always shows Runs, and choosing
 * Nodes there goes back to the graph (§13.2). Choosing a panel expands a collapsed sidebar.
 */
export function LeftPanelSwitch() {
  const view = useView();
  const panel = useViewUi((s) => s.leftPanel);
  const runMode = useRun((s) => s.selectedRunId !== null);
  const runs = useRun((s) => s.runs.length);
  const graphId = useEditor((s) => s.graphId);
  const shown: LeftPanel = runMode ? "history" : panel;
  // A click always records the choice, also on the item already shown (it may only look selected because of run
  // mode, or the sidebar may be collapsed).
  const choose = (id: LeftPanel) => {
    view.ui.getState().setLeftPanel(id);
    if (id === "palette" && runMode && graphId) view.navigate(webRoutes.graph(view.repoId, graphId));
  };
  return (
    <ToggleGroup type="single" value={shown} spacing={0} aria-label="Left panel" className="h-8 shrink-0 rounded-lg bg-muted p-[3px]">
      <ToggleGroupItem value="palette" className={SEGMENT_ITEM} onClick={() => choose("palette")}>
        Nodes
      </ToggleGroupItem>
      <ToggleGroupItem value="history" className={SEGMENT_ITEM} onClick={() => choose("history")}>
        {`Runs${runs ? ` (${runs})` : ""}`}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
