import type { AppContext } from "../app/context.js";

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

/**
 * createAppContext → GraphStore.ensureDir → Engine.recover → Notifier.start → Hono app on
 * @hono/node-server bound to 127.0.0.1:<port> (port 0 = random, for tests) → WsHub.attach.
 */
export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  throw new Error("not implemented");
}
