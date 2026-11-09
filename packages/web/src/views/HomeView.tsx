import { Overview } from "../components/overview/Overview";

/** Home (DESIGN §13.3): the overview of every registered repository's graphs, unfiltered. */
export function HomeView() {
  return <Overview repoId={null} />;
}
