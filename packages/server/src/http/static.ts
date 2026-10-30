import type { Hono } from "hono";

/** Serves webDistDir() assets; unknown non-API GET paths fall back to index.html. Missing dist → 503 hint page. */
export function registerStatic(app: Hono, distDir: string): void {
  throw new Error("not implemented");
}
