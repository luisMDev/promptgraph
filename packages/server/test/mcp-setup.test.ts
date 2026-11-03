import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SKILLS, MCP_TOOL_GROUPS, ClaudeSetupResponseSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSetup, checkClaudeSetup, shellQuote } from "../src/mcp/setup.js";
import { createTempRepo, tempDir } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("setup guide content", () => {
  it("every skill in the catalog has a SKILL.md in the plugin", () => {
    for (const skill of MCP_SKILLS) {
      const file = path.join(REPO_ROOT, "plugins/promptgraph/skills", skill.name, "SKILL.md");
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toContain(`name: ${skill.name}`);
    }
  });

  it("the catalog has no duplicate tool names", () => {
    const names = MCP_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("buildClaudeSetup", () => {
  it("quotes the CLI path and offers the plugin when it is bundled", () => {
    const setup = buildClaudeSetup({
      repoPath: "/work/my repo",
      cliEntry: "/opt/promptgraph dir/cli/index.js",
      nodePath: "/usr/bin/node",
      marketplaceRoot: "/opt/promptgraph",
    });
    expect(ClaudeSetupResponseSchema.parse(setup)).toBeTruthy();
    expect(setup.mcpAddCommand).toBe("claude mcp add promptgraph -- /usr/bin/node '/opt/promptgraph dir/cli/index.js' mcp");
    expect(setup.binPath).toBe("/opt/promptgraph dir/cli/index.js");
    expect(setup.plugin).toMatchObject({
      available: true,
      addMarketplaceCommand: "/plugin marketplace add /opt/promptgraph",
      installCommand: "/plugin install promptgraph@promptgraph",
    });
    expect(setup.skills.map((s) => s.name)).toEqual(["design-graph", "run-graph", "review-run"]);
  });

  it("says the plugin is unavailable when the checkout does not bundle it", () => {
    const setup = buildClaudeSetup({ repoPath: "/r", cliEntry: "/c.js", nodePath: "/n", marketplaceRoot: null });
    expect(setup.plugin).toMatchObject({ available: false, marketplacePath: null, addMarketplaceCommand: null });
  });

  it("shellQuote leaves plain words bare and escapes single quotes", () => {
    expect(shellQuote("plain-word_1/x.js")).toBe("plain-word_1/x.js");
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
  });
});

describe("checkClaudeSetup", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  function fakeClaude(script: string): NodeJS.ProcessEnv {
    const { dir, cleanup } = tempDir("pg-claude-fake-");
    cleanups.push(cleanup);
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { PG_CLAUDE_BIN: bin };
  }

  // Fake `claude mcp get <name>`: exit 0 and details for the plugin name only, exit 1 otherwise.
  const GET_FAKE = `if [ "$1" = mcp ] && [ "$2" = get ] && [ "$3" = "plugin:promptgraph:promptgraph" ]; then echo "plugin:promptgraph:promptgraph:"; echo "  Status: connected"; exit 0; fi; echo "No MCP server named \"$3\"" >&2; exit 1`;

  const cwd = process.cwd();

  it("detects a promptgraph MCP entry from the plugin", async () => {
    expect(await checkClaudeSetup({ env: fakeClaude(GET_FAKE), cwd })).toMatchObject({ claudeFound: true, mcpRegistered: true });
  });

  it("detects a promptgraph entry added by hand", async () => {
    const env = fakeClaude('if [ "$3" = promptgraph ]; then echo "promptgraph:"; exit 0; fi; exit 1');
    expect(await checkClaudeSetup({ env, cwd })).toMatchObject({ claudeFound: true, mcpRegistered: true });
  });

  it("runs claude in the repository (local and project scopes depend on the directory)", async () => {
    const { repo, cleanup } = createTempRepo();
    cleanups.push(cleanup);
    const env = fakeClaude(`if [ "$(pwd)" = "${repo}" ] && [ "$3" = promptgraph ]; then echo "promptgraph:"; exit 0; fi; exit 1`);
    expect(await checkClaudeSetup({ env, cwd: repo })).toMatchObject({ mcpRegistered: true });
    expect(await checkClaudeSetup({ env, cwd })).toMatchObject({ mcpRegistered: false });
  });

  it("reports when promptgraph is not configured", async () => {
    const res = await checkClaudeSetup({ env: fakeClaude('echo "No MCP server named \\"promptgraph\\"" >&2; exit 1'), cwd });
    expect(res).toMatchObject({ claudeFound: true, mcpRegistered: false });
    expect(res.output).toBe("No promptgraph MCP server is configured.");
  });

  it("reports a missing claude binary without throwing", async () => {
    const { repo, cleanup } = createTempRepo();
    cleanups.push(cleanup);
    const res = await checkClaudeSetup({ env: { PG_CLAUDE_BIN: path.join(repo, "does-not-exist") }, cwd: repo });
    expect(res).toMatchObject({ claudeFound: false, mcpRegistered: false });
  });
});
