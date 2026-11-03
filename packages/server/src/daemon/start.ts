import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { findLegacyServers, readStickyPort, removeDaemonInfo, removeStaleLegacy, writeDaemonInfo, writeStickyPort } from "../config/daemon-info.js";
import { DaemonLock, isDaemonLock } from "../config/instance-lock.js";
import { getPaths } from "../config/paths.js";
import { loadOrCreateToken } from "../config/token.js";
import { VERSION } from "../config/version.js";
import { markInterrupted } from "../engine/recovery.js";
import { createHttpApp } from "../http/app.js";
import { processStartTime } from "../util/process.js";
import { errorMessage } from "../util/text.js";
import { WsHub } from "../ws/hub.js";
import { createDaemonContext, type DaemonContext } from "./context.js";

export const HOST = "127.0.0.1";
/** Default port when there is no sticky port (`PG_PORT_DEFAULT` overrides it). */
export const DEFAULT_PORT = 4777;

/** Another daemon holds the lock for this PG_HOME (`promptgraph daemon` exits with EXIT_DAEMON_LOCKED). */
export class DaemonLockedError extends Error {
  constructor(readonly heldBy: number | null) {
    super(
      heldBy === null
        ? "the promptgraph daemon lock is held by an unknown process"
        : `promptgraph daemon is already running (pid ${heldBy})`,
    );
  }
}

/** A pre-M7 per-repository server is still running (DESIGN §4.4). */
export class LegacyServerRunningError extends Error {}

export interface StartDaemonOptions {
  /** Explicit port: must be free. Omitted: sticky port → PG_PORT_DEFAULT (or 4777) → a random port. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** Prerequisite warnings already checked; computed lazily against `env` otherwise. */
  warnings?: string[];
  /** Tests only: an in-memory token instead of `<PG_HOME>/token`. */
  token?: string;
}

export interface RunningDaemon {
  ctx: DaemonContext;
  port: number;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** DESIGN §4.1 item 7; idempotent. */
  close(): Promise<void>;
}

/**
 * Starts the daemon in this process, in the order of DESIGN §4.1 item 1: daemon lock (held →
 * DaemonLockedError) → refuse while a legacy server runs, delete stale legacy records → token → DB +
 * DaemonContext + HTTP app → bind 127.0.0.1 → mark interrupted every run left running → backfill →
 * legacy locks of the registered repositories → notifier and WebSocket hub → `port` file and daemon
 * record. Installs no process handlers (installProcessHandlers does, for the CLI).
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const paths = getPaths(env);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const lock = await DaemonLock.acquire(paths);
  if (!isDaemonLock(lock)) throw new DaemonLockedError(lock.heldBy);

  let ctx: DaemonContext | null = null;
  let server: Server | null = null;
  const abort = async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    ctx?.legacyLocks.releaseAll();
    ctx?.store.db.close();
    await lock.release();
  };
  try {
    const legacy = findLegacyServers(paths);
    if (legacy.length > 0) {
      const s = legacy[0]!;
      throw new LegacyServerRunningError(`stop the promptgraph server for ${s.repoPath} (pid ${s.pid}) first`);
    }
    removeStaleLegacy(paths);
    const token = opts.token ?? loadOrCreateToken(paths);
    ctx = createDaemonContext({ token, warnings: opts.warnings, env });
    server = createAdaptorServer({ fetch: createHttpApp(ctx).fetch }) as Server;
    await listenWithFallback(server, opts.port, () => portCandidates(readStickyPort(paths), env));
    ctx.port = (server.address() as AddressInfo).port;
    markInterrupted(ctx.store, {});
    await ctx.registry.backfill();
    for (const row of ctx.store.listRepos()) {
      try {
        ctx.legacyLocks.hold(row.path);
      } catch (err) {
        // A pre-M7 binary holds it: that repository refuses to activate until it is stopped.
        console.error(`promptgraph: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    await abort();
    throw err;
  }

  const daemon = ctx;
  const http = server;
  const stopNotifier = daemon.notifier.start();
  const hub = new WsHub(daemon);
  hub.attach(http);
  writeStickyPort(paths, daemon.port);
  writeDaemonInfo(paths, {
    version: 2,
    pid: process.pid,
    pidStart: processStartTime(process.pid) ?? 0,
    port: daemon.port,
    serverVersion: VERSION,
    startedAt: daemon.startedAt,
  });

  let closing: Promise<void> | null = null;
  const close = async () => {
    removeDaemonInfo(paths);
    await daemon.registry.shutdownAll();
    // Anything no repository owns any more.
    await daemon.ptys.killAll();
    daemon.legacyLocks.releaseAll();
    stopNotifier();
    await hub.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    daemon.store.db.close();
    await lock.release();
  };
  return {
    ctx: daemon,
    port: daemon.port,
    origin: `http://${HOST}:${daemon.port}`,
    close: () => (closing ??= close()),
  };
}

/** Ports tried without an explicit one (DESIGN §4.1 item 2): sticky, PG_PORT_DEFAULT or 4777, then random. */
export function portCandidates(sticky: number | null, env: NodeJS.ProcessEnv): number[] {
  const raw = env.PG_PORT_DEFAULT;
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const fallback = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
  return [...new Set([...(sticky === null ? [] : [sticky]), fallback, 0])];
}

/** Error of a busy explicit port: keeps `code` EADDRINUSE for callers. */
export class PortInUseError extends Error {
  readonly code = "EADDRINUSE";
  constructor(readonly port: number) {
    super(`Port ${port} is already in use`);
  }
}

async function listenWithFallback(server: Server, explicit: number | undefined, candidates: () => number[]): Promise<void> {
  if (explicit !== undefined) {
    try {
      return await listen(server, explicit);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortInUseError(explicit);
      throw err;
    }
  }
  let last: unknown;
  for (const port of candidates()) {
    try {
      return await listen(server, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      last = err;
    }
  }
  throw last;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Process-wide handlers of a daemon process (DESIGN §4.1 item 8): an unhandled rejection is logged and
 * the daemon keeps running; an uncaught exception is logged, then the daemon stops gracefully (runs stay
 * resumable) and the process exits 1. Returns a function that removes them.
 */
export function installProcessHandlers(daemon: RunningDaemon): () => void {
  const onRejection = (reason: unknown) => {
    console.error("promptgraph: unhandled rejection:", reason);
  };
  let failing = false;
  const onException = (err: Error) => {
    console.error("promptgraph: uncaught exception, stopping:", err);
    if (failing) return;
    failing = true;
    daemon.close().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
