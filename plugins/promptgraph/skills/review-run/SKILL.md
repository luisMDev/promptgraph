---
name: review-run
description: Explain what happened in a past or current promptgraph run, covering results, failures, waits, changes per step and lane, cost and pull requests, and suggest how to improve the graph. Use when the user asks "what happened in the last run", "summarise the run", "why did it fail", "what did step X change", or "how do I make this graph more reliable".
---

# Review a promptgraph run

The tools come from the `promptgraph` MCP server.

1. Call `server_status` (and `start_server` if needed: run history stays in `~/.promptgraph/state.db`
   after a restart).
2. Find the run. Use the run id if the user gave one. Otherwise call `list_runs` (filter by
   `graphId` if a graph was named) and take the newest run, or ask when it is unclear which one they
   mean.
3. Call `get_run_report`. Check:
   - `stalls`: steps that failed, were interrupted or cancelled, steps waiting now, and long waits for
     the user.
   - `steps`: the result, attempts, duration, waiting time and changes of each step.
   - `lanes` and `pullRequests`: the branches, commits and PR links.
4. Look deeper only where it matters. Call `get_node_output` for failed steps or steps the user asked
   about. Call `get_diff` with scope `node` for what one step changed, or scope `lane` for a whole
   branch.
5. Report in a few short sections: the result, what changed, what went wrong and why, and the cost
   and time. Link the PRs. Do not paste full outputs.

## Improvements to suggest

Suggest only what the run data supports:
- If a step failed on missing dependencies, set `settings.workspaceSetup`.
- If a step waited at permission prompts, add narrow `allowedTools` to that step.
- If tests failed and the run stopped, add a test-fix loop (`condition` exitCode plus a loop edge with
  `maxIterations`).
- If the merge had conflicts, the parallel branches touched the same files: split the work by file,
  or run those steps one after another.
- If an auto-completed step ended while Claude was still asking a question, use
  `completion: {"mode": "manual"}` or the `marker` mode for that step.
- If an expensive step used a large model for simple work, set `model` on that step.

If the user agrees, apply the changes with the design-graph skill (`get_graph`, then `save_graph`).
