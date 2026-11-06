// Shared plumbing for the scripts that drive promptgraph against a throwaway demo repository
// (capture.mjs for the docs screenshots, video/scripts/record.mjs for the demo video).
// Everything lives in a temp dir: never the user's ~/.promptgraph, ~/.claude.json or a real repository.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVER_CLI = path.join(ROOT, "packages/server/dist/cli/index.js");
export const FAKE_CLAUDE = path.join(ROOT, "packages/server/test/fixtures/fake-claude");
export const FAKE_GH = path.join(ROOT, "packages/server/test/fixtures/fake-gh");
// Full Chromium renders small text with better spacing than chrome-headless-shell.
export const DEFAULT_CHROME = path.join(os.homedir(), ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome");
export const WAIT_MS = 60_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadPlaywright() {
  const hint = process.env.PLAYWRIGHT_CORE;
  if (hint) {
    const req = createRequire(path.join(path.resolve(hint), "package.json"));
    for (const id of ["playwright-core", path.resolve(hint)]) {
      try {
        return await import(pathToFileURL(req.resolve(id)).href);
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error(`PLAYWRIGHT_CORE=${hint}: playwright-core not found there`);
  }
  try {
    return await import("playwright-core");
  } catch {
    throw new Error("playwright-core is not resolvable: install it in a scratch dir and set PLAYWRIGHT_CORE (see README.md)");
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Polls `fn` until it returns a truthy value. */
export async function until(what, fn, timeoutMs = WAIT_MS, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

export function git(cwd, env, ...args) {
  return execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
}

export function createDemoRepo(root, env) {
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "demo-app");
  fs.mkdirSync(repo);
  git(root, env, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, env, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "# demo-app\n\nA tiny service used to demo promptgraph.\n");
  fs.writeFileSync(path.join(repo, "TODO.md"), "- Add a /health endpoint that returns { ok: true }\n");
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo-app", private: true, scripts: { test: "echo ok" } }, null, 2)}\n`);
  git(repo, env, "add", "-A");
  git(repo, env, "commit", "-qm", "Initial commit");
  git(repo, env, "remote", "add", "origin", origin);
  git(repo, env, "push", "-q", "-u", "origin", "main");
  return repo;
}

/**
 * Isolated state in `root`: promptgraph home, Claude config and git config (no global hooks, signing or identity
 * leaks). `claudeBin` is the fake claude or a real `claude`; for the real one, the temp CLAUDE_CONFIG_DIR gets a
 * copy of the user's config (onboarding done, dark TUI) and credentials, so the real ~/.claude.json is never
 * written. Call removeCredentials() when done, even if the temp dir is kept.
 */
export function createIsolatedEnv(root, { claudeBin = FAKE_CLAUDE } = {}) {
  const pgHome = path.join(root, "pg");
  const claudeConfig = path.join(root, "claude-config");
  const gitConfig = path.join(root, "gitconfig");
  fs.mkdirSync(pgHome);
  fs.mkdirSync(claudeConfig, { mode: 0o700 });
  fs.writeFileSync(
    gitConfig,
    "[user]\n\tname = promptgraph demo\n\temail = demo@promptgraph.local\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  );
  if (claudeBin !== FAKE_CLAUDE) {
    const src = path.join(os.homedir(), ".claude.json");
    const cfg = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, "utf8")) : {};
    fs.writeFileSync(path.join(claudeConfig, ".claude.json"), JSON.stringify({ ...cfg, hasCompletedOnboarding: true, theme: "dark" }));
    const creds = path.join(os.homedir(), ".claude", ".credentials.json");
    if (fs.existsSync(creds)) fs.copyFileSync(creds, path.join(claudeConfig, ".credentials.json"));
  }
  const env = {
    ...process.env,
    PG_HOME: pgHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    PG_CLAUDE_BIN: claudeBin,
    PG_GH_BIN: FAKE_GH,
    FAKE_GH_URL: "https://github.com/acme/demo-app/pull/42",
    FAKE_CLAUDE_DELAY_MS: "50",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { env, claudeConfig };
}

/** Deletes the copy of the Claude credentials (no-op with the fake claude). */
export function removeCredentials(claudeConfig) {
  fs.rmSync(path.join(claudeConfig, ".credentials.json"), { force: true });
}

/**
 * Runs `promptgraph <repo> --foreground --no-open --port <port>` (the daemon in a child process, with the
 * isolated PG_HOME of `env`), waits for `Open: http://127.0.0.1:<port>/r/<repoId>` and reads the token
 * from `<PG_HOME>/token` (sent only as a Bearer header, never logged or put in a URL). `loginUrl()`
 * mints a one-time login URL for `/r/<repoId>` (over Bearer, valid 30 s): call it right before
 * `page.goto`, never ahead of slow setup steps.
 */
export async function startServer(repo, env, port) {
  const child = spawn(process.execPath, [SERVER_CLI, repo, "--foreground", "--no-open", "--port", String(port)], {
    env: { ...env, PG_DAEMON_SHELL_ENV: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const match = await until(
    "the server URL",
    () => {
      if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}):\n${output}`);
      return /Open: (http:\/\/127\.0\.0\.1:(\d+)\/r\/(\S+))/.exec(output);
    },
    30_000,
  );
  const [, , boundPort, repoId] = match;
  const token = fs.readFileSync(path.join(env.PG_HOME, "token"), "utf8").trim();
  const base = `http://127.0.0.1:${boundPort}`;
  const loginUrl = (next = `/r/${encodeURIComponent(repoId)}`) => mintLoginUrl(base, token, next);
  return {
    child,
    loginUrl,
    token,
    repoId,
    base,
    output: () => output,
  };
}

/**
 * One-time login URL (DESIGN §14): `POST /api/daemon/login-codes` with the Bearer token, then
 * `<base>/login?code=<code>&next=<next>`, which signs a browser in once (302 + the pg_session cookie).
 */
export async function mintLoginUrl(base, token, next) {
  const res = await fetch(`${base}/api/daemon/login-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`POST /api/daemon/login-codes → ${res.status}`);
  const { code } = await res.json();
  return `${base}/login?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
}

export async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((r) => server.child.once("exit", r));
  server.child.kill("SIGINT");
  await Promise.race([exited, sleep(10_000)]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

/**
 * REST client of the demo daemon (Bearer token). A route starting with `/api/` is used as is (daemon
 * routes such as `/api/settings`); any other route is relative to the demo repository,
 * `/api/repos/<repoId>` (`api("GET", "/runs/<id>")`).
 */
export function apiClient(server) {
  return async function api(method, route, body) {
    const url = route.startsWith("/api/") ? route : `/api/repos/${encodeURIComponent(server.repoId)}${route}`;
    const res = await fetch(`${server.base}${url}`, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Current node run (highest iteration, then attempt) of `nodeId`, or of a given iteration. */
export function currentNodeRun(detail, nodeId, iteration) {
  return detail.nodeRuns
    .filter((n) => n.nodeId === nodeId && (iteration === undefined || n.iteration === iteration))
    .sort((a, b) => b.iteration - a.iteration || b.attempt - a.attempt)[0];
}
