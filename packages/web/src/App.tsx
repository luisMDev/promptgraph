import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas } from "./components/canvas/Canvas";
import { Banners } from "./components/common/Banners";
import { PromptDialog } from "./components/common/PromptDialog";
import { Toasts } from "./components/common/Toasts";
import { Icons } from "./components/common/icons";
import { Button } from "./components/common/ui";
import { Button as IconButton } from "./components/ui/button";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider, SidebarRail } from "./components/ui/sidebar";
import { PanelLeftIcon, PanelRightIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Header } from "./components/header/Header";
import { RunControls, SaveIndicator } from "./components/header/RunControls";
import { RunHistory } from "./components/history/RunHistory";
import { Inspector } from "./components/inspector/Inspector";
import { Palette } from "./components/palette/Palette";
import { RunReport, useAutoOpenReport } from "./components/report/RunReport";
import { TerminalDrawer } from "./components/terminal/TerminalDrawer";
import { createGraph, openInitialGraph, startLiveUpdates } from "./store/app-actions";
import { useAppStore } from "./store/app-store";
import { useEditorStore } from "./store/editor-store";
import { useRunStore } from "./store/run-store";
import { useUiStore, type LeftPanel } from "./store/ui-store";

/** Lazy: the dialog pulls in diff2html, which the rest of the app does not need. */
const ApprovalDialog = lazy(() => import("./components/approval/ApprovalDialog").then((m) => ({ default: m.ApprovalDialog })));
const DiffDialog = lazy(() => import("./components/approval/DiffDialog").then((m) => ({ default: m.DiffDialog })));

/** Layout shell: header / palette | canvas | inspector / terminal drawer (§13). */
export function App() {
  const bootError = useAppStore((s) => s.bootError);
  const booted = useAppStore((s) => s.repo !== null);
  const reportRunId = useUiStore((s) => s.reportRunId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  useAutoOpenReport();

  useEffect(() => {
    const stop = startLiveUpdates();
    void (async () => {
      await useAppStore.getState().boot();
      const repo = useAppStore.getState().repo;
      if (!repo) return;
      useEditorStore.getState().setPhase(repo.phase, repo.supportedNodeTypes);
      await openInitialGraph();
    })();
    return stop;
  }, []);

  if (bootError) return <FullScreenMessage title="Cannot reach the promptgraph server" detail={bootError} />;
  if (!booted) return <FullScreenMessage title="Loading…" />;

  // Two shadcn sidebar providers, one per side (a provider drives a single sidebar): the outer one wraps the whole
  // shell for the left sidebar (palette / runs), the inner one wraps the canvas and the right sidebar (inspector).
  // Each collapses from its edge rail, which also resizes it when dragged; the canvas shows the expand buttons.
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => useUiStore.getState().setSidebarOpen(open)}
      className="h-full min-h-0 flex-col bg-background text-foreground"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <Header />
      <Banners />
      {reportRunId && <RunReport runId={reportRunId} />}
      {/* `relative` + `overflow-hidden`: the left Sidebar is positioned against this row (not the viewport), so it
          always sits below the header and any banners, and slides out of view when collapsed. */}
      <div className={`relative flex min-h-0 flex-1 overflow-hidden ${reportRunId ? "hidden" : ""}`}>
        <LeftSidebar />
        <SidebarProvider
          open={inspectorOpen}
          onOpenChange={(open) => useUiStore.getState().setInspectorOpen(open)}
          className="relative min-h-0 min-w-0 flex-1"
          style={{ "--sidebar-width": `${inspectorWidth}px` } as CSSProperties}
        >
          <main className="relative flex min-w-0 flex-1 flex-col">
            <CanvasOverlay />
            <div className="min-h-0 flex-1">
              <CanvasArea />
            </div>
            <TerminalDrawer />
          </main>
          <RightSidebar />
        </SidebarProvider>
      </div>
      <ApprovalGate />
      <DiffGate />
      <Toasts />
    </SidebarProvider>
  );
}

function ApprovalGate() {
  const nodeRunId = useUiStore((s) => s.approvalNodeRunId);
  if (!nodeRunId) return null;
  return (
    <Suspense fallback={null}>
      <ApprovalDialog key={nodeRunId} nodeRunId={nodeRunId} />
    </Suspense>
  );
}

function DiffGate() {
  const target = useUiStore((s) => s.diffTarget);
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <DiffDialog target={target} />
    </Suspense>
  );
}

/**
 * A sidebar toggle with a tooltip; aria-label names the action (collapse inside the sidebar, expand outside).
 * It reads the UI store rather than useSidebar(): the canvas sits inside the inspector's provider, so the nearest
 * sidebar context there is the right one even for the left sidebar's expand button.
 */
function SidebarToggle({ side, label, className }: { side: "left" | "right"; label: string; className?: string }) {
  const open = useUiStore((s) => (side === "left" ? s.sidebarOpen : s.inspectorOpen));
  const toggle = () => {
    const ui = useUiStore.getState();
    if (side === "left") ui.setSidebarOpen(!open);
    else ui.setInspectorOpen(!open);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton variant="ghost" size="icon-sm" aria-label={label} aria-expanded={open} className={className} onClick={toggle}>
          {side === "left" ? <PanelLeftIcon /> : <PanelRightIcon />}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const FLOATING = "bg-card shadow-soft ring-1 ring-border";

/**
 * Controls floating over the top corners of the canvas: the left sidebar's expand button while it is collapsed, and
 * at the top right the autosave indicator, the run controls (problems, Run / Cancel, …) and the inspector's expand
 * button. The save indicator sits left of Run so that appearing and disappearing never shifts the Run button.
 * The row itself lets pointer events through, so only its buttons cover the canvas.
 */
function CanvasOverlay() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  return (
    <>
      {!sidebarOpen && <SidebarToggle side="left" label="Expand sidebar" className={`absolute top-2 left-2 z-10 ${FLOATING}`} />}
      <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-2 *:pointer-events-auto">
        <SaveIndicator />
        <RunControls />
        {!inspectorOpen && <SidebarToggle side="right" label="Expand inspector" className={FLOATING} />}
      </div>
    </>
  );
}

function RightSidebar() {
  return (
    // Re-anchored to its provider's (relative) wrapper like the left sidebar. nokey: Backspace/Delete on the
    // inspector's buttons, checkboxes and tabs must not delete canvas items.
    <Sidebar side="right" collapsible="offcanvas" className="nokey absolute h-full">
      <div className="min-h-0 flex-1">
        <Inspector />
      </div>
      <SidebarRail aria-label="Collapse or resize inspector" title="Click to collapse, drag to resize" onResize={(px) => useUiStore.getState().setInspectorWidth(px)} />
    </Sidebar>
  );
}

function LeftSidebar() {
  const panel = useUiStore((s) => s.leftPanel);
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  const runs = useRunStore((s) => s.runs.length);
  const shown: LeftPanel = runMode ? "history" : panel;
  const choose = (id: LeftPanel) => {
    useUiStore.getState().setLeftPanel(id);
    if (id === "palette" && runMode) void useRunStore.getState().selectRun(null);
  };
  return (
    // shadcn's desktop sidebar container is `fixed inset-y-0 h-svh`; it is re-anchored to the (relative) layout row
    // with `absolute h-full` because the header + banners above it have no fixed height.
    <Sidebar collapsible="offcanvas" className="nokey absolute h-full">
      {/* Manual activation: arrowing across the tabs must not leave run mode; Enter/Space/click select. */}
      <Tabs value={shown} activationMode="manual" onValueChange={(v) => choose(v as LeftPanel)} className="min-h-0 flex-1 gap-0">
        <SidebarHeader className="flex-row items-center gap-1 border-b">
          <TabsList className="min-w-0 flex-1">
            <TabsTrigger value="palette" className="text-xs">
              Nodes
            </TabsTrigger>
            {/* Radix only fires onValueChange on change; in run mode "Runs" is already shown even when leftPanel is
                "palette", so a click must still record the choice (as the hand-rolled tab did). */}
            <TabsTrigger value="history" className="text-xs" onClick={() => useUiStore.getState().setLeftPanel("history")}>
              {`Runs${runs ? ` (${runs})` : ""}`}
            </TabsTrigger>
          </TabsList>
          <SidebarToggle side="left" label="Collapse sidebar" />
        </SidebarHeader>
        <SidebarContent>
          <TabsContent value="palette" className="min-h-0">
            <Palette />
          </TabsContent>
          <TabsContent value="history" className="min-h-0">
            <RunHistory />
          </TabsContent>
        </SidebarContent>
      </Tabs>
      <SidebarRail aria-label="Collapse or resize sidebar" title="Click to collapse, drag to resize" onResize={(px) => useUiStore.getState().setSidebarWidth(px)} />
    </Sidebar>
  );
}

function CanvasArea() {
  const hasGraph = useEditorStore((s) => s.graph !== null);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const graphCount = useAppStore((s) => s.graphs.length);
  const [creating, setCreating] = useState(false);

  if (loading) return <Centered>Loading graph…</Centered>;
  if (loadError) {
    return (
      <Centered>
        <div className="max-w-lg space-y-2 text-center">
          <Icons.alert className="mx-auto text-2xl text-red-600" />
          <p className="text-sm font-medium text-red-700">This graph cannot be loaded</p>
          <pre className="rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap text-muted-foreground">{loadError}</pre>
          <p className="text-xs text-muted-foreground">Fix the JSON file in .promptgraph/graphs/ or delete it from the graph menu.</p>
        </div>
      </Centered>
    );
  }
  if (!hasGraph) {
    return (
      <Centered>
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{graphCount ? "Select a graph from the menu above." : "No graphs in this repository yet."}</p>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icons.plus /> New graph
          </Button>
        </div>
        {creating && <PromptDialog title="New graph" label="Name" submitLabel="Create" onSubmit={(name) => void createGraph(name)} onClose={() => setCreating(false)} />}
      </Centered>
    );
  }
  return <Canvas />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-muted-foreground">{children}</div>;
}

function FullScreenMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="max-w-lg text-xs text-muted-foreground">{detail}</p>}
      {detail && <p className="max-w-lg text-xs text-muted-foreground">Open the URL printed by the promptgraph command (it carries the session token).</p>}
    </div>
  );
}
