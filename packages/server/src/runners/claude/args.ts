import type { Effort, PermissionMode } from "@promptgraph/shared";

export interface ClaudeLaunchSpec {
  /** Initial message (positional argument). */
  message: string;
  /** New session: our pre-generated UUID (--session-id). Ignored when resumeSessionId is set. */
  sessionId: string;
  /** `--resume <id>` (context "resume", retry after interruption, Reopen session). */
  resumeSessionId?: string;
  /** `--name "pg:<graph>/<node-label>"` */
  name: string;
  /** Absolute path of the run's hooks.json (--settings). */
  settingsPath: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: Effort;
  allowedTools?: string[];
}

/** promptgraph "manual" → Claude Code "default"; others pass through. */
export function toCliPermissionMode(mode: PermissionMode): string {
  return mode === "manual" ? "default" : mode;
}

/**
 * argv for an interactive claude (§7.1):
 * [message, --session-id <id> | --resume <id>, --name, --settings, --permission-mode, --model?, --effort?,
 *  --allowedTools <t>...?]. The message comes first so a slash command is recognised (SPIKE A1).
 */
export function buildClaudeArgs(spec: ClaudeLaunchSpec): string[] {
  throw new Error("not implemented");
}
