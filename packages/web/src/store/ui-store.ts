import { create } from "zustand";

/** UI chrome: terminal drawer tabs/height, open dialogs. */
export interface UiState {
  /** ptyIds open as terminal tabs, in order. */
  terminalTabs: string[];
  activeTerminal: string | null;
  drawerHeight: number;
  approvalNodeRunId: string | null;
  settingsOpen: boolean;
  /** Diff dialog: one node's changes (with a switch to its whole lane), or a lane of a run. */
  diffTarget: DiffTarget | null;
  /** Run whose report (§13.1) replaces the editor/canvas view. */
  reportRunId: string | null;
}

export type DiffTarget =
  | { kind: "node"; nodeRunId: string; title: string }
  | { kind: "lane"; runId: string; laneId: string; title: string };

export interface TerminalTabMeta {
  title: string;
  /** Node run the terminal belongs to (null for ad-hoc PTYs such as Reopen session). */
  nodeRunId: string | null;
}

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

export type LeftPanel = "palette" | "history";

export interface UiStore extends UiState {
  tabMeta: Record<string, TerminalTabMeta>;
  drawerOpen: boolean;
  leftPanel: LeftPanel;
  /** Left sidebar expanded (it collapses off-canvas via its header trigger or its edge rail). */
  sidebarOpen: boolean;
  /** Right sidebar (inspector) expanded (it collapses off-canvas via its edge rail). */
  inspectorOpen: boolean;
  /** Sidebar widths in px, resized by dragging their edge rail; persisted in localStorage. */
  sidebarWidth: number;
  inspectorWidth: number;
  toasts: Toast[];
  /** Node the edit canvas should pan to when it is outside the viewport (palette click-to-append). */
  revealNodeId: string | null;

  revealNode(nodeId: string | null): void;
  openTerminal(ptyId: string, meta: TerminalTabMeta): void;
  closeTerminal(ptyId: string): void;
  setActiveTerminal(ptyId: string): void;
  closeAllTerminals(): void;
  setDrawerOpen(open: boolean): void;
  setDrawerHeight(px: number): void;
  openApproval(nodeRunId: string | null): void;
  setSettingsOpen(open: boolean): void;
  openDiff(target: DiffTarget | null): void;
  openReport(runId: string | null): void;
  /** Shows a left panel, expanding the sidebar if it was collapsed. */
  setLeftPanel(panel: LeftPanel): void;
  setSidebarOpen(open: boolean): void;
  setInspectorOpen(open: boolean): void;
  setSidebarWidth(px: number): void;
  setInspectorWidth(px: number): void;
  toast(kind: Toast["kind"], message: string): void;
  dismissToast(id: number): void;
}

export const MIN_DRAWER_HEIGHT = 120;
const TOAST_MS = 6000;
let toastSeq = 0;

export const SIDEBAR_WIDTH = { min: 192, max: 480, default: 240 } as const;
export const INSPECTOR_WIDTH = { min: 256, max: 640, default: 320 } as const;
const WIDTH_KEYS = { sidebar: "promptgraph.sidebarWidth", inspector: "promptgraph.inspectorWidth" } as const;

export function clampWidth(px: number, bounds: { min: number; max: number }): number {
  return Math.round(Math.max(bounds.min, Math.min(px, bounds.max)));
}

function loadWidth(key: string, bounds: { min: number; max: number; default: number }): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return stored ? clampWidth(stored, bounds) : bounds.default;
  } catch {
    return bounds.default;
  }
}

function saveWidth(key: string, px: number): void {
  try {
    localStorage.setItem(key, String(px));
  } catch {
    // Storage unavailable (private mode, quota): the width just won't survive a reload.
  }
}

export function clampDrawerHeight(px: number, viewport: number): number {
  return Math.round(Math.max(MIN_DRAWER_HEIGHT, Math.min(px, Math.max(MIN_DRAWER_HEIGHT, viewport - 160))));
}

export const useUiStore = create<UiStore>()((set, get) => ({
  terminalTabs: [],
  activeTerminal: null,
  drawerHeight: 300,
  approvalNodeRunId: null,
  settingsOpen: false,
  diffTarget: null,
  reportRunId: null,
  tabMeta: {},
  drawerOpen: false,
  leftPanel: "palette",
  sidebarOpen: true,
  inspectorOpen: true,
  sidebarWidth: loadWidth(WIDTH_KEYS.sidebar, SIDEBAR_WIDTH),
  inspectorWidth: loadWidth(WIDTH_KEYS.inspector, INSPECTOR_WIDTH),
  toasts: [],
  revealNodeId: null,

  revealNode(nodeId) {
    set({ revealNodeId: nodeId });
  },

  openTerminal(ptyId, meta) {
    const s = get();
    set({
      terminalTabs: s.terminalTabs.includes(ptyId) ? s.terminalTabs : [...s.terminalTabs, ptyId],
      tabMeta: { ...s.tabMeta, [ptyId]: meta },
      activeTerminal: ptyId,
      drawerOpen: true,
    });
  },

  closeTerminal(ptyId) {
    const s = get();
    const i = s.terminalTabs.indexOf(ptyId);
    if (i === -1) return;
    const terminalTabs = s.terminalTabs.filter((t) => t !== ptyId);
    const { [ptyId]: _closed, ...tabMeta } = s.tabMeta;
    const activeTerminal = s.activeTerminal === ptyId ? (terminalTabs[Math.min(i, terminalTabs.length - 1)] ?? null) : s.activeTerminal;
    set({ terminalTabs, tabMeta, activeTerminal, drawerOpen: terminalTabs.length > 0 && s.drawerOpen });
  },

  setActiveTerminal(ptyId) {
    if (get().terminalTabs.includes(ptyId)) set({ activeTerminal: ptyId, drawerOpen: true });
  },

  closeAllTerminals() {
    set({ terminalTabs: [], tabMeta: {}, activeTerminal: null, drawerOpen: false });
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open });
  },

  setDrawerHeight(px) {
    set({ drawerHeight: px });
  },

  openApproval(nodeRunId) {
    set({ approvalNodeRunId: nodeRunId });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  openDiff(target) {
    set({ diffTarget: target });
  },

  openReport(runId) {
    set({ reportRunId: runId });
  },

  setLeftPanel(panel) {
    set({ leftPanel: panel, sidebarOpen: true });
  },

  setSidebarOpen(open) {
    set({ sidebarOpen: open });
  },

  setInspectorOpen(open) {
    set({ inspectorOpen: open });
  },

  setSidebarWidth(px) {
    const sidebarWidth = clampWidth(px, SIDEBAR_WIDTH);
    set({ sidebarWidth });
    saveWidth(WIDTH_KEYS.sidebar, sidebarWidth);
  },

  setInspectorWidth(px) {
    const inspectorWidth = clampWidth(px, INSPECTOR_WIDTH);
    set({ inspectorWidth });
    saveWidth(WIDTH_KEYS.inspector, inspectorWidth);
  },

  toast(kind, message) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), TOAST_MS);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
