# promptgraph plugin for Claude Code

With this plugin, Claude Code can design, run and supervise [promptgraph](../../README.md) graphs.

## What it adds

- **MCP server** `promptgraph`, started as `promptgraph mcp`. Its tools save, edit (`patch_graph`)
  and validate graphs,
  start, wait for and cancel runs, read step outputs, diffs and run reports, and control steps
  (done, retry, skip, hold). Approvals are not among them: you approve in the promptgraph UI.
- **Skills**
  - `design-graph`: turns a task into a graph. It splits the work into steps, puts independent parts
    in parallel lanes, adds merge nodes, checks, test-fix and review loops, and gates. It also edits an
    existing graph in place ("remove this step", "add a review after the tests", "simplify this")
    with `patch_graph`, keeping node ids and positions.
  - `run-graph`: starts a run and supervises it, deals with steps that wait for input or approval,
    and reports the result.
  - `review-run`: explains what a run did and why it stopped, and suggests changes to the graph.

## Install

1. Build promptgraph and put `promptgraph` on your `PATH`:
   `pnpm install && pnpm build && (cd packages/server && pnpm link --global)`.
   You can skip the `PATH` step if you export
   `PROMPTGRAPH_BIN=/path/to/promptgraph/packages/server/dist/cli/index.js`.
2. In Claude Code:

   ```text
   /plugin marketplace add /path/to/promptgraph
   /plugin install promptgraph@promptgraph
   ```

3. In a git repository, ask something like: "design a promptgraph graph that implements TODO.md
   with a test-fix loop and opens a draft PR". To check that the server is running, use
   `/mcp` or ask Claude to call `server_status`.

The chat panel in the promptgraph UI starts its own Claude Code session with this plugin loaded
(`--plugin-dir`), so you do not need to install it for the chat. If you also install it globally,
the chat session may list the promptgraph MCP server twice; both copies talk to the same server.

If no promptgraph server is running for the repository, Claude can start one in the background. It
keeps running after the session ends; stop it with `kill <pid>` (`server_status` shows the pid).
