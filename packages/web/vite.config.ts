import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * Dev: `pnpm --filter @promptgraph/server dev` (port 4777) + `pnpm --filter @promptgraph/web dev`; open the vite
 * URL with ?t=<token>. The server port is PG_DEV_PORT (PG_PORT accepted too), default 4777.
 */
const port = process.env.PG_DEV_PORT ?? process.env.PG_PORT ?? "4777";
const target = `http://127.0.0.1:${port}`;

/** The server rejects foreign Host/Origin headers (DNS-rebinding protection), so present as the server itself. */
const asServer: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (req) => {
      if (req.getHeader("origin")) req.setHeader("origin", target);
    });
    proxy.on("proxyReqWs", (req) => {
      req.setHeader("origin", target);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["source"] },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": asServer,
      "/hooks": asServer,
      "/ws": { ...asServer, target: target.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 1600 },
});
