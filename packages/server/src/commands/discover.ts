import type { SlashCommand } from "@promptgraph/shared";

/**
 * Slash commands and skills for the `command` picker (GET /api/commands): project `.claude/commands/**.md`
 * and `.claude/skills/<name>/SKILL.md`, user `$CLAUDE_CONFIG_DIR|~/.claude` equivalents, installed plugin
 * commands, plus a fixed list of useful built-ins. Frontmatter `description` / `argument-hint` are read.
 * Nested command dirs map to `/dir:name`. Sorted by name, project shadows user.
 */
export function listSlashCommands(repoPath: string, env?: NodeJS.ProcessEnv): Promise<SlashCommand[]> {
  throw new Error("not implemented");
}
