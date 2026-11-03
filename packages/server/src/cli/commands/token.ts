import { API } from "@promptgraph/shared";
import { DaemonLock, isDaemonLock } from "../../config/instance-lock.js";
import { newToken, writeToken } from "../../config/token.js";
import { findDaemon } from "../../daemon/client.js";
import type { CliOptions } from "../args.js";
import { CliError, runCommand, type CliDeps } from "../deps.js";

const ROTATED = "Token rotated: every browser and desktop window must sign in again (promptgraph open).";

/**
 * `promptgraph token rotate` (DESIGN §4.3, §14): through the daemon when a verified one runs (it swaps the
 * token in memory, rewrites the file, drops every session and closes every WebSocket); otherwise the
 * file is rewritten while this process holds the daemon lock, so a daemon starting at the same moment
 * cannot load the old value; the next daemon start finds a token other than the one its sessions were
 * issued under and deletes them all (syncTokenFingerprint). Lock held but no verified daemon → error,
 * retry. The token is never printed.
 */
export function runTokenRotate(_opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const conn = await findDaemon(deps.paths, { version: deps.version, fetchImpl: deps.fetchImpl });
    if (conn) {
      await conn.client.post(API.rotateToken, {});
      deps.stdout(ROTATED);
      return 0;
    }
    const lock = await DaemonLock.acquire(deps.paths);
    if (!isDaemonLock(lock)) throw new CliError("the promptgraph daemon is starting or unreachable; retry");
    try {
      writeToken(deps.paths, newToken());
    } finally {
      await lock.release();
    }
    deps.stdout(ROTATED);
    return 0;
  });
}
