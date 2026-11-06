import { createContext, useContext } from "react";
import type { TabChats } from "../../store/tabs-store";
import type { EditorStoreApi } from "../../store/view/editor-store";

/**
 * What a view knows about the in-app tab it is mounted in (DESIGN §13.4). Absent outside the tabbed app
 * (tests rendering one view): the view is then always active.
 */
export interface TabContextValue {
  tabId: string;
  /** The visible tab. Hidden views stay mounted but open no terminals and react to no keys. */
  active: boolean;
  /** The title derived from the view's data (persisted with the tab). */
  setTitle(title: string): void;
  close(): void;
  /** The editor store the view shows: a view whose editor is dirty or saving is never evicted. */
  reportEditor(editor: EditorStoreApi | null): void;
  /** The tab's chats (§21.11), persisted with the tab. */
  chats: TabChats | null;
  setChats(chats: TabChats | null): void;
  /** The bottom bar below the tab's panel: views portal their items into its end (the chat bar) and start (account and
   * Claude Code status); null until mounted. */
  bottomBar: HTMLElement | null;
  bottomBarStart: HTMLElement | null;
}

export const TabContext = createContext<TabContextValue | null>(null);

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}
