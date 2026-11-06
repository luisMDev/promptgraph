import {
  API,
  compareVersions,
  DAEMON_RESTART_PROGRESS_PREFIX,
  OpenMismatchResultSchema,
  type OpenMismatchResult,
  type VersionMismatchPolicy,
} from "@promptgraph/shared";
import { stopDaemon, STOP_TIMEOUT_MS } from "../cli/commands/stop.js";
import { CliError, type CliDeps } from "../cli/deps.js";
import { daemonLogPath } from "../config/daemon-info.js";
import { ensureDaemon, findDaemon, type DaemonConnection, type EnsuredDaemon } from "./client.js";

/** What `open --on-version-mismatch` got: a daemon to open, or a decision the caller must take (exit 4). */
export type OpenOutcome = { kind: "open"; conn: EnsuredDaemon } | { kind: "mismatch"; result: OpenMismatchResult };

/**
 * Running runs of a daemon: the sum of `RepoSummary.runs.running` over `GET /api/repos`, or null when
 * the call fails or answers something unexpected. Read leniently: the daemon may be of another version.
 */
export async function countRunningRuns(conn: DaemonConnection): Promise<number | null> {
  try {
    const body = await conn.client.get<unknown>(API.repos);
    const repos = (body as { repos?: unknown }).repos;
    if (!Array.isArray(repos)) return null;
    let total = 0;
    for (const repo of repos) {
      const running = (repo as { runs?: { running?: unknown } } | null)?.runs?.running;
      if (typeof running !== "number" || !Number.isInteger(running) || running < 0) return null;
      total += running;
    }
    return total;
  } catch {
    return null;
  }
}

function ensure(deps: CliDeps, version: string | undefined): Promise<EnsuredDaemon> {
  return ensureDaemon({ paths: deps.paths, serverCommand: deps.serverCommand, env: deps.env, version, fetchImpl: deps.fetchImpl });
}

/**
 * Stops the daemon of version `from` exactly like `promptgraph stop`, after one progress line on stderr
 * (the desktop shell shows it on the splash), then starts this version. A daemon that went away by itself
 * meanwhile is not an error. @throws CliError when it does not stop in time.
 */
async function restart(deps: CliDeps, from: string): Promise<EnsuredDaemon> {
  deps.stderr(`${DAEMON_RESTART_PROGRESS_PREFIX} (${from} → ${deps.version})…`);
  const outcome = await stopDaemon(deps);
  if (outcome === "timeout") {
    throw new CliError(`the running promptgraph ${from} did not stop within ${STOP_TIMEOUT_MS / 1000} s; run promptgraph stop, or check ${daemonLogPath(deps.paths)}`);
  }
  return ensure(deps, deps.version);
}

/**
 * The daemon `open --on-version-mismatch <policy>` opens (DESIGN §4.3, §20.9): none running or the same
 * version → ensureDaemon. Another version → its running runs are counted first, then:
 * - `auto`: an older daemon with no running run is restarted with this version; anything else (a newer
 *   daemon, a running run, an unknown count) is a `mismatch` for the caller, and nothing changes;
 * - `restart`: stopped whatever it runs (runs pause, resumable), then this version is started;
 * - `attach`: used as it is.
 */
export async function openWithPolicy(deps: CliDeps, policy: VersionMismatchPolicy): Promise<OpenOutcome> {
  const found = await findDaemon(deps.paths, { fetchImpl: deps.fetchImpl });
  if (!found || found.serverVersion === deps.version) return { kind: "open", conn: await ensure(deps, deps.version) };
  const runningRuns = await countRunningRuns(found);
  const daemonIsOlder = compareVersions(found.serverVersion, deps.version) < 0;
  switch (policy) {
    case "attach":
      return { kind: "open", conn: await ensure(deps, undefined) };
    case "restart":
      return { kind: "open", conn: await restart(deps, found.serverVersion) };
    case "auto":
      if (daemonIsOlder && runningRuns === 0) return { kind: "open", conn: await restart(deps, found.serverVersion) };
      return {
        kind: "mismatch",
        result: OpenMismatchResultSchema.parse({ v: 1, mismatch: { serverVersion: found.serverVersion, cliVersion: deps.version, runningRuns, daemonIsOlder } }),
      };
  }
}
