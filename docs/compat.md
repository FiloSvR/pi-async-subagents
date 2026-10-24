# pi compatibility

Tested with `@earendil-works/pi-coding-agent` 1.4.0 on Node 24. The extension
is a Pi package: the host supplies `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox` (peer, `*`); never add them to
`dependencies`.

## Surfaces used

### Host extension API

- `ExtensionAPI` / `ExtensionContext`
- `getAgentDir()`
- `registerTool`, `registerCommand`, `registerMessageRenderer`, `on`
  (session start/reload, tool calls)
- the tool result and UI-policy shape
- `typebox` `Type` schemas

### Host TUI API

- `Box`, `Text` from `@earendil-works/pi-tui` (compact result rendering)
- the custom message renderer contract (`expanded`, `outputPad`, theme)

### Child process (RPC)

- `pi --mode rpc`, JSONL records, `--no-session`
- commands: `prompt`, `abort`, `get_state`
- events: message updates, agent end/settled, errors, shutdown
- spawn: the `pi` executable, cwd, environment, model/continue flags

### Agent discovery and config

- `~/.pi/agent/agents/*.md` frontmatter (`name`, `description`, `tools`,
  `model`, `worktree`, `max-minutes`, `system-prompt`)
- `~/.pi/agent/subagents/config.json`
- `~/.pi/agent/settings.json` package declarations

## Upgrade procedure

1. Read the release notes; diff the surfaces above.
2. Bump the tested version here and in `.forgejo/workflows/ci.yml`.
3. `npm run check` against the pinned host; `npm run smoke` against the real
   CLI.
4. Let the weekly canary (`pi-canary`) run against `@latest`.
5. Fix, tag `vX.Y.Z`, push, install the tag.
