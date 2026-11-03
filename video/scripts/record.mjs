#!/usr/bin/env node
// Records the raw footage of the launch video: a real promptgraph run, driven with Playwright, captured as a
// Chromium screencast (JPEG frames + timestamps) into video/public/recording/. The Remotion composition
// (video/src) cuts, speeds up, zooms and captions it.
//
//   PLAYWRIGHT_CORE=<dir with playwright-core> node video/scripts/record.mjs [--fake-claude] [--keep]
//
// By default the prompt steps run the real Claude Code with haiku and one-line prompts (a few cents), so the
// terminal and the diffs on screen are genuine; --fake-claude uses the test fake instead. Pull requests always
// go to the fake gh: nothing leaves the machine. State lives in a temp dir (see scripts/screenshots/demo-env.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
} from "../../scripts/screenshots/demo-env.mjs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/recording");
/** CSS viewport; with deviceScaleFactor 1.5 the frames are 1920x1080 and the UI reads well on a phone. */
const VIEWPORT = { width: 1280, height: 720 };
const SCALE = 1.5;
const RUN_TIMEOUT_MS = Number(process.env.PG_VIDEO_TIMEOUT_MS ?? 240_000);

const log = (...a) => console.log("[record]", ...a);
const args = new Set(process.argv.slice(2));
const fakeClaude = args.has("--fake-claude");

/** The demo graph: plan, three parallel lanes, merge, commit, review gate, draft PR. */
const GRAPH = {
  version: 1,
  id: "ship-health",
  name: "Ship /health",
  settings: {
    baseBranch: "main",
    maxParallelClaude: 3,
    defaults: {
      model: "haiku",
      completion: { mode: "auto", graceSec: 0 },
      // Haiku likes to look around before writing: allow read-only commands so no step stops on a prompt.
      allowedTools: [
        "Bash(ls:*)",
        "Bash(pwd)",
        "Bash(cat:*)",
        "Bash(head:*)",
        "Bash(find:*)",
        "Bash(echo:*)",
        "Bash(mkdir:*)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
      ],
    },
  },
  nodes: [
    {
      id: "plan",
      type: "prompt",
      label: "Plan",
      position: { x: 0, y: 0 },
      config: { prompt: "Write PLAN.md: a 3-line plan for a GET /health endpoint. Use only the Write tool, run no commands." },
    },
    {
      id: "impl",
      type: "prompt",
      label: "Implement API",
      position: { x: 300, y: -170 },
      config: { prompt: "Create src/health.ts exporting health() that returns { ok: true }. Use only the Write tool, run no commands." },
    },
    {
      id: "tests",
      type: "prompt",
      label: "Write tests",
      position: { x: 300, y: 0 },
      config: { prompt: "Create test/health.test.ts with one vitest test for health() from ../src/health. Use only the Write tool, run no commands." },
    },
    {
      id: "docs",
      type: "prompt",
      label: "Update docs",
      position: { x: 300, y: 170 },
      config: { prompt: "Add a short 'Health check' section about GET /health to README.md. Use only Read and Edit, run no commands." },
    },
    { id: "merge", type: "merge", label: "Merge lanes", position: { x: 600, y: 0 }, config: { strategy: "merge", onConflict: "claude" } },
    { id: "commit", type: "commit", label: "Commit", position: { x: 900, y: 0 }, config: { generateMessage: true } },
    {
      id: "review",
      type: "approval",
      label: "Review",
      position: { x: 1200, y: 0 },
      config: { message: "Check the combined change before opening the PR.", showDiff: true },
    },
    { id: "pr", type: "pr", label: "Open PR", position: { x: 1500, y: 0 }, config: { draft: true, requireApproval: true } },
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
};

/** A visible mouse pointer: headless Chromium draws none. Follows real mouse events, shrinks on press. */
function installCursor() {
  const add = () => {
    if (document.getElementById("pg-demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "pg-demo-cursor";
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4 3.9 7.4-2.9 1.5-3.9-7.5L4 19z" fill="#fff" stroke="#0a0a0a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(640px, 360px)",
      filter: "drop-shadow(0 2px 4px rgb(0 0 0 / .5))",
      transition: "scale .12s ease",
    });
    document.body.appendChild(c);
    document.addEventListener("mousemove", (e) => (c.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`), true);
    document.addEventListener("mousedown", () => (c.style.scale = "0.82"), true);
    document.addEventListener("mouseup", () => (c.style.scale = "1"), true);
  };
  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add);
}

async function main() {
  if (!fs.existsSync(SERVER_CLI)) throw new Error(`${SERVER_CLI} not found: run pnpm install && pnpm build first`);
  const chrome = process.env.PG_SHOTS_CHROME ?? DEFAULT_CHROME;
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default?.chromium;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pgvideo-")));
  log("temp dir", root);
  const { env, claudeConfig } = createIsolatedEnv(root, {
    claudeBin: fakeClaude ? FAKE_CLAUDE : (process.env.PG_SHOTS_CLAUDE ?? "claude"),
  });

  let server;
  let browser;
  try {
    const repo = createDemoRepo(root, env);
    server = await startServer(repo, env, await freePort());
    const api = apiClient(server);
    await api("PUT", "/api/settings", { ...(await api("GET", "/api/settings")), notifications: false });
    await api("PUT", `/api/graphs/${GRAPH.id}`, GRAPH);

    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "dark" });
    await context.addInitScript((id) => {
      localStorage.setItem("pg-theme", "dark");
      localStorage.setItem("pg_last_graph", id);
    }, GRAPH.id);
    await context.addInitScript(installCursor);
    const page = await context.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    await page.goto(server.url);
    await page.getByRole("tab", { name: "Nodes" }).click();
    await page.locator('.react-flow__node[data-id="pr"]').waitFor();
    await page.evaluate(() => document.activeElement?.blur());

    // ---------------------------------------------------------------- screencast
    const cdp = await context.newCDPSession(page);
    const frames = [];
    let writes = Promise.resolve();
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = `frames/${String(frames.length).padStart(5, "0")}.jpg`;
      frames.push({ file, t: metadata.timestamp });
      const buf = Buffer.from(data, "base64");
      writes = writes.then(() => fs.promises.writeFile(path.join(OUT, file), buf));
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    const markers = {};
    /** Pointer clicks (for the click sounds) and boxes of the regions the video spotlights. */
    const clicks = [];
    const boxes = {};
    /** Records the CSS-pixel box of `locators` (their union) under `name`, as fractions of the viewport. */
    async function saveBox(name, ...locators) {
      const bs = (await Promise.all(locators.map((l) => l.boundingBox()))).filter(Boolean);
      if (!bs.length) return;
      const x = Math.min(...bs.map((b) => b.x));
      const y = Math.min(...bs.map((b) => b.y));
      const r = Math.max(...bs.map((b) => b.x + b.width));
      const btm = Math.max(...bs.map((b) => b.y + b.height));
      boxes[name] = { x: x / VIEWPORT.width, y: y / VIEWPORT.height, w: (r - x) / VIEWPORT.width, h: (btm - y) / VIEWPORT.height };
    }
    const mark = (name) => {
      markers[name] = Date.now() / 1000;
      log("marker", name);
    };

    // ---------------------------------------------------------------- pointer helpers
    let pointer = { x: 640, y: 360 };
    await page.mouse.move(pointer.x, pointer.y);
    /** Glides the pointer to (x, y) with an ease-in-out curve, like a person would. */
    async function glide(x, y, ms = 650) {
      const from = { ...pointer };
      const steps = Math.max(12, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        await sleep(16);
      }
      pointer = { x, y };
    }
    async function clickOn(locator, { dx = 0.5, dy = 0.5, ms } = {}) {
      await locator.waitFor();
      const target = async () => {
        const b = await locator.boundingBox();
        if (!b) throw new Error("Element has no box");
        return { x: b.x + b.width * dx, y: b.y + b.height * dy };
      };
      let t = await target();
      await glide(t.x, t.y, ms);
      // The canvas can refit while the pointer travels (a drawer opens, a run starts): follow the element
      // until it stops moving, so the click lands on it.
      for (let i = 0; i < 5; i++) {
        await sleep(160);
        t = await target();
        if (Math.hypot(t.x - pointer.x, t.y - pointer.y) < 2) break;
        await glide(t.x, t.y, 220);
      }
      await sleep(120);
      clicks.push(Date.now() / 1000);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
    }
    const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
    async function waitNode(runId, nodeId, statuses) {
      const want = [statuses].flat();
      return until(
        `${nodeId} to be ${want.join("|")}`,
        async () => {
          const d = await api("GET", `/api/runs/${runId}`);
          if (["failed", "cancelled"].includes(d.run.status)) throw new Error(`Run ${d.run.status}: ${d.run.error}`);
          const nr = currentNodeRun(d, nodeId);
          return nr && want.includes(nr.status) ? nr : null;
        },
        RUN_TIMEOUT_MS,
        200,
      );
    }

    // ---------------------------------------------------------------- the story
    await sleep(1200);
    mark("editor");
    // Look over the graph: glide along the fan-out, then to Run.
    for (const id of ["plan", "tests", "merge", "pr"]) {
      const b = await node(id).boundingBox();
      await glide(b.x + b.width / 2, b.y + b.height / 2, 520);
      await sleep(180);
    }
    await sleep(400);
    await clickOn(page.getByRole("button", { name: "Run", exact: true }), { ms: 700 });
    mark("run");
    // More room for the run: fold the left panel away.
    await sleep(500);
    await clickOn(page.getByRole("button", { name: "Collapse sidebar" }), { ms: 500 });
    const { runs } = await until("the run to start", async () => {
      const r = await api("GET", `/api/runs?graph=${GRAPH.id}&limit=1`);
      return r.runs.length ? r : null;
    });
    const runId = runs[0].id;

    await waitNode(runId, "plan", "succeeded");
    await until("the lanes to fan out", async () => {
      const d = await api("GET", `/api/runs/${runId}`);
      return ["impl", "tests", "docs"].every((id) => currentNodeRun(d, id)?.status === "running");
    }, RUN_TIMEOUT_MS, 200);
    mark("fanout");
    await saveBox("lanes", node("impl"), node("tests"), node("docs"));
    await sleep(400);

    // "Update docs" reads, then edits: the longest lane, so its live session is still working on screen.
    await clickOn(node("docs"), { dy: 0.35 });
    await page.locator(".xterm").first().waitFor();
    mark("terminal");
    await sleep(600); // The drawer opens and the canvas refits.
    await saveBox("terminal", page.locator(".pg-terminal").first(), page.getByText("Live — you can type").first());
    await sleep(1000);
    await glide(VIEWPORT.width * 0.45, VIEWPORT.height * 0.8, 600);

    await waitNode(runId, "review", "waiting_approval");
    await sleep(800);
    // Close the terminal and refit, so the whole graph (and the review gate) is in view again.
    await clickOn(page.getByRole("button", { name: "Close terminal" }).first(), { ms: 500 });
    await sleep(300);
    await clickOn(page.getByRole("button", { name: "Fit view" }), { ms: 500 });
    await sleep(700);
    mark("review-waiting");
    await clickOn(node("review"), { dy: 0.35 });
    const approval = page.getByRole("dialog");
    await approval.getByText("Approval required").waitFor();
    // The diff (real Claude writes files); the fake dry run has no changes to show.
    await approval.locator(".d2h-file-wrapper").first().or(approval.getByText(/No changes/).first()).waitFor();
    mark("approval");
    await sleep(1200);
    const box = await approval.boundingBox();
    await glide(box.x + box.width / 2, box.y + box.height * 0.6, 500);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 90);
      await sleep(110);
    }
    await sleep(900);
    await clickOn(approval.getByRole("button", { name: "Approve", exact: true }));
    await approval.waitFor({ state: "hidden" });

    await waitNode(runId, "pr", "waiting_approval");
    await sleep(600);
    // The PR gate sits under the inspector at this width: answer it from the header's approvals menu.
    await clickOn(page.getByRole("button", { name: /approvals? pending/ }), { ms: 600 });
    await sleep(500);
    await clickOn(page.getByRole("menuitem").filter({ hasText: "Open PR" }).first(), { ms: 450 });
    const prDialog = page.getByRole("dialog");
    await prDialog.getByText("Approve pull request").waitFor();
    const approve = prDialog.getByRole("button", { name: "Approve & push" });
    await until("Approve & push to be enabled", () => approve.isEnabled(), RUN_TIMEOUT_MS);
    mark("pr");
    await sleep(2200);
    await clickOn(approve);
    await prDialog.waitFor({ state: "hidden" });

    await page.getByText("Run report").waitFor({ timeout: RUN_TIMEOUT_MS });
    mark("report");
    await sleep(1800);
    const report = await page.getByText("Run report").boundingBox();
    await glide(report.x + 300, report.y + 300, 600);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 70);
      await sleep(120);
    }
    await sleep(2200);
    mark("end");

    await cdp.send("Page.stopScreencast");
    await writes;
    const t0 = frames[0]?.t ?? 0;
    const manifest = {
      width: VIEWPORT.width * SCALE,
      height: VIEWPORT.height * SCALE,
      claude: fakeClaude ? "fake" : "real (haiku)",
      frames: frames.map((f) => ({ file: f.file, t: Number((f.t - t0).toFixed(3)) })),
      markers: Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, Number((v - t0).toFixed(3))])),
      clicks: clicks.map((c) => Number((c - t0).toFixed(3))),
      boxes,
    };
    fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
    log(`${frames.length} frames, ${manifest.frames.at(-1)?.t.toFixed(1)}s`, manifest.markers);
  } catch (err) {
    if (server) console.error(`--- server output ---\n${server.output()}`);
    const failure = path.join(os.tmpdir(), "pg-video-failure.png");
    const pages = browser?.contexts().flatMap((c) => c.pages()) ?? [];
    if (pages[0]) await pages[0].screenshot({ path: failure }).then(() => console.error(`Failure screenshot: ${failure}`), () => {});
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    removeCredentials(claudeConfig);
    if (args.has("--keep")) log("kept", root);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
