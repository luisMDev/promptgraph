// @vitest-environment jsdom
import type { ClaudeSetupResponse } from "@promptgraph/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/rest";
import { ClaudeSetupButton } from "./ClaudeSetupWizard";

vi.mock("../../api/rest", () => ({
  api: { claudeSetup: vi.fn(), checkClaudeSetup: vi.fn() },
  errorMessage: (err: unknown) => String(err),
}));

const SETUP: ClaudeSetupResponse = {
  version: "0.1.0",
  repoPath: "/work/repo",
  binPath: "/opt/promptgraph/cli/index.js",
  mcpAddCommand: "claude mcp add promptgraph -- /usr/bin/node /opt/promptgraph/cli/index.js mcp",
  plugin: {
    available: true,
    marketplacePath: "/opt/promptgraph",
    addMarketplaceCommand: "/plugin marketplace add /opt/promptgraph",
    installCommand: "/plugin install promptgraph@promptgraph",
  },
  skills: [{ name: "design-graph", title: "Design a graph", summary: "Builds graphs.", examples: ["Design a graph for X."] }],
  toolGroups: [
    {
      title: "Runs",
      tools: [
        { name: "wait_for_run", summary: "Waits.", confirmFirst: false },
        { name: "cancel_run", summary: "Cancels a run.", confirmFirst: true },
      ],
    },
  ],
};

async function openWizard(user: ReturnType<typeof userEvent.setup>) {
  render(<ClaudeSetupButton />);
  await user.click(screen.getByRole("button", { name: "Connect Claude Code" }));
  await screen.findByText("/plugin install promptgraph@promptgraph");
}

describe("Claude Code setup wizard", () => {
  beforeEach(() => {
    vi.mocked(api.claudeSetup).mockResolvedValue(SETUP);
    vi.mocked(api.checkClaudeSetup).mockResolvedValue({ claudeFound: true, mcpRegistered: false, output: "promptgraph: missing" });
  });
  afterEach(() => cleanup());

  it("opens from the header and shows the plugin commands by default", async () => {
    const user = userEvent.setup();
    await openWizard(user);
    expect(screen.getByText("/plugin marketplace add /opt/promptgraph")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Plugin/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("export PROMPTGRAPH_BIN=/opt/promptgraph/cli/index.js")).toBeTruthy();
  });

  it("switches to the MCP-only command when that option is picked", async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await user.click(screen.getByRole("radio", { name: /MCP server only/ }));
    expect(screen.getByText(SETUP.mcpAddCommand)).toBeTruthy();
    expect(screen.queryByText("/plugin install promptgraph@promptgraph")).toBeNull();
  });

  it("runs the check when the step is reached and says when promptgraph is not listed", async () => {
    const user = userEvent.setup();
    await openWizard(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.checkClaudeSetup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Not listed yet/)).toBeTruthy();
  });

  it("walks through skills and filters tools, marking the ones that ask first", async () => {
    const user = userEvent.setup();
    await openWizard(user);
    for (let i = 0; i < 2; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Design a graph")).toBeTruthy();
    expect(screen.getByText(/Design a graph for X\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByText("asks first").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Filter tools"), "wait");
    expect(screen.getByText("wait_for_run")).toBeTruthy();
    expect(screen.queryByText("cancel_run")).toBeNull();
  });
});
