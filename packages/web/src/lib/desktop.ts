import { DESKTOP_COMMANDS } from "@promptgraph/shared";

/**
 * The desktop bridge (DESIGN §20.2, CONTRACTS §12.5): what the page may ask of the Tauri shell, through the
 * global API it injects (`withGlobalTauri`) and the runtime capability of the daemon's origin. The web
 * package does not depend on `@tauri-apps/api`: the few calls it makes are typed here. In a browser the
 * bridge is inert and nothing desktop-specific renders.
 */
export type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

export interface DesktopBridge {
  /** The page runs in the promptgraph desktop window. */
  isDesktop: boolean;
  /** The window has no native frame: the tab strip is the title bar (`PG_DESKTOP_DECORATIONS`). */
  customTitleBar: boolean;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  startResizeDragging(direction: ResizeDirection): Promise<void>;
  setTitle(title: string): Promise<void>;
  /** Opens an `https:` URL in the system browser; anything else is ignored. */
  openExternal(url: string): Promise<void>;
  /** Re-runs the CLI with `--next <next>` and navigates the window to a fresh login URL (§20.3). */
  relogin(next: string): Promise<void>;
}

/** The parts of `window.__TAURI__` the bridge uses (Tauri v2 global API). */
interface TauriWindowHandle {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  startResizeDragging(direction: ResizeDirection): Promise<void>;
  setTitle(title: string): Promise<void>;
}

export interface TauriGlobal {
  core: { invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  window: { getCurrentWindow(): TauriWindowHandle };
  opener: { openUrl(url: string): Promise<void> };
}

/** Set by the shell's initialization script. */
export interface PgDesktopGlobal {
  customTitleBar: boolean;
}

export type DesktopWindowLike = { __TAURI__?: Partial<TauriGlobal>; __PG_DESKTOP__?: Partial<PgDesktopGlobal> };

const resolved = Promise.resolve();

export const inertDesktopBridge: DesktopBridge = Object.freeze({
  isDesktop: false,
  customTitleBar: false,
  minimize: () => resolved,
  toggleMaximize: () => resolved,
  isMaximized: () => Promise.resolve(false),
  close: () => resolved,
  startResizeDragging: () => resolved,
  setTitle: () => resolved,
  openExternal: () => resolved,
  relogin: () => Promise.reject(new Error("not in the desktop window")),
});

/** Whether `url` may go to the system browser: absolute `https:` only. */
export function isExternalUrlAllowed(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The bridge over a window's globals: inert unless the Tauri global API is there. */
export function createDesktopBridge(win: DesktopWindowLike): DesktopBridge {
  const tauri = win.__TAURI__;
  if (typeof tauri?.core?.invoke !== "function" || typeof tauri.window?.getCurrentWindow !== "function") return inertDesktopBridge;
  const { core, window: windowApi } = tauri as Pick<TauriGlobal, "core" | "window">;
  const opener = tauri.opener;
  const current = () => windowApi.getCurrentWindow();
  return {
    isDesktop: true,
    customTitleBar: win.__PG_DESKTOP__?.customTitleBar === true,
    minimize: () => current().minimize(),
    toggleMaximize: () => current().toggleMaximize(),
    isMaximized: () => current().isMaximized(),
    close: () => current().close(),
    startResizeDragging: (direction) => current().startResizeDragging(direction),
    setTitle: (title) => current().setTitle(title),
    openExternal: async (url) => {
      if (!isExternalUrlAllowed(url) || !opener) return;
      await opener.openUrl(url);
    },
    relogin: async (next) => {
      await core.invoke(DESKTOP_COMMANDS.relogin, { next });
    },
  };
}

let current: DesktopBridge | null = null;

/** The page's bridge (created on first use from `window`). */
export function getDesktopBridge(): DesktopBridge {
  current ??= typeof window === "undefined" ? inertDesktopBridge : createDesktopBridge(window as unknown as DesktopWindowLike);
  return current;
}

/** Tests: replace the page's bridge (null = derive it from `window` again). */
export function setDesktopBridge(bridge: DesktopBridge | null): void {
  current = bridge;
}

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * The desktop window has no tabs of its own, so links to other origins, and links with `target=_blank`,
 * go to the system browser (`https:` only; others are dropped) instead of navigating or opening a webview
 * window (DESIGN §13.2, §20.2). One delegated `click`/`auxclick` listener on the document, in the capture
 * phase so it runs before any React handler. Same-origin links without a target are left alone (in-app
 * `<Link>`s handle their own clicks). Returns teardown.
 */
export function installExternalLinkHandler(bridge: DesktopBridge, doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    if (e.type === "click" ? e.button !== 0 : e.button !== 1) return;
    const target = e.target as Node | null;
    const el = target && target.nodeType === 1 ? (target as Element) : (target?.parentElement ?? null);
    const anchor = el?.closest("a[href]");
    if (!anchor || anchor.namespaceURI !== XHTML) return;
    const { href, target: linkTarget } = anchor as HTMLAnchorElement;
    let url: URL;
    try {
      url = new URL(href, doc.baseURI);
    } catch {
      return;
    }
    if (url.origin === doc.location.origin && linkTarget !== "_blank") return;
    e.preventDefault();
    if (url.protocol === "https:") void bridge.openExternal(url.href).catch(() => {});
  };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);
  return () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("auxclick", onClick, true);
  };
}

/**
 * The handler for the links xterm detects in a terminal (`WebLinksAddon`). The addon's default calls
 * `window.open()` without a URL and sets its location afterwards, which the shell's new-window guard denies
 * (it only sees about:blank), so in the desktop window terminal links go to `openExternal` instead
 * (`https:` only). In a browser: undefined, the addon's default (a new tab).
 */
export function terminalLinkHandler(bridge: DesktopBridge): ((event: MouseEvent, uri: string) => void) | undefined {
  if (!bridge.isDesktop) return undefined;
  return (_event, uri) => void bridge.openExternal(uri).catch(() => {});
}

/** Delay before an unreachable desktop window asks the shell to sign in again (DESIGN §13.5). */
export const DESKTOP_RELOGIN_AFTER_MS = 10_000;

/**
 * An automatic `relogin` for the same reason is not repeated within this window, across page loads: a
 * successful call navigates to a new page, which must not start the next attempt by itself if it comes
 * back signed out or unreachable (DESIGN §13.5).
 */
export const DESKTOP_RELOGIN_COOLDOWN_MS = 60_000;

/** The path to come back to after `relogin`: the window URL's path (it mirrors the active tab, §13.2). */
export function currentPagePath(loc: Pick<Location, "pathname"> = window.location): string {
  return loc.pathname || "/";
}
