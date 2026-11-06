import { describe, expect, it } from "vitest";
import { resolveUndoKey } from "./undo-keys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("undo / redo shortcuts", () => {
  it("Ctrl/Cmd+Z undoes", () => {
    expect(resolveUndoKey(key("z", { ctrlKey: true }))).toBe("undo");
    expect(resolveUndoKey(key("z", { metaKey: true }))).toBe("undo");
  });

  it("Ctrl/Cmd+Shift+Z and Ctrl+Y redo", () => {
    expect(resolveUndoKey(key("Z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(resolveUndoKey(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(resolveUndoKey(key("y", { ctrlKey: true }))).toBe("redo");
  });

  it("ignores other keys and modifiers", () => {
    expect(resolveUndoKey(key("z"))).toBeNull();
    expect(resolveUndoKey(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveUndoKey(key("y", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveUndoKey(key("x", { ctrlKey: true }))).toBeNull();
    expect(resolveUndoKey({ ...key("z", { ctrlKey: true }), getModifierState: (k: string) => k === "AltGraph" })).toBeNull();
  });
});
