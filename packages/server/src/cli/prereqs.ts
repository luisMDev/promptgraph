import { execFile } from "node:child_process";
import { childEnv, claudeBin, ghBin } from "../config/child-env.js";
import { detectNotifyPlatform } from "../notify/notifier.js";

export interface PrereqReport {
  /** Fatal: git missing. */
  errors: string[];
  /** claude or curl missing (Claude nodes fail / never complete), gh missing (PR nodes fail), no desktop notifications. */
  warnings: string[];
}

const CHECK_TIMEOUT_MS = 15_000;

function runs(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { env: childEnv({}, env), timeout: CHECK_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

/**
 * §4.2: `git --version`, `<claudeBin()> --version`, `<ghBin()> --version`, `curl --version` (pg-hook
 * reports Claude's status with curl). Only a missing git is fatal.
 */
export async function checkPrereqs(env: NodeJS.ProcessEnv = process.env): Promise<PrereqReport> {
  const bin = claudeBin(env);
  const gh = ghBin(env);
  const [git, claude, hasGh, curl, platform] = await Promise.all([
    runs("git", ["--version"], env),
    runs(bin, ["--version"], env),
    runs(gh, ["--version"], env),
    runs("curl", ["--version"], env),
    detectNotifyPlatform(env),
  ]);
  const report: PrereqReport = { errors: [], warnings: [] };
  if (!git) report.errors.push("git not found: promptgraph needs git on PATH");
  if (!claude) report.warnings.push(`Claude Code (${bin}) not found: prompt and command nodes will fail`);
  if (!curl) report.warnings.push("curl not found: the hooks cannot report Claude's status, so prompt and command nodes never complete on their own");
  if (!hasGh) report.warnings.push(`GitHub CLI (${gh}) not found: PR nodes will fail`);
  if (platform === "none") report.warnings.push("No desktop notifier found (notify-send / WSL): notifications are disabled");
  return report;
}
