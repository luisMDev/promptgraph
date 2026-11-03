#!/usr/bin/env node
// Regenerates the UI screenshots of docs/screenshots (dark theme) against a throwaway demo repository,
// the fake claude CLI and the fake gh CLI. See README.md next to this file.
//
//   node scripts/screenshots/capture.mjs <out-dir> [--keep] [--scene add-feature,ship-feature,test-fix]
//   node scripts/screenshots/capture.mjs <out-dir> --real-claude   (m2-real-claude-replay.png, real Claude Code)
//
// Never touches the user's ~/.promptgraph, ~/.claude.json or real repositories: everything lives in a temp dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  apiClient,
  createDemoRepo,
  createIsolatedEnv,
  currentNodeRun,
  DEFAULT_CHROME,
  FAKE_CLAUDE,
  freePort,
  loadPlaywright,
  removeCredentials,
  SERVER_CLI,
  sleep,
  startServer,
  stopServer,
  until,
  WAIT_MS,
} from "./demo-env.mjs";

const VIEWPORT = { width: 1600, height: 900 };
const SCENES = ["add-feature", "ship-feature", "test-fix"];
/** Opt-in scene (--real-claude): a real Claude Code session with haiku and minimal prompts. */
const REAL_SCENE = "real-claude";

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

const log = (...a) => console.log("[shots]", ...a);

// ---------------------------------------------------------------------------- demo repository

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

// ---------------------------------------------------------------------------- scenes

function makeScenes({ api, page, outDir, server }) {
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
    // Every view has a URL (DESIGN §13.2); the session cookie from the login keeps the page signed in.
    await page.goto(`${server.base}/r/${encodeURIComponent(server.repoId)}/graphs/${encodeURIComponent(id)}`);
    await page.getByRole("tab", { name: "Nodes" }).click();
    await blur();
    await node(GRAPHS[id].nodes[0].id).waitFor();
    await page.getByText("Saved").or(page.getByText("No problems found.")).first().waitFor();
  }

  async function startRun(graphId) {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const { runs } = await until("the run to start", async () => {
      const r = await api("GET", `/runs?graph=${graphId}&limit=1`);
      return r.runs.length && r.runs[0].status !== "succeeded" ? r : null;
    });
    return runs[0].id;
  }

  async function waitNode(runId, nodeId, statuses, iteration) {
    const want = [statuses].flat();
    return until(`${nodeId} to be ${want.join("|")}`, async () => {
      const nr = currentNodeRun(await api("GET", `/runs/${runId}`), nodeId, iteration);
      return nr && want.includes(nr.status) ? nr : null;
    });
  }

  async function waitRun(runId, status = "succeeded") {
    return until(`run ${runId} to be ${status}`, async () => {
      const d = await api("GET", `/runs/${runId}`);
      if (["failed", "cancelled"].includes(d.run.status) && status !== d.run.status) throw new Error(`Run ${runId} ${d.run.status}: ${d.run.error}`);
      return d.run.status === status ? d : null;
    }, 120_000);
  }

  /** The node card shows `text` (the UI got the state over the WebSocket). */
  const cardShows = (id, text) => node(id).getByText(text, { exact: true }).first().waitFor({ timeout: WAIT_MS });

  async function openRunFromHistory(runId) {
    const { run } = await api("GET", `/runs/${runId}`);
    // A run that finishes while shown opens its report: close it to get the canvas back.
    const closeReport = page.getByRole("link", { name: "Close report" });
    await closeReport.waitFor({ timeout: 3000 }).catch(() => {});
    if (await closeReport.isVisible()) await closeReport.click();
    await page.getByRole("tab", { name: /^Runs/ }).click();
    await page.getByRole("link", { name: new RegExp(`^Open run #${run.shortId}`) }).click();
    await page.getByRole("link", { name: "Back to editor" }).waitFor();
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

      await page.getByRole("link", { name: "Report", exact: true }).first().click();
      await page.getByText("Run report").waitFor();
      await page.getByText("Lanes", { exact: true }).waitFor();
      await shot("run-report.png");
      await page.getByRole("link", { name: "Close report" }).click();

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
      const iterations = page.getByRole("tablist", { name: "Loop iterations" });
      await iterations.waitFor();
      // Scoped: the app's tab strip has tabs too ("<graph> #<shortId>").
      await iterations.getByRole("tab", { name: "#1" }).click();
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

  const { env, claudeConfig } = createIsolatedEnv(root, {
    claudeBin: opts.real ? (process.env.PG_SHOTS_CLAUDE ?? "claude") : FAKE_CLAUDE,
  });

  let server;
  let browser;
  try {
    const repo = createDemoRepo(root, env);
    server = await startServer(repo, env, await freePort());
    log("server", server.base);
    const api = apiClient(server);
    // No desktop notifications from the demo runs.
    await api("PUT", "/api/settings", { ...(await api("GET", "/api/settings")), notifications: false });
    for (const id of opts.scenes) await api("PUT", `/graphs/${id}`, GRAPHS[id]);

    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    await context.addInitScript(() => localStorage.setItem("pg-theme", "dark"));
    const page = await context.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    await page.goto(await server.loginUrl());
    await page.getByRole("button", { name: "Settings" }).waitFor();

    const scenes = makeScenes({ api, page, outDir, server });
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
    removeCredentials(claudeConfig);
    if (opts.keep) log("kept", root);
    else fs.rmSync(root, { recursive: true, force: true });
  }
  log("done:", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
