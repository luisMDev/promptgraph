import type { TabChats } from "./tabs-store";
import { MAX_TAB_CHATS } from "./tabs-store";

/**
 * The bottom chat bar of a tab (DESIGN §21.11), as pure transitions of its `TabChats`: which chats sit in the bar
 * (oldest first) and which one's window is open. At most one window is open per tab.
 */

/** Adds a chat to the bar (if missing; the oldest is dropped beyond MAX_TAB_CHATS) and opens its window. */
export function openChat(chats: TabChats | null, repoId: string, id: string): TabChats {
  const ids = chats && chats.repoId === repoId ? chats.ids : [];
  const next = ids.includes(id) ? ids : [...ids, id].slice(-MAX_TAB_CHATS);
  return { repoId, ids: next, open: id };
}

/** A click on a chat in the bar: opens its window, or minimises it when it is the open one. */
export function toggleChat(chats: TabChats, id: string): TabChats {
  return { ...chats, open: chats.open === id ? null : id };
}

export function minimizeChats(chats: TabChats): TabChats {
  return { ...chats, open: null };
}

/** Removes a chat from the bar (the session itself is kept); null when the bar is left empty. */
export function closeChat(chats: TabChats, id: string): TabChats | null {
  const ids = chats.ids.filter((x) => x !== id);
  if (ids.length === 0) return null;
  return { ...chats, ids, open: chats.open === id ? null : chats.open };
}

/** A session was deleted: it leaves every bar. */
export function dropDeleted(chats: TabChats | null, exists: (id: string) => boolean): TabChats | null {
  if (!chats) return null;
  const ids = chats.ids.filter(exists);
  if (ids.length === chats.ids.length) return chats;
  if (ids.length === 0) return null;
  return { ...chats, ids, open: chats.open && ids.includes(chats.open) ? chats.open : null };
}

/**
 * What the chat shortcut does: minimise the open window, else reopen the newest chat of the bar; "new" when the bar
 * is empty (the caller creates a session first).
 */
export function shortcutTarget(chats: TabChats | null): { kind: "minimize" } | { kind: "open"; id: string } | { kind: "new" } {
  if (chats?.open) return { kind: "minimize" };
  const last = chats?.ids.at(-1);
  return last ? { kind: "open", id: last } : { kind: "new" };
}
