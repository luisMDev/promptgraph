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
  const args: string[] = [];
  // A leading "-" would be parsed as an option; the space is harmless for Claude.
  if (spec.message) args.push(spec.message.startsWith("-") ? ` ${spec.message}` : spec.message);
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
  else args.push("--session-id", spec.sessionId);
  args.push("--name", spec.name, "--settings", spec.settingsPath, "--permission-mode", toCliPermissionMode(spec.permissionMode));
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.allowedTools?.length) args.push("--allowedTools", ...spec.allowedTools);
  return args;
}
