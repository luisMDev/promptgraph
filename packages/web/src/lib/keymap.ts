/**
 * Tab shortcuts (DESIGN §13.4): one pure resolver from a keydown to an action. Letters and digits match
 * `event.code` (the physical key), so they work on every keyboard layout; an event with AltGraph set is
 * never a shortcut. While a terminal has focus only tab switching is handled: Claude Code and readline use
 * Ctrl+W, Ctrl+T, Alt+letters and Alt+digits themselves.
 */
export type KeyAction =
  | { type: "newTab" }
  | { type: "closeTab" }
  | { type: "reopenClosed" }
  | { type: "nextTab" }
  | { type: "prevTab" }
  /** 1-based tab number (1–8). */
  | { type: "gotoTab"; n: number }
  | { type: "lastTab" };

export interface KeyContext {
  /** The desktop window (Ctrl bindings) rather than a browser tab (Alt fallbacks only). */
  desktop: boolean;
  /** Focus is inside a terminal. */
  terminalFocused: boolean;
}

export type KeyEventLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> & {
  getModifierState?(key: string): boolean;
};

type Mods = "ctrl" | "ctrl+shift" | "alt" | "alt+shift";

function mods(e: KeyEventLike): Mods | null {
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey) return e.shiftKey ? "ctrl+shift" : "ctrl";
  if (e.altKey && !e.ctrlKey) return e.shiftKey ? "alt+shift" : "alt";
  return null;
}

function digit(code: string): number | null {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

/** Tab switching: available everywhere, also while a terminal has focus. */
function switching(code: string, m: Mods, desktop: boolean): KeyAction | null {
  if (m === "alt" && code === "PageDown") return { type: "nextTab" };
  if (m === "alt" && code === "PageUp") return { type: "prevTab" };
  if (!desktop) return null;
  if (m === "ctrl" && code === "Tab") return { type: "nextTab" };
  if (m === "ctrl+shift" && code === "Tab") return { type: "prevTab" };
  if (m === "ctrl" && code === "PageDown") return { type: "nextTab" };
  if (m === "ctrl" && code === "PageUp") return { type: "prevTab" };
  return null;
}

/** Everything else, for one modifier family (Ctrl in the desktop window, Alt everywhere). */
function management(code: string, m: Mods, family: "ctrl" | "alt"): KeyAction | null {
  const shift = m === `${family}+shift`;
  if (m !== family && !shift) return null;
  if (code === "KeyT") return shift ? { type: "reopenClosed" } : { type: "newTab" };
  if (shift) return null;
  if (code === "KeyW") return { type: "closeTab" };
  const n = digit(code);
  if (n === 9) return { type: "lastTab" };
  if (n !== null) return { type: "gotoTab", n };
  return null;
}

export function resolveKey(e: KeyEventLike, ctx: KeyContext): KeyAction | null {
  if (e.getModifierState?.("AltGraph")) return null;
  const m = mods(e);
  if (!m) return null;
  const sw = switching(e.code, m, ctx.desktop);
  if (sw) return sw;
  if (ctx.terminalFocused) return null;
  return management(e.code, m, "alt") ?? (ctx.desktop ? management(e.code, m, "ctrl") : null);
}

/** Whether focus is in an xterm instance (its helper textarea lives inside `.xterm`). */
export function terminalHasFocus(doc: Document = document): boolean {
  const el = doc.activeElement;
  return !!el && typeof el.closest === "function" && el.closest(".xterm") !== null;
}

/**
 * Whether a modal layer (a dialog or an open menu) is open. Radix portals these to `document.body`, outside
 * the tab views, and they trap focus and lock the pointer: tab shortcuts wait until they close.
 */
export function modalLayerOpen(doc: Document = document): boolean {
  return doc.querySelector("[role=dialog], [role=alertdialog], [role=menu]") !== null;
}

/**
 * Installs the resolver on `window` in the capture phase, so the page sees the keys before React Flow,
 * inputs or a terminal do. A handled key is not passed on. Nothing is handled while a modal layer is open.
 * Returns teardown.
 */
export function installKeymap(win: Window, opts: { desktop: () => boolean; onAction: (action: KeyAction) => void }): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat && !(e.code === "Tab" || e.code === "PageDown" || e.code === "PageUp")) return;
    if (modalLayerOpen(win.document)) return;
    const action = resolveKey(e, { desktop: opts.desktop(), terminalFocused: terminalHasFocus(win.document) });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    opts.onAction(action);
  };
  win.addEventListener("keydown", onKeyDown, true);
  return () => win.removeEventListener("keydown", onKeyDown, true);
}
