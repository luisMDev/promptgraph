import { describe, expect, it } from "vitest";
import { breadcrumbs, splitTypedPath, tildePath } from "./FolderPicker";

describe("folder picker helpers", () => {
  it("splits a typed path into the directory to list and the prefix to match", () => {
    expect(splitTypedPath("~")).toEqual({ dir: "~/", prefix: "" });
    expect(splitTypedPath("~/pro")).toEqual({ dir: "~/", prefix: "pro" });
    expect(splitTypedPath("/home/a/")).toEqual({ dir: "/home/a/", prefix: "" });
    expect(splitTypedPath("/ho")).toEqual({ dir: "/", prefix: "ho" });
    expect(splitTypedPath("relative/dir")).toBeNull();
    expect(splitTypedPath("")).toBeNull();
  });

  it("shows the home directory as ~", () => {
    expect(tildePath("/home/you/x", "/home/you")).toBe("~/x");
    expect(tildePath("/home/you", "/home/you")).toBe("~");
    expect(tildePath("/home/youth", "/home/you")).toBe("/home/youth");
    expect(tildePath("/etc", "/")).toBe("/etc");
  });

  it("builds breadcrumbs from ~ under home and from / elsewhere", () => {
    expect(breadcrumbs("/home/you/a/b", "/home/you")).toEqual([
      { label: "~", path: "/home/you" },
      { label: "a", path: "/home/you/a" },
      { label: "b", path: "/home/you/a/b" },
    ]);
    expect(breadcrumbs("/etc/x", "/home/you")).toEqual([
      { label: "/", path: "/" },
      { label: "etc", path: "/etc" },
      { label: "x", path: "/etc/x" },
    ]);
    expect(breadcrumbs("/", "/home/you")).toEqual([{ label: "/", path: "/" }]);
  });
});
