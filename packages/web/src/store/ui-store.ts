/** UI chrome: terminal drawer tabs/height, open dialogs. */
export interface UiState {
  /** ptyIds open as terminal tabs, in order. */
  terminalTabs: string[];
  activeTerminal: string | null;
  drawerHeight: number;
  approvalNodeRunId: string | null;
  settingsOpen: boolean;
}
