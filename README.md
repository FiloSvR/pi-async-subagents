# Async subagents for Pi

Spawn subagents that work **while you keep working**. `subagent()` returns
immediately; the child runs in its own Pi process, and its result arrives later
as a message that starts a new turn. Nothing about a subagent can wedge the
parent session: silence is reported, aborted, then killed.

This replaces Pi's bundled `examples/extensions/subagent`, which awaits the child
inside the tool call, so the main agent is stuck until the child exits, and a
child that stops making progress hangs the tool call until you abort.

## Install

This is a Pi package. Install it from this repository's git URL, pinned to a
tag:

```bash
pi install git:<this-repository>@v0.1.0
pi list
```

Then remove any hand-placed copy at `~/.pi/agent/extensions/subagent` so the
same extension does not load twice. Keep a source checkout for development;
`pi update --extensions` reconciles the package, and the tag pins it.

The package declares the host packages (`@earendil-works/pi-coding-agent`,
`typebox`) as `peerDependencies: "*"`; Pi supplies them. Do not add them to
`dependencies`: a physical copy bypasses Pi's extension module mapping.

For a local working tree, `pi install /path/to/pi-async-subagents` loads it from
the resolved path without copying. After changing the source in a running
session, run `/reload` (or restart Pi) to load the new code.

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

## Display

The widget above the editor lists running subagents, plus finished ones for
`finishedVisibleSeconds` (default 30) so the outcome stays visible briefly.
After that window the finished entries disappear; when nothing is running or
recently finished, the widget and its status clear. Every row also shows the
child's model and current context size, e.g. `openrouter/z-ai/glm-5.3-flash · ctx 12.3k`.
The widget re-renders every 2 seconds, so elapsed and idle times keep moving
even while a child is silent between events.

Each delivered result is a custom message that stays in the transcript, but it
is collapsed to one status line (`[subagent] name · finished · duration · usage`).
Press `Ctrl+O` to expand it to the full output and resume hint. Failures and
cancellations keep their reason visible even while collapsed. Set
`"resultDisplay": "hidden"` to keep completed results out of the transcript
entirely; the agent still receives them and can summarise.

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
	"finishedVisibleSeconds": 30,
	"uiPolicy": "deny",
	"resultDisplay": "summary",
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
| `finishedVisibleSeconds` | How long a finished subagent stays in the widget. Default `30`. |
| `uiPolicy` | `deny` (default) answers child dialogs with `cancelled: true`; `allow` answers `confirm: yes`, the first `select` option, and empty `input`/`editor`. |
| `resultDisplay` | `summary` (default) puts one collapsed line per result in the transcript; `full` restores the complete message; `hidden` keeps results out of the transcript entirely (the agent still receives them). |
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
   `stalled` with idle time in the widget. Child startup is not counted as
   idle: a run stays `starting` until the child accepts the prompt, then its
   activity clock begins.
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
npm install                    # TypeScript and @types/node; host packages are peers
./setup-node-modules.sh        # link the host Pi packages for the tests
npm run check                  # typecheck + 63 tests, no model calls, no API keys
```

The tests use a scripted fake RPC child (`test/fake-pi.mjs`), not a model, so
they run offline and free. `test/rpc.test.ts` covers the protocol, `run.test.ts`
covers timeouts/stalls/kill, `registry.test.ts` covers names and persistence,
`agents.test.ts` covers discovery, `worktree.test.ts` covers git worktrees, and
`extension.test.ts` covers the tool wiring end to end.

A zero-token smoke test against the real CLI:

```bash
npm run smoke                  # PI_CLI=/path/to/pi to pick the binary
```

## Upgrade and remove

The package is pinned to a tag. `pi update --extensions` reconciles it; to roll
back, install the previous tag. To remove it, `pi remove <source>`. The child
sessions under `~/.pi/agent/subagents` are yours to delete separately.

The source checkout is for development only; the running extension comes from
the installed package.

Compatibility surfaces and the upgrade checklist live in `docs/compat.md`; the
weekly `pi-canary` workflow runs the same checks against `@latest`.
