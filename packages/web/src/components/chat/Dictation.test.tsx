// @vitest-environment jsdom
import type { ClientMessage, Graph, SaveGraphResponse, VoiceStatus } from "@promptgraph/shared";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureCallbacks } from "../../lib/voice/capture";
import { MicError } from "../../lib/voice/capture";
import { HOLD_THRESHOLD_MS } from "../../lib/voice/use-dictation";
import { chatSessionOf, linearGraph, voiceStatusOf } from "../../test-fixtures";
import { clearChatStores, emptyView, getChatStore, setChatDeps } from "../../store/chat-store";
import { useDaemonStore } from "../../store/daemon-store";
import { createDispatcher } from "../../store/dispatcher";
import { createTestView, TEST_REPO_ID, type TestView } from "../../store/view/test-view";
import { resetVoiceStore, setVoiceDeps, useVoiceStore } from "../../store/voice-store";
import { ChatPanel } from "./ChatPanel";

/** The view under test (its repository's chat store is getChatStore(TEST_REPO_ID)). */
let view: TestView;
const chat = () => getChatStore(TEST_REPO_ID);
let dispatcher = createDispatcher();
const handleServerMessage: typeof dispatcher.handle = (msg) => dispatcher.handle(msg);

const chatSent: ClientMessage[] = [];
const voiceSent: ClientMessage[] = [];
const frames: number[] = [];
const captures: { callbacks: CaptureCallbacks; stop: ReturnType<typeof vi.fn<() => Uint8Array<ArrayBuffer> | null>> }[] = [];
let captureError: unknown = null;
/** When set, startCapture waits for it (the browser's permission prompt). */
let captureGate: Promise<void> | null = null;
let status: VoiceStatus = voiceStatusOf();
const getStatus = vi.fn(async () => status);
let ids = 0;

function input(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Message Claude" }) as HTMLTextAreaElement;
}

async function renderPanel(voice: Partial<VoiceStatus> = {}) {
  status = voiceStatusOf(voice);
  useVoiceStore.setState({ status });
  const user = userEvent.setup();
  view.render(<ChatPanel />);
  return user;
}

const lastVoice = () => voiceSent.at(-1);
const recording = () => useVoiceStore.getState().state === "recording";

describe("composer dictation", () => {
  beforeEach(async () => {
    chatSent.length = 0;
    voiceSent.length = 0;
    frames.length = 0;
    captures.length = 0;
    captureError = null;
    captureGate = null;
    ids = 0;
    getStatus.mockClear();
    resetVoiceStore();
    setVoiceDeps({
      getStatus,
      send: (msg) => {
        voiceSent.push(msg);
        return true;
      },
      sendBinary: (bytes) => {
        frames.push(bytes.byteLength);
        return true;
      },
      startCapture: async (callbacks) => {
        if (captureError) throw captureError;
        if (captureGate) await captureGate;
        const c = { callbacks, stop: vi.fn((): Uint8Array<ArrayBuffer> | null => null) };
        captures.push(c);
        return c;
      },
      newId: () => `v${++ids}`,
    });
    setChatDeps({
      send: (msg) => {
        chatSent.push(msg);
        return true;
      },
      getSession: async (id) => ({ session: chatSessionOf({ id }), items: [], pendingPermissions: [], streaming: [] }),
    });
    const graph: Graph = linearGraph();
    clearChatStores();
    dispatcher = createDispatcher();
    view = createTestView({ graphId: "g1", persistence: {
      load: async () => ({ graph, hash: "h0", modifiedOutside: false, activeRunId: null }),
      save: async (g: Graph): Promise<SaveGraphResponse> => ({ graph: g, hash: "h1" }),
    } });
    await view.editor.getState().load();
    useDaemonStore.setState({ connection: "open" });
    view.ui.getState().setChatOpen(true);
    chat().setState({ sessions: [chatSessionOf({ id: "s1" })], sessionsLoaded: true, activeSessionId: "s1", views: { s1: emptyView() }, error: null });
  });
  afterEach(() => {
    cleanup();
    resetVoiceStore();
  });

  it("hold mode: holding Space on an empty composer records, releasing stops; the transcript is inserted, not sent", async () => {
    const user = await renderPanel({ mode: "hold" });
    input().focus();
    // Held with key repeat: the repeats do nothing.
    await user.keyboard("[Space>3]");
    await waitFor(() => expect(recording()).toBe(true));
    expect(voiceSent).toHaveLength(1);
    expect(voiceSent[0]).toMatchObject({ type: "voice:start", voiceId: "v1", sampleRate: 16000 });
    // Keyterms: promptgraph, node types and the labels of the open graph.
    expect((voiceSent[0] as { keyterms: string[] }).keyterms).toEqual(expect.arrayContaining(["promptgraph", "commit", "Implement", "Test"]));
    expect(screen.getByRole("button", { name: "Stop dictation" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("dictation-status").textContent).toMatch(/Listening/);
    await user.keyboard("[/Space]");
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
    expect(screen.getByTestId("dictation-status").textContent).toMatch(/Transcribing/);
    act(() => handleServerMessage({ type: "voice:final", voiceId: "v1", text: "Add a commit node" }));
    expect(input().value).toBe("Add a commit node");
    expect(input().selectionStart).toBe("Add a commit node".length);
    expect(chatSent).toEqual([]);
    expect(input().value).not.toMatch(/^ /);
  });

  it("Space with text in the composer types a space", async () => {
    const user = await renderPanel();
    await user.type(input(), "hi");
    await user.keyboard(" ");
    expect(input().value).toBe("hi ");
    expect(voiceSent).toEqual([]);
  });

  it("Space types a space when whisper is unavailable", async () => {
    const user = await renderPanel({ available: false, reason: "binary_not_found" });
    input().focus();
    await user.keyboard(" ");
    expect(input().value).toBe(" ");
    expect(voiceSent).toEqual([]);
  });

  it("tap mode with Alt+Space: inserts at the saved cursor and shows the partial dimmed without changing the value", async () => {
    const user = await renderPanel({ mode: "tap" });
    await user.type(input(), "Add node");
    input().setSelectionRange(3, 3);
    await user.keyboard("{Alt>}[Space]{/Alt}");
    await waitFor(() => expect(recording()).toBe(true));
    expect(input().readOnly).toBe(true);
    act(() => handleServerMessage({ type: "voice:partial", voiceId: "v1", text: "a commit" }));
    expect(screen.getByTestId("dictation-preview").textContent).toBe("Add a commit node");
    expect(input().value).toBe("Add node");
    // Enter does not send the half-dictated message.
    await user.keyboard("{Enter}");
    expect(chatSent).toEqual([]);
    await user.keyboard("{Alt>}[Space]{/Alt}");
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
    act(() => handleServerMessage({ type: "voice:final", voiceId: "v1", text: "a commit" }));
    expect(input().value).toBe("Add a commit node");
    expect(input().selectionStart).toBe("Add a commit".length);
    expect(screen.queryByTestId("dictation-preview")).toBeNull();
    expect(input().readOnly).toBe(false);
  });

  it("tap mode with Space on an empty composer: Space again stops", async () => {
    const user = await renderPanel({ mode: "tap" });
    input().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(recording()).toBe(true));
    await user.keyboard(" ");
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
  });

  it("Esc cancels and leaves the composer text as it was", async () => {
    const user = await renderPanel({ mode: "tap" });
    await user.type(input(), "keep this");
    await user.keyboard("{Alt>}[Space]{/Alt}");
    await waitFor(() => expect(recording()).toBe(true));
    act(() => handleServerMessage({ type: "voice:partial", voiceId: "v1", text: "noise" }));
    await user.keyboard("{Escape}");
    expect(lastVoice()).toEqual({ type: "voice:cancel", voiceId: "v1" });
    expect(captures[0]!.stop).toHaveBeenCalled();
    expect(useVoiceStore.getState().state).toBe("idle");
    expect(input().value).toBe("keep this");
    expect(screen.queryByTestId("dictation-preview")).toBeNull();
  });

  it("autoSubmit sends the message with the transcript", async () => {
    const user = await renderPanel({ mode: "tap", autoSubmit: true });
    input().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(recording()).toBe(true));
    await user.keyboard(" ");
    act(() => handleServerMessage({ type: "voice:final", voiceId: "v1", text: "Simplify this graph" }));
    await waitFor(() => expect(chatSent).toHaveLength(1));
    expect(chatSent[0]).toMatchObject({ type: "chat:send", repoId: TEST_REPO_ID, sessionId: "s1", text: "Simplify this graph" });
  });

  it("mic button: a click toggles (tap), a long press records while held", async () => {
    const user = await renderPanel({ mode: "hold" });
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(recording()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
    act(() => handleServerMessage({ type: "voice:final", voiceId: "v1", text: "one" }));

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const mic = screen.getByRole("button", { name: "Dictate" });
    fireEvent.pointerDown(mic, { button: 0 });
    await waitFor(() => expect(recording()).toBe(true));
    now.mockReturnValue(1_000 + HOLD_THRESHOLD_MS + 50);
    fireEvent.pointerUp(mic, { button: 0 });
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v2" });
    now.mockRestore();
  });

  it("explains a denied microphone", async () => {
    captureError = new MicError("denied", "Microphone access was denied. Allow it for this page in the browser's site settings and try again.");
    const user = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(screen.getByTestId("dictation-status").textContent).toMatch(/Microphone access was denied/));
    expect(voiceSent).toEqual([]);
  });

  it("when whisper is unavailable the mic opens the reason and the setup instructions; Check again refetches", async () => {
    const user = await renderPanel({ available: false, reason: "model_not_found", detail: "No ggml-*.bin in ~/whisper.cpp/models" });
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    const pop = await screen.findByRole("dialog");
    expect(within(pop).getByText(/No whisper model/)).toBeTruthy();
    expect(within(pop).getByText(/No ggml-\*\.bin/)).toBeTruthy();
    const steps = within(pop).getByRole("list", { name: "Setup instructions" });
    expect(within(steps).getByText("sh ./models/download-ggml-model.sh small")).toBeTruthy();
    expect(within(steps).getByRole("button", { name: "Copy: sudo apt install cmake" })).toBeTruthy();
    expect(voiceSent).toEqual([]);
    getStatus.mockClear();
    status = voiceStatusOf();
    await user.click(within(pop).getByRole("button", { name: /Check again/ }));
    expect(getStatus).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(pop).getByText(/dictation is available/)).toBeTruthy());
  });

  it("is disabled while the server is not connected, and says why", async () => {
    await renderPanel();
    act(() => useDaemonStore.setState({ connection: "reconnecting" }));
    const mic = screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement;
    // aria-disabled (not disabled), so the tooltip and its reason stay reachable.
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    expect(mic.disabled).toBe(false);
    expect(document.getElementById(mic.getAttribute("aria-describedby")!)?.textContent).toMatch(/needs the connection/);
    fireEvent.pointerDown(mic, { button: 0 });
    fireEvent.click(mic, { detail: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useVoiceStore.getState().state).toBe("idle");
  });

  it("tap mode: a key-repeat Space is ignored because of the repeat flag", async () => {
    await renderPanel({ mode: "tap" });
    input().focus();
    fireEvent.keyDown(input(), { key: " ", code: "Space" });
    await waitFor(() => expect(recording()).toBe(true));
    fireEvent.keyUp(input(), { key: " ", code: "Space" });
    // Without the repeat guard this press would stop the tap recording.
    fireEvent.keyDown(input(), { key: " ", code: "Space", repeat: true });
    expect(recording()).toBe(true);
    expect(voiceSent.map((m) => m.type)).toEqual(["voice:start"]);
  });

  it("a mic hold released off the button still stops", async () => {
    await renderPanel({ mode: "hold" });
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Dictate" }), { button: 0 });
      await waitFor(() => expect(recording()).toBe(true));
      now.mockReturnValue(1_000 + HOLD_THRESHOLD_MS + 50);
      fireEvent.pointerUp(document.body, { button: 0 });
      expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
    } finally {
      now.mockRestore();
    }
  });

  it("Esc cancels with the focus on the mic button (keyboard activation)", async () => {
    const user = await renderPanel({ mode: "hold" });
    const mic = screen.getByRole("button", { name: "Dictate" });
    mic.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(recording()).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop dictation" }));
    await user.keyboard("{Escape}");
    expect(lastVoice()).toEqual({ type: "voice:cancel", voiceId: "v1" });
    expect(useVoiceStore.getState().state).toBe("idle");
  });

  it("hold Space released during the microphone prompt keeps recording (as tap)", async () => {
    let grant: () => void = () => {};
    captureGate = new Promise((r) => (grant = r));
    await renderPanel({ mode: "hold" });
    input().focus();
    fireEvent.keyDown(input(), { key: " ", code: "Space" });
    await waitFor(() => expect(useVoiceStore.getState().state).toBe("requesting_mic"));
    fireEvent.keyUp(input(), { key: " ", code: "Space" }); // let go to click Allow
    act(() => window.dispatchEvent(new Event("blur"))); // the prompt takes the focus
    await act(async () => grant());
    await waitFor(() => expect(recording()).toBe(true));
    expect(voiceSent.map((m) => m.type)).toEqual(["voice:start"]);
    // Now a tap: Space stops it.
    fireEvent.keyDown(input(), { key: " ", code: "Space" });
    expect(lastVoice()).toEqual({ type: "voice:stop", voiceId: "v1" });
  });

  it("hides the placeholder under the partial preview, which is laid out in flow", async () => {
    const user = await renderPanel({ mode: "tap" });
    input().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(recording()).toBe(true));
    expect(input().placeholder).toMatch(/Listening/);
    act(() => handleServerMessage({ type: "voice:partial", voiceId: "v1", text: "a long partial transcript" }));
    expect(input().placeholder).toBe("");
    const preview = screen.getByTestId("dictation-preview");
    expect(preview.className).not.toMatch(/\babsolute\b/);
    expect(preview.className).toMatch(/grid-area/);
  });

  it("autoSubmit while Claude is busy keeps the transcript and says it was not sent", async () => {
    const user = await renderPanel({ mode: "tap", autoSubmit: true });
    act(() => chat().setState({ views: { s1: { ...emptyView(), status: "thinking" } } }));
    input().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(recording()).toBe(true));
    await user.keyboard(" ");
    act(() => handleServerMessage({ type: "voice:final", voiceId: "v1", text: "Simplify this graph" }));
    expect(input().value).toBe("Simplify this graph");
    expect(chatSent.filter((m) => m.type === "chat:send")).toEqual([]);
    expect(screen.getByTestId("dictation-status").textContent).toMatch(/Not sent automatically/);
  });
});
