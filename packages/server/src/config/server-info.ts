import fs from "node:fs";
import path from "node:path";
import { ServerInfoSchema, type ServerInfo } from "@promptgraph/shared";
import { isProcessAlive } from "../util/process.js";
import type { PgPaths } from "./paths.js";
import { repoKey } from "./repo-key.js";

/** `<PG_HOME>/servers/<repo-key>.json` (§19.1). */
export function serverInfoPath(paths: PgPaths, repoPath: string): string {
  return path.join(paths.home, "servers", `${repoKey(repoPath)}.json`);
}

/** Log of a server started in the background by `promptgraph mcp` (§19.2). */
export function backgroundServerLogPath(paths: PgPaths, repoPath: string): string {
  return path.join(paths.home, "logs", `server-${repoKey(repoPath)}.log`);
}

/** Atomic write (tmp + rename), mode 0600: the record holds the session token. */
export function writeServerInfo(paths: PgPaths, info: ServerInfo): void {
  const file = serverInfoPath(paths, info.repoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ServerInfoSchema.parse(info), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Removes the record only if it still belongs to this process (a newer server may have replaced it). */
export function removeServerInfo(paths: PgPaths, repoPath: string): void {
  const file = serverInfoPath(paths, repoPath);
  const current = readRecord(file);
  if (current === null || current.pid === process.pid) fs.rmSync(file, { force: true });
}

/**
 * The live server's record for `repoPath`, or null when there is none, it does not parse, or its
 * process is gone (stale records are left in place: the next server overwrites them).
 */
export function readServerInfo(paths: PgPaths, repoPath: string): ServerInfo | null {
  const info = readRecord(serverInfoPath(paths, repoPath));
  return info && info.repoPath === repoPath && isProcessAlive(info.pid) ? info : null;
}

function readRecord(file: string): ServerInfo | null {
  try {
    const parsed = ServerInfoSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

