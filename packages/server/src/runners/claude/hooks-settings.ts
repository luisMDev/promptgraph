export interface ClaudeHooksSettings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> }>>;
}

/** §7.2: one entry per HookEvent (CLAUDE_HOOK_FOR_EVENT), command = `<abs pg-hook path> <event>` (path shell-quoted). */
export function buildHooksSettings(pgHookPath: string): ClaudeHooksSettings {
  throw new Error("not implemented");
}

/** Writes hooks.json for a run (idempotent) and returns its path. */
export function writeHooksSettings(file: string, pgHookPath: string): string {
  throw new Error("not implemented");
}
