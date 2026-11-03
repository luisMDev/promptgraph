import { describe, expect, it } from "vitest";
import { resolveKey, type KeyEventLike } from "./keymap";

function key(code: string, mods: Partial<Omit<KeyEventLike, "code">> & { altGraph?: boolean } = {}): KeyEventLike {
  return {
    code,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    shiftKey: !!mods.shiftKey,
    metaKey: !!mods.metaKey,
    getModifierState: (k: string) => k === "AltGraph" && !!mods.altGraph,
  };
}

const browser = { desktop: false, terminalFocused: false };
const desktop = { desktop: true, terminalFocused: false };
const alt = { altKey: true };
const ctrl = { ctrlKey: true };

describe("keymap resolver (DESIGN §13.4)", () => {
  it("browser: the Alt fallbacks only", () => {
    expect(resolveKey(key("KeyT", alt), browser)).toEqual({ type: "newTab" });
    expect(resolveKey(key("KeyW", alt), browser)).toEqual({ type: "closeTab" });
    expect(resolveKey(key("KeyT", { ...alt, shiftKey: true }), browser)).toEqual({ type: "reopenClosed" });
    expect(resolveKey(key("PageDown", alt), browser)).toEqual({ type: "nextTab" });
    expect(resolveKey(key("PageUp", alt), browser)).toEqual({ type: "prevTab" });
    expect(resolveKey(key("Digit1", alt), browser)).toEqual({ type: "gotoTab", n: 1 });
    expect(resolveKey(key("Digit8", alt), browser)).toEqual({ type: "gotoTab", n: 8 });
    expect(resolveKey(key("Digit9", alt), browser)).toEqual({ type: "lastTab" });
    // The browser keeps its own Ctrl bindings.
    for (const code of ["KeyT", "KeyW", "Tab", "PageDown", "Digit1"]) expect(resolveKey(key(code, ctrl), browser)).toBeNull();
    expect(resolveKey(key("KeyX", alt), browser)).toBeNull();
    expect(resolveKey(key("KeyW", { ...alt, shiftKey: true }), browser)).toBeNull();
    expect(resolveKey(key("KeyT"), browser)).toBeNull();
    expect(resolveKey(key("KeyT", { ...alt, metaKey: true }), browser)).toBeNull();
  });

  it("desktop: the Ctrl bindings, and the Alt fallbacks too", () => {
    expect(resolveKey(key("KeyT", ctrl), desktop)).toEqual({ type: "newTab" });
    expect(resolveKey(key("KeyW", ctrl), desktop)).toEqual({ type: "closeTab" });
    expect(resolveKey(key("KeyT", { ...ctrl, shiftKey: true }), desktop)).toEqual({ type: "reopenClosed" });
    expect(resolveKey(key("Tab", ctrl), desktop)).toEqual({ type: "nextTab" });
    expect(resolveKey(key("Tab", { ...ctrl, shiftKey: true }), desktop)).toEqual({ type: "prevTab" });
    expect(resolveKey(key("PageDown", ctrl), desktop)).toEqual({ type: "nextTab" });
    expect(resolveKey(key("PageUp", ctrl), desktop)).toEqual({ type: "prevTab" });
    expect(resolveKey(key("Digit3", ctrl), desktop)).toEqual({ type: "gotoTab", n: 3 });
    expect(resolveKey(key("Digit9", ctrl), desktop)).toEqual({ type: "lastTab" });
    expect(resolveKey(key("KeyT", alt), desktop)).toEqual({ type: "newTab" });
    expect(resolveKey(key("PageDown", alt), desktop)).toEqual({ type: "nextTab" });
    expect(resolveKey(key("KeyT", { ctrlKey: true, altKey: true }), desktop)).toBeNull();
  });

  it("while a terminal has focus only tab switching is handled", () => {
    const term = { desktop: false, terminalFocused: true };
    const termDesktop = { desktop: true, terminalFocused: true };
    for (const ctx of [term, termDesktop]) {
      expect(resolveKey(key("KeyT", alt), ctx)).toBeNull();
      expect(resolveKey(key("KeyW", alt), ctx)).toBeNull();
      expect(resolveKey(key("KeyT", { ...alt, shiftKey: true }), ctx)).toBeNull();
      expect(resolveKey(key("Digit1", alt), ctx)).toBeNull();
      expect(resolveKey(key("Digit9", alt), ctx)).toBeNull();
      expect(resolveKey(key("PageDown", alt), ctx)).toEqual({ type: "nextTab" });
      expect(resolveKey(key("PageUp", alt), ctx)).toEqual({ type: "prevTab" });
    }
    expect(resolveKey(key("KeyW", ctrl), termDesktop)).toBeNull();
    expect(resolveKey(key("KeyT", ctrl), termDesktop)).toBeNull();
    expect(resolveKey(key("Digit2", ctrl), termDesktop)).toBeNull();
    expect(resolveKey(key("Tab", ctrl), termDesktop)).toEqual({ type: "nextTab" });
    expect(resolveKey(key("PageUp", ctrl), termDesktop)).toEqual({ type: "prevTab" });
  });

  it("an event with AltGraph set is never a shortcut", () => {
    expect(resolveKey(key("Digit8", { ...alt, altGraph: true }), browser)).toBeNull();
    expect(resolveKey(key("KeyT", { ctrlKey: true, altKey: true, altGraph: true }), desktop)).toBeNull();
    expect(resolveKey(key("PageDown", { ...alt, altGraph: true }), browser)).toBeNull();
  });

  it("matches the physical key (event.code), not the character of the layout", () => {
    // AZERTY: the key in the KeyQ position types "a"; the top-row digit keys type "&", "é"… without Shift.
    const azertyDigit1 = { ...key("Digit1", alt), key: "&" } as KeyEventLike & { key: string };
    expect(resolveKey(azertyDigit1, browser)).toEqual({ type: "gotoTab", n: 1 });
    // Dvorak: the key in the KeyT position types "y"; the one typing "t" is KeyK.
    expect(resolveKey({ ...key("KeyT", alt), key: "y" } as KeyEventLike, browser)).toEqual({ type: "newTab" });
    expect(resolveKey({ ...key("KeyK", alt), key: "t" } as KeyEventLike, browser)).toBeNull();
  });
});
