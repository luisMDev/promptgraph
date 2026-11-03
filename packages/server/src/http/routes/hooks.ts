import type { DaemonContext } from "../../daemon/context.js";
import type { App } from "../repo-scope.js";

/**
 * POST /hooks/:nodeRunId/:event → HookRouter.dispatch; always 204 for known events (never blocks Claude).
 * Unscoped: node run ids are unique across repositories and the router is daemon-wide (DESIGN §12.1).
 */
export function registerHookRoutes(app: App, daemon: DaemonContext): void {
  app.post("/hooks/:nodeRunId/:event", async (c) => {
    let body: unknown = null;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      // Unparsable payloads are dropped (dispatch reports invalid_payload); Claude must not see an error.
    }
    const result = daemon.hooks.dispatch(c.req.param("nodeRunId"), c.req.param("event"), body);
    if (result === "invalid_event") return c.json({ error: "Unknown hook event", code: "not_found" }, 404);
    return c.body(null, 204);
  });
}
