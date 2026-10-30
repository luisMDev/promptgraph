export interface PrereqReport {
  /** Fatal: git or claude missing. */
  errors: string[];
  /** e.g. gh missing (PR nodes will fail), notify-send missing. */
  warnings: string[];
}

/** §4.2: `git --version`, `<claudeBin()> --version`, `gh --version`. */
export function checkPrereqs(env?: NodeJS.ProcessEnv): Promise<PrereqReport> {
  throw new Error("not implemented");
}
