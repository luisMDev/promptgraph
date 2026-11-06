import { daemonApi, onUnauthorized } from "../api/rest";
import { wsClient, type WsClient } from "../api/ws";
import { useDaemonStore } from "./daemon-store";
import { createDispatcher, type Dispatcher } from "./dispatcher";
import { flushAllEditors } from "./view/editor-store";
import { useVoiceStore } from "./voice-store";

/** The page's dispatcher: every mounted view registers with it. */
export const dispatcher: Dispatcher = createDispatcher();

/**
 * Connects the page's socket and routes it into the stores: messages to the dispatcher, connection and
 * version state to the daemon store, and a REST 401 or a 4401 close to "signed out" (DESIGN §13.5).
 * `pagehide` flushes every pending autosave. Returns teardown.
 */
export function startLiveUpdates(client: WsClient = wsClient, d: Dispatcher = dispatcher): () => void {
  const daemon = useDaemonStore.getState();
  daemon.applyWsStatus(client.status());
  const offMsg = client.onMessage((msg) => d.handle(msg));
  const offStatus = client.onStatus((s) => {
    useDaemonStore.getState().applyWsStatus(s);
    // The daemon drops a voice session with its socket: a recording in progress cannot finish.
    if (s.connection !== "open") useVoiceStore.getState().connectionLost();
  });
  const offAuth = onUnauthorized(() => {
    useDaemonStore.getState().setSignedOut();
    client.signOut();
  });
  const onPageHide = () => void flushAllEditors();
  window.addEventListener("pagehide", onPageHide);
  client.connect();
  return () => {
    offMsg();
    offStatus();
    offAuth();
    window.removeEventListener("pagehide", onPageHide);
    client.close();
  };
}

/** Removes a repository from Home (DESIGN §13.3); 409 repo_active is thrown unless `force`. */
export async function removeRepository(repoId: string, force: boolean, d: Dispatcher = dispatcher): Promise<void> {
  await daemonApi.removeRepo(repoId, force);
  d.repoRemoved(repoId);
}
