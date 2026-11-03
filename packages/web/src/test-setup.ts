// Global test setup (registered in the root vitest.config.ts). jsdom lacks a few DOM APIs that Radix
// primitives (Dialog, DropdownMenu, Tooltip, …) call; polyfill them only when a DOM environment is present.
if (typeof window !== "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  globalThis.ResizeObserver ??= window.ResizeObserver;

  const proto = window.HTMLElement.prototype as HTMLElement & Partial<Record<string, unknown>>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};

  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
