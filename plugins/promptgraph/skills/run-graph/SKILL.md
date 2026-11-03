---
name: run-graph
description: Run a promptgraph graph and supervise it until it finishes. Handles steps that wait for input, approvals, failures and retries. Use when the user asks to "run the graph", "execute the pipeline/flow", "start promptgraph on X", "check on the run", or "why is the run stuck".
---

# Run and supervise a promptgraph graph

A run starts real Claude Code sessions, shell commands and git operations in worktrees under
`~/.promptgraph/worktrees/`. It uses the user's Claude usage and can create branches and pull
requests (only after a human approves). Start a run only when the user asked for one.

The tools come from the `promptgraph` MCP server.

## Start

1. Call `server_status`. If the daemon is not running, call `start_server` (it starts it in the
   background and registers this repository). If it reports a version mismatch, ask the user to run
   `promptgraph stop` in a terminal, then call `start_server`.
2. Pick the graph. If the user did not name one, call `list_graphs` and ask. Call `validate_graph`.
   If it reports errors, fix the graph (see the design-graph skill) or report the errors. Do not run
   a graph that has errors.
3. Unless the user already said "run it", tell them in one line what the run will do (number of
   Claude steps, parallel lanes, whether it ends in a PR) and get a go-ahead.
4. Call `start_run`. Save the `runId`. Offer `open_ui` so the user can watch the canvas and the live
   terminals: it opens their browser already signed in and returns only the plain page address, so
   never ask the user for a sign-in link.

## Supervise

Call `wait_for_run` with `until: "attention"`. It returns when the run finishes, pauses, or a step
needs someone. Each result has a `next` hint and an `attention` list. Handle each case:

| Situation | What to do |
|---|---|
| `waiting_approval` (approval or pr step) | Call `get_approval` and `get_diff` (scope `lane`). Summarise what the step asks to approve and what changed. **The user approves or rejects it in the UI** (`open_ui`). You cannot approve, so never say that you did. |
| `waiting_input` | A Claude session shows a permission prompt, a trust dialog or a question in its terminal. Tell the user the step name and the `waiting` message, and ask them to answer it in the UI. If the step's work is already done, ask the user whether to mark it `done`. |
| `idle` | Claude finished its turn, but the step waits for a manual Done (manual completion or Hold). Read its output with `get_node_output`, summarise it, and ask the user, or call `node_action done` if they told you to continue. |
| run `paused`, step `failed` | Read `get_node_output` (the error, the shell tail, Claude's last message). Explain the cause. Then propose `node_action retry` (after a fix, for example a flaky test or a missing dependency) or `skip`, or a change to the graph for the next run. |
| run `paused`, step `interrupted` | The promptgraph daemon was stopped (`promptgraph stop`) or crashed while the step ran. If `server_status` says it is not running, call `start_server`. Then propose `node_action retry` on the step, or `resume_run`. |
| `timedOut: true` | Nothing changed within the timeout. Say briefly what is running (the `activity` field) and call `wait_for_run` again. |

Keep the user informed between waits with one line about what is running and what finished. Do not
paste whole outputs.

## Finish

When the run is `succeeded`, `failed` or `cancelled`, call `get_run_report` and summarise it: the
result, the duration and cost, what each lane changed, the commits, the PR links, and the places
where the run stopped or waited. Offer `get_diff` for any step. If the user asks, offer `cleanup_run`
to remove the worktrees.

## Rules

- Ask before `cancel_run`, `cleanup_run`, `delete_graph`, `node_action fail` and `skip`.
- Never try to get around an approval gate. Do not change the graph to remove an approval or to set
  `allowPrWithoutApproval` so that a run can continue.
- A graph cannot be saved while one of its runs is active. Change it after the run ends or is
  cancelled.
- Never stop or kill the promptgraph daemon: it also runs other repositories' work. If it must be
  restarted, ask the user to run `promptgraph stop`.
