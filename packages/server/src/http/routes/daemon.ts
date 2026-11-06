import {
  LoginCodeRequestSchema,
  SESSION_COOKIE,
  type DaemonHelloResponse,
  type DaemonInfoResponse,
  type ListSessionsResponse,
  type LoginCodeResponse,
  type OkResponse,
  type RevokeSessionsResponse,
  type UsageLimitsResponse,
} from "@promptgraph/shared";
import { helloProof } from "../../config/token.js";
import { SUPPORTED_PHASE, VERSION } from "../../config/version.js";
import { rotateToken, type DaemonContext } from "../../daemon/context.js";
import { InvalidSessionIdError, sessionHash } from "../../daemon/sessions.js";
import { RUNNER_NODE_TYPES } from "../../runners/registry.js";
import { cookieValue } from "../credentials.js";
import { HttpError, readBody } from "../errors.js";
import type { App } from "../repo-scope.js";

/** 16 random bytes in base64url are 22 characters; anything short or odd is refused. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * GET /api/daemon/hello?nonce= (public, DESIGN §4.1 item 3) · GET /api/daemon · GET /api/daemon/usage-limits (§23.3) · and the Bearer-only
 * routes of DESIGN §14 (tokenAuth refuses cookies there): POST /api/daemon/login-codes, POST
 * /api/daemon/token/rotate, GET /api/daemon/sessions, DELETE /api/daemon/sessions/:id.
 */
export function registerDaemonRoutes(app: App, daemon: DaemonContext): void {
  app.get("/api/daemon/hello", (c) => {
    const nonce = c.req.query("nonce") ?? "";
    if (!NONCE_PATTERN.test(nonce)) throw new HttpError(400, "bad_request", "nonce must be 16 to 128 base64url characters");
    return c.json<DaemonHelloResponse>({ pid: process.pid, serverVersion: VERSION, proof: helloProof(daemon.getToken(), nonce) });
  });

  app.get("/api/daemon", async (c) => {
    const [warnings, platform] = await Promise.all([daemon.prereqWarnings(), daemon.notifier.detectPlatform()]);
    return c.json<DaemonInfoResponse>({
      version: VERSION,
      pid: process.pid,
      port: daemon.port,
      startedAt: daemon.startedAt,
      phase: SUPPORTED_PHASE,
      supportedNodeTypes: [...RUNNER_NODE_TYPES],
      warnings,
      notificationsAvailable: platform !== "none",
    });
  });

  app.get("/api/daemon/usage-limits", (c) => c.json<UsageLimitsResponse>({ limits: daemon.usageLimits.current() }));

  app.post("/api/daemon/login-codes", async (c) => {
    const body = await readBody(c, LoginCodeRequestSchema);
    return c.json<LoginCodeResponse>(daemon.loginCodes.mint(undefined, { desktop: body.desktop }));
  });

  app.post("/api/daemon/token/rotate", (c) => {
    rotateToken(daemon);
    return c.json<OkResponse>({ ok: true });
  });

  app.get("/api/daemon/sessions", (c) => {
    // Bearer only; a session cookie sent along (a desktop or dev client) marks its own session.
    const value = cookieValue(c.req.header("cookie"), SESSION_COOKIE);
    return c.json<ListSessionsResponse>({ sessions: daemon.sessions.list(value ? sessionHash(value) : null) });
  });

  app.delete("/api/daemon/sessions/:id", (c) => {
    let revoked: number;
    try {
      revoked = daemon.sessions.revoke(c.req.param("id"));
    } catch (err) {
      if (err instanceof InvalidSessionIdError) throw new HttpError(400, "bad_request", err.message);
      throw err;
    }
    return c.json<RevokeSessionsResponse>({ ok: true, revoked });
  });
}
