import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

export interface ToastState {
  toasts: Toast[];
  toast(kind: Toast["kind"], message: string): void;
  dismiss(id: number): void;
}

export const TOAST_MS = 6000;

/** Toasts are global (DESIGN §13.4): one stack for the page, whatever view raised them. */
export const useToastStore = create<ToastState>()((set, get) => {
  let seq = 0;
  return {
    toasts: [],
    toast(kind, message) {
      const id = ++seq;
      set({ toasts: [...get().toasts, { id, kind, message }] });
      setTimeout(() => get().dismiss(id), TOAST_MS);
    },
    dismiss(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});

export function toast(kind: Toast["kind"], message: string): void {
  useToastStore.getState().toast(kind, message);
}
