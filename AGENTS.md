# pi-async-subagents

A Pi package: async, liveness-checked subagents. The extension runs inside Pi;
the host supplies `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox` (peer `*`), never a physical copy.

- Test first. `npm run check` (typecheck + 57 offline tests) must be green.
- The tests use a scripted fake RPC child; no model, no API keys.
- Keep the Pi surface small and listed in `docs/compat.md`. An upgrade diffs
  it, bumps the tested version, runs the checks and `npm run smoke`, then tags.
- Released from a tag; `package.json` `pi` manifest is the package entry.
- Do not commit host names, IPs, tokens, or machine paths.
