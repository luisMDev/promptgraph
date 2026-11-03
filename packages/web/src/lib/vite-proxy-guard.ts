/**
 * Guard of the vite dev server's proxy to the daemon (DESIGN §14 Development). Pure, so it is tested
 * without a server; `vite.config.ts` runs it before proxying any HTTP request or WebSocket upgrade.
 *
 * A request passes only when its `Host` is the vite server itself (an allowed name on the port vite
 * listens on) and its `Origin`, when present, is that same origin. Anything else gets 403, so pages of
 * other local origins cannot use the vite origin's session cookie through the proxy, and DNS-rebinding
 * names never reach the daemon. The proxy adds no credential; Sec-Fetch-* headers go through unchanged.
 */

export interface ProxyGuardOptions {
  /** Host names the vite server answers to (`server.allowedHosts`). */
  allowedHosts: readonly string[];
  /** Port vite listens on (the request socket's local port). */
  port: number;
}

export interface ProxyGuardRequest {
  host: string | undefined;
  origin: string | undefined;
}

/** null when the request may be proxied, else why it is refused (answered with 403). */
export function proxyGuard(req: ProxyGuardRequest, opts: ProxyGuardOptions): string | null {
  if (!req.host) return "missing Host header";
  const m = /^([^:]+):(\d+)$/.exec(req.host.toLowerCase());
  if (!m || !opts.allowedHosts.includes(m[1]!) || Number(m[2]) !== opts.port) return `Host ${req.host} is not this dev server`;
  if (req.origin !== undefined && req.origin !== `http://${req.host.toLowerCase()}`) return `Origin ${req.origin} is not this dev server`;
  return null;
}
