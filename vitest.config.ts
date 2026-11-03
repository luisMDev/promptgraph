import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"], alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx", "packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    // A fresh PG_HOME per run, so nothing falls back to the user's real ~/.promptgraph.
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./packages/web/src/test-setup.ts"],
  },
});
