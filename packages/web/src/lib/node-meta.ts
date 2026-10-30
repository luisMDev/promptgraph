import type { GraphNode, NodeType } from "@promptgraph/shared";
import { preview } from "./format";

export interface NodeTypeMeta {
  title: string;
  description: string;
  /** Accent classes for the type icon chip. */
  accent: string;
  /** Introduced by Phase 2; flagged in the palette while the server runs phase 1. */
  phase2?: boolean;
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  prompt: { title: "Prompt", description: "Claude Code session with a prompt", accent: "bg-orange-500/15 text-orange-300" },
  command: { title: "Command", description: "Run a slash command or skill", accent: "bg-amber-500/15 text-amber-300" },
  shell: { title: "Shell", description: "Run a shell command in the lane", accent: "bg-emerald-500/15 text-emerald-300" },
  commit: { title: "Commit", description: "Commit the lane's changes", accent: "bg-sky-500/15 text-sky-300" },
  pr: { title: "Pull request", description: "Push and open a PR (gated)", accent: "bg-indigo-500/15 text-indigo-300" },
  approval: { title: "Approval", description: "Pause until you approve", accent: "bg-violet-500/15 text-violet-300" },
  merge: { title: "Merge", description: "Merge parallel lanes", accent: "bg-pink-500/15 text-pink-300" },
  condition: { title: "Condition", description: "Branch on exit code, regex or judge", accent: "bg-teal-500/15 text-teal-300", phase2: true },
};

export const PALETTE_ORDER: readonly NodeType[] = ["prompt", "command", "shell", "commit", "pr", "approval", "merge", "condition"];

/** One-line summary of a node's key config, shown on its card. */
export function configPreview(node: GraphNode): string {
  switch (node.type) {
    case "prompt":
      return preview(node.config.prompt, 90) || "No prompt yet";
    case "command":
      return node.config.command.trim() || "No command selected";
    case "shell":
      return node.config.run.trim() ? `$ ${preview(node.config.run, 80)}` : "No command yet";
    case "commit":
      return node.config.generateMessage ? "Generated message" : preview(node.config.message, 80) || "No message";
    case "pr":
      return `${node.config.draft ? "Draft PR" : "PR"} → ${node.config.base ?? "base branch"}${node.config.requireApproval ? " · approval" : ""}`;
    case "approval":
      return preview(node.config.message, 80) || (node.config.showDiff ? "Review diff and approve" : "Approve to continue");
    case "merge":
      return `${node.config.strategy} · conflicts: ${node.config.onConflict}`;
    case "condition": {
      const ev = node.config.evaluator;
      if (ev.kind === "exitCode") return `exit code = ${ev.equals}`;
      if (ev.kind === "regex") return `/${ev.pattern}/${ev.flags}`;
      return preview(ev.question, 80) || "Judge question";
    }
  }
}
