import { describe, expect, it } from "vitest";
import { closeChat, dropDeleted, minimizeChats, openChat, shortcutTarget, toggleChat } from "./chat-dock";
import { MAX_TAB_CHATS } from "./tabs-store";

const R = "repo-0123abcd";

describe("chat dock transitions (DESIGN §21.11)", () => {
  it("opens chats into the bar (once each, newest last, capped) with one open window", () => {
    let c = openChat(null, R, "a");
    expect(c).toEqual({ repoId: R, ids: ["a"], open: "a" });
    c = openChat(c, R, "b");
    expect(openChat(c, R, "a")).toEqual({ repoId: R, ids: ["a", "b"], open: "a" });
    // Chats of another repository are replaced.
    expect(openChat({ repoId: "other", ids: ["x"], open: "x" }, R, "a")).toEqual({ repoId: R, ids: ["a"], open: "a" });
    let many = openChat(null, R, "c0");
    for (let i = 1; i <= MAX_TAB_CHATS; i++) many = openChat(many, R, `c${i}`);
    expect(many.ids).toHaveLength(MAX_TAB_CHATS);
    expect(many.ids[0]).toBe("c1");
  });

  it("toggles, minimises and closes", () => {
    const c = { repoId: R, ids: ["a", "b"], open: "a" };
    expect(toggleChat(c, "a").open).toBeNull();
    expect(toggleChat(c, "b").open).toBe("b");
    expect(minimizeChats(c).open).toBeNull();
    expect(closeChat(c, "a")).toEqual({ repoId: R, ids: ["b"], open: null });
    expect(closeChat(c, "b")).toEqual({ repoId: R, ids: ["a"], open: "a" });
    expect(closeChat({ repoId: R, ids: ["a"], open: null }, "a")).toBeNull();
  });

  it("drops deleted sessions and keeps the same object when nothing changed", () => {
    const c = { repoId: R, ids: ["a", "b"], open: "b" };
    expect(dropDeleted(c, () => true)).toBe(c);
    expect(dropDeleted(c, (id) => id === "a")).toEqual({ repoId: R, ids: ["a"], open: null });
    expect(dropDeleted(c, () => false)).toBeNull();
    expect(dropDeleted(null, () => true)).toBeNull();
  });

  it("the shortcut minimises an open window, reopens the newest chat, or asks for a new one", () => {
    expect(shortcutTarget({ repoId: R, ids: ["a"], open: "a" })).toEqual({ kind: "minimize" });
    expect(shortcutTarget({ repoId: R, ids: ["a", "b"], open: null })).toEqual({ kind: "open", id: "b" });
    expect(shortcutTarget(null)).toEqual({ kind: "new" });
  });
});
