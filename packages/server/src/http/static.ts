import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT_PAGE = `<!doctype html><meta charset="utf-8"><title>promptgraph</title>
<p>The web UI has not been built. Run <code>pnpm build</code> (or <code>pnpm --filter @promptgraph/web dev</code> for development).</p>`;

/** Paths owned by the API; never answered with the SPA. */
const RESERVED = /^\/(api|hooks|ws)(\/|$)/;

/** Serves webDistDir() assets; unknown non-API GET paths fall back to index.html. Missing dist → 503 hint page. */
export function registerStatic(app: Hono, distDir: string): void {
  const root = path.resolve(distDir);
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    const pathname = safeDecode(new URL(c.req.url).pathname);
    if (pathname === null) return c.text("Bad request", 400);
    if (RESERVED.test(pathname)) return next();
    const index = path.join(root, "index.html");
    if (!fs.existsSync(index)) return c.html(NOT_BUILT_PAGE, 503);

    const file = path.resolve(root, `.${pathname}`);
    const inside = file === root || file.startsWith(root + path.sep);
    if (inside && isFile(file)) {
      const immutable = pathname.startsWith("/assets/");
      return serveFile(file, immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    // Missing files with an extension are real 404s; anything else is a client-side route.
    if (path.extname(pathname)) return c.text("Not found", 404);
    return serveFile(index, "no-cache");
  });
}

function safeDecode(p: string): string | null {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function serveFile(file: string, cacheControl: string): Response {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(fs.readFileSync(file), { headers: { "content-type": type, "cache-control": cacheControl } });
}
