import type { Hono } from "hono";
import type { AppContext } from "../../app/context.js";

/** POST /hooks/:nodeRunId/:event → HookRouter.dispatch; always 204 for known events (never blocks Claude). */
export function registerHookRoutes(app: Hono, ctx: AppContext): void {
  app.post("/hooks/:nodeRunId/:event", async (c) => {
    let body: unknown = null;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      // Unparsable payloads are dropped (dispatch reports invalid_payload); Claude must not see an error.
    }
    const result = ctx.hooks.dispatch(c.req.param("nodeRunId"), c.req.param("event"), body);
    if (result === "invalid_event") return c.json({ error: "Unknown hook event", code: "not_found" }, 404);
    return c.body(null, 204);
  });
}
