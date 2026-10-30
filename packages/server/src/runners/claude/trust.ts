/** Matches Claude Code's workspace trust dialog in ANSI-stripped, whitespace-removed PTY output (SPIKE A5). */
export const TRUST_DIALOG_PATTERN = /Doyoutrustthefilesinthisfolder|Itrustthisfolder/i;

/**
 * SPIKE A5: atomic read-modify-write of `projects["<dir>"].hasTrustDialogAccepted = true` in
 * claudeConfigFile(env). Serialised within the process; tolerant to a missing file (creates it).
 * Must never be pointed at the real ~/.claude.json in tests (set CLAUDE_CONFIG_DIR).
 */
export function preTrustDirectory(dir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  throw new Error("not implemented");
}
