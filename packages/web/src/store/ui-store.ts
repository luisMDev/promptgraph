import { create } from "zustand";

/** UI chrome: terminal drawer tabs/height, open dialogs. */
export interface UiState {
  /** ptyIds open as terminal tabs, in order. */
  terminalTabs: string[];
  activeTerminal: string | null;
  drawerHeight: number;
  approvalNodeRunId: string | null;
  settingsOpen: boolean;
}

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
  toasts: Toast[];

  openTerminal(ptyId: string, meta: TerminalTabMeta): void;
  closeTerminal(ptyId: string): void;
  setActiveTerminal(ptyId: string): void;
  closeAllTerminals(): void;
  setDrawerOpen(open: boolean): void;
  setDrawerHeight(px: number): void;
  openApproval(nodeRunId: string | null): void;
  setSettingsOpen(open: boolean): void;
  setLeftPanel(panel: LeftPanel): void;
  toast(kind: Toast["kind"], message: string): void;
  dismissToast(id: number): void;
}

export const MIN_DRAWER_HEIGHT = 120;
const TOAST_MS = 6000;
let toastSeq = 0;

export function clampDrawerHeight(px: number, viewport: number): number {
  return Math.round(Math.max(MIN_DRAWER_HEIGHT, Math.min(px, Math.max(MIN_DRAWER_HEIGHT, viewport - 160))));
}

export const useUiStore = create<UiStore>()((set, get) => ({
  terminalTabs: [],
  activeTerminal: null,
  drawerHeight: 300,
  approvalNodeRunId: null,
  settingsOpen: false,
  tabMeta: {},
  drawerOpen: false,
  leftPanel: "palette",
  toasts: [],

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

  setLeftPanel(panel) {
    set({ leftPanel: panel });
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
