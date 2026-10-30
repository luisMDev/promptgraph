import { beforeEach, describe, expect, it } from "vitest";
import { MIN_DRAWER_HEIGHT, clampDrawerHeight, useUiStore } from "./ui-store";

describe("ui store", () => {
  beforeEach(() => useUiStore.getState().closeAllTerminals());

  it("opens terminals as tabs without duplicates and activates them", () => {
    const ui = useUiStore.getState();
    ui.openTerminal("p1", { title: "A", nodeRunId: "n1" });
    ui.openTerminal("p2", { title: "B", nodeRunId: "n2" });
    ui.openTerminal("p1", { title: "A", nodeRunId: "n1" });
    const s = useUiStore.getState();
    expect(s.terminalTabs).toEqual(["p1", "p2"]);
    expect(s.activeTerminal).toBe("p1");
    expect(s.drawerOpen).toBe(true);
  });

  it("activates the neighbour tab when closing the active one", () => {
    const ui = useUiStore.getState();
    ui.openTerminal("p1", { title: "A", nodeRunId: null });
    ui.openTerminal("p2", { title: "B", nodeRunId: null });
    ui.openTerminal("p3", { title: "C", nodeRunId: null });
    ui.setActiveTerminal("p2");
    ui.closeTerminal("p2");
    expect(useUiStore.getState().activeTerminal).toBe("p3");
    ui.closeTerminal("p3");
    ui.closeTerminal("p1");
    expect(useUiStore.getState()).toMatchObject({ terminalTabs: [], activeTerminal: null, drawerOpen: false });
  });

  it("clamps the drawer height", () => {
    expect(clampDrawerHeight(10, 900)).toBe(MIN_DRAWER_HEIGHT);
    expect(clampDrawerHeight(5000, 900)).toBe(740);
    expect(clampDrawerHeight(300, 900)).toBe(300);
  });
});
