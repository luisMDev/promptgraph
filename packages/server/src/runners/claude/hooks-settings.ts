import fs from "node:fs";
import path from "node:path";
import { CLAUDE_HOOK_FOR_EVENT, HOOK_EVENTS } from "@promptgraph/shared";

export interface ClaudeHooksSettings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> }>>;
}

/** pg-hook gives up after 2 s (curl -m 2); the timeout only guards against a stuck shell. */
const HOOK_TIMEOUT_SEC = 10;

/** POSIX single-quote quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** §7.2: one entry per HookEvent (CLAUDE_HOOK_FOR_EVENT), command = `<abs pg-hook path> <event>` (path shell-quoted). */
export function buildHooksSettings(pgHookPath: string): ClaudeHooksSettings {
  const hooks: ClaudeHooksSettings["hooks"] = {};
  for (const event of HOOK_EVENTS) {
    hooks[CLAUDE_HOOK_FOR_EVENT[event]] = [
      { hooks: [{ type: "command", command: `${shellQuote(pgHookPath)} ${event}`, timeout: HOOK_TIMEOUT_SEC }] },
    ];
  }
  return { hooks };
}

/** Writes hooks.json for a run (idempotent) and returns its path. */
export function writeHooksSettings(file: string, pgHookPath: string): string {
  const content = `${JSON.stringify(buildHooksSettings(pgHookPath), null, 2)}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current !== content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}
