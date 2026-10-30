import type { Server } from "node:http";
import type { AppContext } from "../app/context.js";

/**
 * WebSocket hub on /ws (§12.2, protocol in shared/ws.ts). Upgrade requires localhost Host/Origin and
 * isAuthorized(). On connect sends `hello`. Bus → clients: run:update and graphs:changed to all;
 * node:update/lane:update to subscribers of the run; pty:data (base64) / pty:exit to attached clients.
 * Client messages are validated with ClientMessageSchema; pty:attach replies pty:attached + replay;
 * pty:input → PtyManager.userInput (live only, else pty:error).
 */
export class WsHub {
  constructor(private readonly ctx: AppContext) {}

  attach(server: Server): void {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    throw new Error("not implemented");
  }
}
