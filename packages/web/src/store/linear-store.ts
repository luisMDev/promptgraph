import type { LinearStatusResponse } from "@promptgraph/shared";
import { create } from "zustand";
import { daemonApi } from "../api/rest";

/**
 * The daemon's Linear connection (DESIGN §24), loaded on demand by the settings dialog and the new-graph dialog.
 * `status` is null until the first load answers; a failed load leaves it null (the pickers then fall back to a name).
 */
interface LinearState {
  status: LinearStatusResponse | null;
  loading: boolean;
  /** GET /api/linear, once (or again with `force`). */
  load(force?: boolean): Promise<void>;
  /** PUT /api/linear/key; throws (ApiRequestError) when Linear rejects the key or cannot be reached. */
  connect(apiKey: string): Promise<void>;
  disconnect(): Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useLinearStore = create<LinearState>()((set, get) => ({
  status: null,
  loading: false,
  load(force = false) {
    if (inflight) return inflight;
    if (get().status && !force) return Promise.resolve();
    set({ loading: true });
    inflight = daemonApi
      .linearStatus()
      .then((status) => set({ status }))
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
        set({ loading: false });
      });
    return inflight;
  },
  async connect(apiKey) {
    set({ status: await daemonApi.setLinearKey(apiKey) });
  },
  async disconnect() {
    set({ status: await daemonApi.clearLinearKey() });
  },
}));

/** Tests: forget the loaded status. */
export function resetLinearStore(): void {
  inflight = null;
  useLinearStore.setState({ status: null, loading: false });
}
