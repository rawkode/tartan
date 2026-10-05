# Tartan design summary

This is the public summary of Tartan's design: the kernel, its invariants, the extension model, lanes and the core
flows. [`../architecture.md`](../architecture.md) is the shorter overview; `packages/contract` is the source of truth
for names and signatures.

## Principles

1. **A small kernel.** It owns only what security and accountability depend on: identity, the hierarchy, repositories
   and lanes, the Git gateway, the event log, capabilities, a job executor and the Advance. Issues, pull requests,
   review and merge queues are extensions.
2. **The protocol is data.** Installations attach to nodes of the hierarchy and the nearest provider of an interface
   wins, so different subtrees can run different coordination models. Agents learn the protocol in force from the
   forge (MCP instructions, the tool list, `context_get`).
3. **Swappable coordination, non-swappable accountability.** Whatever extension asks, trunk moves only through the
   Advance, with a reason chain and a why note.
4. **The forge talks back through the agent's own tools**: `remote:` lines in `git push`, notices on MCP results,
   claim responses. An agent with no Tartan integration is still coordinated.
5. **One deployment, one Worker, one config, one image**, in the deployer's own account.

## Kernel invariants

Each is enforced inside a Durable Object transaction and has a test.

| Id  | Invariant |
| --- | --- |
| K1  | **One writer of protected refs.** A protected ref, `refs/tartan/*` or `refs/notes/tartan` changes only through a kernel git job that registered its intent before pushing. The gateway rejects every client push to them; an observed change that matches no intent is quarantined and pauses landing until the owner acknowledges it |
| K2  | **One owner per lane.** A lane's head moves only by a gateway push of its owner (or a listed delegate) while the lane is active, or by a registered kernel write for that lane; anything else is quarantined |
| K3  | **Every kernel state change appends exactly one event in the same transaction.** The log is the outbox: sequence numbers are strictly increasing per repository, each row is hash-chained to the previous one, and side effects outside the object are written as intents first and completed by an idempotent sweeper |
| K4  | **An Advance requires a reason chain** of events in the repository's log, including each change's submission and its approval by the review provider in force (or a passing human-review gate), bound to the head being landed; the kernel always writes the why note |
| K5  | **At most one Advance per ref is in flight**, held under a lease; every push sub-step is compare-and-swap and re-entrant |
| K6  | **Disjoint landing.** A batch tested on an older base lands without a re-test only if nothing that landed since touched its affected projects or any global file, and the restack is clean |
| K7  | **Lane leases expire**; an expired lane becomes `lost` and its owner can resume it for 24 hours |
| K8  | **Gates are monotonic down the tree**: a gate installed at an ancestor applies to every descendant and cannot be removed or shadowed below it; any enforcing veto blocks |
| K9  | **Notices never block.** Only gates, check verdicts, required review decisions and compare-and-swap can block a land |
| K10 | **Event hygiene**: bounded causal depth, and a producer emits only kernel types, its own types and the types of interfaces it provides, validated against their schemas |
| K11 | **No person, agent or extension ever receives an Artifacts token.** Every upstream token is minted per operation and scoped to the one repository it touches; trunk write tokens exist only on kernel paths |
| K12 | **Installation confinement**: everything an installation names must resolve to its node or a descendant |
| K13 | **Policy comes from trunk**: policy files (the root `*.cue` files, home of the CUE package `tartan`) are read from the change's base, never from the lane, and a change to them always goes to a person |
| K14 | **Verdicts are bound to the tested candidate**: a check result counts only for the batch, attempt and commit it was announced for, and the Advance pushes exactly that commit (or its disjoint restack) |
| K15 | **Reads are by SHA**: the kernel resolves refs from its own index, and only commit and tree ids reach the storage binding |
| K16 | **Lane operations are owner-bound**: every lane-mutating kernel operation (open, adopt, close, archive, sync, restack, delegate) is authorized by one rule, wherever it comes from, so the kernel API cannot do what the gateway forbids |
| K17 | **A lane's diff is the range from its merge base with trunk**, found by a bounded walk over the trunk commit set, so diffs and radar stay correct after trunk moves |

## Data model

| Store                                   | Holds                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ForgeDO` (`forge`)                     | setup state, IdP configuration, keys (sealed), principals, identities, sessions, tokens, delegations, nodes, grants, protected refs, the extension registry, audit |
| `RepoDO` (`repo:<repoId>`)              | ref index, push log (canonical repository and its lane repositories), lanes, trunk commits, kernel write intents, event log, advances, runs and jobs, project-graph cache |
| `InboxDO` (`inbox:<principalId>`)       | notices, delivery and acknowledgement, presence, long-poll waiters                                                                          |
| `ExtensionDO` (`ext:<inst>:<scope>`)    | host tables (cursors, dedupe, timers, render cache, breaker) and the extension's own tables                                                 |
| Artifacts `tartan-<stage>`              | canonical repositories `r-<repoUlid>` and lane repositories `l-<repoUlid>-<laneUlid>`                                                       |
| R2 `tartan-<stage>-blobs`               | job logs, extension bundles, blame and diff caches                                                                                          |

Each module owns a fixed range of migration numbers in each Durable Object, and modules never touch each other's
tables; in-object calls go through each module's synchronous internal API.

## Lanes

A lane belongs to one principal and one unit of work. Two backends implement the same interface:

- **`branch`**: `refs/heads/lanes/<laneId>` in the canonical repository. Always available; the gateway's ref policy is
  the isolation boundary. The first milestone runs on this backend.
- **`repo`**: each agent lane is its own Artifacts repository, created with `import()` from a short-lived, MAC-protected
  capability URL that the gateway serves for trunk. Lane pushes use an upstream token scoped to that lane repository
  alone, which adds a second isolation layer. If an import cannot be used (for example, the importer cannot reach the
  forge), the lane falls back to a branch lane, and the seeder records which backend was chosen and why.

Lanes have leases, ranges (K17), a landing freeze while they land, quarantine (K2) and garbage collection; archived
lanes are kept for the repository's attic retention.

## Core flows

**Setup.** The deploy sets a single-use setup token; the setup URL carries it in the fragment. The wizard names the
forge, takes the IdP's issuer URL, registers Tartan by dynamic client registration where the IdP supports it (a public
PKCE client), and the first sign-in becomes the owner. Destroy deregisters that client (RFC 7592).

**Git through the gateway.** Authenticate (session cookies are never accepted on Git), resolve the path to a
repository, apply the lane policy and the size limit, record the push, forward it with a scoped upstream token,
relay the response and add `remote:` lines. A refused ref gets a synthesized `ng` with the reason.

**The agent loop.** Claim with a footprint → a lane opens → push to the lane → the push is diffed against every lane
and trunk, and radar notices go to both parties → submit a change → CI on the affected projects → review by exception
→ the Weave composes candidates and asks for an Advance → trunk moves with a reason chain, trailers and a note.

**The Advance.** LandWorkflow composes the batch with `git merge-tree`, runs every gate on the path, waits for checks
bound to that exact candidate, takes the lock, restacks if trunk moved, pushes trunk with compare-and-swap, writes
`refs/notes/tartan` and the change refs, and completes. Each step can be retried without repeating its effect.

**Conflicts.** Predicted while the work happens (declared, same project, same file, adjacent, textual) and stored as
records. A real conflict at land time ejects the change and creates a resolver work item with both intents, both diffs
and the conflict regions.

**Events to extensions.** Events are appended in RepoDO and pulled by each installation's ExtensionDO in order, with
pokes to wake it; there is no queue to lose ordering.

**CI.** The pipeline, `tartan.ci`'s part of the CUE package `tartan` in the repository root, is planned into a job graph
of the affected projects; RunWorkflow runs each job in a TartanSandbox container with live logs to R2 and the event
stream; results are cached by input hash.

## Security model, in brief

- One OIDC IdP per forge; sessions are `__Host-` cookies for the SPA only. Git and MCP take bearer tokens (personal
  access tokens, agent tokens, later OAuth 2.1 for MCP).
- Roles inherit down the hierarchy; agent tokens are capped by their owner's role, a node subtree and optionally one
  lane.
- CSRF protection, strict security headers and a sandboxed CSP for raw file views; WebSockets check the origin.
- Secrets at rest are sealed with keys derived from one root secret; the root never leaves the Worker's environment.
- Extensions run in their own Durable Objects with capability-checked kernel access, CPU and rate limits, a circuit
  breaker and a kill switch; outbound fetches are restricted.
- Every kernel decision that matters (gate verdicts, advances, quarantines, setup and recovery) is in the audit log or
  the event chain.

## Decisions worth knowing

- **wrangler and Deno.** `wrangler.jsonc` is the deploy source of truth (event triggers, containers, Artifacts and
  Workflows in one file); Deno runs format, lint, type checks and unit tests; npm owns dependencies with exact pins.
- **No pull-request primitive.** "Change" is one provider of `changes@1`.
- **Ordered pull for extension events**, not a queue, so each installation sees its repository's events in order.
- **Classic containers via the Sandbox SDK** for real git (`merge-tree`, notes, lease pushes) and real toolchains,
  because Artifacts exposes no merge or blame API.
