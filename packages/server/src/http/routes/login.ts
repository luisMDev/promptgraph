import { LOGIN_PATH, safeRedirectTarget } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { sessionLabel } from "../../daemon/sessions.js";
import { sessionCookieHeader } from "../auth.js";
import type { App } from "../repo-scope.js";
import { signedOutPage } from "../signed-out-page.js";

/**
 * GET /login?code=&next= (public, DESIGN §14): redeems a one-time login code, creates a session labelled
 * from the User-Agent (or "promptgraph desktop" for a code minted with `desktop`), sets the `pg_session`
 * cookie and redirects (302) to safeRedirectTarget(next, origin). An invalid, used or expired code gets
 * the signed-out page (401). Only GET redeems: a HEAD (link preview, prefetch) never consumes a code.
 */
export function registerLoginRoutes(app: App, daemon: DaemonContext): void {
  app.get(LOGIN_PATH, (c) => {
    if (c.req.method !== "GET") return signedOutPage(c.req.method);
    const grant = daemon.loginCodes.redeem(c.req.query("code"));
    if (!grant) return signedOutPage();
    const value = daemon.sessions.create(sessionLabel(c.req.header("user-agent"), grant.desktop));
    const target = safeRedirectTarget(c.req.query("next"), new URL(c.req.url).origin);
    return new Response(null, {
      status: 302,
      headers: {
        location: target,
        "set-cookie": sessionCookieHeader(value),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  });
}
