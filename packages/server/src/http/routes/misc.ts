import path from "node:path";
import {
  UpdateAppSettingsRequestSchema,
  type AppSettings,
  type ListCommandsResponse,
  type RepoInfoResponse,
  type UpdateAppSettingsRequest,
} from "@promptgraph/shared";
import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";
import { SUPPORTED_PHASE, VERSION } from "../../config/version.js";
import { listSlashCommands } from "../../commands/discover.js";
import { currentBranch, listBranches } from "../../git/repo.js";
import { readJson } from "../errors.js";

/** GET /api/repo · GET/PUT /api/settings · GET /api/commands */
export function registerMiscRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/repo", async (c) => {
    const [branch, branches, notifyPlatform] = await Promise.all([
      currentBranch(ctx.repo.path),
      listBranches(ctx.repo.path),
      ctx.notifier.detectPlatform(),
    ]);
    return c.json<RepoInfoResponse>({
      path: ctx.repo.path,
      name: ctx.repo.name || path.basename(ctx.repo.path),
      currentBranch: branch,
      branches,
      version: VERSION,
      phase: SUPPORTED_PHASE,
      warnings: ctx.warnings,
      supportedNodeTypes: ctx.engine.supportedNodeTypes(),
      notificationsAvailable: notifyPlatform !== "none",
    });
  });

  app.get("/api/settings", (c) => c.json<AppSettings>(ctx.settings.get()));
  app.put("/api/settings", async (c) => {
    // Validate, but pass the raw patch on: parsing fills defaults for keys the client did not send.
    const raw = await readJson(c);
    UpdateAppSettingsRequestSchema.parse(raw);
    return c.json<AppSettings>(ctx.settings.update(raw as UpdateAppSettingsRequest));
  });

  app.get("/api/commands", async (c) =>
    c.json<ListCommandsResponse>({ commands: await listSlashCommands(ctx.repo.path, ctx.env) }),
  );
}
