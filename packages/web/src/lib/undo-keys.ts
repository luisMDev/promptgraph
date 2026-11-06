import { modalLayerOpen, terminalHasFocus, type KeyEventLike } from "./keymap";

/**
 * Editor undo / redo shortcuts (DESIGN §13): Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo. Matched on
 * `event.key`, like the browser's own undo, so they follow the keyboard layout. Pure.
 */
export function resolveUndoKey(e: KeyEventLike & Pick<KeyboardEvent, "key">): "undo" | "redo" | null {
  if (e.altKey || e.getModifierState?.("AltGraph")) return null;
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.shiftKey) return "redo";
  return null;
}

/** Text fields keep their own undo; the shortcuts only apply to the graph. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * Installs the shortcuts on `win`. Ignored while typing in a field, in a terminal or with a dialog or menu open.
 * Returns teardown.
 */
export function installUndoKeys(win: Window, onAction: (action: "undo" | "redo") => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const action = resolveUndoKey(e);
    if (!action || isTextTarget(e.target) || terminalHasFocus(win.document) || modalLayerOpen(win.document)) return;
    e.preventDefault();
    onAction(action);
  };
  win.addEventListener("keydown", onKeyDown);
  return () => win.removeEventListener("keydown", onKeyDown);
}
