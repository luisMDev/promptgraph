import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { createAppContext, type AppContext } from "../app/context.js";
import { createHttpApp } from "../http/app.js";
import { WsHub } from "../ws/hub.js";

export interface StartServerOptions {
  repoPath: string;
  port: number;
  /** Generated when omitted. */
  token?: string;
  warnings?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface RunningServer {
  ctx: AppContext;
  /** http://127.0.0.1:<port>/?t=<token> */
  url: string;
  port: number;
  token: string;
  /** Engine.shutdown, WS close, HTTP close, DB close. */
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

/**
 * createAppContext → GraphStore.ensureDir → Engine.recover → Notifier.start → Hono app on
 * @hono/node-server bound to 127.0.0.1:<port> (port 0 = random, for tests) → WsHub.attach.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const ctx = await createAppContext({ repoPath: opts.repoPath, token, warnings: opts.warnings, env: opts.env });
  const closeDb = () => ctx.store.db.close();
  let server: Server;
  try {
    ctx.graphs.ensureDir();
    await ctx.engine.recover();
    server = createAdaptorServer({ fetch: createHttpApp(ctx).fetch }) as Server;
    await listen(server, opts.port);
  } catch (err) {
    closeDb();
    throw err;
  }
  ctx.port = (server.address() as AddressInfo).port;
  const stopNotifier = ctx.notifier.start();
  const stopWatch = ctx.graphs.watch();
  const hub = new WsHub(ctx);
  hub.attach(server);

  let closing: Promise<void> | null = null;
  const close = async () => {
    await ctx.engine.shutdown();
    stopWatch();
    stopNotifier();
    await hub.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    closeDb();
  };
  return {
    ctx,
    url: `http://${HOST}:${ctx.port}/?t=${token}`,
    port: ctx.port,
    token,
    close: () => (closing ??= close()),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use; pass --port <n>`) : err);
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
