// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link } from "./Link";
import { MemoryLocationProvider, useLocation } from "./location";

function Where() {
  return <span data-testid="where">{useLocation().path}</span>;
}

function setup(onClick?: () => void) {
  const navigations: { path: string; replace: boolean }[] = [];
  const newTabs: { path: string; activate: boolean }[] = [];
  render(
    <MemoryLocationProvider
      initialPath="/"
      onNavigate={(path, o) => navigations.push({ path, replace: !!o?.replace })}
      onOpenInNewTab={(path, o) => newTabs.push({ path, activate: o.activate })}
    >
      <Link to="/r/demo-0123abcd/graphs/g1" onClick={onClick}>
        Graph
      </Link>
      <Where />
    </MemoryLocationProvider>,
  );
  return { link: screen.getByRole("link", { name: "Graph" }), navigations, newTabs };
}

describe("Link", () => {
  afterEach(cleanup);

  it("is a real link to its target", () => {
    expect(setup().link.getAttribute("href")).toBe("/r/demo-0123abcd/graphs/g1");
  });

  it("plain click navigates the current view", () => {
    const { link, navigations, newTabs } = setup();
    expect(fireEvent.click(link, { button: 0 })).toBe(false); // default prevented
    expect(navigations).toEqual([{ path: "/r/demo-0123abcd/graphs/g1", replace: false }]);
    expect(newTabs).toEqual([]);
    expect(screen.getByTestId("where").textContent).toBe("/r/demo-0123abcd/graphs/g1");
  });

  it("Ctrl/Cmd-click opens a background tab without navigating", () => {
    const { link, navigations, newTabs } = setup();
    fireEvent.click(link, { button: 0, ctrlKey: true });
    fireEvent.click(link, { button: 0, metaKey: true });
    expect(newTabs).toEqual([
      { path: "/r/demo-0123abcd/graphs/g1", activate: false },
      { path: "/r/demo-0123abcd/graphs/g1", activate: false },
    ]);
    expect(navigations).toEqual([]);
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("middle click opens a background tab", () => {
    const { link, navigations, newTabs } = setup();
    expect(fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(newTabs).toEqual([{ path: "/r/demo-0123abcd/graphs/g1", activate: false }]);
    expect(navigations).toEqual([]);
  });

  it("Ctrl/Cmd+Shift-click opens a foreground tab", () => {
    const { link, navigations, newTabs } = setup();
    fireEvent.click(link, { button: 0, ctrlKey: true, shiftKey: true });
    expect(newTabs).toEqual([{ path: "/r/demo-0123abcd/graphs/g1", activate: true }]);
    expect(navigations).toEqual([]);
  });

  it("leaves Shift- and Alt-clicks to the browser", () => {
    const { link, navigations, newTabs } = setup();
    // Record whether the app prevented the default, then stop jsdom from "navigating".
    const prevented: boolean[] = [];
    const record = (e: Event) => {
      prevented.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", record);
    fireEvent.click(link, { button: 0, shiftKey: true });
    fireEvent.click(link, { button: 0, altKey: true });
    document.removeEventListener("click", record);
    expect(prevented).toEqual([false, false]);
    expect(navigations).toEqual([]);
    expect(newTabs).toEqual([]);
  });

  it("runs onClick first; preventDefault there cancels the navigation", () => {
    const onClick = vi.fn((e?: { preventDefault(): void }) => e?.preventDefault());
    const { link, navigations } = setup(onClick as never);
    fireEvent.click(link, { button: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(navigations).toEqual([]);
  });
});
