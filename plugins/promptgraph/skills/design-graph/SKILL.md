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

1. **Connect.** Call `server_status`. If nothing is running, tell the user and call `start_server`
   (it starts promptgraph in the background without opening a browser).
2. **Learn the format.** Call `graph_reference` once per session. Use `list_commands` before you put a
   slash command in a `command` node, and use only commands it lists.
3. **Understand the work.** Read the code involved and ask the user what is unclear: the goal, the
   test command, the base branch, whether the result should become a PR. For an existing graph, call
   `get_graph` and change only what was asked.
4. **Draft the graph** with the rules below. Give it a short kebab-case `id` and a readable `name`.
   Give every node a short `label` and a meaningful `id` (`implement`, `tests`, `fix`, not `n1`).
5. **Show the plan before saving.** Show a small outline (steps, which run in parallel, loops, gates).
   Skip this only when the user asked for one specific change.
6. **Save** with `save_graph`. You can leave out positions and edge ids. If `runnable` is false, fix
   every item in `validation.errors` and save again. Mention any warnings to the user.
7. **Hand off.** Tell the user the file path (`.promptgraph/graphs/<id>.json`, which they can commit)
   and offer to open it with `open_ui` or to run it (see the run-graph skill). Do not start a run
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

See `references/patterns.md` for complete graphs you can adapt.
