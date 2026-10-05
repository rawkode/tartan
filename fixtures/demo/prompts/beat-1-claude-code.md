# Beat 1 (Q1) — Claude Code

Pinned prompt for the demo recording. The MCP server is the demo forge's `/-/mcp/rawkode/platform/edge/router`.

> You are working on `rawkode/platform/edge/router` through the Tartan MCP server. Claim the open work item "Per-tenant
> rate limiting" with the footprint project `@demo/api` and prefix `services/api/src/middleware/`, and read the overlaps
> the claim returns. Before you edit, call `conflicts_check` for the files you plan to touch. If another agent's lane
> overlaps yours, send it a short `inbox_send` saying which file and function you will change. Then implement the limit
> in `services/api/src/middleware/`, run the tests named in the work item's context, push to your lane with the exact
> `git` commands the lane handle gives you, and submit with `changes_submit` once the acceptance criteria pass. Quote
> any notice a tool result carries before you act on it.
