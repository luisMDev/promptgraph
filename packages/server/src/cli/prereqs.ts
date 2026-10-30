import { execFile } from "node:child_process";
import { childEnv, claudeBin } from "../config/child-env.js";
import { detectNotifyPlatform } from "../notify/notifier.js";

export interface PrereqReport {
  /** Fatal: git missing. */
  errors: string[];
  /** claude missing (Claude nodes fail), gh missing (PR nodes fail), no desktop notifications. */
  warnings: string[];
}

const CHECK_TIMEOUT_MS = 15_000;

function runs(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { env: childEnv({}, env), timeout: CHECK_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

/** §4.2: `git --version`, `<claudeBin()> --version`, `gh --version`. Only a missing git is fatal. */
export async function checkPrereqs(env: NodeJS.ProcessEnv = process.env): Promise<PrereqReport> {
  const bin = claudeBin(env);
  const [git, claude, gh, platform] = await Promise.all([
    runs("git", ["--version"], env),
    runs(bin, ["--version"], env),
    runs("gh", ["--version"], env),
    detectNotifyPlatform(env),
  ]);
  const report: PrereqReport = { errors: [], warnings: [] };
  if (!git) report.errors.push("git not found: promptgraph needs git on PATH");
  if (!claude) report.warnings.push(`Claude Code (${bin}) not found: prompt and command nodes will fail`);
  if (!gh) report.warnings.push("gh not found: PR nodes will fail");
  if (platform === "none") report.warnings.push("No desktop notifier found (notify-send / WSL): notifications are disabled");
  return report;
}
