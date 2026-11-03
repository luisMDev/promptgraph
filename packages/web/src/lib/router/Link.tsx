import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { useLocation } from "./location";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** In-app path (`webRoutes`). */
  to: string;
  /** A plain click replaces the current history entry. */
  replace?: boolean;
}

/** What a click on an in-app link does (DESIGN §13.2). */
export type LinkAction = { kind: "navigate" } | { kind: "newTab"; activate: boolean } | { kind: "default" };

/**
 * Plain left click → navigate this view; Ctrl/Cmd-click → background tab; Ctrl/Cmd+Shift-click → foreground
 * tab. Any other modifier (Shift or Alt alone) is left to the browser.
 */
export function linkClickAction(e: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): LinkAction {
  if (e.button !== 0) return { kind: "default" };
  const mod = e.ctrlKey || e.metaKey;
  if (mod) return { kind: "newTab", activate: e.shiftKey };
  if (e.shiftKey || e.altKey) return { kind: "default" };
  return { kind: "navigate" };
}

/**
 * A real `<a href>` for every in-app navigation target, so the browser (and the desktop shell) know where
 * it leads: a plain click navigates the current view, Ctrl/Cmd-click or a middle click opens a background
 * tab, Ctrl/Cmd+Shift-click a foreground tab. `onClick` runs first; calling `preventDefault` there cancels
 * the navigation.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, replace, onClick, onAuxClick, target, ...rest }, ref) {
  const { navigate, openInNewTab } = useLocation();
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || (target && target !== "_self")) return;
    const action = linkClickAction(e);
    if (action.kind === "default") return;
    e.preventDefault();
    if (action.kind === "navigate") navigate(to, { replace });
    else openInNewTab(to, { activate: action.activate });
  };
  const handleAuxClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onAuxClick?.(e);
    if (e.defaultPrevented || e.button !== 1) return;
    e.preventDefault();
    openInNewTab(to, { activate: false });
  };
  return <a ref={ref} href={to} target={target} onClick={handleClick} onAuxClick={handleAuxClick} {...rest} />;
});
