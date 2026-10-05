# Tartan design overview

This is the long-form description of how Tartan is built: its components, data model, identity, lanes, the
git gateway, coordination (radar, the Weave, Advances), provenance, CI, the extension model, repository config and
the security model. [`README.md`](README.md) is the short design summary, [`../architecture.md`](../architecture.md)
is the one-page overview, and `packages/contract` is the source of truth for names, types and signatures. Where this
document and the contract disagree, the contract wins.

The document describes what the code on the default branch does. Where a part is designed but not built yet, or is
built but switched off by default, the text says so; [Planned work](#planned-work) collects those items.

For the agent workflow, read [The agent loop](#the-agent-loop), [Conflict radar](#conflict-radar),
[The Weave queue and Advances](#the-weave-queue-and-advances) and [Why-notes and provenance](#why-notes-and-provenance).

## What Tartan is

Tartan is a git forge that you deploy into your own Cloudflare account. One deployment is one forge: one Worker,
one configuration file, one container image, your domain and your OIDC identity provider.

Its kernel knows nothing about issues, pull requests, review or merge queues. The kernel owns only what security and
accountability depend on:

- identity: people, agents and extension installations, and one OIDC identity provider per forge;
- an unbounded hierarchy of users, groups and repositories, with inherited roles and inherited installations;
- repositories in Cloudflare Artifacts, and **lanes**: one per unit of work, owned by one principal;
- the git gateway, the only path by which a person or an agent moves a ref;
- an ordered, causal, hash-chained event log per repository;
- a capability broker (`KernelCaps`) and an extension host;
- a durable job executor (Workflows and Sandbox containers) and a monorepo planner;
- **the Advance**, the only way a protected branch moves: compare-and-swap, gates that cannot be removed below the
  node that installed them, a required reason chain, and a kernel-written why note on every landed commit.

Everything people think of as "the forge" is an extension on one public contract, installed on a node of the
hierarchy: work items (issues), changes (the reviewable unit, shown as pull requests in the Classic pack), conflict
radar, CI policy, review, the Weave and FIFO merge queues, boards, epics, the HUD, and third-party policies written in
Rust and compiled to WebAssembly. First-party extensions use exactly the contract that third-party ones use.

Because installations attach to nodes and the nearest provider of an interface wins, the coordination protocol is
data, and it can differ per subtree. `acme/platform/**` can run the Swarm pack (claims with footprints, lanes, radar,
review by exception, the Weave) while `acme/docs` runs the Classic pack (issues, pull requests, a person approves
every change, FIFO). An agent learns the protocol in force from the forge itself: the MCP instructions, the tool list
and `context_get` are assembled from the installations at the agent's scope.

Five questions shape the design, and each has a mechanism:

| Question                                        | Mechanism                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do agents know what others are doing?       | claim footprints, `conflicts_check`, [conflict radar](#conflict-radar) on every lane push, [notices appended to every MCP tool result](#every-result-carries-attention-data), the live Lanes view and the HUD |
| What happens when changes conflict?             | [radar](#conflict-radar) records predicted conflicts during the work; at land time [the queue](#the-weave-queue-and-advances) composes candidates with real `git merge-tree` and ejects a conflicting change |
| How do you review everything?                   | [review by exception](#first-party-extensions) with a risk score, [policy read from trunk](#repository-config-in-cue), [gates](#gates) on every Advance, and gates that can run in shadow, be replayed against history and promoted |
| How do you track why a change was made?         | the reason chain of every [Advance](#the-advance), kernel-written commit trailers, a [why note](#the-why-note) per landed commit in `refs/notes/tartan`, and the [Why-blame view](#reading-provenance) |
| How do you compare changes and pick what ships? | each change carries its CI, radar record, review risk and revisions; the [`queue@1` provider](#queue1-providers) decides order, and the Advance records why |

## Components

```
 Browser (SPA)           MCP clients (Claude Code, Codex, …)            git CLI
   │ session cookie        │ agent token (MCP and git)                     │ personal access or agent token
   ▼                       ▼                                               ▼
┌──────────────────────────── Worker tartan-<stage>  (your domain) ─────────────────────────────┐
│ router: /-/health /-/setup /-/auth /-/api /-/live /-/mcp /-/cap /.well-known/tartan.json       │
│         /<repo>.git/…  /<repo>/-/lanes/<laneId>.git/…  everything else → the SPA's assets      │
│ identity · authorization · CSRF · git gateway (ref policy, push recording) · MCP host · slots  │
│ entrypoints: KernelCaps (extension capabilities) · RepoProbe (diffs, project graph) · ExtTail   │
└──────┬─────────────┬───────────────┬────────────────┬────────────────┬───────────────┬────────┘
       ▼             ▼               ▼                ▼                ▼               ▼
   ForgeDO       RepoDO per      InboxDO per      ExtensionDO per   Workflows:      BusDO
   identity,     repository:     principal:       installation      Run, Land,      global log
   hierarchy,    refs, push log, notices,         scope: the        Ingest, Swarm   consumer
   registry,     lanes, events,  presence,        extension's code      │
   audit         advances, runs  long-poll        and tables            ▼
                     │                                            TartanSandbox containers
                     └── relay ──► K2 stream (optional)            (CI jobs, merge-tree, notes)

   Artifacts namespace tartan-<stage>: canonical repositories r-<id>, lane repositories l-<id>-<lane>
   R2 tartan-<stage>-blobs: job logs, extension packages, diffs · KV · Worker Loader · Workers AI
```

### Resources

One Worker, six Durable Object classes, four Workflows, one Artifacts namespace, one R2 bucket, one KV namespace,
Worker Loader, Workers AI and static assets; with the global event log switched on, also a K2 stream and a Secrets
Store binding for its consume token. There is no D1 database, no Queue and no second Worker.

| Unit             | Kind                          | Responsibility                                                                                                                                            |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker           | `fetch` and `scheduled`       | the single front door: routing, security headers, CSRF, authentication, the git gateway, the MCP host, the slot and action API, the setup wizard, the SPA |
| `ForgeDO`        | Durable Object, one per forge | setup state, the identity provider, sealed keys, principals, sessions and tokens, the hierarchy and its grants, the extension registry, audit             |
| `RepoDO`         | one per repository            | the ref index, the push log, lanes and their policy, the event log, advances, runs and jobs, the project-graph cache, repository config state             |
| `InboxDO`        | one per principal             | notices (radar, ejections, review requests, messages), delivery and acknowledgement, presence, long-poll waiters                                          |
| `ExtensionDO`    | one per installation scope    | runs one installation's code, holds its tables, drives its event cursor, retries, dead letters, timers, render cache and circuit breaker                  |
| `BusDO`          | one per consumer shard        | the consumer of the global event log: cursor, dedupe, retries and dead letters (only with the K2 log switched on)                                         |
| `TartanSandbox`  | container-enabled DO          | real git and real toolchains: CI jobs, `merge-tree` composition, notes, pushes with a lease                                                               |
| `RunWorkflow`    | Workflow                      | durable job graphs: register (superseding older runs of the same change) → acquire a job slot → start the sandbox job → wait → finish                     |
| `LandWorkflow`   | Workflow                      | the Advance pipeline, the only code path that moves trunk                                                                                                 |
| `IngestWorkflow` | Workflow                      | runs for every Artifacts push event and reconciles it with the push log (a backstop for writes that did not come through the gateway)                     |
| `SwarmWorkflow`  | Workflow                      | simulated agents driven through the same MCP and git HTTP paths as real agents (dev stages only)                                                          |
| `KernelCaps`     | `WorkerEntrypoint`            | the capability surface extensions call; every call re-checks the installation's grants against the acting principal                                       |
| `RepoProbe`      | `WorkerEntrypoint`            | CPU-heavy, cacheable git reads: lane ranges, tree diffs, hunks, three-way merges, the project graph, affected sets                                        |
| `ExtTail`        | `WorkerEntrypoint`            | collects logs of `js` and `wasm` extensions into each installation's console                                                                              |

Workflow instance ids are deterministic (`run-<repo>-<run>`, `land-<repo>-<batch>`), so creating an instance twice
finds the first one, and every step reads persisted state or the remote first, so a retry after a crash, an eviction
or a redeploy never repeats a side effect.

### Who may write what

- **ForgeDO** is the only writer of identity, the hierarchy, grants and the extension registry. Each change bumps a
  version counter in the same transaction, so isolates can cache reads keyed by those counters.
- **RepoDO** is the only writer of refs, the push log, lanes, events, advances and runs for its repository. It never
  runs extension code; it appends events and wakes subscribers.
- **ExtensionDO** is the only writer of its extension's tables. It reaches the kernel only through `KernelCaps`, and
  other extensions only through events or granted interface calls.
- **The git gateway is the only path by which a person or an agent moves a ref.** It maps each principal to what it
  may write, refuses the rest, and records every push before it forwards it.
- **LandWorkflow is the only way trunk moves.** Kernel git jobs are the only writers of protected branches,
  `refs/tartan/*` and `refs/notes/tartan`, and each one registers its intent before it pushes, so an observed change
  that no intent explains is detected.
- **No person, agent or extension holds an Artifacts credential.** The kernel mints short-lived upstream tokens per
  operation, each scoped to the one repository it touches.

The git gateway, the MCP host and the SPA run inside the Worker and share its origin; each has its own section below.

### The Sandbox runner

`TartanSandbox` runs one container image, built from `containers/runner/Dockerfile` on the Cloudflare Sandbox base
image with git 2.55.0, pnpm 10.34.6 and the `cue` CLI v0.17.1 added at pinned versions. It runs CI jobs, the
Advance's git work (`merge-tree`, commit, notes, pushes with a lease) and repository config evaluation. Inside the
container, processes that parse repository content run as one unprivileged user with read tokens only; a process that
holds a write token runs as a second user, and the first user's processes are stopped before it starts. Tokens are
passed per command and never stored. A forge can be deployed without containers (`--no-containers`); CI and landing
then report "unavailable", and repository config cannot be switched on.

### Scheduled work

A cron trigger runs every five minutes: lane garbage collection and lane seeding sweeps, ref reconciliation for
canonical and lane repositories, event retention, identity-provider metadata refresh, and backstops for any Workflow
instance that should exist but does not. Archived repositories are swept once a day.

## Data model and hierarchy

All state lives in Durable Object SQLite, written with raw SQL and typed row mappers. Identifiers are lowercase ULIDs.
Each module owns a fixed range of migration numbers in each Durable Object, and modules never touch each other's
tables; calls inside one object go through each module's synchronous internal API.

### The hierarchy

The hierarchy is a tree of nodes. A node is a **user** (a root namespace), a **group** (a root or nested) or a
**repository** (never a root). There is no depth limit.

```
acme                         group (root)
├── platform                 group            ← Swarm pack installed here
│   ├── edge                 group
│   │   └── router           repository       → acme/platform/edge/router
│   └── api                  repository
└── docs                     repository       ← Classic pack installed here
alice                        user (root)
└── notes                    repository
```

- Each node stores its full path (`acme/platform/edge/router`), so a node's ancestors are the prefixes of its path,
  and a subtree is one range scan. Slugs are lowercase letters, digits and `-`, 1 to 64 characters. Users and groups
  share one root slug space, and a short list of root slugs is reserved (`-`, `api`, `mcp`, `admin`, `settings`, …).
- A move or rename rewrites the subtree's paths in one transaction and leaves a redirect, so old URLs answer `301` and
  git follows them. A repository's Artifacts name never changes, so moves never touch storage.
- Roles are granted on nodes and inherited downward. A grant can raise a role below, never lower it.
- Installations, gates and protected-ref patterns attach to nodes and apply to their subtrees.
- Visibility is `private` (grants only), `internal` (every signed-in user reads) or `public` (anonymous read).

### Stores

| Store                                | Holds                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ForgeDO` (`forge`)                  | setup state, identity-provider configuration, sealed keys, principals, identities, sessions, tokens, invites, nodes, redirects, grants, protected refs, packages, installations, contributions, forge events, audit, job slots               |
| `RepoDO` (`repo:<repoId>`)           | the ref index, the trunk commit set, lanes, the push log (canonical and lane repositories), kernel write intents, the event log and its checkpoints, land batches, advances, runs and jobs, the project-graph cache, repository config state |
| `InboxDO` (`inbox:<principalId>`)    | notices, delivery and acknowledgement state, presence                                                                                                                                                                                        |
| `ExtensionDO` (`ext:<inst>:<scope>`) | host tables (cursors, dedupe, retries, dead letters, timers, render cache, console, breaker) and the extension's own tables                                                                                                                  |
| `BusDO` (`bus:<group>:<n>`)          | the global log consumer's cursor, dedupe, retries and dead letters                                                                                                                                                                           |
| Artifacts `tartan-<stage>`           | canonical repositories `r-<repoUlid>` and lane repositories `l-<repoUlid>-<laneUlid>`                                                                                                                                                        |
| R2 `tartan-<stage>-blobs`            | job logs, extension packages, push diffs and other immutable caches                                                                                                                                                                          |

### Migration ranges

| Durable Object | Module ranges                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every object   | common tables (`_migrations`, `meta`, `_timers`, rate limits): 1–99                                                                                           |
| `ForgeDO`      | identity 100–199 · tree 200–299 · registry 300–399 · forge events and audit 400–449 · job slots 450–499 · reserved 500–549 · global log relay 550–569         |
| `RepoDO`       | core: refs, pushes, lanes 100–199 · events 200–249 · probe cache 250–299 · runs 300–349 · land 350–399 · repository config 400–429 · global log relay 460–479 |
| `InboxDO`      | 100–199                                                                                                                                                       |
| `BusDO`        | 100–199                                                                                                                                                       |
| `ExtensionDO`  | host tables 1–99 in `_migrations`; the extension's own migrations 1–999 in `_ext_migrations`                                                                  |

A Durable Object has one alarm, so no module sets it directly: every module registers timers with a shared `timers`
API that keeps the alarm at the earliest due time and dispatches to each module with its own error handling.

Ids are lowercase ULIDs with a prefix where a kind must be visible: principals `u_` (user), `a_` (agent), `x_`
(extension) and `sys_kernel`, installations `i_`, lanes `ln_`, Advances `adv_<batch>_<attempt>`. A repository's id is
its node's id. URLs are `/<path>` for a node, `/<repo>/-/<view>` for repository views, `/<repo>.git` for git and
`/<repo>/-/lanes/<laneId>.git` for a lane remote.

### Events

Every kernel state change appends exactly one event to its repository's log in the same transaction. An event is an
envelope:

```jsonc
{
	"id": "01k6…", "seq": 4182, "stream": "repo:01k6…", "type": "changes.submitted", "v": 1,
	"source": { "kind": "installation", "id": "i_01k6…", "ext": "tartan.changes@0.1.0" },
	"actor": { "kind": "agent", "id": "a_01k6…", "onBehalfOf": "u_01k6…" },
	"node": "01k6…", "repo": "01k6…", "subject": { "kind": "change", "id": "zkqv…" },
	"causedBy": "01k6…", "correlation": "work:acme/platform/router#42", "depth": 2, "shadow": false,
	"at": 1790000000000, "hash": "9f2c…", "data": { "laneId": "ln_01k6…", "head": "9fa…", "revision": 1 }
}
```

- `seq` is strictly increasing per repository. `hash` is SHA-256 over the previous hash and the canonical row, so the
  log is a hash chain; a checkpoint every 1,000 events keeps it verifiable after old events are pruned.
- `causedBy`, `correlation` and `depth` make the log causal. Depth is at most 8.
- Kernel namespaces are reserved: `node.*`, `principal.*`, `repo.*`, `push.*`, `ref.*`, `lane.*`, `land.*`,
  `advance.*`, `run.*`, `gate.*`, `presence.*`, `extension.*`. An extension may emit its own `x.<extId>.*` events and
  the events of interfaces it provides, validated against their schemas.
- Side effects outside the object (creating a Workflow instance, creating or deleting a lane repository) are written as
  intents in the same transaction and completed by an idempotent sweeper, so the log doubles as an outbox.
- Events are kept for 30 days (simulated-agent events for 24 hours). Events named in an Advance's reason chain are
  pinned and kept.
- Forge-wide events (`node.*`, `principal.*`, `extension.*`, `repo.created`) live in ForgeDO's forge stream.

## Identity

### One identity provider per forge

Each forge trusts exactly one OIDC identity provider, chosen in the setup wizard. Tartan is a relying party only: it
requests no refresh tokens and keeps its own sessions. The wizard runs: unlock → environment checks → forge name and
origin → identity provider → claim → protocol pack and first content.

1. **Unlock.** The deploy generates a single-use setup token and prints the setup URL
   (`https://<host>/-/setup#t=<token>`) once; the token is in the URL fragment, so it never reaches a server log.
   Without a setup token, the forge writes a single-use claim code to Workers Logs instead, and until the forge is
   claimed anyone who can read the account's Workers Logs can claim it. A used token is never accepted again.
2. **Discover.** The wizard fetches the issuer's metadata through the outbound validator (HTTPS only, no private
   addresses) and requires an exact issuer match and PKCE S256 support.
3. **Register.** When the provider has a registration endpoint, the wizard registers Tartan by Dynamic Client
   Registration (RFC 7591) as a **public client using PKCE** with no client secret, and stores what the registration
   response says. Without one, the owner pastes a client id; a confidential client works with
   `OIDC_CLIENT_SECRET`. `OIDC_ISSUER` and `OIDC_CLIENT_ID` can pre-fill and lock this step.
4. **Claim.** The first sign-in through the wizard becomes the forge **Owner** and gets a root user namespace.
5. **Destroy.** `deno task destroy` deletes a dynamically registered client (RFC 7592).

Recovery uses a new setup token value (a used one is refused) or a single-use recovery code; a recovered forge shows
a banner for 7 days. If the issuer changes, other users are relinked by explicit per-user invites, never by email.

### Sign-in

The login flow uses `state`, `nonce`, PKCE S256 and a browser-binding cookie, checks the RFC 9207 `iss` parameter
when the provider advertises it, and verifies the ID token signature. An identity is keyed by `(issuer, sub)`.
A new identity becomes a principal only through a single-use invite link (7 days, created by a Maintainer or above of
the target node) or, if the Owner turned it on, just-in-time provisioning for allowed email domains with a verified
email. Accounts are never linked by email.

Sessions are `__Host-tartan-session` cookies: an opaque 256-bit value stored as its SHA-256, idle expiry 12 hours,
absolute expiry 7 days. Cookies serve the SPA only; git and MCP never accept them.

### Roles and grants

| Role       | Value | May                                                                                                |
| ---------- | ----- | -------------------------------------------------------------------------------------------------- |
| Guest      | 10    | see public and internal metadata                                                                   |
| Reporter   | 20    | read code, lanes and the attic; comment                                                            |
| Developer  | 30    | push non-protected branches (people), claim work, open lanes, submit changes                       |
| Maintainer | 40    | approve changes routed to a person, push tags, install extensions at the node, sign off policy     |
| Owner      | 50    | grants, deletes, transfers, installs that hold `land` or provide `checks@1`, `review@1`, `queue@1` |

A principal's effective role at a node is the highest grant on the node and its ancestors. The forge Owner always
has the Owner role on every root, so a broken grant cannot lock the Owner out.

### Tokens

| Credential            | Format   | Lifetime                      | Bounds                                                                                                                              |
| --------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Personal access token | `tpat_…` | up to 1 year, expiry required | scopes, an optional node subtree, a role ceiling                                                                                    |
| Agent token           | `tagt_…` | 7 days by default, 30 at most | scopes (default `repo:read`, `repo:write`, `lanes`, `mcp`), a node subtree, a role ceiling (default Developer)                      |

An agent is its own principal (`a_…`) with an accountable owner, the person who created it. Its tool and model labels
are self-asserted and shown as such. Its effective role is the lower of its grants (or its owner's role) and the
token's ceiling, inside the token's node subtree and scopes. Whatever the role, an agent's git writes are limited to
its own lanes, and agents never change grants, settings or installations.

Tokens are stored as SHA-256, looked up through a short isolate cache, and a revocation takes effect within a minute.
Tokens are accepted in an `Authorization` header only, never in a query string or a cookie.

OAuth 2.1 for MCP clients, with a delegation consent screen, is planned; today MCP clients use agent tokens or
personal access tokens.

## Lanes

**Lanes are per-agent Artifacts repositories created with `import()`, with branch lanes as the fallback.**

A lane is one unit of work's place to push. It belongs to one principal; only that principal and the delegates it
lists can move it. A lane records its owner, the work item it serves, a footprint (the projects and path prefixes the
owner declared), its base and head, and a lease.

### Two backends behind one interface

```
                           canonical repository r-<repo>
                           refs/heads/main (trunk, written only by the Advance)
                                   │
          ┌────────────────────────┼─────────────────────────────┐
          │ import() at the base   │ import() at the base        │ branch lane (fallback)
          ▼                        ▼                             ▼
   lane repository           lane repository            refs/heads/lanes/ln_C
   l-<repo>-<ln_A>           l-<repo>-<ln_B>            in the canonical repository
   main ◄── agent A          main ◄── agent B           ◄── agent C
```

**Lane repositories.** Each lane is its own Artifacts repository `l-<repoUlid>-<laneUlid>`, reached through the lane
remote `https://<host>/<repo>/-/lanes/<laneId>.git`, whose only writable ref is `refs/heads/main`. Opening a lane
records it as `opening`, then the kernel's seeder creates the lane repository with `import()` from a capability URL
that the gateway serves for trunk at the lane's base. The capability URL is read-only, names one lane and one seed
attempt, carries an HMAC-SHA256 over every path segment (verified in the isolate before any Durable Object call),
expires after 120 seconds, accepts one pack request, and is redacted in every log, event and view. The kernel then
verifies the new repository by SHA and marks the lane `open`. A lane push goes through the gateway's lane remote and
is forwarded with an upstream token scoped to that one lane repository, so a lane push cannot reach trunk or another
lane whatever the policy decided: a second isolation layer under the ref policy.

**Branch lanes.** A branch lane is `refs/heads/lanes/<laneId>` in the canonical repository, pushed through the
repository's own git URL. Opening one is a row in RepoDO; the ref appears on the owner's first push. The gateway's ref
policy is the isolation boundary. Branch lanes are hidden from default ref advertisements; a member can still list or
fetch them by explicit prefix.

**Choosing the backend.** The forge's lane mode (`import` or `branch`) is set at deploy time (`deploy --lane-mode`),
and an Owner can override it per repository. The compiled default is `branch`, so a forge uses lane repositories once
it is deployed with `--lane-mode import` or a repository is switched. A lane can fall back to a branch lane on the
same lane id, and `lane.opened` records the backend it got. An Owner can run a lane self-test
(`POST /-/api/admin/selftest/lanes`) that opens and deletes one scratch lane repository through the normal path.

### Lifecycle

```
opening ─► open ─► submitted ─► landing ─► landed ─► closed ─► deleted (24 h after close)
             ▲         │  ▲          │
             └─────────┘  └──────────┘
        change abandoned   batch ended without this change (ejected or failed)

open or submitted ── lease expires ──► lost      (its owner can resume it for 24 h)
open or submitted ── archive ────────► archived  (readable for the attic retention, then deleted)
```

Only lane repositories pass through `opening`; a branch lane opens directly. A push to a submitted lane adds a
revision to its change and keeps the lane `submitted`.

- **Lease.** 30 minutes, renewed by pushes and lane-scoped MCP activity.
- **Range.** A lane's diff is always the range from its merge base with trunk to its head, found by a bounded walk
  over the kernel's set of trunk commits. Radar, changes, review and CI all read that range, so they stay correct after
  trunk moves and after the owner rebases.
- **Landing freeze.** While a lane's change is in a batch that is landing, pushes to it and server-side syncs are
  refused (`lane-landing`), so the head that was approved is the head that lands.
- **Quarantine.** If a lane's head changes in a way that no gateway push or registered kernel write explains, the lane
  is quarantined: it cannot be submitted or landed until its owner pushes again.
- **Garbage collection.** 24 hours after a lane closes, the cron deletes its lane repository (or its branch ref). The
  landed head stays fetchable at `refs/tartan/changes/<changeId>` in the canonical repository. An archived lane stays
  readable for the repository's attic retention (1 to 30 days, default 7).
- **Adopted branches.** A person's ordinary branch becomes a lane when a change is opened from it
  (`changes_open {sourceRef}`); from then on it is owner-confined like any lane.

### The lane handle

Every tool that opens or returns a lane returns the same handle, so an agent never has to know which backend it got:

```jsonc
{
	"id": "ln_01k6…", "mode": "repo", "state": "open",
	"remote": "https://git.example.com/acme/platform/router/-/lanes/ln_01k6….git",
	"ref": "refs/heads/main", "branch": "lanes/ln_01k6…", "base": "<sha>",
	"git": {
		"start": "git fetch https://…/-/lanes/ln_01k6….git main && git switch -c lanes/ln_01k6… FETCH_HEAD",
		"push": "git push https://…/-/lanes/ln_01k6….git HEAD:refs/heads/main"
	}
}
```

For a branch lane, `remote` is the repository's git URL, `ref` is `refs/heads/lanes/<laneId>`, and the commands fetch
from and push to `origin`. The MCP host waits up to 20 seconds for a lane that is still `opening`; if it is still
opening, the handle comes back without `git` commands and the agent polls `lanes_get`.

## The git gateway and ref policy

### Requests

```
git client ─► host check ─► route match ─► authenticate ─► authorize (view) ─┬─► upload-pack: filter refs, check wants, stream
                                                                             └─► receive-pack: size check ─► strict parser
                                                                                   ─► ref policy ─► forward with a scoped token
                                                                                   ─► relay ─► record (phase 1, then phase 2)
```

1. **Host and route.** Git is served only on the forge's canonical host (any other host gets `403` with the canonical
   URL, so credentials go to one origin). A lane remote matches first, then the canonical repository, by longest path
   prefix; moved repositories answer `301`.
2. **Authenticate and authorize.** Basic (any user name, a `tpat_` or `tagt_` password) or `Authorization: Bearer`;
   never cookies. Reporter or above gets the member view; on a public repository everyone else gets the public view,
   and lane remotes have no public view. Pushing needs Developer or above and a token with the `lanes` or
   `repo:write` scope; the ref policy then decides each command.
3. **Upload-pack.** Advertisements are filtered to the caller's view: hidden namespaces (`refs/heads/lanes/`,
   `refs/tartan/`) appear only when a member asks for them by prefix. Capability lists are rewritten to an allowlist
   for every caller. Public-view requests pass a fail-closed parser, and every `want` must be a visible tip (current,
   or one a visible ref held in the last 10 minutes).
4. **Receive-pack.** The gateway checks the declared body size against `TARTAN_MAX_PUSH_MB` before contacting
   upstream, then parses the command section strictly: well-formed pkt-lines, valid ref names, at most 1,000 commands
   (8 for agents), allowlisted capabilities only; anything unexpected rejects the push as a whole. One RPC to RepoDO
   returns the caller's lanes, the target lane, protected patterns and existing refs, and pure policy functions
   classify every command (table below).
5. **Forward.** An accepted push streams to Artifacts with an upstream token scoped to the one repository the URL
   names. On the canonical repository, an agent with no active branch lane there is refused before any write token is
   minted.
6. **Record.** As soon as the upstream report is parsed, RepoDO records the push (phase 1, no I/O) and emits
   `push.accepted`; the gateway releases the final packet only after that, so the pusher's next tool call sees its own
   push. Then `RepoProbe` computes the lane range and its diff (phase 2), stores it in R2, and RepoDO emits
   `push.diffed` with the paths and up to 20 commits. Radar, changes, review and CI all read that one diff.
7. **Backstop.** `IngestWorkflow` runs for every push event from Artifacts and the five-minute cron reconciles the
   ref index. A ref change that matches a recorded push or a registered kernel write is merged into it; one that does
   not is parked, re-checked after a grace window, and then treated as tampering (see the principles).

### Ref policy

| Target                                                                                                                    | Who may write                                                                                                                   | Refusal reason                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| protected branches (each repository's default branch always), `refs/tartan/*`, `refs/notes/tartan`, `refs/heads/tartan/*` | the kernel only                                                                                                                 | `woven-by-tartan`, `kernel-only`                                            |
| a lane's head (its lane repository's `main`, or `refs/heads/lanes/<id>`)                                                  | its owner or a delegate, while the lane is active and neither `opening` nor `landing`, from the `old` value the kernel recorded | `not-your-lane`, `lane-opening`, `lane-landing`, `lane-closed`, `stale-old` |
| any other ref of a lane repository                                                                                        | nobody                                                                                                                          | `lane-main-only`                                                            |
| other branches of the canonical repository                                                                                | people with Developer or above; never agents                                                                                    | `agents-lanes-only`                                                         |
| tags                                                                                                                      | Maintainer or above; never agents                                                                                               | `tags-maintainer`                                                           |
| reserved parents (`refs/heads/lanes`, `refs/tartan`, …) and case variants of existing or protected refs                   | nobody                                                                                                                          | `reserved-parent`, `case-collision`                                         |
| deleting a lane's ref                                                                                                     | nobody through git                                                                                                              | `use-lanes-close`                                                           |

A rejection is a synthesized receive-pack response, not an HTTP error: every command gets an `ng` line with its reason,
nothing is forwarded upstream, no write token is minted, and the rejection is recorded (`push.rejected`). Stock git
prints it as `! [remote rejected] main -> main (woven-by-tartan)`. A push that mixes allowed and refused refs is
refused as a whole. The full reason list is `REF_POLICY_REASONS` in the contract.

The gateway can also add `remote:` guidance lines to a refused push (the exact lane push command), behind the
compile-time switch `ECHO_ENABLED` in `src/constants.ts`, which is **off**: with it off, a refused push carries its
reason code only, and agents get the same information from MCP notices and lane handles. Echo lines from extensions on
an accepted push (radar results, gate findings) are planned.

### Import mode

An Owner can create a repository in import mode for history that is private or larger than one push. While a
repository is importing, only the Owner may push (people's tokens only, never an agent's), there are no lanes, no
protection and no landing, and the push size limit still applies to each push. Completing the import seeds the ref
index and the trunk commit set and turns protection and lanes on. Public repositories can also be imported from a URL.

## The agent loop

On a repository running the Swarm pack, one unit of agent work goes through ten steps. Every step is an event in the
repository's log.

```
 claim ─► lane ─► push ─► radar ─► submit ─► CI ─► review ─► Weave ─► Advance ─► why note
```

| Step     | Who                                    | What happens                                                                                                                                           | Events                                              |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| claim    | agent → `tartan.work` (`work@1`)       | `work_claim {ref, footprint, plan}` claims a work item; the response lists overlapping in-flight work with a suggestion                                | `work.claimed`                                      |
| lane     | `tartan.work` → kernel                 | the kernel opens a lane for the claimant (lane caps and `lane.open` gates apply) and returns the lane handle                                           | `lane.opening`, `lane.opened`                       |
| push     | agent → gateway                        | the agent pushes its lane with stock git; the gateway records the push and its lane-range diff                                                         | `push.accepted`, `push.diffed`                      |
| radar    | `tartan.radar` (`conflicts@1`)         | the lane's touches are joined against every active lane and recent landings; both owners get notices                                                   | `conflicts.detected`, `conflicts.cleared`           |
| submit   | agent → `tartan.changes` (`changes@1`) | `changes_submit` creates a change revision bound to the lane's current head and base; later pushes add revisions                                       | `changes.submitted`, `changes.revised`              |
| CI       | `tartan.ci` (`checks@1`)               | plans jobs for the affected projects from the pipeline at the change's base on trunk, reuses cached successes, runs the rest in containers             | `run.*`, `checks.updated`, `checks.completed`       |
| review   | `tartan.review` (`review@1`)           | scores risk; approves low-risk changes automatically and routes the rest to a person with an evidence bundle                                           | `review.requested`, `review.decided`                |
| Weave    | `tartan.weave` (`queue@1`)             | enqueues the approved head, forms a batch and submits it for landing with its reason chain                                                             | `queue.enqueued`, `queue.batched`, `land.submitted` |
| Advance  | kernel (`LandWorkflow`)                | composes, gates, tests, locks and pushes trunk with compare-and-swap                                                                                   | `land.*`, `ref.advanced`, `changes.landed`          |
| why note | kernel                                 | writes trailers and a note per landed commit; the work item is done, the lane closes, radar raises `trunk_drift` for lanes that touch the landed paths | `work.done`, `lane.closed`                          |

The agent needs no Tartan-specific client: an MCP client and stock git are enough. On a repository running the
Classic pack the same kernel runs a different protocol: a change is opened from a lane or a branch, a person approves
every change, and FIFO lands one change at a time.

## Conflict radar

`tartan.radar` provides `conflicts@1`. It predicts conflicts while the work happens, records each one, and tells both
parties through the channels they already watch. It never blocks a push or a land.

Radar reads three inputs: the **footprints** declared at claim time (projects and path prefixes); each lane's
**touches**, its cumulative lane-range diff from `push.diffed`, with every path mapped to a project by the longest
matching project root (a later push replaces them, and after a rebase the paths that already landed drop out); and
**landings** (`ref.advanced`), for trunk drift.

### Grades

| Severity       | Meaning                                                                         | Produced today |
| -------------- | ------------------------------------------------------------------------------- | -------------- |
| `declared`     | two footprints overlap, or one lane's footprint covers the other lane's touches | yes            |
| `same_project` | both lanes touch the same project, no shared file                               | yes            |
| `same_file`    | both lanes touch the same path                                                  | yes            |
| `trunk_drift`  | a change that landed after the lane's base touched the lane's paths             | yes            |
| `adjacent`     | both lanes edit hunks within a few lines of each other                          | planned        |
| `textual`      | a three-way merge of the two lanes conflicts                                    | planned        |
| `semantic`     | an extension-supplied judgement                                                 | planned        |

Pairs of stacked lanes (one lane's range carries the other's head) are not reported. Each conflict carries a
suggestion: `proceed`, `coordinate`, `stack`, `rebase` or `yield`.

### Delivery

| Channel           | What the agent or person sees                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claim response    | overlapping in-flight work, with the other work item's title, why, agent and a suggestion                                                                               |
| `conflicts_check` | "if I edit these paths, whom do I collide with?", from footprints and live touches                                                                                      |
| MCP notices       | the other party's next tool result, whatever the tool, carries the notice in a fenced `tartan-notices` block and in `structuredContent._tartan`                         |
| inbox             | `inbox_read`, `inbox_wait` (long poll up to 25 s), `inbox_ack`; `inbox_send` lets agents coordinate directly                                                            |
| web UI            | the Radar tab (statistics and open conflicts), a lane badge, a file banner ("3 lanes are editing this file"), the change sidebar with acknowledge actions, a HUD metric |

Agents answer with `conflicts_ack {conflictId, resolution}` (`adapt`, `coordinate`, `rebase`, `stack`, `yield` or
`ignore`). A conflict that stops holding is cleared; if it was cleared before landing after a notice, it counts as
avoided on the HUD. Each notice carries a stable deduplication key, so a retried handler never notifies twice.

## The Weave queue and Advances

### `queue@1` providers

Two providers ship, sharing one engine (the files are kept byte-identical by a test): `tartan.weave` (Swarm pack)
enqueues on any non-shadow approval and batches up to 4 changes (its `batch` setting); `tartan.fifo` (Classic pack)
enqueues only on a person's approval and lands one change at a time.

The train is serial: one batch in flight per repository. A tick (debounced, under the installation's lock) composes
the next waiting entries into a land request, stores the request with its batch id **before** submitting it, and
submits it; a retried tick resubmits the identical request, and the kernel's idempotency on the batch id returns the
existing batch.

| Outcome                       | What the queue does                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a change conflicts at compose | ejects it (`queue.ejected`) and notifies its author with both intents, the other changes' paths and the conflict regions; the rest of the batch continues |
| a gate vetoes a change        | ejects it and notifies its author with the gate's message                                                                                                 |
| the batch fails its tests     | retries each change alone; a change that fails alone is ejected                                                                                           |
| the batch lands               | marks entries landed (`queue.landed`) and forms the next batch                                                                                            |
| a new revision is pushed      | withdraws the waiting entry approved at the older head                                                                                                    |

An Owner can swap the `queue@1` provider of a live subtree (Extensions → Swap `queue@1`). Only the provider in force
forms batches; the old one releases its waiting entries and lets an in-flight batch finish, and the new one adopts
what the event stream says is approved and not yet landed.

Planned for the Weave: partitions by affected projects with parallel sub-trains, bisection of failed batches,
resolver work items that carry both intents to any agent, and reuse of test evidence across a disjoint trunk move.

### The Advance

`caps.land.submit` is the only entry, and only the `queue@1` provider in force may call it. It is idempotent on the
caller's batch id and validates, in one RepoDO transaction:

- every lane belongs to the repository, is `submitted` and not quarantined;
- each change's head equals its lane's recorded head (`head-moved` otherwise);
- the reason chain names events in this repository's log, and holds, for every change, its submission and an
  approval by the `review@1` provider in force (or a passing human-review gate) **for that same head**;
- landing is not paused.

It then freezes the lanes (`landing`), records the batch with its intent, and creates the `LandWorkflow` instance.

```
land.submit ─► compose ─► gates ─► [config hold] ─► test ─► lock ─► restack ─► push trunk, notes, change refs ─► complete
                  │         │                         │                │
              conflict    veto                     failure        trunk moved
                  ▼         ▼                         ▼                ▼
                eject     eject                  retry alone      new attempt
```

A conflicting or vetoed change is dropped from the batch and ejected by the queue, and the rest of the batch goes on
(a veto starts a new attempt without that change). A failed test fails the batch, and the queue retries each change
alone. If trunk moved before the push, the attempt is stale and the batch starts a new attempt, at most three in all.

| Step        | Work                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compose     | in a warm sandbox mirror, fetch trunk and each lane head by SHA, `git merge-tree` and `commit-tree` one squash commit per change; record conflicts with their regions; push the candidate to `refs/tartan/candidates/<batch>` |
| gates       | run every `ref.advance` gate in force on the path from the root to the repository, with prefetched inputs (changed paths, added lines); any enforcing veto drops that change                                                  |
| config hold | with repository config on, wait (outside the lock) while a policy change of this repository is being applied                                                                                                                  |
| test        | announce `land.testing {batchId, attempt, candidateSha}` and wait for a `checks@1` verdict that echoes all three                                                                                                              |
| lock        | take the one Advance lock for the ref, under a lease                                                                                                                                                                          |
| restack     | trunk must still be the composed base, otherwise the attempt is stale and the batch is composed again; build the why notes                                                                                                    |
| push trunk  | read the remote ref: already the new value → skip; still the expected old value → push with `--force-with-lease`; anything else → stale                                                                                       |
| push notes  | the same for `refs/notes/tartan`, re-applying this Advance's notes on top if the notes tip moved                                                                                                                              |
| push refs   | `refs/tartan/changes/<changeId>` → each landed lane head                                                                                                                                                                      |
| complete    | update the ref index, record the landing, emit `ref.advanced`, close the landed lanes                                                                                                                                         |

Every push registers a kernel write intent first. Every step is retryable without repeating its effect, and a sweeper
releases a lock whose Workflow instance died, finishing the Advance itself if the push had already happened.

Each landed change becomes one squash commit on a linear trunk. Its message is composed by the kernel:

```
<title from the queue provider>

<summary from the queue provider>

Change-Id: I<40hex>
Tartan-Change: zkqv…
Tartan-Work: acme/platform/router#42
Tartan-Agent: codex-2 (codex)
Tartan-On-Behalf-Of: alice
Tartan-Review: auto(0.18)
Tartan-Advance: adv_01k6…_1
Co-authored-by: claude-1 <agent+a_01k6…@agents.git.example.com>
```

`Change-Id`, `Tartan-Agent`, `Tartan-On-Behalf-Of`, `Tartan-Advance` and `Co-authored-by` come from verified kernel
state (the push log and lane ownership); a provider trailer that spells one of those keys is dropped, and the other
trailers are checked as syntax only.

## Why-notes and provenance

Accountability does not depend on which extensions are installed: whatever provider asked for the Advance, the kernel
requires the reason chain and writes the why note.

### The why note

`refs/notes/tartan` holds one JSON document per landed commit. The kernel section is always present; extensions add
sections with `caps.notes.contribute` (up to 8 KB each):

```jsonc
{
	"v": 1,
	"kernel": {
		"advance": "adv_01k6…_1", "ref": "refs/heads/main", "batch": "lb_01k6…", "landedBy": "i_weave",
		"actor": "a_01k6…", "onBehalfOf": "u_01k6…", "change": "zkqv…", "lane": "ln_01k6…", "laneHead": "<sha>",
		"rangeBase": "<sha>", "firstPushers": [{ "principal": "a_01k6…", "commits": 3 }], "provenance": "complete",
		"reason": { "summary": "weave batch 7", "events": ["01k6…", "01k6…"] },
		"gates": [{ "ext": "acme.no-secrets@0.1.0", "decision": "allow", "mode": "enforce" }],
		"checks": { "state": "success", "runs": ["run_01k6…"], "evidenceReused": false },
		"chain": { "seq": 41822, "head": "9f2c…" }
	},
	"ext": {
		"tartan.work": { "item": "acme/platform/router#42", "title": "Per-tenant rate limiting", "why": "…" },
		"tartan.review": { "route": "auto", "risk": 0.18 }
	}
}
```

The note carries the event chain's position and head hash, so git history and the event log can be checked against
each other. Notes are ordinary git: `git fetch origin 'refs/notes/*:refs/notes/*' && git log --notes=tartan` works
with stock git on the forge's own domain.

### Reading provenance

- **`/-/api/why`** and the MCP tool **`why`** answer for a commit, or for the newest landing that touched a path: the
  change, the work item and its why, the agent, model label and on-behalf-of, the review route, the gates, and the
  reason events.
- **Advances** (`/<repo>/-/advances`) lists every Advance with its batch, attempts, gates and checks.
- **Why-blame** (`/<repo>/-/blame/<ref>/<path>`) shows, for a file, the landings that touched it and their why notes.
  Line-by-line blame is planned.
- **The commit page** shows the trailers and the note.

### Attribution

Attribution comes, strongest first, from (1) **the push log**: the gateway knows the principal, token and
on-behalf-of of every ref transition it forwards, and RepoDO records the first principal to push each commit of a
lane range, so pushing someone else's commits into your own lane shows up as a `Co-authored-by` line and a
`firstPushers` entry; (2) **lane ownership**, so even a transition seen only by the backstop is attributable;
(3) **agent commit trailers** (`Change-Id`, `Tartan-Work`), self-asserted and shown as claimed unless they match the
push log; and (4) **the landed commit**, whose trailers and why note come from verified state.

## CI

CI is Cloudflare-native: `tartan.ci` provides `checks@1`, plans job graphs, and runs them with `RunWorkflow` in
`TartanSandbox` containers.

### The pipeline

With repository config on, the pipeline is `tartan.ci`'s repo policy in the root CUE package `tartan`
(`extensions: "tartan.ci": settings: pipeline: {timeout, jobs, on, lanes}`; the
[repository config guide](../repo-config.md) has a full example). Jobs declare their dependencies (`needs`), may run
once per affected project (`each: "affected"`), and are bound to triggers (`on.change`, `on.land`, `on.push`).

Without a pipeline (or with repository config off), CI is zero-config: one test job per affected project, using the
command its manifest declares (for example `package.json` `scripts.test`). Nothing detected means success with "no
CI configured".

**Policy comes from trunk.** CI reads the pipeline, and the test scripts it would run, at the change's base on trunk,
never from the lane. A change that edits them is tested with the base definition and routed to a person by review.
Land candidates read it at their own base.

### Affected-only planning

```
changed paths (hash-pruned tree diff of the lane range)
        │
        ▼
project graph at the base ──► projects containing a changed path ──► + reverse-dependency closure ──► affected set
        │                                                                                     (a global file ⇒ all)
        ▼
input hash per (job, project) = SHA-256(job spec, image, tree hash of every project root in the closure, global file blobs)
        │
        ▼
cached success for that hash?  yes ─► "cached" check, no container      no ─► run the job
```

- A change to a global file, a project manifest or a path outside every project root affects every project (see
  [Monorepo projects](#monorepo-projects)).
- The result cache stores successes only, keyed by input hash, so a candidate whose project subtrees did not change
  reuses the lane's results.
- The same planner feeds radar's project overlap, review's blast radius, `repo_affected`, `context_get` and the
  project pages.

### Execution

- **Triggers:** a change submitted or revised, a land candidate (`land.testing`), pushes to configured branches, and a
  re-run from the UI or `checks_rerun`.
- **One sandbox per run:** a shallow checkout of the exact SHA with a read token for that one repository, then jobs in
  dependency order, independent jobs in parallel. Job state is persisted, so a Workflow retry re-attaches to a running
  job instead of restarting it.
- **Logs** stream live (redacted) to the run page and to R2. Every way a run ends (finish, timeout, cancel, supersede,
  slot expiry) destroys its container.
- **Timeouts:** 15 minutes per job by default, 60 at most.
- **Cost controls:** a forge-wide job-slot semaphore (6 concurrent by default), daily container usage counted and
  reported against a budget, supersede on new revisions, and CI on submit rather than on every lane push.
- **No pipeline secrets.** Jobs have registry access and no forge secrets.

### Dispatch through the global log

By default a queued run is dispatched inline by its RepoDO. With the K2 global log configured and
`deploy --workload-transport k2`, the queued `run.started` event is the workload request: the log's `workloads`
consumer (BusDO) asks RepoDO to dispatch it, and RepoDO's outbox dispatches it itself after a grace period if the log
is silent. Either way there is one Workflow instance per run and one `run.dispatched {via: 'k2' | 'backstop' | 'local'}`
event that records how it was dispatched. Runs fall back to inline dispatch whenever the log is unhealthy.

## The extension model

### The contract

An extension is a package with a manifest, `tartan.json`, on the contract `tartan:ext@0.1.0`. The manifest declares
the runtime, the interfaces it provides and requires, its permissions, the events it subscribes to, its storage, and
its contributions: slots, MCP tools, gates, echo lines, context sections, settings and a protocol card. Everything an
extension does goes through that declaration and the capabilities granted at install time. A shortened manifest
(`extensions/weave/tartan.json`):

```jsonc
{
	"schema": 1, "id": "tartan.weave", "version": "0.1.0", "api": "tartan:ext@0.1.0", "runtime": "builtin",
	"storage": { "scope": "repo", "migrations": ["migrations/0001_init.sql", "migrations/0002_train.sql"] },
	"provides": ["queue@1"], "requires": ["changes@1", "checks@1", "review@1"],
	"permissions": { "repo": "read", "land": ["refs/heads/*"], "notes": true, "notify": true },
	"subscribe": [{ "event": "changes.submitted" }, { "event": "review.decided" }, { "event": "land.*" }],
	"contributes": {
		"slots": [{ "slot": "change.sidebar", "id": "position", "dynamic": true, "refreshOn": ["queue.*", "land.*"] }],
		"protocol": "protocol.md"
	},
	"config": { "default": { "batch": 4, "debounceMs": 2000 }, "cue": "config/settings.cue" }
}
```

### Interfaces

| Interface     | Entity                                                                          | Tools                                                                                                 | First-party providers                                |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `work@1`      | `WorkItem` (`issue`, `intent` or `resolve`; why, acceptance, footprint, claims) | `work_list`, `work_get`, `work_create`, `work_update`, `work_claim`, `work_release`, `work_comment`   | `tartan.work`                                        |
| `changes@1`   | `Change` with revisions (head, base, affected projects, diffstat)               | `changes_open`, `changes_submit`, `changes_get`, `changes_list`, `changes_abandon`, `changes_comment` | `tartan.changes`                                     |
| `conflicts@1` | `Conflict` (two sides, path, severity, suggestion, state)                       | `conflicts_check`, `conflicts_list`, `conflicts_ack`                                                  | `tartan.radar`                                       |
| `checks@1`    | `Check` (subject, SHA, context, state, run)                                     | `checks_get`, `checks_rerun`                                                                          | `tartan.ci`                                          |
| `review@1`    | `Review` (revision, head, risk, factors, route, decision)                       | `review_get`, `review_decide`, `review_queue`                                                         | `tartan.review` (`by-exception` or `human-required`) |
| `queue@1`     | `QueueEntry` (change, position, state, batch)                                   | `queue_status`, `queue_enqueue`, `queue_withdraw`                                                     | `tartan.weave`, `tartan.fifo`                        |
| `context@1`   | multi-valued: sections for `context_get`                                        | through the kernel's `context_get`                                                                    | work, radar, review, weave, ci                       |

Consumers subscribe to interface events (`changes.*`), never to an extension id, which is what makes `tartan.weave`
and `tartan.fifo` interchangeable.

**Resolution on the hierarchy.** For a single-provider interface the **nearest** installation in `enforce` mode wins
at a node, unless an Owner **locked** an ancestor's provider, in which case nearer installs of that interface are
refused. Multi-valued contributions (gates, echo, context, slots, tools, subscriptions) accumulate from the root
down. **Gates are monotonic:** a gate installed at an ancestor applies to every descendant and cannot be disabled,
removed or shadowed below it. **Confinement:** everything an installation names (repositories, lanes, streams, nodes,
notice recipients) must resolve to its node or a descendant.

### Hooks

An extension module implements any of these entry points. Every entry point that can write runs under one lock per
installation scope, so an extension's writes are serialized; the read-only ones (`render`, `context`) may run beside
them.

| Hook       | Called when                                      | Acts as, and with what                       |
| ---------- | ------------------------------------------------ | -------------------------------------------- |
| `init`     | after migrations, on first activation or upgrade | the installation                             |
| `onEvent`  | a subscribed event is delivered                  | the installation, at its background role     |
| `onTimer`  | a timer the extension set falls due              | the installation                             |
| `gate`     | a gate point it contributes to is reached        | inputs prefetched by the host                |
| `echo`     | a push is accepted (planned on the gateway side) | inputs prefetched by the host                |
| `render`   | a slot it contributes is shown                   | the viewer, read-only (`SELECT`-only SQL)    |
| `onAction` | a button in its UI is pressed                    | the viewer, within the installation's grants |
| `callTool` | an agent calls one of its MCP tools              | the agent, within the installation's grants  |
| `context`  | `context_get` assembles a context pack           | the agent, read-only                         |

### Event delivery

Events are delivered by ordered pull, not a queue: RepoDO appends an event, matches it against the installations
subscribed at that repository, and pokes each one; the installation's ExtensionDO then reads from its own cursor,
skips ids it has seen, calls `onEvent`, and advances the cursor. Delivery is at least once with deduplication, in
order per installation scope and stream. A failing event is retried after 1 s, 5 s, 30 s, 2 minutes and 10 minutes,
then goes to the dead letters with `extension.error`; the manifest's `onError` decides whether the stream skips it
(the default) or pauses (for projections that must not have gaps). A lost poke is caught by the next one or by the
cron. `backfill` (`none`, `30d` or `all`) sets an installation's starting cursor, so a board installed today rebuilds
itself from history.

### Gates

| Point         | Called from                                                | Budget and default                                                                                                                                                |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref.advance` | every Advance, per change, from the root to the repository | 1,500 ms by default; inputs over 2,000 added lines or 256 KB are marked truncated, and a truncated input is vetoed unless the gate declares it scanned everything |
| `lane.open`   | before a lane opens                                        | 300 ms; allow on timeout                                                                                                                                          |

A gate answers `allow`, `advise` (recorded and shown) or `veto`, with a message and optional annotations, and every
decision is recorded as `gate.decided`. Any enforcing veto blocks; shadow decisions never do.

**Shadow, replay, compare, promote.** A gate (or a `review@1` routing policy) can be installed in **shadow** mode: it
runs beside the enforcing gates, and its decisions are recorded but never block. **Replay** rebuilds the gate input of
up to the last 50 Advances and runs the shadow gate on them, so the compare page can say "would have vetoed 2 of the
last 41 Advances" right after installation. **Promote** switches shadow to enforce (and the old installation to
disabled) in one transaction. Shadow installs of mutating interfaces (`queue@1`, `work@1`, …) are refused.

### Slots and `tartan-ui@1`

Extensions never send HTML or JavaScript to the browser. A dynamic slot returns a JSON document in the `tartan-ui@1`
format, which the host validates and renders with its own components.

- **Slots:** `nav.global`, `home.section`, `node.tab`, `node.section`, `repo.tab`, `repo.sidebar`,
  `repo.header.action`, `file.banner`, `lane.badge`, `lane.sidebar`, `work.panel`, `work.sidebar`, `change.tab`,
  `change.panel`, `change.sidebar`, `change.gate`, `blame.annotation`, `hud.metric`, `settings.page` and
  `agent.context`. Static contributions (tabs, navigation, header actions) render without calling the extension.
- **Node types** (35): layout (`stack`, `row`, `grid`, `section`, `card`, `tabs`, `divider`), text (`heading`,
  `text`, `markdown`, `code`, `badge`, `label`, `avatar`, `icon`, `link`, `empty`), data (`progress`, `kv`, `stat`,
  `alert`, `table`, `list`, `timeline`, `diff`, `board`, `matrix`, `sparkline`) and input (`button`, `menu`, `form`,
  `input`, `textarea`, `select`, `checkbox`).
- **Validation:** every object is closed (unknown properties fail), at most 500 nodes, 64 KB and depth 16;
  same-origin links must be paths and external links `https:`. Markdown nodes carry their source, and the SPA's own
  renderer shows it without raw HTML (no `v-html`; raw HTML shows as text). The SPA receives the validated document,
  never the extension's raw output, and a render that fails or times out becomes an error chip.
- **Rendering:** the server re-derives the slot's context from the route (client values are hints), checks the
  installation's confinement and the viewer's role, and calls `render` read-only under a 1-second budget. Results are
  cached per viewer (or per role, when a slot declares it), keyed by the extension's data version.
- **Actions:** a button posts `{action, payload}` to the slot's action route (same-origin, JSON); `onAction` returns a
  new render, a toast, a same-origin navigation or slots to refresh.
- **Live:** slots declare `refreshOn` event patterns, and the SPA re-fetches them when matching events arrive.

### Runtimes

| Runtime   | Executes                                                                                                    | Storage                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `builtin` | TypeScript in the Worker bundle, run in-process by the installation's own ExtensionDO                       | the ExtensionDO's SQLite (host tables guarded) |
| `js`      | a JavaScript bundle loaded with Worker Loader as a Dynamic Worker, one per installation and package version | its own facet SQLite                           |
| `wasm`    | a WebAssembly component on the `tartan:ext@0.1.0` WIT world (synchronous imports), loaded the same way      | its own facet SQLite, through WIT imports      |

- All twelve first-party packages (ten extensions and two packs) are `builtin`. They import only `@tartan/contract`
  and `@tartan/ext-api`, enforced by `deno task lint`, so they use exactly what third-party extensions get. The `js`
  and `wasm` runtimes are on by default (`EXT_DYNAMIC_ENABLED`).
- Dynamic Workers run with no outbound network, no bindings and no secrets in their environment. Capabilities arrive
  per call as an opaque stub that is valid only for that call. A WASM package's imports must be a subset of its
  manifest permissions, checked at publish time.
- The Rust SDK (`sdk/rust/tartan-ext`) implements the WIT world with UI builders, a SQL helper and gate decisions; see
  [`../ext/rust.md`](../ext/rust.md). `acme.no-secrets` is a Rust gate that vetoes an Advance adding a secret and shows
  masked findings in the change sidebar.
- Every call into a `js` or `wasm` extension has a host-side wall-clock timeout. A **circuit breaker** records a strike
  for a timeout, a hung call or a reset; 3 strikes in 10 minutes open it for 15 minutes, then one call is let through,
  and a further strike reopens it with a doubled cooldown (up to 4 hours). While it is open, a gate returns its
  manifest default (a security gate declared `default: "veto"` keeps vetoing), renders return the error chip and
  events wait. Owners see and reset the breaker on the installation page.
- **Kill switch:** an installation set to `disabled` is refused at once; inherited gates still cannot be disabled below
  their node.

### Capabilities

`KernelCaps` is one implementation, used in-process by builtins and through a `WorkerEntrypoint` by dynamic runtimes.
Its namespaces are `repo` (reads, diffs, hunks, three-way merges, lane ranges, the project graph, affected sets, repo
policy), `lanes` (open, adopt, get, list, close, archive, delegate, sync, restack), `land` (`submit` for `queue@1`
providers, `report` for `checks@1` providers), `runs`, `notes`, `events`, `notify`, `authz`, `principals` (never an
email address), `interfaces` (`call`, `provider`) and `timers`.

- **Two principals per call.** Background handlers act as the installation's service principal (`x_<inst>`) at its
  background role (Reporter by default). Interactive calls act as the viewer or agent, limited to the intersection of
  the installation's grants and the actor's role and scopes.
- **Approval.** A Maintainer installs at a node. Installing a provider of `checks@1`, `review@1` or `queue@1`, granting
  `land` or `land.report`, raising the background role, locking, or installing at a root needs the Owner.
- **Limits on effects.** `render` and `context` are read-only; shadow installs cannot land, open lanes, start runs or
  notify; a per-installation effects budget and the event depth limit stop feedback loops.

**Install, upgrade, storage.** A forge admin publishes a package (`PUT /-/api/packages`, at most 10 MiB; the manifest,
migrations and WASM imports are validated) and it is stored in R2 under its SHA-256. Installing shows a permission
sheet, any interface it replaces, and the mode. Activation is lazy: the first call loads the package, runs migrations,
then `init`. An upgrade asks again if permissions widen. Storage is one SQLite database per installation and scope
(`node`, or one per repository under the node for hot extensions such as radar), with a quota.

### Packs

A pack is a manifest with `"kind": "pack"` and members; installing it installs each member at the node.

| Pack                  | Members                                                                                                 | What an agent experiences                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tartan.pack.swarm`   | work, changes, radar, ci, review (`by-exception`, auto-approve below risk 0.35), weave (batch 4), board | claim with a footprint, push a lane often, read notices, submit; low-risk changes are approved automatically |
| `tartan.pack.classic` | work (as Issues), changes (as Pull requests), ci, review (`human-required`), fifo, board                | open a change; a person approves every change; FIFO lands one at a time; no radar                            |

The setup wizard installs one pack (Swarm is the suggested one) at the Owner's root namespace or a node the Owner
names; an Owner can install the other pack on any subtree. The MCP instructions at a scope are the concatenated
protocol cards (`protocol.md`) of the installations in force there, so the same agent sees different rules and tools
on different subtrees.

### First-party extensions

Besides the interface providers in the table above, the first-party set has `tartan.board` (Kanban boards rebuilt
from history), `tartan.epics` (epics across repositories) and `tartan.hud` (active lanes, predicted and avoided
conflicts, landings per hour, and changes that needed a person). `acme.no-secrets`, the Rust → WASM example, is not
installed by default and is built with `deploy --build-ext`.

**Review by exception.** `tartan.review` scores each revision from six factors: path sensitivity from the owners
rules, blast radius from the project graph, size, weakened tests, the lane's worst open conflict, and the author's
track record of ejections, vetoes and reverts. Below the threshold it approves automatically; otherwise it routes the
change to a person with the evidence. A change always goes to a person when it touches a policy file (any root `*.cue`
file), weakens tests, or cannot be scored fully. Every decision names the revision and head it judged.

## Repository config in CUE

A repository configures its CI pipeline, its review owners, its projects and some of its extensions in the CUE
package `tartan` at its root. The full guide is [`../repo-config.md`](../repo-config.md); the design and its
alternatives are in [`ADR-repo-config-cue.md`](ADR-repo-config-cue.md). Repository config is **off** unless the forge
was deployed with `--repo-config`.

- **What it is.** Every `*.cue` file directly in the repository root whose package clause is `package tartan`. Files
  of other CUE packages in the same directory are left alone. The official `cue` CLI decides which files belong to the
  package.
- **What it can set.** `projects`, `global`, and per extension either its repo policy (`tartan.ci` `pipeline`,
  `tartan.review` `owners`), an overlay of settings an Owner opened to repositories, or an install of a package an
  Owner approved. It can never install an interface provider or a pack, and never disable, shadow or reconfigure an
  inherited gate.
- **Where it runs.** `cue export` runs in a hardened sandbox job: no network, a 2 GiB address-space limit, killed after
  10 seconds. Results are cached by an input key. The kernel checks every rule again on the exported JSON; CUE's
  closedness is for authors, not the security boundary.
- **How it lands.** A change that touches any root `*.cue` file needs a sign-off by a Maintainer (or above) in the
  browser, bound to the lane head; agents, tokens and extensions cannot sign off. At most one such change lands per
  batch. After it lands, other lands of that repository wait until the new config is applied; if it fails to evaluate,
  the last good config stays in force.
- **Policy is read at the base.** CI, review and the project graph read the config in force at each change's base on
  trunk, never the lane's copy.
- **Agents can check before pushing.** `repo_config_schema` returns the forge's schema and the exact `cue export`
  command, and `repo_config_preview` evaluates a lane's root files without applying them.

## Monorepo projects

Tartan treats a repository as a set of projects, and most coordination works per project.

- **Detection.** The project graph comes from the configured `projects` in package `tartan` when there are any, else
  from workspace detectors: pnpm and npm workspaces, `deno.json` workspaces, Cargo workspaces and `go.work`. With
  `TARTAN_PROJECTS=scan` (`deploy --projects`), cuenv `#Project` definitions are read first, by a textual scan of the
  module's `env.cue` files, and the workspace detectors add edges between them. The nearest project root wins for
  nested projects.
- **Caching.** The graph is keyed by a hash of every fact detection read, so two commits with the same manifests share
  one graph.
- **Global changes.** A change to a global file (each detector's lockfiles and workspace manifests and every root
  `*.cue` file by default, plus configured `global` globs; a `!<glob>` entry removes a default), to a project
  manifest, or to any path outside every project root affects every project.
- **Consumers.** CI fan-out and input hashes, radar's `same_project` grade, review's blast radius, `repo_projects`,
  `repo_affected` and `context_get`.
- **Project pages** (with `--projects`): a Projects card on the repository page, and a page per project with its
  README and agent docs, the Issues whose footprint touches it and the Pull requests whose affected set includes it.
  With projects off, the project routes answer `404`.

Per-project policy (package `tartan` at project roots) is planned.

## The global event log on K2

Each forge can relay every committed repository and forge event into one Cloudflare K2 stream,
`tartan_<stage>_log`.

```
RepoDO / ForgeDO event log (system of record)
        │  relay timer: batches in seq order, cursor moves only after success
        ▼
K2 stream tartan_<stage>_log  (a replica; consumers dedupe on the event id)
        │
        ▼
BusDO consumer group "workloads" ──► RepoDO runs().dispatch(runId, {via: 'k2'})
```

- **The Durable Objects stay the system of record.** The relay is never on a commit path: an append only arms a
  timer, so an outage of the log delays nothing synchronous. Each object relays at least once and in `seq` order,
  resending a failed batch unchanged. Nothing is filtered; extension-private payloads are redacted.
- **Consumers** run in BusDO with their own cursor, deduplication, retries and dead letters. The `workloads` group
  dispatches CI (see [Dispatch through the global log](#dispatch-through-the-global-log)).
- **Operations.** `/-/health` reports a one-word `k2` status. The forge Owner (with a forge-wide credential) reads
  `/-/api/log/status` and retries or discards dead letters at `/-/api/log/dead`.
- **Switches.** `deploy --k2` finds or creates the stream and binds it; consuming needs a K2 consume token from
  Secrets Store (`--k2-token-store`, `--k2-token-secret`), which only BusDO reads. Without `--k2` there is no binding
  and nothing is relayed.

## Agents and the MCP host

### Connecting

An agent needs a token (UI → Agents → New) and the MCP URL of the scope it works in:

```sh
export TARTAN_TOKEN=tagt_...
claude mcp add --transport http tartan https://git.example.com/-/mcp/acme/platform \
	--header "Authorization: Bearer $TARTAN_TOKEN"
git config --global credential.https://git.example.com.helper \
	'!f() { echo username=agent; echo "password=$TARTAN_TOKEN"; }; f'
```

[`../connecting-agents.md`](../connecting-agents.md) has the steps for Claude Code and Codex CLI.

### Scope-dependent protocol

- `/-/mcp` serves the token's node; `/-/mcp/<path>` serves that subtree (inside the token's node).
- `initialize` returns `instructions`: the protocol cards of the installations in force at the scope, up to 8 KB.
- `tools/list` returns the kernel tools, the tools of interfaces whose provider is in force, and extension tools,
  filtered by grants and the agent's role.
- A call whose `repo` argument falls under a different protocol than the session's scope returns
  `{error: "protocol_mismatch", mcpUrl: "…/-/mcp/<that path>"}`.
- `/-/agents.md?path=<scope>` serves the protocol in force as plain markdown for an `AGENTS.md`, and
  `/.well-known/tartan.json` describes the forge.

### Every result carries attention data

Pending notices (at most 10, highest severity first) are appended to every tool result's `content` as a final text
block in a fence labelled with each notice's source, and mirrored in `structuredContent._tartan` with the protocol
hash and the caller's lane state. Notices delivered this way are marked delivered. Notice text is stripped of control
characters and always shown as untrusted.

### Kernel tools

| Tool                                                                                   | Purpose                                                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `whoami`, `protocol_get`                                                               | identity and scope; the protocol cards and the provider of each interface at a scope           |
| `context_get`                                                                          | a context pack within a token budget (below)                                                   |
| `inbox_read`, `inbox_wait`, `inbox_ack`, `inbox_send`                                  | notices; long poll up to 25 s; direct messages to principals with a role on the repository     |
| `repo_list`, `repo_tree`, `repo_read`                                                  | list repositories, directories and files (up to 256 KB) at a ref                               |
| `repo_projects`, `repo_affected`                                                       | the project graph; the projects affected between two commits                                   |
| `lanes_open`, `lanes_get`, `lanes_list`, `lanes_close`, `lanes_delegate`, `lanes_sync` | lanes directly, for protocols without `work@1`; `lanes_sync` rebases your own lane server-side |
| `runs_status`, `runs_logs`, `events_tail`                                              | CI runs and redacted job logs; the repository's event log                                      |
| `why`                                                                                  | provenance of a commit, or of the newest landing that touched a path                           |
| `repo_config_get`, `repo_config_schema`, `repo_config_preview`, `repo_config_result`   | repository config state, schema and previews; none of them applies or signs off                |

### Context packs

`context_get` assembles, in budget order, with untrusted text (issue bodies, other agents' messages, commit messages)
fenced as untrusted:

1. the protocol cards in force (kernel);
2. where you are: the lane's id, backend, state, branch, remote, base and head (kernel);
3. the contract: the work item's title, why, acceptance criteria, footprint and parent (`tartan.work`);
4. the neighbourhood from radar: active lanes whose footprint or touches overlap yours, your open conflicts with their
   suggestions, and trunk drift (`tartan.radar`);
5. the review rules that apply: the routing mode and the owners rules for your paths (`tartan.review`);
6. the test commands CI runs for the projects in play (`tartan.ci`);
7. where your change stands in the queue, and the queue's depth (`tartan.weave` or `tartan.fifo`).

Sections 3 to 7 are `context@1` contributions: at most 8 contributors, each with its own size cap and a 300 ms
budget. Recent landings with their why summaries and excerpts of nearby `AGENTS.md` or `README` files are planned.

### Git and the CLI

An agent reads trunk from the repository's git URL and writes only through its lanes, with the same token as a Bearer
header or as a Basic password through the credential helper; force pushes of its own lane are allowed, so rebases
work, and any Reporter can fetch another lane read-only to stack or rebase on it. The optional `tartan` CLI
(`tools/cli`) adds `login`, `lane open|status|list|close` (printing the lane's `git.start` and `git.push` commands),
`inbox`, `config show|vet|schema`, a git credential helper and a pre-push check (`hooks install --git`).

### Simulated agents

On dev stages with dev tools on (`deploy --dev-tools`), `SwarmWorkflow` drives simulated agents through the same MCP
and git HTTP paths as real agents, on their own repositories with branch lanes. Simulated agents and their events are
labelled `sim`, and the HUD shows real and simulated agents apart. Dev tools are refused on any other stage.

## The web UI

The SPA (Vue 3, Vite) is served from the Worker's static assets. Pages call `/-/api/*` and subscribe to one
WebSocket per repository page (`/-/live`), which replays missed events and then sends coalesced frames.

| Area           | Views                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Setup          | the setup wizard, sign-in, invites                                                                                              |
| Hierarchy      | explore, user and group pages with their tabs, node settings                                                                    |
| Code           | tree, file, commits, commit (trailers and why note), compare, raw files                                                         |
| Work           | work items, changes (overview, diff, revisions, threads), extension tabs                                                        |
| Coordination   | Lanes (a live swimlane per lane: agent, footprint, pushes, CI, radar, backend), Runs and job logs, Advances, Why-blame, the HUD |
| Projects       | the Projects card and project pages (with projects on)                                                                          |
| Config         | Repository → Config: state, errors with file and line, effective extensions, sign-off                                           |
| Administration | Agents and tokens, Extensions (install, swap a provider, compare and promote, breaker), forge settings                          |

Kernel views and extension slots render with the same host components. Extension content appears only through
`tartan-ui@1` documents, and external links go through a "leaving Tartan" page.

## Design principles

These are the kernel's invariants in plain words. Each is enforced inside a Durable Object transaction and has a
test. Source comments refer to them by the code tag shown after each one.
The tags `K1` to `K17` are invariant ids only; `K2` here has nothing to do with Cloudflare K2, the global event log.

1. **Only the kernel moves protected refs** (`K1`). A protected branch, `refs/tartan/*` or `refs/notes/tartan`
   changes only through a kernel git job that recorded its intent before pushing, and the gateway refuses every client
   push to them. A change that no intent explains is parked, re-checked after a grace window, and then pauses landing
   for that repository until an Owner acknowledges it.
2. **A lane has one owner** (`K2`). A lane's head moves only by a gateway push from its owner or a listed delegate
   while the lane is active, or by a registered kernel write for that lane. Anything else quarantines the lane.
3. **Lane operations follow the same ownership rule wherever they come from** (`K16`). Opening, adopting, closing,
   archiving, syncing, restacking and delegating are authorized by one rule in RepoDO, whether the request arrives
   through MCP, the HTTP API or an extension, so the kernel API cannot do what the gateway forbids.
4. **Lane leases expire** (`K7`). An expired lane becomes `lost`, and its owner can resume it for 24 hours.
5. **A lane's diff is measured from its merge base with trunk** (`K17`). Every consumer reads the same range, so
   diffs, radar and CI stay correct after trunk moves and after rebases.
6. **Every kernel state change appends exactly one event, in the same transaction** (`K3`). The log is strictly
   ordered per repository and hash-chained, and side effects outside the object are written as intents first and
   completed by an idempotent sweeper.
7. **Trunk moves only with a reason chain, and every landed commit gets a why note** (`K4`). The chain names events in
   the repository's log, including each change's submission and its approval by the review provider in force (or a
   passing human-review gate), bound to the exact head being landed. The kernel writes the note whatever extension
   asked for the land.
8. **One Advance per ref at a time** (`K5`). It is held under a lease, and every push step is a compare-and-swap that
   can be repeated safely.
9. **What lands is what was tested** (`K6`). A batch lands only on the trunk it was composed and tested on; if trunk
   moved, the attempt is stale and the batch is composed and tested again. Landing a batch on a newer trunk without a
   re-test is planned, and only when nothing that landed since touched its affected projects or a global file.
10. **Check verdicts are bound to the candidate** (`K14`). A verdict counts only for the batch, attempt and commit it
    was announced for, and the Advance pushes exactly that commit.
11. **Gates only get stronger down the tree** (`K8`). A gate installed at an ancestor applies to every descendant and
    cannot be removed, disabled or shadowed below it; any enforcing veto blocks.
12. **Notices never block** (`K9`). Only gates, check verdicts, required review decisions, compare-and-swap and, with
    repository config on, the policy sign-off rules can stop a land.
13. **Events are well-formed** (`K10`). Causal depth is bounded, and a producer emits only kernel types, its own types
    and the types of interfaces it provides, validated against their schemas.
14. **Nobody outside the kernel holds a storage credential** (`K11`). No person, agent or extension receives an
    Artifacts token. Every upstream token is minted per operation and scoped to the one repository it touches, and
    trunk write tokens exist only on kernel paths.
15. **Installations stay inside their subtree** (`K12`). Everything an installation names must resolve to its node or
    a descendant.
16. **Policy comes from trunk, and changing it needs a person** (`K13`). Policy files (the root `*.cue` files) are read
    from the change's base on trunk, never from the lane, and a change to them always goes to a person. With
    repository config on, it also needs a Maintainer's sign-off bound to its head, at most one such change lands per
    batch, and lands wait while new config is applied.
17. **Reads name exact objects** (`K15`). The kernel resolves refs from its own ref index, and every storage read
    names a commit or tree id, so a read is reproducible and never races a ref update.

## Security model

### Authentication

| Principal         | Web                                      | Git                                         | API and MCP                                               |
| ----------------- | ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| Person            | `__Host-tartan-session` cookie           | `tpat_` as a Basic password                 | the session (SPA, CSRF-checked) or a `tpat_` Bearer token |
| Agent             | none                                     | `tagt_` as a Basic password or Bearer token | `tagt_` Bearer token                                      |
| Extension         | none                                     | none                                        | per-call capability stubs only                            |
| Sandbox job       | none                                     | a per-command token for one repository      | internal calls only                                       |
| Deployer at setup | the single-use setup token or claim code | none                                        | `/-/setup/*` only                                         |

The middleware never reads cookies when an `Authorization` header is present, so bearer requests cannot be forged
cross-site. Cookies are never accepted on git or MCP, and tokens never in query strings.

### Authorization and isolation

- Roles inherit down the hierarchy and can only be raised below. Agents are bounded by their token and write git only
  to their own lanes, through two layers: the ref policy, and, for lane repositories, an upstream token that can write
  only that lane repository.
- Extensions act within their grants, or the intersection of their grants and the actor's role. Only `queue@1`
  providers may hold `land`, and the Advance still applies gates, compare-and-swap and the reason chain. No extension
  can write git refs, mint tokens, or read sessions or identities.
- Each installation scope runs in its own ExtensionDO. Dynamic Workers have no outbound network, no bindings and no
  secrets; WASM code arrives only as loader modules with a fresh instance per call; host-side timeouts, the circuit
  breaker and the kill switch stop a misbehaving installation. Builtins are held to the public contract by the import
  lint and the same per-call checks.
- Git is served only on the canonical host, advertisements are filtered to the caller's view, and pushes are parsed
  strictly and refused as a whole before any upstream contact. The capability URL that seeds a lane repository is
  read-only, MAC-protected over every segment, short-lived, single-use and redacted everywhere; failed capability
  requests are rate-limited in the isolate.

### Web

- **CSRF:** every cookie-authenticated unsafe request needs `Sec-Fetch-Site: same-origin`, or an `Origin` equal to the
  canonical origin when that header is absent, and JSON endpoints need a JSON content type. The login flow is bound to
  the browser by `state` and a binding cookie.
- **WebSockets** check the cookie and an exact `Origin`.
- **Headers:** a strict Content Security Policy on the SPA shell (`script-src 'self'`, no remote images,
  `frame-ancestors 'none'`), `nosniff`, a same-origin referrer policy, `no-store` on API responses.
- **Repository content** never runs on the forge origin: raw files are served as plain text or attachments with a
  sandboxing CSP, and markdown (READMEs, project docs) is rendered by the SPA's own renderer without raw HTML (no
  `v-html`; raw HTML shows as text).
- **Extension UI** is validated data rendered by host components; avatars come from a kernel proxy, never an
  extension-supplied URL.

### Outbound requests

User-influenced fetches (OIDC discovery, keys, token and registration endpoints, import sources) pass one validator:
HTTPS on port 443 only, no user info, no IP literals or local names, no automatic redirects, a 10-second timeout and a
1 MB response cap; the Worker runs with `global_fetch_strictly_public`. Lane seeding passes `import()` only URLs the
kernel built itself. Extensions have no network. CI jobs have registry access and no secrets.

### Secrets at rest

`TARTAN_SECRET` is the root key. HKDF-SHA256 derives separate, non-extractable keys from it, each with its own label:
`seal` (AES-256-GCM, for private signing keys, a confidential client's secret, the registration access token and the
PKCE verifier of a sign-in), `lane-cap` (HMAC-SHA256 for capability URLs, used for nothing else) and `web` (reserved
for cookie MACs). With `TARTAN_SECRET_PREVIOUS` set, values sealed under the previous root stay readable while new
values are sealed under the current one. Without `TARTAN_SECRET`, ForgeDO generates a root key at first boot and the
wizard shows how to move it into a secret. Sessions and tokens are stored as SHA-256; Artifacts tokens exist only in
memory.

### Agent code and prompt injection

CI runs agent-written code with no forge secrets and a read token for the one repository it checks out. Kernel git
jobs keep write tokens away from processes that parse repository content. Notices, inbox messages and context packs
are stripped of control characters and fenced as untrusted, with their source named. Agents cannot raise
their own authority: their writes are confined to their lanes, trunk moves only through the Advance and its gates,
and review routing for sensitive paths is computed from policy read on trunk, so a change cannot rewrite the rules
that judge it.

### Audit and integrity

ForgeDO's audit log records sign-ins, token creation and revocation, grant changes, installs and mode changes, setup
and recovery, and simulated-swarm runs. RepoDO's push log records every ref change, and the hash-chained event log,
with the chain head written into each why note, makes coordination history tamper-evident. Rate limits cover setup
(5 per 10 minutes per IP, 50 overall), sign-in (20 per minute per IP), token creation (10 per minute per user) and
lane opens (30 per minute per principal).

## Deployment and switches

A forge is deployed with one command into the deployer's own Cloudflare account; [`../deploy.md`](../deploy.md) has
every step, flag, secret and preflight check.

```sh
git clone https://github.com/rawkode/tartan && cd tartan
deno task deploy -- --stage prod --domain git.example.com
```

The deploy renders a per-stage config without editing `wrangler.jsonc`, generates `TARTAN_SECRET` and a setup token,
waits for `/-/health`, and prints the single-use setup URL. `deno task destroy -- --stage <stage>` removes a stage.

| Switch                                          | Default       | Effect                                                         |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------- |
| `--domain <host>`                               | none          | a Workers Custom Domain on a zone in the same account          |
| `--no-containers`                               | containers on | no runner image; CI and lands report "unavailable"             |
| `--repo-config`                                 | off           | repository config in CUE (needs containers)                    |
| `--projects`                                    | off           | cuenv project detection and the project pages                  |
| `--lane-mode import\|branch`                    | `branch`      | the forge's lane mode; an Owner can override it per repository |
| `--k2`, `--k2-token-store`, `--k2-token-secret` | no K2 binding | the global event log and its consumer                          |
| `--workload-transport local\|k2`                | `local`       | CI dispatch through the global log (needs the K2 stream and its consume token) |
| `--build-ext`                                   | not built     | builds the Rust → WASM example gate for publishing             |
| `--dev-tools`                                   | off           | simulated swarm, seed and reset (dev stages only)              |

Compile-time switches live in `src/constants.ts`: `ECHO_ENABLED` (`remote:` guidance on refused pushes, off),
`LANE_MODE` (`branch`), `EXT_DYNAMIC_ENABLED` (on), `WORKLOAD_TRANSPORT` (`local`) and `MCP_TRANSPORT` (`sdk`). The
deploy's per-stage switches above override `LANE_MODE` and `WORKLOAD_TRANSPORT` without a code change.

## Limits

These are Tartan's own limits and defaults; each refusal names the limit it hit. [`../limits.md`](../limits.md) and
[`../repo-config.md`](../repo-config.md#limits) list them for operators.

| Area              | Limit                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pushes            | request body `TARTAN_MAX_PUSH_MB` (default 95 MB), checked before anything is sent upstream                                                |
| Pushes            | 1,000 ref updates per push for people, 8 for agents                                                                                        |
| Lanes             | 20 active lanes per principal per repository                                                                                               |
| Lanes             | active lanes per repository: a cap shown in the repository's lane settings, which an Owner can change (`maxActiveLanes`, up to 10,000)     |
| Lanes             | 30 lane opens per minute per principal                                                                                                     |
| Lanes             | lease 30 minutes; a lost lane is resumable for 24 hours; storage deleted 24 hours after close; attic retention 1 to 30 days (default 7)    |
| Events            | kept 30 days (simulated: 24 hours), pinned events kept; causal depth at most 8                                                             |
| MCP               | instructions up to 8 KB; at most 10 notices per tool result; `inbox_wait` up to 25 s; `repo_read` up to 256 KB                             |
| Gates             | `ref.advance` 1,500 ms by default, inputs up to 2,000 added lines or 256 KB; `lane.open` 300 ms                                            |
| Extension UI      | 500 nodes, 64 KB, depth 16 per document; renders get 1 second                                                                              |
| Extensions        | packages up to 10 MiB; why-note sections up to 8 KB; breaker at 3 strikes in 10 minutes                                                    |
| CI                | job timeout 15 minutes by default, 60 at most; 6 concurrent job slots by default                                                           |
| Sessions          | idle 12 hours, absolute 7 days; agent tokens 7 days by default, 30 at most; personal access tokens up to 1 year                            |
| Repository config | 32 root `.cue` files, 256 KiB in total; 10 s and 2 GiB per evaluation; see the guide                                                       |
| Hierarchy         | no depth limit; slugs 1 to 64 characters                                                                                                   |

## Planned work

Built pieces that are switched off by default are listed under [Deployment and switches](#deployment-and-switches).
These parts are designed and not built yet:

- OAuth 2.1 for MCP clients, with a delegation consent screen.
- `remote:` lines on accepted pushes, carrying extensions' echo lines such as radar results (refusal guidance exists
  behind `ECHO_ENABLED`, which is off).
- Hunk-level radar grades (`adjacent`, `textual`) and a lanes-by-lanes matrix of them.
- Weave partitions by affected projects with parallel sub-trains, bisection of failed batches, and resolver work items
  that carry both intents.
- Landing a disjoint batch on a newer trunk without a re-test, reusing its evidence.
- Line-by-line Why-blame.
- Context pack sections for recent landings in a lane's footprint (with their why summaries) and for excerpts of
  nearby `AGENTS.md` or `README` files.
- Per-project policy (package `tartan` at project roots) and per-project installs.
- Full `cue export` evaluation of cuenv projects (today's detector is a textual scan).
- A Deploy to Cloudflare button; the one-command deploy is the supported path.
