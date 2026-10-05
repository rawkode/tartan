# Architecture overview

Tartan deploys as **one Worker with one `wrangler.jsonc` and one container image**. The web UI is a Vue SPA served from
the same Worker's static assets, so the UI, the API, Git and MCP share one origin.

```
 Browser (SPA)        Claude Code / Codex / other MCP clients        git CLI
   │ session cookie     │ agent token (MCP and git)                    │ personal access token
   ▼                    ▼                                              ▼
┌────────────────────────── Worker tartan-<stage>  (your domain) ─────────────────────────────┐
│ router: /-/health /-/setup /-/auth /-/api /-/live /-/mcp /-/cap /<repo>.git /<repo>/-/lanes  │
│ identity · authorization · git gateway (lane policy, push limits, remote: messages) · MCP   │
│ entrypoints: KernelCaps (extension capabilities) · RepoProbe (diffs, project graph)          │
└──────┬───────────────┬────────────────┬──────────────────┬──────────────┬───────────────────┘
       ▼               ▼                ▼                  ▼              ▼
   ForgeDO         RepoDO per repo   InboxDO per        ExtensionDO     Workflows: Run, Land,
   identity,       refs, push log,   principal          per installation Ingest, Swarm
   hierarchy,      lanes, event log, notices,           scope            │
   registry,       advances, runs    presence                            ▼
   audit                                                           TartanSandbox containers
                                                                   (CI, git compose, notes)
   Artifacts namespace tartan-<stage>: canonical repos r-<id>, lane repos l-<id>-<lane>
   R2 tartan-<stage>-blobs: logs, extension bundles, diffs · KV: OAuth state · Workers AI
```

## Resources

One Worker; five Durable Object classes (`ForgeDO`, `RepoDO`, `InboxDO`, `ExtensionDO`, `TartanSandbox`); four
Workflows; one Artifacts namespace; one R2 bucket; one KV namespace; Worker Loader (for `js` and `wasm` extensions);
Workers AI; static assets. No D1, Queues or second Worker.

| Unit            | Responsibility                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker          | the single front door: routing, security headers, CSRF, authentication, the Git gateway, the MCP host, the slot and action API, the setup wizard     |
| `ForgeDO`       | one per forge: setup state, the IdP, keys, principals, sessions and tokens, the hierarchy and its grants, the extension registry, audit              |
| `RepoDO`        | one per repository: the ref index, the push log, lanes and their policy, the event log (ordered, causal, hash-chained), advances, runs and jobs      |
| `InboxDO`       | one per principal: notices (radar, ejections, review requests), delivery state, presence, long-poll waiters                                          |
| `ExtensionDO`   | one per installation scope: runs that extension's code, holds its tables, drives its event cursor, retries and circuit breaker                       |
| `TartanSandbox` | containers for real git and real toolchains: CI jobs, `merge-tree` composition, notes, lease pushes                                                  |
| Workflows       | `RunWorkflow` (job graphs), `LandWorkflow` (the Advance pipeline), `IngestWorkflow` (every Artifacts push event), `SwarmWorkflow` (simulated agents) |
| `KernelCaps`    | the capability surface extensions call; every call re-checks the installation's grants against the acting principal                                  |
| `RepoProbe`     | CPU-heavy, cacheable git reads: merge bases, tree diffs, hunks, three-way merges, the project graph                                                  |

## Who may write what

- **ForgeDO** is the only writer of identity, the hierarchy, grants and the registry.
- **RepoDO** is the only writer of refs, the push log, lanes, events, advances and runs for its repository. It never
  runs extension code.
- **ExtensionDO** is the only writer of its extension's tables, and reaches the kernel only through `KernelCaps`.
- **The gateway is the only way a person or an agent moves a ref.** It maps each principal to the lanes it may write,
  refuses everything else with a readable message, and records every push before it forwards it. No person, agent or
  extension ever holds an Artifacts credential; the gateway mints short-lived upstream tokens per push.
- **The Advance (LandWorkflow) is the only way trunk moves.** Kernel git jobs are the only writers of protected refs,
  `refs/tartan/*` and `refs/notes/tartan`, and each one registers its intent before it pushes, so the push trigger can
  tell kernel writes from tampering.

## Lanes

A lane is one unit of work's place to push, owned by one principal; only the owner and its delegates can move it.
Lanes are per-agent Artifacts repositories created with `import()`, with branch lanes as the fallback; both backends
sit behind one interface:

- **Lane repositories**: each agent lane is its own Artifacts repository `l-<repo>-<lane>`, created in seconds with
  `import()` from a short-lived capability URL that the gateway serves for trunk. A lane push then uses an upstream
  token scoped to that one lane repository, so even a policy bug could not move trunk or another lane.
- **Branch lanes** (the fallback): `refs/heads/lanes/<laneId>` inside the canonical repository; the gateway's ref
  policy is the boundary. A repository falls back per lane, with the reason recorded (a failed seed, a repository too
  large to import, the forge's lane-repository ceiling), and the deploy chooses the default mode
  (`deploy --lane-mode`).

## Requests, in brief

- **Git**: `git clone https://<host>/<path>.git` and `git push` go through the gateway: authentication, the lane
  policy, the push size limit, then a streamed proxy to Artifacts, with `remote:` lines (radar notices, rejections)
  added to the response.
- **MCP**: `/-/mcp[/<path>]` assembles the tools, instructions and context from the installations at the agent's
  scope, and appends pending notices to each tool result.
- **UI**: the SPA calls `/-/api/*` and subscribes to `/-/live` for the event stream. Extension UI is server-driven
  JSON (`tartan-ui@1`) rendered by the host; extensions never run in the browser.
- **Pushes that bypass the gateway** (none should) are still observed: every Artifacts push event starts an
  `IngestWorkflow` that reconciles the ref with the push log.

See [`design/README.md`](design/README.md) for the invariants and the core flows, [`extensions.md`](extensions.md)
for the extension model, and [`deploy.md`](deploy.md) for the deployment.
