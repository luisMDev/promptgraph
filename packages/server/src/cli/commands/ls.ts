import { API, DaemonInfoResponseSchema, ListReposResponseSchema, type RepoSummary } from "@promptgraph/shared";
import { DaemonVersionMismatch, findDaemon } from "../../daemon/client.js";
import type { CliOptions } from "../args.js";
import { formatDuration, formatTable, NOT_RUNNING, runCommand, type CliDeps } from "../deps.js";

function notes(repo: RepoSummary): string {
  const out: string[] = [];
  if (!repo.available) out.push("unavailable");
  if (repo.error) out.push(`error: ${repo.error}`);
  return out.join("; ");
}

/**
 * `promptgraph ls [--json]` (DESIGN §4.3): daemon pid, version, port and uptime, then one line per
 * repository; `--json` prints ListReposResponse only. Never starts a daemon (none → NOT_RUNNING, exit 1).
 * A daemon of another version is still listed, with the mismatch on stderr.
 */
export function runLs(opts: CliOptions, deps: CliDeps): Promise<number> {
  return runCommand(deps, async () => {
    const conn = await findDaemon(deps.paths, { fetchImpl: deps.fetchImpl });
    if (!conn) {
      (opts.json ? deps.stderr : deps.stdout)(NOT_RUNNING);
      return 1;
    }
    if (conn.serverVersion !== deps.version) deps.stderr(`warning: ${new DaemonVersionMismatch(conn.serverVersion, deps.version).message}`);
    const raw = await conn.client.get<unknown>(API.repos);
    if (opts.json) {
      deps.stdout(JSON.stringify(raw));
      return 0;
    }
    const { repos } = ListReposResponseSchema.parse(raw);
    const info = DaemonInfoResponseSchema.safeParse(await conn.client.get<unknown>(API.daemon).catch(() => null));
    const uptime = formatDuration(deps.now() - (info.success ? info.data.startedAt : conn.info.startedAt));
    deps.stdout(`promptgraph ${conn.serverVersion} · pid ${conn.info.pid} · ${conn.origin} · up ${uptime}`);
    if (info.success) for (const w of info.data.warnings) deps.stdout(`warning: ${w}`);
    if (repos.length === 0) {
      deps.stdout("No repositories registered; run promptgraph <repo-dir> to add one.");
      return 0;
    }
    const rows = [
      ["NAME", "ID", "RUNNING", "PAUSED", "APPROVAL", "INPUT", "PATH", ""],
      ...repos.map((r) => [
        r.name,
        r.id,
        String(r.runs.running),
        String(r.runs.paused),
        String(r.waiting.approval),
        String(r.waiting.input),
        r.path,
        notes(r),
      ]),
    ];
    for (const line of formatTable(rows)) deps.stdout(line);
    return 0;
  });
}
