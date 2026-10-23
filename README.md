# Async subagents for Pi

Spawn subagents that work **while you keep working**. `subagent()` returns
immediately; the child runs in its own Pi process, and its result arrives later
as a message that starts a new turn. Nothing about a subagent can wedge the
parent session: silence is reported, aborted, then killed.

This replaces Pi's bundled `examples/extensions/subagent`, which awaits the child
inside the tool call, so the main agent is stuck until the child exits, and a
child that stops making progress hangs the tool call until you abort.

## How it works

```
parent Pi ── subagent tool ──▶ ChildRpc ──▶ pi --mode rpc (child process)
    ▲                                              │
    └──── triggerTurn message ◀── agent_settled ───┘
```

- The child is a real `pi` process in RPC mode (`docs/rpc.md` in the host
  package), addressed over strict JSONL: commands on stdin, responses and
  events on stdout.
- The parent's tool call only reports *acceptance*. Completion, failure,
  cancellation and stalls are delivered with `pi.sendMessage(...,
  { triggerTurn: true, deliverAs: "followUp" })`.
- Child sessions are persisted under `~/.pi/agent/subagents/sessions`, so a
  finished subagent can be resumed by name with its whole context intact.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent` | Start a background subagent. Returns immediately. |
| `subagent_message` | Steer a running subagent (`steer`/`followUp`) or resume a finished one. |
| `subagents_list` | Running and remembered subagents, plus available agent definitions. |
| `subagent_cancel` | Stop a running subagent; its partial output is still reported. |
| `subagent_cleanup` | Remove worktrees whose branch is merged and whose checkout is clean. |

`/subagents` lists running subagents; `/subagents cancel <name>` stops one.

### `subagent` parameters

| Parameter | Description |
| --- | --- |
| `agent` | Required. Name of an agent definition. |
| `task` | Required. Task prompt. |
| `name` | Optional handle (defaults to the agent name; duplicates get `-2`, `-3`, …). |
| `cwd` | Optional working directory; overrides the agent's default. |
| `model` | Optional `provider/model[:thinking]` override. |
| `thinking` | Optional thinking level override. |
| `agentScope` | `both` (default: user and project agents), `user`, or `project`. |
| `confirmProjectAgents` | Ask before running repo-controlled agents. Default `true`. |
| `worktree` | Create a dedicated git worktree and run there. An agent can default this with `worktree: true` in frontmatter. Mutually exclusive with `cwd`. |
| `branch` | Branch to create or check out in the worktree. Default `subagent/<name>`. |
| `worktreeBase` | Ref to branch from. Default `main`. |

Concurrent runs are capped by `maxConcurrent` (default 6). The tool refuses
with a clear message instead of queueing silently.

## Agent definitions

Both directories are discovered by default. Same locations and format as Pi's own subagent example:

- `~/.pi/agent/agents/*.md` (user)
- nearest `.pi/agents/*.md` up from the working directory (project; overrides a user agent with the same name)

```markdown
---
name: worker
description: General implementer
tools: read, write, edit, bash
model: openrouter/z-ai/glm-5.3
thinking: medium
max-minutes: 30
system-prompt: append
cwd: agents/sre
---

You are a worker...
```

| Field | Meaning |
| --- | --- |
| `name`, `description` | Required; `description` is what the model sees when choosing. |
| `tools` | Strict allowlist (`read, bash` or `[read, bash]`). Omit for Pi's defaults. |
| `model` | Default model, `provider/id[:thinking]`. Omit to inherit the caller's model. |
| `thinking` | Default thinking level. |
| `cwd` | Default working directory for runs of this agent. |
| `max-minutes` | Per-run runtime cap; overrides the global `maxRunMinutes`. |
| `worktree` | `true` runs this agent in its own git worktree by default. |
| `system-prompt` | `append` (default), `replace`, or `prepend` (prepended to the task instead of `--append-system-prompt`). |

The body becomes the child's system prompt.

## Configuration

`~/.pi/agent/subagents/config.json` (all optional):

```json
{
	"stallSeconds": 120,
	"abortAfterSeconds": 600,
	"maxRunMinutes": 60,
	"settleGraceSeconds": 15,
	"uiPolicy": "deny",
	"maxDepth": 1,
	"maxConcurrent": 6
}
```

| Key | Meaning |
| --- | --- |
| `stallSeconds` | Silence after which the run is shown as **stalled**. |
| `abortAfterSeconds` | Silence after which the run is **aborted**, then killed if it ignores the abort. |
| `maxRunMinutes` | Hard cap on one run regardless of activity. |
| `settleGraceSeconds` | How long an aborted child gets to report its own settlement before `SIGTERM`/`SIGKILL`. |
| `uiPolicy` | `deny` (default) answers child dialogs with `cancelled: true`; `allow` answers `confirm: yes`, the first `select` option, and empty `input`/`editor`. |
| `maxDepth` | Subagent nesting. `1` means a child cannot spawn its own subagents. |
| `maxConcurrent` | Maximum running subagents per session. |

Dialogs a child opened and had declined are named in the completion message,
so a subagent that "did nothing" because it asked for permission is visible
rather than mysterious.

## Safety model

The old extension's failure mode was a tool call that never returned. This one
has explicit terms:

1. **Command deadlines.** Every RPC command has a response deadline (30s
   default; 60s for `prompt`), so a silent child rejects a command instead of
   blocking forever.
2. **Stall detection.** A 1s watchdog tracks the last event of any kind
   (`message_end`, `tool_execution_*`, `bash_execution_update`, …). Runs show
   `stalled` with idle time in the widget.
3. **Abort, then kill.** At `abortAfterSeconds` the run gets `abort`, then
   `settleGraceSeconds` to settle, then `SIGTERM`, then `SIGKILL`. The run is
   reported as `timeout` with the reason and last activity.
4. **Crash handling.** A child that exits without `agent_settled` fails the run
   immediately with its exit code and stderr tail.
5. **No orphans.** Aborting `pi` closes the child's stdin, which Pi's RPC mode
   treats as shutdown. Session shutdown and session switches stop every run.
6. **Dying children are replaced in the report, not the run.** Cancelling or
   timing out still delivers the partial assistant text.

Statuses reported in results and the widget: `finished`, `failed`,
`cancelled`, `timeout` (stall or runtime cap), plus transient `stalled`.

## Worktrees (parallel work in one repo)

Two implementers cannot share a checkout. With `worktree: true` — or an agent
whose frontmatter says `worktree: true` — the run gets its own:

```text
<repo>/.pi/worktrees/<branch-slug>   # checked out on <branch>, created from <worktreeBase>
```

- The branch is created from `worktreeBase` (default `main`) unless it already
  exists, in which case it is checked out as-is.
- The worktree root is kept out of `git status` (best effort: appended to
  `.git/info/exclude`).
- When the run finishes **unchanged** (clean, no commits beyond the base) and
  the extension created the branch, the worktree and branch are removed and the
  result says so. Anything else is kept and the path and branch are reported,
  so work is never lost.
- Cancelled and timed-out runs keep their worktree for inspection.
- `worktree: true` and `cwd` are mutually exclusive.

After the merge, `subagent_cleanup` removes only the safe ones: branch merged
into the base (local `main`, or `origin/main` when `fetch: true`), checkout
clean, and no subagent still running there. Everything else is kept and listed
with its reason. `/subagents cleanup [base]` does the same, and `dryRun: true`
shows what would go.

## Files

- `~/.pi/agent/subagents/config.json` — configuration (above).
- `~/.pi/agent/subagents/sessions/` — child session files, used for resume.
- `~/.pi/agent/subagents/registry/<session>.json` — name → agent/session/cwd, so
  names survive a Pi restart.

(With a non-default `PI_CODING_AGENT_DIR`, these live under that directory.)

## Development

```bash
./setup-node-modules.sh          # link host packages for standalone tests
node --test test/*.test.ts       # 54 tests, no model calls, no API keys
# optional typecheck if TypeScript is installed:
# npx -y tsc -p tsconfig.json
```

The tests use a scripted fake RPC child (`test/fake-pi.mjs`), not a model, so
they run offline and free. `test/rpc.test.ts` covers the protocol, `run.test.ts`
covers timeouts/stalls/kill, `registry.test.ts` covers names and persistence,
`agents.test.ts` covers discovery, `worktree.test.ts` covers git worktrees, and
`extension.test.ts` covers the tool wiring end to end.

A zero-token smoke test against the real CLI:

```bash
node --input-type=module -e '
import { ChildRpc } from "./rpc.ts";
const rpc = new ChildRpc({
  command: process.execPath,
  args: [process.env.PI_CLI ?? "pi", "--mode", "rpc", "--no-session"],
  cwd: process.cwd(),
  env: { ...process.env },
});
await rpc.start(); console.log(await rpc.send({ type: "get_state" })); await rpc.stop();
'
```

## Removing / going back

This directory used to be symlinks into Pi's bundled example. To restore them:

```bash
D=$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/@earendil-works/pi-coding-agent
rm -rf ~/.pi/agent/extensions/subagent
ln -s "$D/examples/extensions/subagent" ~/.pi/agent/extensions/subagent
```

(Correct the path for your install layout; for the managed installer the example
lives at `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent`.)
