import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas } from "./components/canvas/Canvas";
import { Banners } from "./components/common/Banners";
import { PromptDialog } from "./components/common/PromptDialog";
import { Toasts } from "./components/common/Toasts";
import { Icons } from "./components/common/icons";
import { Button } from "./components/common/ui";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "./components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Header } from "./components/header/Header";
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

  // The sidebar provider wraps the whole shell so the header's SidebarTrigger can toggle the left panel.
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={(open) => useUiStore.getState().setSidebarOpen(open)}
      className="h-full min-h-0 flex-col bg-background text-foreground"
      style={{ "--sidebar-width": "15rem" } as CSSProperties}
    >
      <Header />
      <Banners />
      {reportRunId && <RunReport runId={reportRunId} />}
      {/* `relative` + `overflow-hidden`: the left Sidebar is positioned against this row (not the viewport), so it
          always sits below the header and any banners, and slides out of view when collapsed. */}
      <div className={`relative flex min-h-0 flex-1 overflow-hidden ${reportRunId ? "hidden" : ""}`}>
        <LeftSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CanvasArea />
          </div>
          <TerminalDrawer />
        </main>
        {/* nokey: Backspace/Delete on the inspector's buttons, checkboxes and tabs must not delete canvas items. */}
        <aside className="nokey w-80 shrink-0 border-l bg-card/60">
          <Inspector />
        </aside>
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
        <SidebarHeader className="border-b">
          <TabsList className="w-full">
            <TabsTrigger value="palette" className="text-xs">
              Nodes
            </TabsTrigger>
            {/* Radix only fires onValueChange on change; in run mode "Runs" is already shown even when leftPanel is
                "palette", so a click must still record the choice (as the hand-rolled tab did). */}
            <TabsTrigger value="history" className="text-xs" onClick={() => useUiStore.getState().setLeftPanel("history")}>
              {`Runs${runs ? ` (${runs})` : ""}`}
            </TabsTrigger>
          </TabsList>
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
          <Icons.alert className="mx-auto text-2xl text-red-400" />
          <p className="text-sm font-medium text-red-300">This graph cannot be loaded</p>
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
