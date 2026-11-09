---
name: design-graph
description: Design or edit a promptgraph graph, a flow of Claude Code steps (prompts, slash commands, shell, commit, PR, approval, merge, condition) that runs in parallel git worktrees. Use when the user asks to "create a graph", "make a promptgraph flow/pipeline/diagram", "split this work into parallel steps", "add a test-fix loop", or to change an existing graph in .promptgraph/graphs.
---

# Design a promptgraph graph

A graph turns a piece of work into steps that promptgraph runs unattended. Each `prompt` or `command`
node is a **separate, full Claude Code session** in a git worktree, and it knows only its prompt, the
repository and the outputs of the steps right before it. Write every prompt so it makes sense to a
session that sees nothing else.

The tools come from the `promptgraph` MCP server.

## Steps

1. **Connect.** Call `server_status`. If the daemon is not running, tell the user and call
   `start_server` (it starts the promptgraph daemon in the background without opening a browser and
   registers this repository). If it reports a version mismatch, ask the user to run `promptgraph stop`
   in a terminal; do not stop the daemon yourself.
2. **Learn the format.** Call `graph_reference` once per session. Use `list_commands` before you put a
   slash command in a `command` node, and use only commands it lists.
3. **Understand the work.** Read the code involved and ask the user what is unclear: the goal, the
   test command, the base branch, whether the result should become a PR. For a new graph, also ask
   how complex it should be — **Simple** (2–4 sequential steps, no loops), **Standard** (5–8 steps
   with a test-fix loop or a review) or **Complex** (parallel lanes joined by a merge, review loops,
   approval gates) — unless the user already said. Ask everything in one go, with the
   `AskUserQuestion` tool when it is available (it shows clickable options), and design at the depth
   chosen. For an existing graph, see "Editing an existing graph" below.
4. **Draft the graph** with the rules below. Give it a short kebab-case `id` and a readable `name`.
   Give every node a short `label` and a meaningful `id` (`implement`, `tests`, `fix`, not `n1`).
5. **Show the plan before saving.** Show a small outline (steps, which run in parallel, loops, gates).
   Skip this only when the user asked for one specific change.
6. **Save** with `save_graph`. You can leave out positions and edge ids. If `runnable` is false, fix
   every item in `validation.errors` and save again. Mention any warnings to the user.
7. **Hand off.** Tell the user the file path (`.promptgraph/graphs/<id>.json`, which they can commit)
   and offer to open it with `open_ui` (it opens the user's browser, signed in, and returns only the
   plain page address) or to run it (see the run-graph skill). Do not start a run
   unless the user asks for one.

## Design rules

**Split the work**
- Use one step per job that can be checked on its own: plan, implement, test, review, commit.
  Do not make a step for each small edit.
- Put work in **parallel** only when the parts touch different files: backend and docs, two separate
  modules. Each branch gets its own worktree and its own branch. Parallel branches that edit the same
  files cause merge conflicts.
- Join parallel branches **only with a `merge` node** (2 or more inputs). Then run the tests on the
  merged result.
- Keep `settings.maxParallelClaude` at 3 or lower unless the user asks for more, because parallel
  sessions use the usage limits.

**Check the result**
- Use `shell` steps with the project's real commands to check the work (`pnpm test`, `cargo build`,
  `npm run lint`). Look them up in package.json, the Makefile or CI. Do not guess them.
- For "until green", build a **test-fix loop**: `shell` test → (`"when": "always"`) `condition`
  exitCode=0 → `true`: continue, `false`: a `prompt` fix with `"context": "resume"` → a loop edge
  back to the **shell** step (`"loop": {"maxIterations": 3}`).
- For review cycles, use `command` "/code-review" (if `list_commands` has it), then a `judge`
  condition ("Did the review report blocking issues?"), then a fix prompt, then a loop edge back to the
  review.
- Set `settings.workspaceSetup` (for example `pnpm install`) when the tests need dependencies: each new
  worktree starts without `node_modules`.

**Git and safety**
- Add a `commit` step before `pr` and before `merge`. Without it, uncommitted changes only reach the
  next step as a checkpoint.
- `pr` steps keep `requireApproval: true`. Do not set `settings.allowPrWithoutApproval`. Add an
  `approval` step before anything the user should look at first.
- When the graph is linked to Linear issues and the user wants them kept up to date, add a `linear` step (usually
  after `pr`): it proposes progress comments and state changes, which the user approves in the UI. Leave its
  `prompt` empty to use the default instructions.
- Never use `bypassPermissions` (it does not exist in promptgraph). Default to `acceptEdits`. To keep
  unattended runs from stopping at permission prompts, use `allowedTools` with narrow entries such as
  `"Bash(pnpm test:*)"`.
- Use `permissionMode: "plan"` with `completion: {"mode": "manual"}` for a planning step that the user
  should read before the next step continues.

**Prompts**
- Say exactly what to do and when it is finished: files, behaviour, constraints, and "add tests". Do
  not write "continue" or "do the rest", because the next session cannot see your conversation.
- Use `context: "resume"` when a step must continue the same conversation, for example a fix after a
  failing test in the same lane. Use the default `fresh` when the predecessors' outputs are enough.
  Use `clean` when only the repository state matters.
- If the user should check a step before the run continues, use `completion: {"mode": "manual"}`.
  Otherwise the default `auto` continues 5 s after Claude stops.

## Editing an existing graph

When the user wants to change a graph that already exists ("remove this node", "simplify this",
"add a review after the tests"), edit it in place with `patch_graph` instead of rewriting it with
`save_graph`. The user is usually looking at the graph, and a rewrite moves every node around.

1. **Find the graph and the nodes.** In promptgraph's chat panel, each message starts with a
   `<promptgraph-context graph="…" selected-nodes="…" selected-edges="…" />` block. `graph` is the
   graph on screen, and "this node", "these steps" or "here" mean the selected nodes. If nothing is
   selected and the request is ambiguous, ask which step they mean. Outside the chat panel, use
   `list_graphs` and ask.
2. **Read it.** Call `get_graph` and use the real node ids from it. If `activeRunId` is set, the graph
   is read-only: tell the user and stop.
3. **Make the smallest change that does what was asked.** Do not rename, reorder or reposition nodes
   that the request does not involve. Leave out `position` for new nodes; promptgraph places them
   next to their neighbours.
4. **Send all the ops in one `patch_graph` call.** Ops apply in order, and if one op fails, nothing is
   saved:
   - `add_node {node}`, `connect {source, target, sourcePort?, when?, loop?}`,
     `disconnect {edgeId}` or `disconnect {source, target}`.
   - `update_node {id, label?, config?}`: `config` is merged into the existing config. A key set to
     `null` goes back to its default. Send only the fields that change.
   - `remove_node {id}` reconnects the node's predecessors to its success successors, so the flow
     stays connected. Its failure / `always` handlers and condition branches are removed with it:
     reconnect them yourself with `connect` if they should stay. Pass `reconnect: false` to cut the
     flow at that point.
   - "Add X after Y" → `insert_after {after: "Y", node}`. The new node takes over Y's outgoing success
     edges; Y's failure / `always` handlers and loop back-edges stay on Y (pass `port: "true"` or
     `"false"` to insert after one branch of a condition). "Add X before Y" →
     `insert_before {before: "Y", node}`.
   - Use only the config field names of the node type (`graph_reference`): an unknown field (a typo
     like `promt`) makes the whole patch fail with the list of expected fields.
5. **Check the result.** If `runnable` is false, fix the errors with another `patch_graph` call. If the
   call fails because the graph changed meanwhile (the user may be editing it), call `get_graph`
   again, rebuild the ops against the new version and retry once.
6. **Say what changed** in one or two lines, naming the steps: "Removed Lint; Implement now feeds
   Test directly." The user can undo the change in the UI.

**Simplifying a graph** means fewer steps that do the same work:
- Merge consecutive `prompt` steps in the same lane that do one job into one step. Combine their
  prompts with `update_node` on the first step, then `remove_node` the others.
- Drop redundant checks, for example a lint step followed by a test step that already lints, or two
  identical test runs in a row.
- Remove `approval` steps the user did not ask for, but keep every `pr` gate, and keep `merge` nodes
  while two or more lanes still join there.
- Do not drop a test-fix or review loop unless the user asks for it.
- If you are not sure a step is redundant, ask the user before removing it.

See `references/patterns.md` for complete graphs you can adapt.
