# Concepts

This page explains how Tartan coordinates several agents and people on the same repositories. The names match
`packages/contract`, which is the source of truth for every type, tool and event mentioned here. The
[README](../README.md#features-and-their-status) gives the status of each feature; the few parts that are not built yet
are marked _not built yet_ here.

## The forge and its hierarchy

A **forge** is one deployment: one Worker in your Cloudflare account, one identity provider, one hierarchy. Nothing is
shared with other forges.

The hierarchy is made of **nodes**: users, groups and repositories. Groups nest to any depth, so
`acme/platform/edge/router` is a repository inside the groups `platform` and `edge` under the root `acme`. Users and
groups can both be roots. Moving or renaming a node leaves a redirect from the old path.

Two things inherit down the tree:

- **Roles.** Guest, Reporter, Developer, Maintainer and Owner, granted on a node, apply to its whole subtree. A grant
  further down can raise a role, never lower it.
- **Installations.** An extension installed on a node applies to that node's subtree.

## Principals

| Principal    | Signs in with                                                                                       | Acts as                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| User         | the forge's OIDC provider (browser session), or a `tpat_` personal access token for git and the API | itself                                                                                     |
| Agent        | a `tagt_` agent token, scoped to one node, with a role ceiling and an expiry                        | itself, on behalf of the user who created it                                               |
| Installation | nothing: the kernel calls it                                                                        | `x_<installation>` in background hooks; the viewer or caller in renders, actions and tools |

Every event, lane, change and landed commit records the principal that caused it and, for an agent, the user it acted
for.

## Lanes

A **lane** is one unit of work's place to push. It has exactly one owner (plus any delegates the owner adds), a base on
trunk, a footprint and a lease. Only its owner can move it; nobody, including the owner, can push trunk.

Lanes are per-agent Artifacts repositories created with `import()`, with branch lanes as the fallback. Both backends sit
behind one interface:

- **Lane repositories**: each agent lane is its own Artifacts repository, reached at
  `https://<forge>/<repo>/-/lanes/<laneId>.git`, where the agent pushes `main`. A push to a lane repository uses an
  upstream token scoped to that one repository.
- **Branch lanes**: `refs/heads/lanes/<laneId>` inside the repository. The gateway's ref policy confines each agent to
  its own lanes.

The deploy sets the forge's lane mode (`deploy --lane-mode import` or `branch`; branch lanes are the default), an Owner
can override it per repository, and the lane handle records which backend each lane uses. The lane-repo self-test
(**Settings**, and a step of the setup wizard) opens one scratch lane repository through the same path agents use and
deletes it.

Whatever the backend, a refused push names the reason that git prints (`woven-by-tartan` for trunk, `not-your-lane` for
someone else's lane). A lane's diff is always the range from its merge base with trunk, so diffs and conflict detection
stay correct after trunk moves. A lane is frozen while it lands; a lane whose lease expires becomes `lost`, and its
owner can resume it for 24 hours.

The lane handle that the MCP tools return carries the exact git commands for the lane's backend, so an agent never has
to work out refs or remotes itself.

## Work items, claims and footprints

The `work@1` interface (provided by `tartan.work`) holds **work items** (issues and intents; a `resolve` kind is
reserved for the planned resolver items), each referenced as `<repo>#<n>`. Claiming a work item opens a lane for the
claimant.

A claim carries a **footprint**: the projects and path prefixes the work expects to touch. The claim response already
lists overlapping work in flight, with a suggestion for each: `proceed`, `coordinate`, `stack`, `rebase` or `yield`. An
agent learns about a collision before it writes any code.

## Conflict radar

The `conflicts@1` interface (provided by `tartan.radar`) compares every lane with every other active lane and with
trunk, continuously:

- at claim time, from the declared footprints;
- after every push, from the paths and projects the lane's range actually touches;
- after every landing, as trunk drift for the lanes that are still open.

Each conflict is a record with a grade (`declared`, `same_project`, `same_file`, `trunk_drift`), not an error. Both lane
owners get a notice with the other lane, the overlap and a suggestion. Notices never block anything: only gates, check
verdicts, required reviews, compare-and-swap and, with repository config on, the policy sign-off can stop a land.

Agents see radar notices where they already look: at the end of every MCP tool result (see [Scoped MCP](#scoped-mcp)),
in their inbox (`inbox_read`, `inbox_wait`), and through `conflicts_check {paths}`, which answers "who do I collide
with if I edit these paths?" before editing. People see them in the **Lanes** view, on lane badges, on file banners, in
the change sidebar and in the repository's **Radar** tab. Finer grades (adjacent hunks, textual overlaps) and radar
lines in the pusher's own `git push` output are _not built yet_.

## Changes, CI and review

A **change** (`changes@1`, provided by `tartan.changes`) is the reviewable unit built from a lane. After its first push,
the lane's owner calls `changes_submit {laneId, title, summary}`; every later push to the lane is a new revision, and a
new revision is reviewed again.

**CI** (`checks@1`, provided by `tartan.ci`) runs only the projects a change affects, as a job graph in Cloudflare
Workflows with each job in a Sandbox container, and reuses earlier successes with the same input hash. The pipeline is
repository policy in the CUE package `tartan` ([repo-config.md](repo-config.md)); without one, CI detects what to run.

**Review** (`review@1`, provided by `tartan.review`) routes by exception: it scores each change's risk from the
sensitivity of the changed paths (owners rules), the blast radius in the project graph, the size of the diff, weakened
tests, the lane's open conflicts and the author's record of ejects, vetoes and reverts. Changes below the threshold are
approved automatically; the rest go to a person with the factors that scored. A change that touches policy files or
weakens tests always goes to a person. The Classic pack sets review to require a person for every change.

Policy is always read from trunk at the change's base, never from the lane under review. A change to any root `*.cue`
file is always routed to a person; with repository config on (`deploy --repo-config`) it also needs a sign-off,
bound to its head, by a Maintainer or above.

## The Weave and the Advance

The `queue@1` interface decides the order in which approved changes land. Two providers ship:

- **`tartan.weave`** (the Weave) takes up to four approved changes at a time per repository, composes them onto trunk
  with real `git merge-tree` in a container, has CI test the composed candidate, and asks the kernel to advance trunk.
  A change that conflicts or is vetoed is ejected, and its author gets a notice with both intents, the other changes'
  paths and the conflict regions. When a batch fails its tests, each change is retried alone.
- **`tartan.fifo`** lands one change at a time, in order, after a person's approval.

An Owner can swap the provider on a live subtree (**Extensions → Swap queue@1…**); the new provider takes over the
waiting changes. Partitions (parallel sub-trains for disjoint projects), bisecting a failed batch and resolver work
items are _not built yet_.

The **Advance** is the only way a protected branch moves. Whatever extension asks for it, the kernel:

- runs every `ref.advance` gate installed on the path from the root to the repository (a gate cannot be removed below
  the node that installed it, and any enforcing veto blocks);
- requires a **reason chain**: the events in the repository's log that justify the land, including each change's
  submission and its approval, bound to the lane head being landed;
- moves the ref by compare-and-swap, with at most one Advance per ref in flight;
- pushes exactly the commit that was tested;
- writes a why-note.

No person, agent or extension can move trunk another way. Pushes that bypass the gateway are observed from Artifacts'
push events and reconciled; a protected ref that moves without a registered kernel write is quarantined and pauses
landing until an Owner acknowledges it.

## Why-notes

Every landed commit gets a note under `refs/notes/tartan` and trailers on its squash commit (`Change-Id`,
`Tartan-Change`, `Tartan-Work`, `Tartan-Agent`, `Tartan-On-Behalf-Of`, `Tartan-Review`, `Tartan-Advance`, and
`Co-authored-by` for any other principal who first pushed commits in the lane). The note's kernel section names the
Advance, the batch, the change, the lane and its head, the actor and the user it acted for, the first pushers of the
lane's commits, and the reason chain. Gate decisions and sections contributed by extensions follow it.

Members can still fetch the landed lane head at `refs/tartan/changes/<changeId>` after the lane is cleaned up. The
note and the trailers work with stock git:

```sh
git clone https://git.example.com/acme/platform/router.git && cd router
git fetch origin refs/notes/tartan:refs/notes/tartan
git log --notes=tartan -1
```

The MCP tool `why`, `GET /-/api/why` and the **Why-blame** view in the web UI answer the same question for a commit, or
for the newest landing that touched a path; line-level blame is not built yet. `GET /-/api/advances` and the
**Advances** view list the Advances of a repository.

## Every event has a cause

Each repository has an append-only event log: ordered by sequence number, hash-chained, and with a `causedBy` and a
`correlation` on every event. Every kernel state change appends exactly one event in the same transaction. Extensions
react to these events, and the Advance's reason chain points into the same log, which is how a landed commit can be
traced back to the work item, the agent and the decisions behind it.

A forge can also relay every repository's events to one K2 stream, a global event log, with `deploy --k2`. The Durable
Objects stay the system of record. Dispatching CI runs from that log (`--workload-transport k2`, which also needs the
log's consume token) falls back to inline dispatch whenever the log is unhealthy; it is _in progress_
([README](../README.md#features-and-their-status)).

## Protocol packs per subtree

Because installations attach to nodes and **the nearest provider of an interface wins**, the coordination protocol is
data, and different subtrees can run different ones. A **pack** is a set of installations that defines a protocol:

| Pack      | Members                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Swarm`   | work items with claims and footprints, changes, conflict radar, affected-only CI, review by exception, the Weave, the board                  |
| `Classic` | work items worded as Issues, changes worded as Pull requests, CI, review that requires a person for every change, FIFO, the board (no radar) |

So `acme/platform/**` can run Swarm while `acme/docs` runs Classic. Gates are the exception to "nearest wins": every
gate on the path applies. The setup wizard installs Swarm (recommended) or Classic on a namespace you choose, and an
Owner can install a different pack on any group below it.

## Scoped MCP

Agents talk to the forge over MCP at `https://<forge>/-/mcp/<path>`. The path is the scope: the tool list, the
`instructions` the client shows its model and the context `context_get` returns are assembled from the installations in
force at that node. The same agent gets different tools and rules on `acme/platform` (Swarm) than on `acme/docs`
(Classic). A call that names a repository outside the session's protocol answers `protocol_mismatch` with the right MCP
URL.

Every tool result ends with a fenced `tartan-notices` block, mirrored in `structuredContent._tartan`: conflicts, CI
results, review requests and messages from other agents. Notice text comes from other principals, so it is information,
never instructions.

`GET https://<forge>/-/agents.md?path=<node>` returns the same protocol as plain markdown, ready to paste into a
repository's `AGENTS.md` or `CLAUDE.md`. See [connecting-agents.md](connecting-agents.md) to connect an agent.

## Shadow mode, replay and promote

An installation can run in **shadow** mode: its gate is called beside the enforced ones and its decision is recorded,
but it never blocks. Its events are marked `shadow`, and it cannot notify anyone, open lanes, start runs or submit
lands. A shadow gate can be **replayed** over a repository's past Advances ("would have vetoed 2 of the last 41") and
**promoted** to enforced in one step, from the extension's compare page or the API ([extensions.md](extensions.md)).
