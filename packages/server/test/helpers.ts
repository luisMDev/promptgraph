import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the fake claude CLI (set PG_CLAUDE_BIN to it). */
export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude");

/** Absolute path of the fake gh CLI (set PG_GH_BIN to it). */
export const FAKE_GH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-gh");

/** Fresh temp dir; removed by the returned cleanup. */
export function tempDir(prefix = "pg-test-"): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** git repo on branch `main` with one commit (README.md) and a test identity. */
export function createTempRepo(prefix = "pg-repo-"): { repo: string; cleanup: () => void } {
  const { dir, cleanup } = tempDir(prefix);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@promptgraph.local");
  run("config", "user.name", "promptgraph test");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# test repo\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  return { repo: dir, cleanup };
}

/**
 * Env for tests: isolated PG_HOME and CLAUDE_CONFIG_DIR, fake claude. Spread over process.env for
 * the server under test. `mode` sets FAKE_CLAUDE_MODE.
 */
export function fakeClaudeEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const pgHome = path.join(root, "pg-home");
  const claudeConfig = path.join(root, "claude-config");
  fs.mkdirSync(pgHome, { recursive: true });
  fs.mkdirSync(claudeConfig, { recursive: true });
  return {
    PG_HOME: pgHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    PG_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_DELAY_MS: "20",
    ...extra,
  };
}

/**
 * Real-claude recipe (opt-in tests only, guarded by PG_REAL_CLAUDE=1): a CLAUDE_CONFIG_DIR containing a
 * copy of ~/.claude.json with onboarding completed. Never touches the user's real config file.
 */
export function realClaudeEnv(root: string): Record<string, string> {
  const claudeConfig = path.join(root, "claude-config");
  fs.mkdirSync(claudeConfig, { recursive: true });
  const src = path.join(os.homedir(), ".claude.json");
  const cfg = fs.existsSync(src) ? (JSON.parse(fs.readFileSync(src, "utf8")) as Record<string, unknown>) : {};
  fs.writeFileSync(
    path.join(claudeConfig, ".claude.json"),
    JSON.stringify({ ...cfg, hasCompletedOnboarding: true, theme: "dark" }),
  );
  const pgHome = path.join(root, "pg-home");
  fs.mkdirSync(pgHome, { recursive: true });
  return { PG_HOME: pgHome, CLAUDE_CONFIG_DIR: claudeConfig, PG_CLAUDE_BIN: "claude" };
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
