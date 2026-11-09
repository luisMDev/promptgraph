// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import type { DaemonInfoResponse } from "@promptgraph/shared";
import { useDaemonStore } from "../../store/daemon-store";
import { createTestView, type TestView } from "../../store/view/test-view";
import { SettingsMenu, useSettingsMenu } from "./SettingsMenu";

const daemon: DaemonInfoResponse = { version: "0.0.0", pid: 1, port: 4777, startedAt: 1, phase: 2, warnings: [], supportedNodeTypes: [], notificationsAvailable: true };

describe("settings menu", () => {
  const originalUpdate = useDaemonStore.getState().updateSettings;
  let updateSettings: ReturnType<typeof vi.fn<(patch: { notifications?: boolean; bypassPermissions?: boolean }) => Promise<void>>>;
  let view: TestView;
  const render = (ui: Parameters<TestView["render"]>[0]) => view.render(ui);

  beforeEach(() => {
    updateSettings = vi.fn((patch: { notifications?: boolean; bypassPermissions?: boolean }) => {
      const prev = useDaemonStore.getState().settings;
      if (prev) useDaemonStore.setState({ settings: { ...prev, ...patch } });
      return Promise.resolve();
    });
    useDaemonStore.setState({ settings: { notifications: true, bypassPermissions: false }, info: daemon, updateSettings });
    view = createTestView({ repoInfo: null });
  });
  afterEach(() => {
    cleanup();
    useSettingsMenu.setState({ open: false });
    useDaemonStore.setState({ settings: null, info: null, updateSettings: originalUpdate });
  });

  it("opens from the keyboard and moves focus into the menu", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    await user.keyboard("{Enter}");

    expect(useSettingsMenu.getState().open).toBe(true);
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  });

  it("navigates items with ArrowDown", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    screen.getByRole("button", { name: "Settings" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Light" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Desktop notifications" }));
  });

  it("switches the theme, remembers it and keeps the menu open", async () => {
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect((await screen.findByRole("menuitemradio", { name: "Dark" })).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(useSettingsMenu.getState().open).toBe(true);

    await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("toggling the checkbox item saves the setting and keeps the menu open", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Desktop notifications" });
    expect(item.getAttribute("aria-checked")).toBe("true");

    await user.click(item);
    expect(updateSettings).toHaveBeenCalledWith({ notifications: false });
    expect(useSettingsMenu.getState().open).toBe(true);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Desktop notifications" }).getAttribute("aria-checked")).toBe("false");
  });

  it("bypass permissions is off by default; turning it on saves it and shows the warning", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Bypass permissions" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/approve its own gates/)).toBeNull();

    await user.click(item);
    expect(updateSettings).toHaveBeenCalledWith({ bypassPermissions: true });
    expect(screen.getByRole("menuitemcheckbox", { name: "Bypass permissions" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/approve its own gates/)).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");
    expect(useSettingsMenu.getState().open).toBe(false);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("disables the toggle when no notifier is available", async () => {
    const user = userEvent.setup();
    useDaemonStore.setState({ info: { ...daemon, notificationsAvailable: false } });
    render(<SettingsMenu repoPath="/tmp/repo" />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Desktop notifications (unavailable)" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("/tmp/repo")).toBeTruthy();
  });
});
