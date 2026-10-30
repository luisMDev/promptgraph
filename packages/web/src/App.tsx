import { useEffect, useState, type ReactNode } from "react";
import { ApprovalDialog } from "./components/approval/ApprovalDialog";
import { Canvas } from "./components/canvas/Canvas";
import { Banners } from "./components/common/Banners";
import { PromptDialog } from "./components/common/PromptDialog";
import { Toasts } from "./components/common/Toasts";
import { Icons } from "./components/common/icons";
import { Button } from "./components/common/ui";
import { Header } from "./components/header/Header";
import { RunHistory } from "./components/history/RunHistory";
import { Inspector } from "./components/inspector/Inspector";
import { Palette } from "./components/palette/Palette";
import { TerminalDrawer } from "./components/terminal/TerminalDrawer";
import { createGraph, openInitialGraph, startLiveUpdates } from "./store/app-actions";
import { useAppStore } from "./store/app-store";
import { useEditorStore } from "./store/editor-store";
import { useRunStore } from "./store/run-store";
import { useUiStore, type LeftPanel } from "./store/ui-store";

/** Layout shell: header / palette | canvas | inspector / terminal drawer (§13). */
export function App() {
  const bootError = useAppStore((s) => s.bootError);
  const booted = useAppStore((s) => s.repo !== null);

  useEffect(() => {
    const stop = startLiveUpdates();
    void (async () => {
      await useAppStore.getState().boot();
      const repo = useAppStore.getState().repo;
      if (!repo) return;
      useEditorStore.getState().setPhase(repo.phase);
      await openInitialGraph();
    })();
    return stop;
  }, []);

  if (bootError) return <FullScreenMessage title="Cannot reach the promptgraph server" detail={bootError} />;
  if (!booted) return <FullScreenMessage title="Loading…" />;

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
      <Header />
      <Banners />
      <div className="flex min-h-0 flex-1">
        <LeftSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CanvasArea />
          </div>
          <TerminalDrawer />
        </main>
        <aside className="w-80 shrink-0 border-l border-zinc-800 bg-zinc-900/60">
          <Inspector />
        </aside>
      </div>
      <ApprovalDialog />
      <Toasts />
    </div>
  );
}

function LeftSidebar() {
  const panel = useUiStore((s) => s.leftPanel);
  const runMode = useRunStore((s) => s.selectedRunId !== null);
  const runs = useRunStore((s) => s.runs.length);
  const shown: LeftPanel = runMode ? "history" : panel;
  const tab = (id: LeftPanel, label: string) => (
    <button
      type="button"
      onClick={() => {
        useUiStore.getState().setLeftPanel(id);
        if (id === "palette" && runMode) void useRunStore.getState().selectRun(null);
      }}
      className={`flex-1 border-b-2 py-2 text-xs font-medium ${shown === id ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
    >
      {label}
    </button>
  );
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
      <div className="flex shrink-0 border-b border-zinc-800">
        {tab("palette", "Nodes")}
        {tab("history", `Runs${runs ? ` (${runs})` : ""}`)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{shown === "palette" ? <Palette /> : <RunHistory />}</div>
    </aside>
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
          <pre className="rounded-md bg-zinc-900 p-3 text-left text-xs whitespace-pre-wrap text-zinc-400">{loadError}</pre>
          <p className="text-xs text-zinc-500">Fix the JSON file in .promptgraph/graphs/ or delete it from the graph menu.</p>
        </div>
      </Centered>
    );
  }
  if (!hasGraph) {
    return (
      <Centered>
        <div className="space-y-3 text-center">
          <p className="text-sm text-zinc-400">{graphCount ? "Select a graph from the menu above." : "No graphs in this repository yet."}</p>
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
  return <div className="flex h-full items-center justify-center p-6 text-zinc-500">{children}</div>;
}

function FullScreenMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-zinc-950 p-6 text-center">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      {detail && <p className="max-w-lg text-xs text-zinc-500">{detail}</p>}
      {detail && <p className="max-w-lg text-xs text-zinc-500">Open the URL printed by the promptgraph command (it carries the session token).</p>}
    </div>
  );
}
