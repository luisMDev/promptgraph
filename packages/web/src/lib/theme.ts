import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

/** localStorage key; index.html reads it too, to set the class before the first paint. Keep both in sync. */
export const THEME_STORAGE_KEY = "pg-theme";

const listeners = new Set<() => void>();

/** The active theme: the `dark` class on <html>, set by index.html (dark unless "light" was stored). */
export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Switches the theme and remembers it in this browser. A UI preference, so it is not sent to the server. */
export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, quota): the choice then lasts until reload.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the active theme, re-rendering on setTheme. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "dark");
}
