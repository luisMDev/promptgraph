import { create } from "zustand";

/**
 * A place at the end of the tab strip (DESIGN §13.4) where the active tab's view portals its items (pending approvals).
 * Set by the TabStrip; null while it is not mounted.
 */
export const useStripSlot = create<{ el: HTMLElement | null; setEl(el: HTMLElement | null): void }>()((set) => ({
  el: null,
  setEl: (el) => set({ el }),
}));
