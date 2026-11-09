import { z } from "zod";
import {
  ChatDeletedMessageSchema,
  ChatDeltaMessageSchema,
  ChatInterruptMessageSchema,
  ChatItemMessageSchema,
  ChatPermissionMessageSchema,
  ChatSendMessageSchema,
  ChatSessionMessageSchema,
  ChatStatusMessageSchema,
} from "./chat.js";
import { UsageLimitsSchema } from "./billing.js";
import { RepoIdSchema, RepoSummarySchema } from "./repos.js";
import { LaneSchema, NodeRunSchema, RunBriefEntrySchema, RunSummarySchema } from "./run.js";
import {
  VoiceCancelMessageSchema,
  VoiceErrorMessageSchema,
  VoiceFinalMessageSchema,
  VoicePartialMessageSchema,
  VoiceStartMessageSchema,
  VoiceStopMessageSchema,
} from "./voice.js";

/**
 * WebSocket protocol on /ws (DESIGN §12.2). JSON text frames, one message per frame. The only binary frames are
 * the client's voice audio (§22): little-endian Int16 mono PCM at 16 kHz, routed to that client's active voice
 * session.
 *
 * Delivery rules:
 * - `repo:status`, `repo:removed` and `usage:limits` go to every client.
 * - `run:update`, `run:deleted`, `graphs:changed` and `chat:*` (§21) go to clients subscribed to their repository (`repo:subscribe`).
 * - `node:update` / `lane:update` / `brief:update` go to clients subscribed to that run.
 * - `pty:*` go to clients attached to that pty.
 * - `voice:*` go only to the client that sent the voice:start.
 */

/** Close code when the token was rotated or the socket's session revoked: the client stops reconnecting. */
export const WS_CLOSE_SIGNED_OUT = 4401;

// --- server → client -------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string() }),
  /** A repository's counters or state changed (debounced per repository). */
  z.object({ type: z.literal("repo:status"), repo: RepoSummarySchema }),
  z.object({ type: z.literal("repo:removed"), repoId: RepoIdSchema }),
  /** New subscription usage limits were observed (§23.3; account-wide, not per repository). */
  z.object({ type: z.literal("usage:limits"), limits: UsageLimitsSchema }),
  z.object({ type: z.literal("run:update"), repoId: RepoIdSchema, run: RunSummarySchema }),
  /** A run was deleted from the history (§13.2). */
  z.object({ type: z.literal("run:deleted"), repoId: RepoIdSchema, runId: z.string(), graphId: z.string() }),
  z.object({ type: z.literal("node:update"), nodeRun: NodeRunSchema }),
  z.object({ type: z.literal("lane:update"), lane: LaneSchema }),
  /** A run brief entry was added or finished (§13.6). */
  z.object({ type: z.literal("brief:update"), entry: RunBriefEntrySchema }),
  /** Sent in reply to pty:attach before the replay. `live` = process still running (input accepted). */
  z.object({ type: z.literal("pty:attached"), ptyId: z.string(), live: z.boolean(), cols: z.number(), rows: z.number() }),
  /** Raw PTY bytes, base64. Replay chunks come first, then live output. */
  z.object({ type: z.literal("pty:data"), ptyId: z.string(), data: z.string() }),
  z.object({ type: z.literal("pty:exit"), ptyId: z.string(), code: z.number().nullable() }),
  /** Unknown pty, attach failure, input to a dead pty, … */
  z.object({ type: z.literal("pty:error"), ptyId: z.string(), message: z.string() }),
  /** A graph file was saved, created or deleted (by this app or detected on disk). */
  z.object({ type: z.literal("graphs:changed"), repoId: RepoIdSchema, graphId: z.string() }),
  // Chat panel (§21)
  ChatItemMessageSchema,
  ChatDeltaMessageSchema,
  ChatStatusMessageSchema,
  ChatSessionMessageSchema,
  ChatDeletedMessageSchema,
  // Voice dictation (§22)
  VoicePartialMessageSchema,
  VoiceFinalMessageSchema,
  VoiceErrorMessageSchema,
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

// --- client → server -------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** Receive run:update / graphs:changed of this repository (and activate it, DESIGN §4.2). */
  z.object({ type: z.literal("repo:subscribe"), repoId: RepoIdSchema }),
  z.object({ type: z.literal("repo:unsubscribe"), repoId: RepoIdSchema }),
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
  // Chat panel (§21)
  ChatSendMessageSchema,
  ChatInterruptMessageSchema,
  ChatPermissionMessageSchema,
  // Voice dictation (§22)
  VoiceStartMessageSchema,
  VoiceStopMessageSchema,
  VoiceCancelMessageSchema,
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
