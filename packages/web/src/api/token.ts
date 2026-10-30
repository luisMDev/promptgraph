const STORAGE_KEY = "pg_dev_token";
let cached: string | null = null;

/**
 * Session token. In production the server sets the pg_token cookie from `/?t=` and redirects, so the
 * token is not needed client-side. In dev (vite on another port) `?t=` is read here, kept in
 * sessionStorage and sent as Bearer header / `?t=` on the WS URL.
 */
export function getDevToken(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl) {
    safeSessionSet(fromUrl);
    url.searchParams.delete("t");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return safeSessionGet();
}

function safeSessionGet(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function safeSessionSet(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable: the token still works for this page load via `cached`.
  }
  cached = token;
}

/** getDevToken() memoised for the page lifetime (the URL param is removed after the first read). */
export function devToken(): string | null {
  if (cached === null) cached = getDevToken();
  return cached;
}
