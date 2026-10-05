# Tartan design summary

This is the public summary of Tartan's design: the kernel, its invariants, the extension model, lanes and the core
flows. [`../architecture.md`](../architecture.md) is the shorter overview; `packages/contract` is the source of truth
for names and signatures.

| Document                                               | For                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| this page                                              | the summary: principles, kernel invariants, data model, lanes, core flows                                                           |
| [`OVERVIEW.md`](OVERVIEW.md)                           | the long-form design: components, data model and migration ranges, identity, lanes, the gateway, radar, the Weave and Advances, provenance, CI, extensions, repository config, projects, the global event log, security, limits and planned work |
| [`ADR-repo-config-cue.md`](ADR-repo-config-cue.md)     | the decision record for repository config in the CUE package `tartan`: evaluation, sign-off, caching, limits and alternatives       |

## Principles

1. **A small kernel.** It owns only what security and accountability depend on: identity, the hierarchy, repositories
   and lanes, the Git gateway, the event log, capabilities, a job executor and the Advance. Issues, pull requests,
   review and merge queues are extensions.
2. **The protocol is data.** Installations attach to nodes of the hierarchy and the nearest provider of an interface
   wins, so different subtrees can run different coordination models. Agents learn the protocol in force from the
   forge (MCP instructions, the tool list, `context_get`).
3. **Swappable coordination, non-swappable accountability.** Whatever extension asks, trunk moves only through the
   Advance, with a reason chain and a why note.
4. **The forge talks back through the agent's own tools**: notices on every MCP result, claim responses and lane
   handles, and a reason on every refused `git push`. An agent needs nothing but an MCP client and stock git.
   (`remote:` guidance on refused pushes is built behind the compile-time switch `ECHO_ENABLED`, which is off;
   extension echo lines on accepted pushes are planned.)
5. **One deployment, one Worker, one config, one image**, in the deployer's own account.

## Kernel invariants

Each is enforced inside a Durable Object transaction and has a test. Source comments use these ids;
[`OVERVIEW.md`](OVERVIEW.md#design-principles) states them in plain words.
The ids are invariant tags only; `K2` here has nothing to do with Cloudflare K2, the global event log.

| Id  | Invariant |
| --- | --- |
| K1  | **One writer of protected refs.** A protected ref, `refs/tartan/*` or `refs/notes/tartan` changes only through a kernel git job that registered its intent before pushing. The gateway rejects every client push to them; an observed change that matches no intent is parked, re-checked after a grace window, and then pauses landing until the owner acknowledges it |
| K2  | **One owner per lane.** A lane's head moves only by a gateway push of its owner (or a listed delegate) while the lane is active, or by a registered kernel write for that lane; anything else is quarantined |
| K3  | **Every kernel state change appends exactly one event in the same transaction.** The log is the outbox: sequence numbers are strictly increasing per repository, each row is hash-chained to the previous one, and side effects outside the object are written as intents first and completed by an idempotent sweeper |
| K4  | **An Advance requires a reason chain** of events in the repository's log, including each change's submission and its approval by the review provider in force (or a passing human-review gate), bound to the head being landed; the kernel always writes the why note |
| K5  | **At most one Advance per ref is in flight**, held under a lease; every push sub-step is compare-and-swap and re-entrant |
| K6  | **What lands is what was tested.** A batch lands only on the trunk it was composed and tested on; if trunk moved, the attempt is stale and the batch is composed and tested again. Landing a disjoint batch on a newer trunk without a re-test is planned, and only when nothing that landed since touched its affected projects or any global file and the restack is clean |
| K7  | **Lane leases expire**; an expired lane becomes `lost` and its owner can resume it for 24 hours |
| K8  | **Gates are monotonic down the tree**: a gate installed at an ancestor applies to every descendant and cannot be removed or shadowed below it; any enforcing veto blocks |
| K9  | **Notices never block.** Only gates, check verdicts, required review decisions, compare-and-swap and, with repository config on, the policy sign-off rules can block a land |
| K10 | **Event hygiene**: bounded causal depth, and a producer emits only kernel types, its own types and the types of interfaces it provides, validated against their schemas |
| K11 | **No person, agent or extension ever receives an Artifacts token.** Every upstream token is minted per operation and scoped to the one repository it touches; trunk write tokens exist only on kernel paths |
| K12 | **Installation confinement**: everything an installation names must resolve to its node or a descendant |
| K13 | **Policy comes from trunk**: policy files (the root `*.cue` files, home of the CUE package `tartan`) are read from the change's base, never from the lane, and a change to them always goes to a person |
| K14 | **Verdicts are bound to the tested candidate**: a check result counts only for the batch, attempt and commit it was announced for, and the Advance pushes exactly that commit |
| K15 | **Reads are by SHA**: the kernel resolves refs from its own ref index, and every storage read names a commit or tree id, so a read is reproducible and never races a ref update |
| K16 | **Lane operations are owner-bound**: every lane-mutating kernel operation (open, adopt, close, archive, sync, restack, delegate) is authorized by one rule, wherever it comes from, so the kernel API cannot do what the gateway forbids |
| K17 | **A lane's diff is the range from its merge base with trunk**, found by a bounded walk over the trunk commit set, so diffs and radar stay correct after trunk moves |

## Data model

| Store                                   | Holds                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ForgeDO` (`forge`)                     | setup state, IdP configuration, keys (sealed), principals, identities, sessions, tokens, invites, nodes, grants, protected refs, the extension registry, audit |
| `RepoDO` (`repo:<repoId>`)              | ref index, push log (canonical repository and its lane repositories), lanes, trunk commits, kernel write intents, event log, advances, runs and jobs, project-graph cache |
| `InboxDO` (`inbox:<principalId>`)       | notices, delivery and acknowledgement, presence, long-poll waiters                                                                          |
| `ExtensionDO` (`ext:<inst>:<scope>`)    | host tables (cursors, dedupe, timers, render cache, breaker) and the extension's own tables                                                 |
| `BusDO` (`bus:<group>:<n>`)             | the global event log consumer's cursor, dedupe, retries and dead letters (only with the K2 log switched on)                                  |
| Artifacts `tartan-<stage>`              | canonical repositories `r-<repoUlid>` and lane repositories `l-<repoUlid>-<laneUlid>`                                                       |
| R2 `tartan-<stage>-blobs`               | job logs, extension packages and push diffs                                                                                                 |

Each module owns a fixed range of migration numbers in each Durable Object, and modules never touch each other's
tables; in-object calls go through each module's synchronous internal API. The ranges are listed in
[`OVERVIEW.md`](OVERVIEW.md#migration-ranges) (`MIGRATION_RANGES` in `packages/contract` is the source of truth).

## Lanes

Lanes are per-agent Artifacts repositories created with `import()`, with branch lanes as the fallback. A lane belongs
to one principal and one unit of work. Two backends implement the same interface:

- **`repo`**: each agent lane is its own Artifacts repository, created with `import()` from a short-lived, MAC-protected
  capability URL that the gateway serves for trunk. Lane pushes use an upstream token scoped to that lane repository
  alone, which adds a second isolation layer.
- **`branch`** (the fallback): `refs/heads/lanes/<laneId>` in the canonical repository; the gateway's ref policy is
  the isolation boundary. A lane can fall back to a branch lane on the same lane id, and `lane.opened` records the
  backend it got.

The forge's lane mode is chosen at deploy time (`deploy --lane-mode import|branch`) and an Owner can override it per
repository; the compiled default is `branch`.

Lanes have leases, ranges (K17), a landing freeze while they land, quarantine (K2) and garbage collection; archived
lanes are kept for the repository's attic retention.

## Core flows

**Setup.** The deploy sets a single-use setup token; the setup URL carries it in the fragment. The wizard names the
forge, takes the IdP's issuer URL, registers Tartan by dynamic client registration where the IdP supports it (a public
PKCE client), and the first sign-in becomes the owner. Destroy deregisters that client (RFC 7592).

**Git through the gateway.** Authenticate (session cookies are never accepted on Git), resolve the path to a
repository, apply the lane policy and the size limit, record the push, forward it with a scoped upstream token and
relay the response. A refused push gets a synthesized `ng` with the reason for every ref, and nothing is forwarded.

**The agent loop.** Claim with a footprint → a lane opens → push to the lane → the push is diffed against every lane
and trunk, and radar notices go to both parties → submit a change → CI on the affected projects → review by exception
→ the Weave composes candidates and asks for an Advance → trunk moves with a reason chain, trailers and a note.

**The Advance.** LandWorkflow composes the batch with `git merge-tree`, runs every gate on the path, waits for checks
bound to that exact candidate, takes the lock, checks that trunk is still the tested base (otherwise the batch is
composed and tested again), pushes trunk with compare-and-swap, writes `refs/notes/tartan` and the change refs, and
completes. Each step can be retried without repeating its effect.

**Conflicts.** Predicted while the work happens (declared footprints, same project, same file, trunk drift) and stored
as records; hunk-level grades are planned. A real conflict at land time ejects the change, and its author gets a
notice with both intents, the other changes' paths and the conflict regions.

**Events to extensions.** Events are appended in RepoDO and pulled by each installation's ExtensionDO in order, with
pokes to wake it; there is no queue to lose ordering.

**CI.** The pipeline, `tartan.ci`'s part of the CUE package `tartan` in the repository root (or zero-config detection
when there is none, or repository config is off), is planned into a job graph of the affected projects; RunWorkflow
runs each run's jobs in a TartanSandbox container with live logs to R2 and the event stream; successes are cached by
input hash.

## Security model, in brief

- One OIDC IdP per forge; sessions are `__Host-` cookies for the SPA only. Git and MCP take bearer tokens (personal
  access tokens and agent tokens; OAuth 2.1 for MCP is planned).
- Roles inherit down the hierarchy; agent tokens are capped by their owner's role and a node subtree.
- CSRF protection, strict security headers and a sandboxed CSP for raw file views; WebSockets check the origin.
- Secrets at rest are sealed with keys derived from one root secret; the root never leaves the Worker's environment.
- Extensions run in their own Durable Objects with capability-checked kernel access, host-side timeouts, rate limits,
  a circuit breaker and a kill switch; `js` and `wasm` extensions have no outbound network.
- Every kernel decision that matters (gate verdicts, advances, quarantines, setup and recovery) is in the audit log or
  the event chain.

## Decisions worth knowing

- **wrangler and Deno.** `wrangler.jsonc` is the deploy source of truth (event triggers, containers, Artifacts and
  Workflows in one file); Deno runs format, lint, type checks and unit tests; npm owns dependencies with exact pins.
- **No pull-request primitive.** "Change" is one provider of `changes@1`.
- **Ordered pull for extension events**, not a queue, so each installation sees its repository's events in order.
- **Classic containers via the Sandbox SDK** for real git (`merge-tree`, notes, lease pushes) and real toolchains,
  in one runner image.
- **Repository config in CUE.** A repository's Tartan config is the CUE package `tartan` in its root, evaluated by
  the official `cue` CLI in a sandbox and applied from trunk only; see
  [`ADR-repo-config-cue.md`](ADR-repo-config-cue.md).
