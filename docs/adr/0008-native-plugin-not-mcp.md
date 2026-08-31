# Native dsh plugin, not an MCP server or external daemon

dsh-cron is a native cordis plugin (in-process service: timer, tick loop, tools, commands), not an MCP server and not an out-of-process cron daemon. The product's core act is a **push** — a due fire wakes an agent via the in-process `agent.followup()` / `agent.steer()` runtime methods — while MCP is pull-only, so an MCP server cannot deliver fires at all; it could only offer CRUD tools shorn of every delivery capability the design exists to provide (delivery policy, idle gating, per-agent scoping). An external daemon re-opens the rejected ADR 0001 option and, on dsh rc.2, has no supported inject channel anyway. If other ecosystems ever need the task store, the path is a sibling package: extract the dsh-free scheduling core (parse, compute, store) into a library and add an MCP facade — delivery in foreign hosts would rely on those hosts' own notification mechanisms and is explicitly out of scope for v1.

## Considered Options

- **MCP server** (tools consumed via dsh-mcp-client): rejected — pull-only protocol cannot wake agents; loses delivery policy, idle gating, and tool scoping; adds protocol overhead inside dsh for zero gain.
- **Out-of-process scheduler daemon**: rejected for v1 under ADR 0001; revisit only if dsh exposes a public cross-process inject API.
