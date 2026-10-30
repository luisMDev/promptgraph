import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** Dev: `pnpm --filter @promptgraph/server dev` (port 4777) + `pnpm --filter @promptgraph/web dev`; open the vite URL with ?t=<token>. */
const server = `http://127.0.0.1:${process.env.PG_PORT ?? 4777}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["source"] },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": server,
      "/hooks": server,
      "/ws": { target: server.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
