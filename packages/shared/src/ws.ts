import { z } from "zod";
import { LaneSchema, NodeRunSchema, RunSummarySchema } from "./run.js";

/**
 * WebSocket protocol on /ws (§12.2). JSON text frames, one message per frame.
 * Auth: `pg_token` cookie or `?t=<token>` on the upgrade request.
 *
 * Delivery rules:
 * - `run:update` and `graphs:changed` are broadcast to every client.
 * - `node:update` / `lane:update` go to clients subscribed to that run.
 * - `pty:*` go to clients attached to that pty.
 */

// --- server → client -------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string() }),
  z.object({ type: z.literal("run:update"), run: RunSummarySchema }),
  z.object({ type: z.literal("node:update"), nodeRun: NodeRunSchema }),
  z.object({ type: z.literal("lane:update"), lane: LaneSchema }),
  /** Sent in reply to pty:attach before the replay. `live` = process still running (input accepted). */
  z.object({ type: z.literal("pty:attached"), ptyId: z.string(), live: z.boolean(), cols: z.number(), rows: z.number() }),
  /** Raw PTY bytes, base64. Replay chunks come first, then live output. */
  z.object({ type: z.literal("pty:data"), ptyId: z.string(), data: z.string() }),
  z.object({ type: z.literal("pty:exit"), ptyId: z.string(), code: z.number().nullable() }),
  /** Unknown pty, attach failure, input to a dead pty, … */
  z.object({ type: z.literal("pty:error"), ptyId: z.string(), message: z.string() }),
  /** A graph file was saved, created or deleted (by this app or detected on disk). */
  z.object({ type: z.literal("graphs:changed"), graphId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

// --- client → server -------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), runId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), runId: z.string() }),
  /** Server replies pty:attached, then the buffered output, then live output. Size applies if given. */
  z.object({
    type: z.literal("pty:attach"),
    ptyId: z.string(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("pty:detach"), ptyId: z.string() }),
  /** Keystrokes as a UTF-8 string (xterm onData). */
  z.object({ type: z.literal("pty:input"), ptyId: z.string(), data: z.string() }),
  /** The most recent attach/resize drives the PTY size. */
  z.object({ type: z.literal("pty:resize"), ptyId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

export function encodeBase64(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
