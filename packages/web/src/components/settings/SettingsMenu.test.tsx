// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../../lib/theme";
import { useAppStore } from "../../store/app-store";
import { useUiStore } from "../../store/ui-store";
import { SettingsMenu } from "./SettingsMenu";

describe("settings menu", () => {
  const originalUpdate = useAppStore.getState().updateSettings;
  let updateSettings: ReturnType<typeof vi.fn<(patch: { notifications?: boolean }) => Promise<void>>>;

  beforeEach(() => {
    updateSettings = vi.fn((patch: { notifications?: boolean }) => {
      const prev = useAppStore.getState().settings;
      if (prev) useAppStore.setState({ settings: { ...prev, ...patch } });
      return Promise.resolve();
    });
    useAppStore.setState({ settings: { notifications: true }, repo: null, updateSettings });
    useUiStore.getState().setSettingsOpen(false);
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ settings: null, updateSettings: originalUpdate });
    useUiStore.getState().setSettingsOpen(false);
  });

  it("opens from the keyboard and moves focus into the menu", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    await user.keyboard("{Enter}");

    expect(useUiStore.getState().settingsOpen).toBe(true);
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
    expect(useUiStore.getState().settingsOpen).toBe(true);

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
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Desktop notifications" }).getAttribute("aria-checked")).toBe("false");
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");
    expect(useUiStore.getState().settingsOpen).toBe(false);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("disables the toggle when no notifier is available", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      repo: {
        id: "repo-0123abcd",
        path: "/tmp/repo",
        name: "repo",
        currentBranch: "main",
        branches: ["main"],
        version: "0.0.0",
        phase: 2,
        warnings: [],
        supportedNodeTypes: [],
        notificationsAvailable: false,
      },
    });
    render(<SettingsMenu />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Desktop notifications (unavailable)" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("/tmp/repo")).toBeTruthy();
  });
});
