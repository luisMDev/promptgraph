import { UpdateAppSettingsRequestSchema, type AppSettings, type ListCommandsResponse, type UpdateAppSettingsRequest } from "@promptgraph/shared";
import { listSlashCommands } from "../../commands/discover.js";
import type { DaemonContext } from "../../daemon/context.js";
import { buildClaudeSetup, bundledMarketplaceRoot, checkClaudeSetup, currentCliEntry } from "../../mcp/setup.js";
import { readJson } from "../errors.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

/** GET/PUT /api/settings (global to the daemon). */
export function registerSettingsRoutes(app: App, daemon: DaemonContext): void {
  app.get("/api/settings", (c) => c.json<AppSettings>(daemon.settings.get()));
  app.put("/api/settings", async (c) => {
    // Validate, but pass the raw patch on: parsing fills defaults for keys the client did not send.
    const raw = await readJson(c);
    UpdateAppSettingsRequestSchema.parse(raw);
    return c.json<AppSettings>(daemon.settings.update(raw as UpdateAppSettingsRequest));
  });
}

/** Under /api/repos/:repoId: GET …/commands · GET …/claude-setup · POST …/claude-setup/check */
export function registerRepoMiscRoutes(app: App, daemon: DaemonContext): void {
  app.get(`${P}/commands`, async (c) =>
    c.json<ListCommandsResponse>({ commands: await listSlashCommands(repoOf(c).repo.path, daemon.env) }),
  );

  /** Claude Code setup guide for the web wizard (DESIGN §19.5). */
  app.get(`${P}/claude-setup`, (c) =>
    c.json(
      buildClaudeSetup({
        repoPath: repoOf(c).repo.path,
        cliEntry: currentCliEntry(),
        nodePath: process.execPath,
        marketplaceRoot: bundledMarketplaceRoot(),
      }),
    ),
  );
  /** Runs `claude mcp get` in the repository: local and project scopes depend on the directory. */
  app.post(`${P}/claude-setup/check`, async (c) => c.json(await checkClaudeSetup({ env: daemon.env, cwd: repoOf(c).repo.path })));
}
