import { Overview } from "../components/overview/Overview";
import { useView } from "../store/view/context";

/**
 * `/r/<repoId>` (DESIGN §13.3): the overview filtered to this repository. It is rendered inside the repository's
 * view, so the tab keeps its bottom bar, chats and pending approvals.
 */
export function GraphsView() {
  return <Overview repoId={useView().repoId} />;
}
