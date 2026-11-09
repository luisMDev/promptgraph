import {
  API,
  LINEAR_ERROR,
  LinearIssueStatesQuerySchema,
  LinearIssuesQuerySchema,
  SetLinearKeyRequestSchema,
  type LinearIssueStatesResponse,
  type LinearIssuesResponse,
  type LinearStatusResponse,
} from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { LinearApiError } from "../../linear/client.js";
import { LinearNotConnectedError } from "../../linear/service.js";
import { HttpError, readBody } from "../errors.js";
import type { App } from "../repo-scope.js";

/** LinearApiError / LinearNotConnectedError → HttpError (DESIGN §24); anything else is rethrown. */
function linearHttpError(err: unknown, keyStatus: 422 | 502): never {
  if (err instanceof LinearNotConnectedError) throw new HttpError(409, LINEAR_ERROR.notConnected, err.message);
  if (err instanceof LinearApiError) {
    if (err.kind === "unauthorized") throw new HttpError(keyStatus, LINEAR_ERROR.keyInvalid, err.message);
    throw new HttpError(502, LINEAR_ERROR.unavailable, err.message);
  }
  throw err;
}

/**
 * Daemon-wide Linear routes (DESIGN §24): GET /api/linear · PUT/DELETE /api/linear/key · GET /api/linear/issues?q=&states=&scope= · GET /api/linear/issue-states?ids=.
 * The key is write-only: no route returns it. The GETs read Linear but change nothing.
 */
export function registerLinearRoutes(app: App, daemon: DaemonContext): void {
  app.get(API.linear, async (c) => c.json<LinearStatusResponse>(await daemon.linear.status()));
  app.put(API.linearKey, async (c) => {
    const { apiKey } = await readBody(c, SetLinearKeyRequestSchema);
    try {
      return c.json<LinearStatusResponse>(await daemon.linear.setKey(apiKey));
    } catch (err) {
      linearHttpError(err, 422);
    }
  });
  app.delete(API.linearKey, (c) => c.json<LinearStatusResponse>(daemon.linear.clearKey()));
  app.get(`${API.linear}/issue-states`, async (c) => {
    const { ids } = LinearIssueStatesQuerySchema.parse({ ids: c.req.query("ids") ?? "" });
    try {
      return c.json<LinearIssueStatesResponse>({ issues: await daemon.linear.issuesById(ids) });
    } catch (err) {
      linearHttpError(err, 502);
    }
  });
  app.get(`${API.linear}/issues`, async (c) => {
    const { q, states, scope } = LinearIssuesQuerySchema.parse({ q: c.req.query("q") ?? "", states: c.req.query("states"), scope: c.req.query("scope") });
    try {
      return c.json<LinearIssuesResponse>({ issues: await daemon.linear.issues(q, states, scope) });
    } catch (err) {
      linearHttpError(err, 502);
    }
  });
}
