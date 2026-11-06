import { API, ListSessionsResponseSchema, RevokeSessionsResponseSchema } from "@promptgraph/shared";
import { findDaemon, type DaemonConnection } from "../../daemon/client.js";
import type { CliOptions } from "../args.js";
import { CliError, formatTable, formatTime, NOT_RUNNING, runCommand, type CliDeps } from "../deps.js";

async function connection(deps: CliDeps): Promise<DaemonConnection> {
  const conn = await findDaemon(deps.paths, { version: deps.version, fetchImpl: deps.fetchImpl });
  if (!conn) throw new CliError(NOT_RUNNING);
  return conn;
}

/** `promptgraph sessions [--json]` (DESIGN §4.3, §14): the signed-in browsers and desktop windows (Bearer only). */
export function runSessions(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const conn = await connection(deps);
    const res = ListSessionsResponseSchema.parse(await conn.client.get(API.sessions));
    if (opts.json) {
      deps.stdout(JSON.stringify(res));
      return 0;
    }
    if (res.sessions.length === 0) {
      deps.stdout("No signed-in sessions.");
      return 0;
    }
    const rows = [
      ["ID", "LABEL", "CREATED", "LAST SEEN", "EXPIRES"],
      ...res.sessions.map((s) => [s.id, s.label, formatTime(s.createdAt), formatTime(s.lastSeenAt), formatTime(s.expiresAt)]),
    ];
    for (const line of formatTable(rows)) deps.stdout(line);
    return 0;
  });
}

/** `promptgraph sessions revoke <id>|--all`: ends one session (an id prefix of 8+ hex digits) or every one. */
export function runSessionsRevoke(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const conn = await connection(deps);
    const id = opts.all ? "all" : opts.target!;
    const { revoked } = RevokeSessionsResponseSchema.parse(await conn.client.delete(API.session(id)));
    if (!opts.all && revoked === 0) throw new CliError(`no session matches ${id} (see promptgraph sessions)`);
    deps.stdout(`Revoked ${revoked} session${revoked === 1 ? "" : "s"}.`);
    return 0;
  });
}
