// @vitest-environment jsdom
import type { AppSettings } from "@promptgraph/shared";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceStatusOf } from "../../test-fixtures";
import { useDaemonStore } from "../../store/daemon-store";
import { resetVoiceStore, setVoiceDeps } from "../../store/voice-store";
import { createTestView, type TestView } from "../../store/view/test-view";
import { SettingsMenu } from "./SettingsMenu";
import { VoiceSettingsDialog, draftToVoiceSettings } from "./VoiceSettingsDialog";

describe("voice settings", () => {
  const originalUpdate = useDaemonStore.getState().updateSettings;
  let view: TestView;
  const updateSettings = vi.fn(async (_patch: Partial<AppSettings>) => undefined);
  const getStatus = vi.fn(async () => voiceStatusOf({ mode: "tap", defaultsFrom: { mode: "claude", language: "fallback", autoSubmit: "fallback" } }));

  beforeEach(() => {
    resetVoiceStore();
    updateSettings.mockClear();
    getStatus.mockClear();
    setVoiceDeps({ getStatus });
    useDaemonStore.setState({ settings: { notifications: true }, updateSettings });
    view = createTestView();
  });
  afterEach(() => {
    cleanup();
    useDaemonStore.setState({ settings: null, updateSettings: originalUpdate });
  });

  it("opens from the settings menu and shows the detected status and the defaults' source", async () => {
    const user = userEvent.setup();
    view.render(<SettingsMenu />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("menuitem", { name: /Voice dictation/ }));
    const dialog = await screen.findByRole("dialog", { name: "Voice dictation" });
    await waitFor(() => expect(dialog.textContent).toMatch(/Ready: whisper.cpp runs on this machine/));
    expect(dialog.textContent).toMatch(/\/usr\/local\/bin\/whisper-cli \(PATH\)/);
    expect(dialog.textContent).toMatch(/ggml-small\.bin \(detected\)/);
    expect(screen.getByRole("option", { name: "Default: tap (Claude Code settings)" })).toBeTruthy();
  });

  it("saves the voice object as a whole and rechecks the status", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useDaemonStore.setState({ settings: { notifications: true, voice: { language: "es" } } });
    view.render(<VoiceSettingsDialog onClose={onClose} />);
    await user.type(screen.getByRole("textbox", { name: /whisper-cli binary/ }), "/opt/whisper/whisper-cli");
    await user.selectOptions(screen.getByRole("combobox", { name: /Mode/ }), "hold");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith({ voice: { whisperBin: "/opt/whisper/whisper-cli", mode: "hold", language: "es" } });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects relative paths", async () => {
    const user = userEvent.setup();
    view.render(<VoiceSettingsDialog onClose={() => {}} />);
    await user.type(screen.getByRole("textbox", { name: /Model/ }), "~/models/ggml-small.bin");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/model: Expected an absolute path/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("maps empty fields to absent (use the default)", () => {
    expect(draftToVoiceSettings({ whisperBin: " ", mode: "", language: "", autoSubmit: "" })).toEqual({});
    expect(draftToVoiceSettings({ mode: "tap", language: "auto", autoSubmit: "off", threads: 4 })).toEqual({ mode: "tap", language: "auto", autoSubmit: false, threads: 4 });
  });
});
