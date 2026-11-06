import { describe, expect, it, vi } from "vitest";
import { authInfoOf, billingModeOf, checkClaudeAuth, ClaudeAuthProbe, runAuthStatus, type RawAuthStatus } from "../src/config/claude-auth.js";
import { FAKE_CLAUDE, tempDir } from "./helpers.js";

/** `claude auth status --json` outputs captured from Claude Code 2.1.319 (account fields removed). */
const SUBSCRIPTION: RawAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", planTier: "max_20x" };
const API_KEY: RawAuthStatus = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" };

describe("billingModeOf (DESIGN §23.1)", () => {
  it.each<[RawAuthStatus, NodeJS.ProcessEnv, string]>([
    [SUBSCRIPTION, {}, "subscription"],
    [API_KEY, {}, "api"],
    [{ loggedIn: true, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" }, {}, "api"],
    [{ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, {}, "cloud"],
    [{ loggedIn: true, authMethod: "oauth_token" }, { CLAUDE_CODE_OAUTH_TOKEN: "t" }, "subscription"],
    // ANTHROPIC_AUTH_TOKEN takes precedence over CLAUDE_CODE_OAUTH_TOKEN and is usually a gateway.
    [{ loggedIn: true, authMethod: "oauth_token" }, { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_AUTH_TOKEN: "g" }, "unknown"],
    [{ loggedIn: false, authMethod: "none" }, {}, "none"],
    [{ loggedIn: true, authMethod: "something_new" }, {}, "unknown"],
  ])("%o with %o → %s", (raw, env, mode) => {
    expect(billingModeOf(raw, env)).toBe(mode);
  });

  it("keeps the plan only on a subscription and never account identifiers", () => {
    const info = authInfoOf({ ...SUBSCRIPTION, email: "a@b.c", orgId: "o" } as RawAuthStatus, {}, 7);
    expect(info).toEqual({
      billingMode: "subscription",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      apiKeySource: null,
      plan: "max",
      planTier: "max_20x",
      apiKeyOverridesLogin: false,
      error: null,
      checkedAt: 7,
    });
    expect(authInfoOf({ ...API_KEY, subscriptionType: "max" }, {}, 7).plan).toBeNull();
  });
});

describe("checkClaudeAuth", () => {
  it("reports an API key that overrides a stored claude.ai login (checked again without the key)", async () => {
    const run = vi.fn(async (env: NodeJS.ProcessEnv, _cwd: string) => (env.ANTHROPIC_API_KEY ? API_KEY : SUBSCRIPTION));
    const info = await checkClaudeAuth({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" }, "/repo", run, () => 1);
    expect(info).toMatchObject({ billingMode: "api", apiKeySource: "ANTHROPIC_API_KEY", apiKeyOverridesLogin: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toEqual({ PATH: "/bin" });
    expect(run.mock.calls[1]![1]).toBe("/repo");
  });

  it("does not check again for a key from apiKeyHelper or without a stored login", async () => {
    const helper = vi.fn(async () => ({ loggedIn: true, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" }));
    expect((await checkClaudeAuth({}, "/repo", helper)).apiKeyOverridesLogin).toBe(false);
    expect(helper).toHaveBeenCalledTimes(1);
    const keyOnly = vi.fn(async (env: NodeJS.ProcessEnv) => (env.ANTHROPIC_API_KEY ? API_KEY : { loggedIn: false, authMethod: "none" }));
    expect((await checkClaudeAuth({ ANTHROPIC_API_KEY: "sk" }, "/repo", keyOnly)).apiKeyOverridesLogin).toBe(false);
  });

  it("turns a failed check into an unknown mode with the error", async () => {
    const info = await checkClaudeAuth({}, "/repo", async () => Promise.reject(new Error("The claude command was not found on PATH")), () => 3);
    expect(info).toMatchObject({ billingMode: "unknown", error: "The claude command was not found on PATH", checkedAt: 3 });
  });

  it("runs the claude CLI: fake-claude answers auth status, a missing binary is reported", async () => {
    const t = tempDir();
    try {
      expect(await runAuthStatus({ PATH: process.env.PATH, PG_CLAUDE_BIN: FAKE_CLAUDE }, t.dir)).toMatchObject({ authMethod: "claude.ai", planTier: "max_20x" });
      await expect(runAuthStatus({ PATH: process.env.PATH, PG_CLAUDE_BIN: "/nonexistent/claude" }, t.dir)).rejects.toThrow(/not found/);
    } finally {
      t.cleanup();
    }
  });
});

describe("ClaudeAuthProbe", () => {
  it("caches per repository for the TTL, shares concurrent checks and refreshes on demand", async () => {
    let now = 1000;
    const helper: RawAuthStatus = { loggedIn: true, authMethod: "api_key_helper", apiKeySource: "apiKeyHelper" };
    const run = vi.fn(async (_env: NodeJS.ProcessEnv, cwd: string) => (cwd === "/a" ? SUBSCRIPTION : helper));
    const probe = new ClaudeAuthProbe({}, { run, now: () => now, ttlMs: 5000 });
    expect(probe.peek("/a")).toBeNull();
    const [first, second] = await Promise.all([probe.get("/a"), probe.get("/a")]);
    expect(first).toBe(second);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await probe.get("/b")).billingMode).toBe("api");
    expect(run).toHaveBeenCalledTimes(2);

    await probe.get("/a", { refresh: true });
    expect(run).toHaveBeenCalledTimes(2); // under a second after the check
    now += 50;
    await probe.get("/a");
    expect(run).toHaveBeenCalledTimes(2);
    now += 1000;
    await probe.get("/a", { refresh: true });
    expect(run).toHaveBeenCalledTimes(3);
    now += 6000;
    await probe.get("/a");
    expect(run).toHaveBeenCalledTimes(4);
    expect(probe.peek("/a")?.billingMode).toBe("subscription");
    probe.forget("/a");
    expect(probe.peek("/a")).toBeNull();
  });
});
