import type { DaemonHelloResponse, DaemonInfoResponse } from "@promptgraph/shared";
import { helloProof } from "../../config/token.js";
import { SUPPORTED_PHASE, VERSION } from "../../config/version.js";
import type { DaemonContext } from "../../daemon/context.js";
import { RUNNER_NODE_TYPES } from "../../runners/registry.js";
import { HttpError } from "../errors.js";
import type { App } from "../repo-scope.js";

/** 16 random bytes in base64url are 22 characters; anything short or odd is refused. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** GET /api/daemon/hello?nonce= (public, DESIGN §4.1 item 3) · GET /api/daemon */
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
}
