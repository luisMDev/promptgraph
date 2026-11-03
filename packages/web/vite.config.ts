import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";
import { proxyGuard } from "./src/lib/vite-proxy-guard";

/**
 * Dev (DESIGN §14 Development): run the daemon (`pnpm --filter @promptgraph/server dev`, or
 * `promptgraph <repo> --foreground`), then `pnpm --filter @promptgraph/web dev`. The daemon's port is
 * PG_DEV_PORT (PG_PORT accepted too), default 4777.
 *
 * The proxy forwards /api, /ws and /login and never adds credentials (it never reads the token). Sign the
 * vite origin in with `promptgraph open --print-url --web-port <vite port>`: it prints a login URL on the
 * vite origin, and the session cookie that /login sets (host 127.0.0.1, any port) then works through the
 * proxy. Requests whose Host is not this dev server, or whose Origin is present and not this dev server,
 * get 403; Sec-Fetch-* go through unchanged so the daemon's Fetch Metadata checks apply; only then are
 * Host and Origin rewritten to the daemon's.
 */
const port = process.env.PG_DEV_PORT ?? process.env.PG_PORT ?? "4777";
const target = `http://127.0.0.1:${port}`;
const ALLOWED_HOSTS = ["127.0.0.1", "localhost"];

/** The web build embeds the promptgraph version (DESIGN §13.5): the daemon's package version. */
const serverPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../server/package.json", import.meta.url)), "utf8")) as { version: string };

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Runs before every proxied HTTP request (res set) and WebSocket upgrade (res undefined). */
function guard(req: IncomingMessage, res: ServerResponse | undefined): string | undefined {
  const reason = proxyGuard({ host: req.headers.host, origin: header(req.headers.origin) }, { allowedHosts: ALLOWED_HOSTS, port: req.socket.localPort ?? 0 });
  if (!reason) return undefined;
  if (res) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Forbidden: ${reason}\n`);
  } else {
    req.socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
  // A string stops vite: the response (or the socket) is already ended.
  return req.url ?? "/";
}

/** The daemon rejects foreign Host/Origin headers (DNS-rebinding protection): present as the daemon itself. */
const toDaemon: ProxyOptions = {
  target,
  changeOrigin: true,
  bypass: guard,
  configure: (proxy) => {
    proxy.on("proxyReq", (req) => {
      if (req.getHeader("origin")) req.setHeader("origin", target);
    });
    proxy.on("proxyReqWs", (req) => {
      if (req.getHeader("origin")) req.setHeader("origin", target);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __PG_VERSION__: JSON.stringify(serverPackage.version) },
  resolve: { conditions: ["source"], alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    allowedHosts: ALLOWED_HOSTS,
    proxy: {
      "/api": toDaemon,
      "/login": toDaemon,
      "/ws": { ...toDaemon, target: target.replace("http", "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Long-lived vendor code in its own chunk; xterm and diff2html are split off by the lazy imports.
        manualChunks: (id) => (/node_modules\/(\.pnpm\/)?(react|react-dom|scheduler|@xyflow|d3-[a-z]+|zustand)[@/]/.test(id) ? "vendor" : undefined),
      },
    },
  },
});
