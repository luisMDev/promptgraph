# promptgraph plugin for Claude Code

With this plugin, Claude Code can design, run and supervise [promptgraph](../../README.md) graphs.

## What it adds

- **MCP server** `promptgraph`, started as `promptgraph mcp`. Its tools save and validate graphs,
  start, wait for and cancel runs, read step outputs, diffs and run reports, and control steps
  (done, retry, skip, hold). Approvals are not among them: you approve in the promptgraph UI.
- **Skills**
  - `design-graph`: turns a task into a graph. It splits the work into steps, puts independent parts
    in parallel lanes, adds merge nodes, checks, test-fix and review loops, and gates.
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
   with a test-fix loop and opens a draft PR". To check that promptgraph is running and that the
   repository is registered, use `/mcp` or ask Claude to call `server_status`.

The MCP server talks to the promptgraph **daemon**, the one background process that serves every
repository (it finds it through `~/.promptgraph/daemon.json` and `~/.promptgraph/token`). The
repository Claude Code runs in is registered with it on first use. If no daemon is running, Claude can
start one in the background (`start_server`, no browser). It keeps running after the session ends,
because runs can take longer than one conversation; stop it with `promptgraph stop`. `open_ui` opens the
canvas in your browser, already signed in; the tool result only holds the plain
`http://127.0.0.1:<port>/r/<repo-id>` address.

If a tool reports that another promptgraph version is running (after an upgrade), run
`promptgraph stop` in a terminal and try again.
