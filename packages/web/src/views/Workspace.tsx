import { webRoutes } from "@promptgraph/shared";
import { PanelLeftIcon, PanelRightIcon } from "lucide-react";
import { Suspense, lazy, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas } from "../components/canvas/Canvas";
import { ChatPanel } from "../components/chat/ChatPanel";
import { Banners } from "../components/common/Banners";
import { PromptDialog } from "../components/common/PromptDialog";
import { Icons } from "../components/common/icons";
import { Button } from "../components/common/ui";
import { Header } from "../components/header/Header";
import { RunControls, SaveIndicator } from "../components/header/RunControls";
import { RunHistory } from "../components/history/RunHistory";
import { Inspector } from "../components/inspector/Inspector";
import { Palette } from "../components/palette/Palette";
import { RunReport, useAutoOpenReport } from "../components/report/RunReport";
import { TerminalDrawer } from "../components/terminal/TerminalDrawer";
import { Button as IconButton } from "../components/ui/button";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider, SidebarRail } from "../components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import type { RepoRoute } from "../lib/router/routes";
import { createGraph } from "../store/view/actions";
import { useEditor, useRepo, useRun, useView, useViewUi } from "../store/view/context";
import type { LeftPanel } from "../store/view/ui-store";

/** Lazy: the dialog pulls in diff2html, which the rest of the app does not need. */
const ApprovalDialog = lazy(() => import("../components/approval/ApprovalDialog").then((m) => ({ default: m.ApprovalDialog })));
const DiffDialog = lazy(() => import("../components/approval/DiffDialog").then((m) => ({ default: m.DiffDialog })));

/**
 * Graph editor and run views (§13): header / palette | canvas | inspector / terminal drawer. The report route
 * replaces the canvas row (which stays mounted) with the run report.
 */
export function Workspace({ route }: { route: RepoRoute }) {
  const ui = useView().ui;
  const sidebarOpen = useViewUi((s) => s.sidebarOpen);
  const sidebarWidth = useViewUi((s) => s.sidebarWidth);
  const inspectorOpen = useViewUi((s) => s.inspectorOpen);
  const inspectorWidth = useViewUi((s) => s.inspectorWidth);
  const chatOpen = useViewUi((s) => s.chatOpen);
  const chatWidth = useViewUi((s) => s.chatWidth);
  const reportRunId = route.kind === "report" ? route.runId : null;
  useAutoOpenReport(route);

  // Two shadcn sidebar providers, one per side (a provider drives a single sidebar): the outer one wraps the whole
  // shell for the left sidebar (palette / runs), the inner one wraps the canvas and the right sidebar (inspector).
  // Each collapses from its edge rail, which also resizes it when dragged; the canvas shows the expand buttons.
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => ui.getState().setSidebarOpen(open)}
      className="min-h-0 flex-1 flex-col bg-background text-foreground"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <Header />
      <Banners />
      {reportRunId && <RunReport runId={reportRunId} />}
      {/* `relative` + `overflow-hidden`: the left Sidebar is positioned against this row (not the viewport), so it
          always sits below the header and any banners, and slides out of view when collapsed. */}
      <div className={`relative flex min-h-0 flex-1 overflow-hidden ${reportRunId ? "hidden" : ""}`}>
        <LeftSidebar />
        {/* A third provider for the chat panel (§21), docked at the far right: canvas and inspector stay visible. */}
        <SidebarProvider
          open={chatOpen}
          onOpenChange={(open) => ui.getState().setChatOpen(open)}
          className="relative min-h-0 min-w-0 flex-1"
          style={{ "--sidebar-width": `${chatWidth}px` } as CSSProperties}
        >
          <SidebarProvider
            open={inspectorOpen}
            onOpenChange={(open) => ui.getState().setInspectorOpen(open)}
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
          <ChatSidebar />
        </SidebarProvider>
      </div>
      <ApprovalGate />
      <DiffGate />
    </SidebarProvider>
  );
}

function ApprovalGate() {
  const nodeRunId = useViewUi((s) => s.approvalNodeRunId);
  if (!nodeRunId) return null;
  return (
    <Suspense fallback={null}>
      <ApprovalDialog key={nodeRunId} nodeRunId={nodeRunId} />
    </Suspense>
  );
}

function DiffGate() {
  const target = useViewUi((s) => s.diffTarget);
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <DiffDialog target={target} />
    </Suspense>
  );
}

/**
 * A sidebar toggle with a tooltip; aria-label names the action (collapse inside the sidebar, expand outside).
 * It reads the view's UI store rather than useSidebar(): the canvas sits inside the inspector's provider, so the
 * nearest sidebar context there is the right one even for the left sidebar's expand button.
 */
function SidebarToggle({ side, label, className }: { side: "left" | "right"; label: string; className?: string }) {
  const { ui } = useView();
  const open = useViewUi((s) => (side === "left" ? s.sidebarOpen : s.inspectorOpen));
  const toggle = () => {
    const s = ui.getState();
    if (side === "left") s.setSidebarOpen(!open);
    else s.setInspectorOpen(!open);
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
  const sidebarOpen = useViewUi((s) => s.sidebarOpen);
  const inspectorOpen = useViewUi((s) => s.inspectorOpen);
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
  const { ui } = useView();
  return (
    // Re-anchored to its provider's (relative) wrapper like the left sidebar. nokey: Backspace/Delete on the
    // inspector's buttons, checkboxes and tabs must not delete canvas items.
    <Sidebar side="right" collapsible="offcanvas" className="nokey absolute h-full">
      <div className="min-h-0 flex-1">
        <Inspector />
      </div>
      <SidebarRail aria-label="Collapse or resize inspector" title="Click to collapse, drag to resize" onResize={(px) => ui.getState().setInspectorWidth(px)} />
    </Sidebar>
  );
}

function ChatSidebar() {
  const ui = useView().ui;
  const open = useViewUi((s) => s.chatOpen);
  return (
    // nokey: Backspace/Delete typed in the composer must not delete canvas items.
    <Sidebar side="right" collapsible="offcanvas" className="nokey absolute h-full">
      {/* Mounted only while open: a collapsed chat costs nothing and the composer gets focus when it opens. */}
      <div className="min-h-0 flex-1">{open && <ChatPanel />}</div>
      <SidebarRail aria-label="Collapse or resize chat" title="Click to collapse, drag to resize" onResize={(px) => ui.getState().setChatWidth(px)} />
    </Sidebar>
  );
}

/** The left sidebar: the palette or the run history, as chosen with the header's Nodes / Runs switch. */
function LeftSidebar() {
  const view = useView();
  const panel = useViewUi((s) => s.leftPanel);
  const runMode = useRun((s) => s.selectedRunId !== null);
  const shown: LeftPanel = runMode ? "history" : panel;
  const title = shown === "palette" ? "Nodes" : "Runs";
  return (
    // shadcn's desktop sidebar container is `fixed inset-y-0 h-svh`; it is re-anchored to the (relative) layout row
    // with `absolute h-full` because the header + banners above it have no fixed height.
    <Sidebar collapsible="offcanvas" className="nokey absolute h-full">
      <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader className="flex-row items-center gap-1 border-b py-1.5">
          <h2 className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
          <SidebarToggle side="left" label="Collapse sidebar" />
        </SidebarHeader>
        <SidebarContent className="min-h-0">{shown === "palette" ? <Palette /> : <RunHistory />}</SidebarContent>
      </section>
      <SidebarRail aria-label="Collapse or resize sidebar" title="Click to collapse, drag to resize" onResize={(px) => view.ui.getState().setSidebarWidth(px)} />
    </Sidebar>
  );
}

function CanvasArea() {
  const view = useView();
  const hasGraph = useEditor((s) => s.graph !== null);
  const loading = useEditor((s) => s.loading);
  const loadError = useEditor((s) => s.loadError);
  const runMode = useRun((s) => s.selectedRunId !== null);
  const graphCount = useRepo((s) => s.graphs?.length ?? 0);
  const [creating, setCreating] = useState(false);

  // The run canvas shows the run's snapshot, whatever state the graph file is in.
  if (runMode) return <Canvas />;
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
        {creating && <PromptDialog title="New graph" label="Name" submitLabel="Create" onSubmit={(name) => void createGraph(view, name)} onClose={() => setCreating(false)} />}
      </Centered>
    );
  }
  return <Canvas />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-muted-foreground">{children}</div>;
}
