#!/usr/bin/env node
// Regenerates the UI screenshots of docs/screenshots (dark theme) against a throwaway demo repository,
// the fake claude CLI and the fake gh CLI. See README.md next to this file.
//
//   node scripts/screenshots/capture.mjs <out-dir> [--keep] [--scene add-feature,ship-feature,test-fix]
//   node scripts/screenshots/capture.mjs <out-dir> --real-claude   (m2-real-claude-replay.png, real Claude Code)
//
// Never touches the user's ~/.promptgraph, ~/.claude.json or real repositories: everything lives in a temp dir.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_CLI = path.join(ROOT, "packages/server/dist/cli/index.js");
const FAKE_CLAUDE = path.join(ROOT, "packages/server/test/fixtures/fake-claude");
const FAKE_GH = path.join(ROOT, "packages/server/test/fixtures/fake-gh");
// Full Chromium renders small text with better spacing than chrome-headless-shell.
const DEFAULT_CHROME = path.join(os.homedir(), ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome");
const VIEWPORT = { width: 1600, height: 900 };
const SCENES = ["add-feature", "ship-feature", "test-fix"];
/** Opt-in scene (--real-claude): a real Claude Code session with haiku and minimal prompts. */
const REAL_SCENE = "real-claude";
const WAIT_MS = 60_000;

// ---------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { out: process.env.PG_SHOTS_OUT ?? null, keep: false, scenes: SCENES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") opts.keep = true;
    else if (a === "--real-claude") opts.real = true;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--scene" || a === "--scenes") opts.scenes = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts.out = a;
    else throw new Error(`Unknown option ${a}`);
  }
  if (opts.real) opts.scenes = [REAL_SCENE];
  else for (const s of opts.scenes) if (!SCENES.includes(s)) throw new Error(`Unknown scene "${s}" (known: ${SCENES.join(", ")})`);
  return opts;
}

const USAGE = `Usage: node scripts/screenshots/capture.mjs <out-dir> [--keep] [--scene ${SCENES.join(",")}]
  <out-dir>   where the PNGs are written (or PG_SHOTS_OUT)
  --keep      keep the temp dir (demo repo, PG_HOME) and print its path
  --scene     only run these scenes (comma separated)
  --real-claude  only m2-real-claude-replay.png, with the real Claude Code (haiku, two tiny prompts; uses a temp
                 copy of ~/.claude.json and ~/.claude/.credentials.json, removed at the end)
Env: PG_SHOTS_CHROME (browser executable), PLAYWRIGHT_CORE (playwright-core dir or a dir whose node_modules has it)`;

// ---------------------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[shots]", ...a);

async function loadPlaywright() {
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

function freePort() {
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
async function until(what, fn, timeoutMs = WAIT_MS, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------------------- demo repository

function git(cwd, env, ...args) {
  return execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
}

function createDemoRepo(root, env) {
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

// ---------------------------------------------------------------------------- graphs

const chain = (...ids) => ids.slice(1).map((id, i) => ({ id: `e${i + 1}`, source: ids[i], target: id }));

const GRAPHS = {
  "add-feature": {
    version: 1,
    id: "add-feature",
    name: "Add feature",
    settings: { baseBranch: "main", maxParallelClaude: 3 },
    nodes: [
      {
        id: "implement",
        type: "prompt",
        label: "Implement",
        position: { x: 0, y: 0 },
        config: { prompt: "[[write:feature.txt:feature v1]] [[sleep:8000]] Implement the feature described in TODO.md" },
      },
      {
        id: "test",
        type: "shell",
        label: "Run tests",
        position: { x: 280, y: 0 },
        config: { run: "echo running tests; sleep 5; cat feature.txt; echo all tests passed" },
      },
      {
        id: "review",
        type: "prompt",
        label: "Review",
        position: { x: 560, y: 0 },
        config: { prompt: "[[ask:Allow editing feature.txt?]] Review the change and fix anything wrong" },
      },
      { id: "commit", type: "commit", label: "Commit", position: { x: 840, y: 0 }, config: { generateMessage: true } },
    ],
    edges: chain("implement", "test", "review", "commit"),
  },
  [REAL_SCENE]: {
    version: 1,
    id: REAL_SCENE,
    name: "Pong smoke",
    settings: { baseBranch: "main", defaults: { model: "haiku", completion: { mode: "auto", graceSec: 0 } } },
    nodes: [
      { id: "ping", type: "prompt", label: "Ping", position: { x: 0, y: 0 }, config: { prompt: "Reply with exactly PONG" } },
      {
        id: "echo",
        type: "prompt",
        label: "Echo",
        position: { x: 320, y: 0 },
        config: { prompt: "What word did the previous step output? Reply with only that word, in lowercase." },
      },
    ],
    edges: chain("ping", "echo"),
  },
  "ship-feature": {
    version: 1,
    id: "ship-feature",
    name: "Ship feature",
    // "always" keeps the worktrees after success, so the history shows the Clean up button.
    settings: { baseBranch: "main", maxParallelClaude: 3, keepWorktrees: "always" },
    nodes: [
      {
        id: "plan",
        type: "prompt",
        label: "Plan the API",
        position: { x: 0, y: 0 },
        config: { prompt: "[[sleep:1500]] [[write:PLAN.md:Plan: add a /health endpoint]] Plan a /health endpoint" },
      },
      {
        id: "impl",
        type: "prompt",
        label: "Implement API",
        position: { x: 280, y: -160 },
        config: { prompt: "[[sleep:6000]] [[write:src/health.ts:export const health = () => ({ ok: true });]] Implement the API in PLAN.md" },
      },
      {
        id: "tests",
        type: "prompt",
        label: "Write tests",
        position: { x: 280, y: 0 },
        config: { prompt: "[[sleep:7000]] [[write:test/health.test.ts:expect(health().ok).toBe(true);]] Write tests for the API" },
      },
      {
        id: "docs",
        type: "prompt",
        label: "Update docs",
        position: { x: 280, y: 160 },
        config: { prompt: "[[sleep:6500]] [[write:docs/health.md:GET /health returns ok]] Document the endpoint" },
      },
      { id: "merge", type: "merge", label: "Merge lanes", position: { x: 560, y: 0 }, config: { strategy: "merge", onConflict: "claude" } },
      { id: "commit", type: "commit", label: "Commit", position: { x: 840, y: 0 }, config: { generateMessage: true } },
      {
        id: "review",
        type: "approval",
        label: "Review",
        position: { x: 1120, y: 0 },
        config: { message: "Check the combined change before opening the PR.", showDiff: true },
      },
      { id: "pr", type: "pr", label: "Open PR", position: { x: 1400, y: 0 }, config: { draft: true, requireApproval: true } },
    ],
    edges: [
      { id: "e1", source: "plan", target: "impl" },
      { id: "e2", source: "plan", target: "tests" },
      { id: "e3", source: "plan", target: "docs" },
      { id: "e4", source: "impl", target: "merge" },
      { id: "e5", source: "tests", target: "merge" },
      { id: "e6", source: "docs", target: "merge" },
      { id: "e7", source: "merge", target: "commit" },
      { id: "e8", source: "commit", target: "review" },
      { id: "e9", source: "review", target: "pr" },
    ],
  },
  "test-fix": {
    version: 1,
    id: "test-fix",
    name: "Test-fix loop",
    settings: { baseBranch: "main", maxParallelClaude: 3 },
    nodes: [
      {
        id: "implement",
        type: "prompt",
        label: "Implement /health",
        position: { x: 0, y: 0 },
        config: { prompt: "[[sleep:1500]] [[write:src/health.ts:export const health = () => ({ ok: true });]] Implement /health" },
      },
      {
        id: "test",
        type: "shell",
        label: "Run tests",
        position: { x: 300, y: 0 },
        // Fails until "Fix failing tests" has run twice: the loop runs three iterations.
        config: {
          run: 'sleep 1; n=$(cat fixes.log 2>/dev/null | wc -l | tr -d " "); echo "fixes applied: $n"; if [ "$n" -lt 2 ]; then echo "FAIL health.test.ts: expected 200, got 500"; exit 1; fi',
        },
      },
      {
        id: "green",
        type: "condition",
        label: "Tests pass?",
        position: { x: 600, y: 0 },
        config: { evaluator: { kind: "exitCode", equals: 0 } },
      },
      {
        id: "commit",
        type: "commit",
        label: "Commit",
        position: { x: 900, y: -110 },
        config: { generateMessage: false, message: "feat: add /health endpoint" },
      },
      {
        id: "report",
        type: "shell",
        label: "Report commit failure",
        position: { x: 1200, y: -110 },
        config: { run: "echo commit failed" },
      },
      {
        id: "fix",
        type: "prompt",
        label: "Fix failing tests",
        position: { x: 900, y: 120 },
        config: { prompt: "[[sleep:3500]] [[bash:echo fix >> fixes.log]] Fix the failing tests (not the tests themselves)" },
      },
    ],
    edges: [
      { id: "e1", source: "implement", target: "test" },
      { id: "e2", source: "test", target: "green", when: "always" },
      { id: "e3", source: "green", sourcePort: "true", target: "commit" },
      { id: "e4", source: "green", sourcePort: "false", target: "fix" },
      { id: "e5", source: "commit", sourcePort: "error", target: "report" },
      { id: "loop", source: "fix", target: "test", loop: { maxIterations: 3, onExhausted: "fail" } },
    ],
  },
};

// ---------------------------------------------------------------------------- server

async function startServer(repo, env, port) {
  const child = spawn(process.execPath, [SERVER_CLI, repo, "--port", String(port), "--no-open"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const url = await until(
    "the server URL",
    () => {
      if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}):\n${output}`);
      return /Open: (http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)/.exec(output)?.[1];
    },
    30_000,
  );
  const token = new URL(url).searchParams.get("t");
  return { child, url, token, base: `http://127.0.0.1:${port}`, output: () => output };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((r) => server.child.once("exit", r));
  server.child.kill("SIGINT");
  await Promise.race([exited, sleep(10_000)]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

function apiClient(server) {
  return async function api(method, route, body) {
    const res = await fetch(`${server.base}${route}`, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Current node run (highest iteration, then attempt) of `nodeId`, or of a given iteration. */
function currentNodeRun(detail, nodeId, iteration) {
  return detail.nodeRuns
    .filter((n) => n.nodeId === nodeId && (iteration === undefined || n.iteration === iteration))
    .sort((a, b) => b.iteration - a.iteration || b.attempt - a.attempt)[0];
}

// ---------------------------------------------------------------------------- scenes

function makeScenes({ api, page, outDir }) {
  const shot = async (name) => {
    await sleep(400); // Let transitions (fitView, dialogs, toasts) settle.
    await page.screenshot({ path: path.join(outDir, name) });
    log("wrote", name);
  };
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const clickNode = async (id) => node(id).click();
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const closeTerminals = async () => {
    const close = page.getByRole("button", { name: "Close terminal" });
    while (await close.count()) await close.first().click();
  };
  const clickPane = async () => page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });

  async function openGraph(id) {
    await page.evaluate((g) => localStorage.setItem("pg_last_graph", g), id);
    await page.reload();
    await page.getByRole("tab", { name: "Nodes" }).click();
    await blur();
    await node(GRAPHS[id].nodes[0].id).waitFor();
    await page.getByText("Saved").or(page.getByText("No problems found.")).first().waitFor();
  }

  async function startRun(graphId) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const { runs } = await until("the run to start", async () => {
      const r = await api("GET", `/api/runs?graph=${graphId}&limit=1`);
      return r.runs.length && r.runs[0].status !== "succeeded" ? r : null;
    });
    return runs[0].id;
  }

  async function waitNode(runId, nodeId, statuses, iteration) {
    const want = [statuses].flat();
    return until(`${nodeId} to be ${want.join("|")}`, async () => {
      const nr = currentNodeRun(await api("GET", `/api/runs/${runId}`), nodeId, iteration);
      return nr && want.includes(nr.status) ? nr : null;
    });
  }

  async function waitRun(runId, status = "succeeded") {
    return until(`run ${runId} to be ${status}`, async () => {
      const d = await api("GET", `/api/runs/${runId}`);
      if (["failed", "cancelled"].includes(d.run.status) && status !== d.run.status) throw new Error(`Run ${runId} ${d.run.status}: ${d.run.error}`);
      return d.run.status === status ? d : null;
    }, 120_000);
  }

  /** The node card shows `text` (the UI got the state over the WebSocket). */
  const cardShows = (id, text) => node(id).getByText(text, { exact: true }).first().waitFor({ timeout: WAIT_MS });

  async function openRunFromHistory(runId) {
    const { run } = await api("GET", `/api/runs/${runId}`);
    // A run that finishes while shown opens its report: close it to get the canvas back.
    const closeReport = page.getByRole("button", { name: "Close report" });
    await closeReport.waitFor({ timeout: 3000 }).catch(() => {});
    if (await closeReport.isVisible()) await closeReport.click();
    await page.getByRole("tab", { name: /^Runs/ }).click();
    await page.getByRole("button", { name: new RegExp(`^Open run #${run.shortId}`) }).click();
    await page.getByRole("button", { name: "Back to editor" }).waitFor();
    return run;
  }

  /** Clicks the middle of an edge's path (loop edges are U-shaped: their bounding box centre is empty). */
  async function clickEdge(edgeId) {
    const pt = await page.evaluate((id) => {
      const p = document.querySelector(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-interaction`)
        ?? document.querySelector(`.react-flow__edge[data-id="${id}"] path`);
      if (!p) return null;
      const m = p.getScreenCTM();
      const q = p.getPointAtLength(p.getTotalLength() / 2);
      return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
    }, edgeId);
    if (!pt) throw new Error(`Edge ${edgeId} not found`);
    await page.mouse.click(pt.x, pt.y);
  }

  return {
    async [REAL_SCENE]() {
      await openGraph(REAL_SCENE);
      const runId = await startRun(REAL_SCENE);
      await waitRun(runId);
      await openRunFromHistory(runId);
      await clickPane();
      await cardShows("echo", "Succeeded");
      await clickNode("echo");
      await page.getByText("Read-only replay").first().waitFor();
      await sleep(1500); // The replay is written to xterm in chunks.
      await shot("m2-real-claude-replay.png");
    },

    async "add-feature"() {
      await openGraph("add-feature");
      await shot("m2-editor.png");

      const runId = await startRun("add-feature");
      await waitNode(runId, "test", "running");
      await cardShows("test", "Running");
      await sleep(1200);
      await shot("m2-run-running.png");

      await waitNode(runId, "review", "waiting_input");
      await cardShows("review", "Waiting for input");
      await clickNode("review");
      const terminal = page.locator(".xterm").first();
      await terminal.waitFor();
      await until("the terminal to show the question", () =>
        page.locator(".xterm-rows").first().innerText().then((t) => t.includes("Allow editing feature.txt?")).catch(() => true),
      );
      await shot("m2-terminal.png");

      // Answer the fake permission prompt in the live terminal.
      await terminal.click();
      await page.keyboard.type("y");
      await page.keyboard.press("Enter");
      await waitRun(runId);
      await openRunFromHistory(runId);
      await closeTerminals();
      await clickPane();
      await cardShows("commit", "Succeeded");
      await shot("m2-run-finished.png");
    },

    async "ship-feature"() {
      await openGraph("ship-feature");
      const runId = await startRun("ship-feature");
      for (const id of ["impl", "tests", "docs"]) await waitNode(runId, id, "running");
      for (const id of ["impl", "tests", "docs"]) await cardShows(id, "Running");
      await sleep(1200);
      await shot("m4-fanout-lanes.png");

      await waitNode(runId, "review", "waiting_approval");
      await cardShows("review", "Waiting for approval");
      await clickNode("merge");
      await shot("m4-merge-node.png");

      await clickNode("review");
      const approval = page.getByRole("dialog");
      await approval.getByText("Approval required").waitFor();
      await approval.getByText("PLAN.md").first().waitFor();
      await shot("m4-approval-dialog.png");
      await approval.getByRole("button", { name: "Approve", exact: true }).click();
      await approval.waitFor({ state: "hidden" });

      await waitNode(runId, "pr", "waiting_approval");
      await cardShows("pr", "Waiting for approval");
      await clickNode("pr");
      const prDialog = page.getByRole("dialog");
      await prDialog.getByText("Approve pull request").waitFor();
      await prDialog.getByText("PLAN.md").first().waitFor();
      const approve = prDialog.getByRole("button", { name: "Approve & push" });
      await until("Approve & push to be enabled", () => approve.isEnabled());
      await shot("m4-pr-dialog.png");
      await approve.click();
      await prDialog.waitFor({ state: "hidden" });

      await waitRun(runId);
      await openRunFromHistory(runId);
      await clickNode("pr");
      await page.getByRole("button", { name: "Show lanes, branches and PRs" }).click();
      await page.getByText("acme/demo-app#42").first().waitFor();
      await shot("m4-history.png");

      await page.getByRole("button", { name: "Report", exact: true }).first().click();
      await page.getByText("Run report").waitFor();
      await page.getByText("Lanes", { exact: true }).waitFor();
      await shot("run-report.png");
      await page.getByRole("button", { name: "Close report" }).click();

      await page.getByRole("button", { name: /Clean up/ }).click();
      await page.getByText("Worktrees cleaned up.").waitFor();
      await shot("m4-history-cleaned.png");
    },

    async "test-fix"() {
      await openGraph("test-fix");
      await shot("m6-editor.png");
      await clickEdge("loop");
      await page.getByText("Loop back-edge").waitFor();
      await shot("m6-editor-loop-edge.png");
      await clickPane();

      const runId = await startRun("test-fix");
      await waitNode(runId, "fix", "running", 1);
      await cardShows("fix", "Running");
      await sleep(1200);
      await shot("m6-run-loop.png");

      await waitRun(runId);
      await openRunFromHistory(runId);
      await clickPane();
      await cardShows("commit", "Succeeded");
      await shot("m6-run-finished.png");

      await clickNode("test");
      await page.getByRole("tablist", { name: "Loop iterations" }).waitFor();
      await page.getByRole("tab", { name: "#1" }).click();
      await page.getByText("Previous iteration: read-only.").waitFor();
      await page.getByText(/Run tests #1/).first().waitFor();
      await shot("m6-iteration-selector.png");

      await clickNode("green");
      await page.getByText("Exit code 0 equals 0.").first().waitFor();
      await shot("m6-condition-result.png");
    },
  };
}

// ---------------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.out) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  if (!fs.existsSync(SERVER_CLI)) throw new Error(`${SERVER_CLI} not found: run pnpm install && pnpm build first`);
  const chrome = process.env.PG_SHOTS_CHROME ?? DEFAULT_CHROME;
  if (!fs.existsSync(chrome)) throw new Error(`Browser not found at ${chrome} (set PG_SHOTS_CHROME)`);
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default?.chromium;

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pgdemo-")));
  log("temp dir", root);

  // Isolated state: promptgraph home, Claude config, git config (no global hooks, signing or identity leaks).
  const pgHome = path.join(root, "pg");
  const claudeConfig = path.join(root, "claude-config");
  const gitConfig = path.join(root, "gitconfig");
  fs.mkdirSync(pgHome);
  fs.mkdirSync(claudeConfig);
  fs.writeFileSync(
    gitConfig,
    "[user]\n\tname = promptgraph demo\n\temail = demo@promptgraph.local\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  );
  if (opts.real) {
    // Real Claude Code: a copy of the user's config (onboarding done, dark TUI) and credentials in the temp
    // CLAUDE_CONFIG_DIR, so the real ~/.claude.json is never written. The copies go with the temp dir.
    const src = path.join(os.homedir(), ".claude.json");
    const cfg = fs.existsSync(src) ? JSON.parse(fs.readFileSync(src, "utf8")) : {};
    fs.writeFileSync(path.join(claudeConfig, ".claude.json"), JSON.stringify({ ...cfg, hasCompletedOnboarding: true, theme: "dark" }));
    const creds = path.join(os.homedir(), ".claude", ".credentials.json");
    if (fs.existsSync(creds)) fs.copyFileSync(creds, path.join(claudeConfig, ".credentials.json"));
    fs.chmodSync(claudeConfig, 0o700);
  }
  const env = {
    ...process.env,
    PG_HOME: pgHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    PG_CLAUDE_BIN: opts.real ? (process.env.PG_SHOTS_CLAUDE ?? "claude") : FAKE_CLAUDE,
    PG_GH_BIN: FAKE_GH,
    FAKE_GH_URL: "https://github.com/acme/demo-app/pull/42",
    FAKE_CLAUDE_DELAY_MS: "50",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };

  let server;
  let browser;
  try {
    const repo = createDemoRepo(root, env);
    server = await startServer(repo, env, await freePort());
    log("server", server.base);
    const api = apiClient(server);
    // No desktop notifications from the demo runs.
    await api("PUT", "/api/settings", { ...(await api("GET", "/api/settings")), notifications: false });
    for (const id of opts.scenes) await api("PUT", `/api/graphs/${id}`, GRAPHS[id]);

    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    await context.addInitScript(() => localStorage.setItem("pg-theme", "dark"));
    const page = await context.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    await page.goto(server.url);
    await page.getByRole("button", { name: "Settings" }).waitFor();

    const scenes = makeScenes({ api, page, outDir });
    for (const id of opts.scenes) {
      log("scene", id);
      await scenes[id]();
    }
  } catch (err) {
    if (server) console.error(`--- server output ---\n${server.output()}`);
    const failure = path.join(os.tmpdir(), "pg-shots-failure.png");
    const pages = browser?.contexts().flatMap((c) => c.pages()) ?? [];
    if (pages[0]) await pages[0].screenshot({ path: failure }).then(() => console.error(`Failure screenshot: ${failure}`), () => {});
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    // Never leave a copy of the Claude credentials behind, even with --keep.
    fs.rmSync(path.join(claudeConfig, ".credentials.json"), { force: true });
    if (opts.keep) log("kept", root);
    else fs.rmSync(root, { recursive: true, force: true });
  }
  log("done:", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
