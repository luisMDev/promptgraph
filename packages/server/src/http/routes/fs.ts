import { ListDirsQuerySchema, type ListDirsResponse } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { listDirs } from "../../daemon/dir-browser.js";
import type { App } from "../repo-scope.js";

/** GET /api/fs/dirs?path=&hidden=1 (DESIGN §12.1): the folder picker of Home's "Add repository" (§13.3). */
export function registerFsRoutes(app: App, daemon: DaemonContext): void {
  app.get("/api/fs/dirs", async (c) => {
    const { path, hidden } = ListDirsQuerySchema.parse(c.req.query());
    return c.json<ListDirsResponse>(await listDirs(path, { env: daemon.env, hidden: hidden === "1" }));
  });
}
