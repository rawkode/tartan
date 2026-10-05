# ADR: per-repository extension config in CUE

- **Status:** accepted design (2026-10-03), implemented (WP23). The feature ships behind `TARTAN_REPO_CONFIG`, which
  stays `off` until the evaluator's isolation has been verified on the production runtime ("Testing", Live). The
  invariant amendments in "Invariant amendments" are part of the kernel's invariants (K4, K9, K13, K13.1–K13.3).
- **Decision:** Tartan config is the CUE package `tartan` in the repository root. There is no `.tartan/` directory.
  Teams name and split their files as they like, and Tartan's CI pipeline and review owners live in the same package.
  `.tartan/pipeline.yaml` and `.tartan/owners.yaml` are retired.
- **Scope:** how a repository configures Tartan and the extensions that apply to it, from files on trunk, written in
  [CUE](https://cuelang.org).
- **Sources of truth:** the [design summary](README.md) for the kernel and its invariants, and `packages/contract` for
  names and signatures. Where this ADR and the code disagree, the maintainers decide.

## Context

Extensions are installed on nodes of the hierarchy by people with the right role, through the install sheet. Teams
also want configuration as code: a reviewed file in the repository that says "use batch 2 for the Weave here" or
"turn on the secrets gate, but allow these fixture paths", with the same review, history and blame as everything
else in the repository. Tartan's own repository policy (the CI pipeline, the review owners, the project list) is
configuration as code too.

CUE fits that job. It has closed schemas, defaults, bounds, comprehensions and file:line errors, and a schema can be
derived from each extension's manifest. It is also a full language, so an evaluator must assume that a
configuration can be hostile: very slow, very large, or crafted to confuse whatever decides what it means.

Repositories that already use CUE often keep other tools' packages in their root (cuenv's `package cuenv` `env.cue`,
for example) and have their own `cue.mod/`. Tartan config has to live beside them without claiming them.

The design follows from four constraints:

1. **K13: policy comes from trunk.** A change to Tartan config always goes to a person and is applied only from trunk.
2. **The kernel is the security boundary, not CUE.** CUE's closedness is a good author experience. It is never what
   stops a configuration from disabling a gate, widening a grant or reaching outside the repository.
3. **Untrusted input never runs where the forge runs.** A CUE evaluation must be stoppable by a process kill and have
   its own memory limit, apart from every Durable Object and Worker isolate.
4. **The CLI decides what the CUE means.** Which files form package `tartan` is decided by the official loader, never
   by a hand-written filter that could disagree with it.

## Decision

1. **Contract `tartan.cue-eval/1`.** An evaluator-agnostic request (files in, a schema overlay, limits) and a
   response envelope `{version, ok | error{code, message, hint?}, issues[]}` with positioned issues.
2. **Evaluator:** the official `cue` CLI, pinned at v0.17.1, running `cue export -E --out json .:tartan` over the
   repository's root `*.cue` files inside a Tartan Sandbox container with a 10 s kill, a 2 GiB address-space limit,
   capped output, a clean environment, no network, no module registry and an unprivileged user. The kernel sends the
   files in, so the container holds no token and no secret.
3. **Content-addressed cache in RepoDO.** Every evaluation is keyed by the contract, the evaluator id, the schema and
   the `(name, blob id)` list of every root `*.cue` file. An Advance that touches no root `*.cue` file changes nothing
   and runs nothing. Pages, MCP tools, extensions and the project graph read cached JSON and never run CUE.
4. **The registry in ForgeDO is the only authority for installations.** It validates the exported JSON (strict shape,
   Owner approval, K8, K12 and the install rules), keeps that approval as a condition of resolution, and applies
   all or nothing, fenced by trunk position.
5. **K13 is enforced by the kernel.** A change that touches a root `*.cue` file lands only with a kernel-recorded
   sign-off by a Maintainer+ user, bound to the head being landed. No extension can produce it.
6. **Repo policy is read from trunk.** The CI pipeline (`tartan.ci`), the review owners (`tartan.review`) and the
   project graph's projects and global files come from the configuration evaluated on trunk: at the trunk tip for a
   change's checks and review (its base is a merge base its owner controls), at the candidate's base for a land.

Evaluation runs only when something forces it: a trunk Advance that changed a root `*.cue` file, a lane preview, a
registry change, or a package self-check.

## Tartan config in a repository

Tartan config is every `*.cue` file directly in the repository root whose package clause is `package tartan`. For
example:

```
tartan.cue    package tartan: projects, global files, extension installs and overlays
ci.cue        package tartan: the CI pipeline
review.cue    package tartan: review owners
env.cue       package cuenv: another tool's file, left alone
cue.mod/      the repository's own CUE module, if any; never sent to the evaluator
```

The file names are only an example. Any root file in package `tartan` is Tartan config, split or named however the
team likes.

```cue
// tartan.cue
package tartan

_services: ["api", "web", "worker"]

projects: {
	shared: root: "packages/shared"
	for s in _services {
		(s): {root: "services/\(s)", deps: ["shared"]}
	}
	api: {sensitive: true, owners: ["@platform"]}
}
global: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]

// An overlay: Weave is installed at /rawkode, and that installation allows repo overrides.
extensions: "tartan.weave": settings: batch: 2

// An own install: approved at /rawkode and installed nowhere above this repository.
extensions: "acme.no-secrets": {
	mode: "enforce"
	settings: {
		severity: "hunk"
		allow: [for s in _services if s != "worker" {"services/\(s)/fixtures/**"}]
	}
}
```

```cue
// ci.cue
package tartan

extensions: "tartan.ci": settings: pipeline: {
	timeout: "15m"
	jobs: {
		install: run: "pnpm install --frozen-lockfile"
		lint: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm lint", optional: true}
		test: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm test"}
	}
	on: {
		change: ["install", "lint", "test"]
		land: ["install", "test"]
		push: {branches: ["release/*"], jobs: ["install", "test"]}
	}
	lanes: ci: "on-submit"
}
```

```cue
// review.cue
package tartan

extensions: "tartan.review": settings: owners: rules: [
	{paths: ["services/api/**"], sensitivity: 2, owners: ["@platform"]},
]
```

**The CLI decides which files are Tartan config.** The kernel sends every root `*.cue` file, and the evaluator runs
`cue export .:tartan`. The CLI's own loader then selects the package:

- files of other packages are left alone, even when they import modules the evaluator cannot reach;
- `_`- and `.`-prefixed files, `*_tool.cue`, `*_test.cue`, files behind an unset `@if(…)` attribute and files without
  a package clause are left out, exactly as a local `cue export .:tartan` leaves them out;
- subdirectories are never read;
- a root with no `package tartan` file exports `{}`, which means no config.

**Exported shape.** The kernel accepts only this:

```
{
	extensions?: {<extension id>: entry}
	projects?:   {<name>: {root, deps?, sensitive?, owners?, test?}}
	global?:     [glob, …]
}
```

- `projects` and `global` belong to the kernel. The project graph is a kernel service read by CI, the radar, the
  Weave, review and context packs, so its configuration does not depend on which CI provider is installed.
- An entry's fields depend on its kind ("What repository config may do").
- Any other top-level field is a `shape` denial that names it, with a hint (the pipeline goes under
  `extensions: "tartan.ci": settings: pipeline`). CUE does not close a package's top level, so this check is the
  kernel's.
- Hidden fields (`_services`) and definitions are not exported, so authors can use helpers freely.

**File rules**, checked by the kernel before any evaluation. A failure is `INVALID_INPUT` naming the path.

| Rule    | Value                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Set     | every entry directly in the root whose name ends in `.cue`, of any package; the same set as the K13 policy paths             |
| Names   | `[A-Za-z0-9_.-]+\.cue`, ASCII only; another name is rejected rather than dropped, because a local `cue export` would load it |
| Kinds   | regular files (git modes 100644 and 100755); a symlink, a submodule or a directory named `*.cue` is rejected                 |
| Size    | at most 32 files, 64 KiB per file, 256 KiB in total, counting other packages' root files, because they are sent too          |
| Imports | the CUE standard library and `tartan.dev/ext` only                                                                           |

**`cue.mod` and imports.** The repository's own `cue.mod/` is never sent. The evaluator runs in a module the forge
builds for each job, so package `tartan` may import only the CUE standard library and `tartan.dev/ext`.

- Any other import fails with `INVALID_INPUT` naming the file, the position and the import: a registry module, a
  package of the repository's own module, a vendored package, or the job's own module. For example: "package tartan
  may import only the CUE standard library and tartan.dev/ext: `ci.cue:3:8` imports `github.com/acme/schemas/ci`".
- The job has no network and never fetches from a registry. Registry and repository-local imports are a follow-up.
- `@embed` can read only the root `*.cue` files that were sent; CUE refuses a parent path.

**Local use.**

- `cue export .:tartan` in the repository root gives the same values on a laptop, with or without the repository's
  own `cue.mod/`, but without the forge's schema. A file that imports `tartan.dev/ext` evaluates locally only through
  the next command.
- `tartan config schema --out <dir>` writes the forge's module and binding file. With the root `*.cue` files copied
  into `<dir>`, `cue export -E --out json .:tartan` there gives byte-identical output.

## What repository config may do

The registry decides each entry's kind from the repository's ancestry in the hierarchy:

| Kind          | Condition                                                                                                                                                                                                                                | May set                                                               | Effect                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| own install   | an Owner approved the package at an ancestor or at the repository; no installation of that extension exists at any ancestor (a manual one at the repository itself is a `conflict`); the package provides no interface; it is not a pack | `enabled`, `mode`, `settings` (its settings and its repo-policy keys) | one installation at the repository node, marked `source: repo-config`                                            |
| repo policy   | an installation of that extension is in force for the repository (at the repository or an ancestor, in any mode, providers and gates included), and its manifest lists `config.repoPolicy` keys                                          | `settings`, only `repoPolicy` keys                                    | nothing is installed or applied; the extension reads the keys at each change's base ("Repo policy")              |
| overlay       | an ancestor installation of that extension has **repo overrides** turned on by an Owner, and its storage is per repository                                                                                                               | `settings`, only keys the manifest lists in `config.repoOverridable`  | the extension's per-repository Durable Object for this repository gets the merged settings; nothing else changes |
| anything else | an inherited extension with neither repo policy nor the opt-in, a provider of any interface as an own install, a pack                                                                                                                    | nothing                                                               | denied `inherited`, `provider_floor` or `pack`                                                                   |

- One entry for an installation in force may hold repo-policy keys and, with the opt-in, overridable keys in the same
  `settings`. The kernel splits them by the manifest's lists.
- **An overlay never** installs, enables, disables or swaps anything. It never changes which installation provides an
  interface, subscriptions, contributions, gates, grants, mode or role. The inherited installation keeps its state and
  only sees new settings in this repository.
- **Repo policy never** changes an installation either. It is data the repository authors, as `pipeline.yaml` and
  `owners.yaml` were, read by the extension through the kernel.
- **Providers stay manual.** No provider of any interface can be installed from repository config, so `review@1`,
  `queue@1` and `checks@1` remain manual, Owner-approved installs.
- **One installation per path.** A manual install at an ancestor of an extension that repository config installed
  below is refused with `conflict`, naming the repositories. Gates are therefore never doubled.
- **Inherited gates are monotonic (K8).** `enabled: false` or `mode: "shadow"` on an inherited gate is denied, with
  "inherited from /rawkode; change it there".
- **Never settable from a repository:** the node, grants, `locked`, the background role, the version, the runtime, the
  pack, backfill, or anything about an inherited installation beyond its overridable settings and its repo policy.

## Schema from extension manifests

The manifest's `config` gains four fields (a contract change):

```jsonc
"config": {
	"default": { "batch": 4, "debounceMs": 2000, "resolver": "notify-author", "reuseDisjointEvidence": true, "bisect": true },
	"cue": "config/settings.cue",              // package-relative; `package settings` with a closed #Settings (and #Policy)
	"targets": [],                             // settings that name K12 targets; enforced by the kernel, never by CUE
	"repoOverridable": ["batch", "debounceMs"], // keys a repository may overlay on an inherited installation
	"repoPolicy": []                           // keys a repository authors as policy, read at each change's base
}
```

```cue
package settings

#Settings: {
	batch:                 int & >=1 & <=4 | *4
	debounceMs:            int & >=0 & <=60000 | *2000
	resolver:              "notify-author"
	reuseDisjointEvidence: bool | *true
	bisect:                bool | *true
}
```

`tartan.ci` declares `"repoPolicy": ["pipeline"]`, and its config file adds `#Policy: {pipeline?: #Pipeline}`, the
CI pipeline schema in CUE. `tartan.review` declares `["owners"]` the same way.

- **Validation:**
  - `repoOverridable` is refused for a package that declares gates or provides `review@1` or `checks@1`, for a key
    that is also a target, and for a key missing from `config.default`.
  - `repoPolicy` keys must not appear in `config.default` or `targets`, and `#Policy` declares exactly those keys, each
    optional. Any package may declare repo policy, providers and gate-bearing packages included, because repo policy
    changes nothing about installations.
  - A package that decides what lands (it declares gates or provides `review@1`, `checks@1` or `queue@1`) reads repo
    policy from a repository below an ancestor installation only once the installing Owner turned on repo overrides
    for that installation; otherwise a Maintainer below an enforced gate could steer what the gate decides (K8). The
    bundled `tartan.ci` and `tartan.review` keep their pipeline and owners policy without the opt-in, as the YAML
    files were. A manual installation at the repository itself needs no opt-in.
  - A package without `config.cue` gets `settings: close({})`.
- **Why CUE text, not JSON Schema:** converting between the two loses defaults, bounds or list item types in one
  direction or the other. The settings form for manual installs (JSON Schema) is unchanged.
- **Builtins** keep `extensions/<x>/config/settings.cue` as the source (`ci`, `review` and `weave`), with an embedded
  mirror and a drift test. **Published packages** carry the text in the registry (at most 64 KiB).
- **The generator** (pure TypeScript in the registry) emits the overlay the evaluator sees:

  ```
  cue.mod/module.cue                               a module path that is fresh for each job
  cue.mod/pkg/tartan.dev/ext/ext.cue               #Mode, #Project, the entry kinds and the closed #Extensions index
  cue.mod/pkg/tartan.dev/ext/x/<sid>/settings.cue  each extension's own config file, verbatim
  ~tartan.cue                                      package tartan; binds extensions, projects and global to the schema
  ```

  - The binding file sits beside the repository's files under a name the file-name rule never admits, so no
    repository file name is reserved. It binds by field (`extensions?: ext.#Extensions`), which is what makes an
    unknown id or key a positioned error.
  - The module path is fresh for each job, so no import can reach the job's own directory. The job normalizes it out
    of messages before they are cached.
  - `#Extensions` is closed. It lists an optional own-install entry (`{enabled?, mode?, settings: {#Settings,
    #Policy}}`) for each approved package that may be installed here, and an optional entry for each installation in
    force that declares repo policy or has overrides on (`settings` holds its `#Policy` keys and, with the opt-in, one
    optional field per overridable key).
  - A key the repository leaves unset is not exported, so it never overwrites the ancestor's value.
  - An unapproved id, an inherited id with neither repo policy nor the opt-in, `mode` or `enabled` on an installation
    in force, and a provider as an own install are all absent, so each is a positioned `field not allowed` before
    the registry denies it too.
- **The schema key** is the sha256 of the sorted generated files. It is cached per repository and registry epoch.
- **`<sid>`** is the extension id with `.` and `-` replaced by `_`. Publishing refuses an id whose `<sid>` another
  registered id already has; a pair that exists anyway keeps only the first id by sort order in a generated schema
  (the other is then a positioned `field not allowed`), so it never fails every repository below.
- **Self-check:** each package version with a config file is checked once, the first time it is approved or installed.
  An empty entry must evaluate to `config.default`, and `#Policy` must declare exactly the `repoPolicy` keys. Until the
  check passes, the package is absent from every generated schema, so one package's broken or slow config file cannot
  fail other repositories' evaluations. An approval commits only after its package passed.

## K13 in the kernel: the policy sign-off

**One predicate.** `isPolicyPath(p)` is true when the first segment of `p` ends in `.cue`: every file directly in the
repository root with that extension, and anything under a root entry so named, compared byte for byte on the raw path
with no normalization. A rename checks both names. The kernel, `tartan.review` and repository config all use the same
function from `packages/contract`.

- It covers exactly the root entries the evaluator's input set and the policy digest are built from, so it covers
  package `tartan` and, on purpose, other packages' root files too. A directory named `*.cue` is rejected by the file
  rule, and changing it needs a sign-off like a file, so it can never change the digest of a signed-off change in
  flight without a person. A file's package cannot be read from its path, and a kernel parser of package clauses would be a second loader
  that could disagree with the CLI. A disagreement in one direction would let a configuration change land without a
  person.
- The cost: an edit to another tool's root file (cuenv's `env.cue`) also needs a sign-off. Narrowing the predicate to
  package `tartan` needs the evaluator to report the files it loaded, which the CLI does not do today.
- The zero-config test scripts stay policy for review routing and for CI, which reads them at the base, as before.
  They do not need the sign-off.

**The sign-off is a kernel act.**

- `POST /-/api/repos/:repo/lanes/:laneId/policy-signoff {head, policyDigest}` accepts SPA session users only: bearer
  tokens, agents and installations are refused. The caller must be Maintainer+ at the repository.
- `policyDigest` is the sha256 of the sorted `(name, mode, blob id)` list of root `*.cue` entries at the head, or
  `null` when there are none. The kernel re-reads the lane head by SHA and recomputes it, so a stale page cannot sign
  a newer push.
- The kernel records the sign-off and appends `repo.policy.approved {laneId, head, policyDigest, …}` with the user as
  the actor. `DELETE` revokes it (`repo.policy.revoked`), and a new push makes the old sign-off irrelevant.

**Land checks:**

- **At `land.submit`, inside the K4 check:** for each change whose range touches a policy path (a missing or
  truncated diff counts as touching), an unrevoked sign-off for that lane and head must exist, and its signer must
  still be a Maintainer+ user. The kernel pins the sign-off into the reason chain itself, so queue providers need not
  name it. A batch holds at most one policy-touching change.
- **In the Advance, after compose:** the composed per-change paths are authoritative, and a capped list counts as
  touching. The candidate's root `*.cue` digest must equal the digest the sign-off names. If another configuration
  change landed in between, the batch is ejected with `config-plan-changed`, because a human approved one
  configuration and trunk would get another. No evaluation runs on the land path. Root `*.cue` files are always global
  in the project graph, so a restack cannot change them without a re-compose.
- **At the K5 lock:** the sign-off pinned at submit must still be the unrevoked sign-off of that head, and its signer
  must still be Maintainer+. A revocation or a demotion during the gates, the tests or a hold ejects the change with
  `policy-signoff`; the rest of the batch is composed again.

The review provider in force still decides review exactly as before. An auto-approving review provider, or a glob that
misses a path, can no longer land a policy change, because neither can produce a sign-off. The sign-off is also the
name the audit log records for every apply it leads to.

## Repo policy: pipeline, owners and projects

Some configuration is not an installation but a document that a reader needs at each change's base. It replaces
`.tartan/pipeline.yaml`, `.tartan/owners.yaml` and the project list that `pipeline.yaml` held.

| Value                | Where in package `tartan`                       | Read by                                                |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `pipeline`           | `extensions: "tartan.ci": settings: pipeline`   | `tartan.ci`, at the change's base                      |
| `owners`             | `extensions: "tartan.review": settings: owners` | `tartan.review`, at the change's base                  |
| `projects`, `global` | the top level                                   | the kernel's project graph, at the commit's trunk base |

**Trunk config history.** RepoDO records one row for each trunk commit at which the root `*.cue` files changed, with
the evaluation that resolved it. A registry change never rewrites a row: the policy in force at a trunk commit is the
one recorded when that commit's configuration was evaluated. The newest 50 rows are kept, with their cached results.

**Reading at a base.** The configuration in force at trunk commit C is the newest row at or before C:

- resolved and valid: that configuration, marked exact;
- still pending: the reader is told `pending`;
- invalid (a CUE error or rejected input): the newest valid row before it, marked not exact, with the failure. This is
  the "last good" rule that installations follow too;
- no row, or a row with no `package tartan` file: no configuration.

**`caps.repo.policy(repo, at)`** (a new capability, under `repo.read`):

- `at` must be a trunk commit. A lane head, a revision or a candidate is refused (K13).
- It returns only the calling extension's own repo-policy keys: `{state: "ok", configSha, exact, values, failed?}`,
  `{state: "none"}`, `{state: "pending"}`, or `{state: "expired"}` for a base older than the oldest kept row once
  rows were pruned (the author syncs the lane).
- It never runs CUE and never waits.

**Readers.**

- **`tartan.ci`** plans a change check or a push check from the pipeline and the project graph at the trunk tip, with
  the affected paths still computed from the change's own range, so a lane rooted on an older trunk commit cannot
  choose an older pipeline; a land candidate is planned at its own base, which is the tip it was composed on. No
  pipeline means zero-config detection, unchanged. `pending` keeps the check pending. A not-exact answer plans with the
  last good pipeline and says so in the check: failing instead would also fail the change that fixes the
  configuration, because that change is tested with trunk's pipeline. `tartan.ci` keeps validating the pipeline value
  itself, because CUE is never the boundary.
- **`tartan.review`** reads its owners rules at the trunk tip too. A not-exact answer routes every change to a person, as an
  invalid `owners.yaml` did, so a last-good pipeline never passes a change on its own.
- **The project graph** takes the configured projects and global files from the configuration at the commit's trunk
  base (the commit itself when it is on trunk, otherwise its merge base with trunk), then runs the workspace detectors
  as before. Root `*.cue` files are always global. The graph's cache key includes the configuration it used.

## Retiring the YAML files

| Was                                                       | Now                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `.tartan/pipeline.yaml`: `timeout`, `jobs`, `on`, `lanes` | `extensions: "tartan.ci": settings: pipeline: {timeout, jobs, on, lanes}`                           |
| `.tartan/pipeline.yaml`: `projects`, `global`             | top-level `projects` and `global`; `.tartan/**` entries are dropped (root `*.cue` is always global) |
| `.tartan/owners.yaml`: `rules`                            | `extensions: "tartan.review": settings: owners: rules`, with `paths` only (`path` is gone)          |
| `version: 1` in either file                               | dropped; the schema is versioned by the forge                                                       |
| `.tartan/README.md` in the genesis commit                 | dropped; a new repository's first commit holds `README.md` only                                     |

- The forge reads nothing under `.tartan/`. A repository that still has one gets a one-line hint on its settings page;
  nothing fails.
- The YAML readers are removed in the merge that switches `tartan.ci`, `tartan.review` and the project graph to
  repository config. Until then they are the current implementation.
- With `TARTAN_REPO_CONFIG` off, a forge has no repository config at all: CI runs zero-config, review has no owners
  rules, the project graph uses the detectors only, and nothing is installed from a repository.

## When and where evaluation runs

| Trigger                                                                                                                       | Input (read by SHA)                   | Runs on                                               | Effect                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lane push touching a root `*.cue` file, or on demand                                                                          | the lane head                         | the cache, else a preview sandbox                     | a registry dry run and a plan in the change card; **never applied**, never read as policy, never used for gates, routing or CI            |
| An Advance whose landed paths touch a root `*.cue` file                                                                       | the new trunk head                    | the cache (checked by sha256), else the trunk sandbox | a trunk config row and the only automatic apply; that repository's lands wait while it is pending (K13.1)                                 |
| Trunk moves outside the Advance (import, an acknowledged or reconciled ref, repo creation) and the root `*.cue` files changed | the new trunk head                    | the trunk sandbox                                     | a trunk config row, read as policy at once (as the YAML files were); installations wait as `needs-apply` until a Maintainer+ applies them |
| A registry change (approval, revoke, move, archive, a changed builtin, an ancestor install, a new evaluator id)               | trunk's config under the new schema   | the trunk sandbox, background class                   | re-apply in the background (`stale`); a trunk row that did not evaluate may resolve now, an `ok` row is never rewritten                  |
| A package self-check                                                                                                          | one package version                   | the trunk sandbox, lowest class                       | records the check; approvals commit only after it passes                                                                                  |
| Settings page, MCP reads, extension calls, the project graph                                                                  | none                                  | nothing                                               | read-only cached state                                                                                                                    |

**Two classes of work, two sandboxes.**

- `cue:trunk` takes only kernel-originated work, in strict priority: trunk evaluations and explicit applies first,
  then registry re-evaluations (staggered, repositories with a pending trunk first), then self-checks.
- Lane previews go to `cue:preview:<k>`, chosen by a hash of the requesting principal. A flood of hostile previews
  can therefore never delay a trunk evaluation.
- A `cue` job-slot kind reserves capacity for each class below the forge's container limit, so CI cannot take the last
  instance from the trunk evaluator.
- Previews are rate-limited: one lane in flight per principal (a newer push of that lane queues behind its running
  preview), the latest request per lane replaces a queued one, a per-principal budget, and a bounded queue that
  answers `rate_limited` when full. A rate-limited or unavailable preview is queued again with backoff.
- Trunk and preview jobs are tracked apart, even for the same input key: trunk never waits on a preview job and never
  takes a preview sandbox's answer for its own, neither from the job nor from the cache; the result carries the role
  of the sandbox that answered, and a preview's answer never overwrites a cached trunk result. Previews may read
  trunk's results.

**Asynchronous by construction.**

1. RepoDO calls `cueSubmit`, which enqueues and returns at once. No request and no timer handler waits for an
   evaluation.
2. The sandbox runs one job at a time, single-flighted by input key, so retries and duplicates join the running job.
3. It writes one size-capped bundle of the validated root `*.cue` files and the generated overlay, then runs one exec
   that:
   - wipes stale job directories;
   - unpacks the bundle into a fresh private directory, re-checking every name;
   - runs the job script, which runs `cue export -E --out json .:tartan` in that directory;
   - removes the directory on exit.
4. The result returns to the repository's Durable Object through a callback.
5. A short watchdog timer enforces the deadline, counted from dispatch: 75 s for an attempt that starts the container,
   30 s otherwise.

## The evaluator job

| Guard           | Value                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Wall clock      | `timeout --foreground -s KILL 10`                                                                                               |
| Address space   | `ulimit -v` 2 GiB, verified on the production architecture before the feature is switched on                                    |
| Memory backstop | the container's OOM killer prefers `cue` (`oom_score_adj 1000`); the instance type leaves room for the control server           |
| Output          | `ulimit -f` caps the JSON file and the stderr file alike; the host reads at most 256 KiB of JSON and the first 64 KiB of stderr. cue's Go runtime ignores SIGXFSZ, so an export that reaches the cap fails its write and exits 1: the job reports that as the file cap (`LIMIT_EXCEEDED`), and error text is cut at the cap with cue's own status |
| Environment     | an empty environment with `CUE_REGISTRY=none`, an unprivileged user, and no network for `cue:*` instances                       |
| Escapes         | the module root is the job directory and its module path is fresh for each job; `@embed` of a parent path is refused by CUE     |
| Versions        | the job reports `cue version` and its own version; a mismatch with the evaluator id is an internal error and is never cached    |
| Secrets         | none: files in, JSON out                                                                                                        |

CUE's messages contain text the repository controls. They are normalized into `issues[]` with positions checked by
pattern, shown as text only, capped at 256 issues and 4 KiB per message, and fenced as untrusted in MCP output. Bidi,
format and zero-width characters in issue text and in plan values are shown as `\uXXXX` escapes, so the change card a
Maintainer decides on never shows reordered or hidden text.

## Cache and state

**Input key:** `sha256(["tartan.cue-eval/1", evaluatorId, schemaKey, [[name, blobId], …sorted]])` over every root
`*.cue` file. The evaluator id names the CUE version, the job script version and the file-rules version, so changing
any of them re-evaluates.

- An edit to any root `*.cue` file re-evaluates, another package's included; its result is usually unchanged, and the
  apply is then a no-op.
- Nothing else re-evaluates: not the repository's `cue.mod/`, not `.cue` files in subdirectories, not other files.

**Integrity.**

- Before dispatching a trunk evaluation, the kernel checks that each file's git blob hash equals its id, and it stores
  a sha256 per file.
- A trunk evaluation reuses only a result that `cue:trunk` produced, and only when those sha256 values match the
  canonical bytes. A preview sandbox evaluates every principal's input, so its result is shown on the change card and
  never applied, never read as policy and never taken as trunk's: when a previewed config lands, trunk evaluates the
  same input again on `cue:trunk` (one more warm evaluation per landed config change, while its lands are held anyway),
  and that result replaces the preview's in the cache.
- A trunk `TIMEOUT` or `LIMIT_EXCEEDED` can come from the environment (a cold or contended instance), so it is final
  only once two trunk evaluations in a row gave it. "Re-evaluate" clears such results and runs them again.
- Internal errors and evaluator outages are never cached.

**Positive evidence.**

- A read counts only if the commit resolves and its root tree is the one read and is not empty. The root `*.cue`
  entries come from that tree.
- Any missing, empty or inconsistent read means "unavailable": nothing changes, and the read retries.
- Removing Tartan config (no root `*.cue` file, or none in package `tartan`) uninstalls the repository's config only on
  that positive evidence **and** when the landed range contains the signed-off change that removed it.

**States:**

| State          | Meaning                                                                                                | Lands of this repository                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `unconfigured` | nothing applied and no config on trunk                                                                 | not held                                                   |
| `current`      | the applied result is the trunk config's                                                               | not held                                                   |
| `pending`      | a policy-touching Advance is not yet resolved, including while the evaluator is unavailable            | **held**, unless an Owner chose "keep last-good" (audited) |
| `failed`       | the trunk config has a CUE error, rejected input or a registry denial                                  | not held; the last-good set stays in force; banner         |
| `stale`        | an approval or install change moved the schema under the applied head; re-evaluating in the background | not held, unless a gate-bearing installation is missing    |
| `needs-apply`  | trunk moved outside the Advance (or the switch went on) and its config differs from the applied one   | not held; the last-good set stays until an explicit apply or a signed Advance |

**Transitions.**

- **The Advance decides synchronously.** Inside the transaction that completes it, the land module checks whether a
  landed path is a root `*.cue` file. If so, the repository goes to `pending`, a trunk config row is opened and an
  evaluation is scheduled. Repositories that never touch a root `*.cue` file never hold.
- **A signed Advance supersedes `needs-apply`.** Its signers approved the full root `*.cue` set at that head, and K13.2
  bound the candidate's digest to it, which is the same authority as an explicit apply: the repository goes to
  `pending`, lands wait, and the result applies. Only an unsigned touch keeps `needs-apply`.
- **An unavailable evaluator never turns a new trunk config into `failed`.** Holding that one repository's lands is
  the safe answer: otherwise agents would keep landing without a gate that a human just approved. Background retries
  back off from 1 minute to 30 minutes. An Owner may release the hold with "keep last-good", which is audited; the
  pending row then reads as last good for repo policy too. "Keep last-good" covers only the holds present when it is
  set (the pending resolution, ForgeDO's `gate-missing` hold, or both) and ends with them; a later hold is not masked.
  It is offered whenever lands are held, so a revoked gate approval never deadlocks the fix that removes the entry.
- **The hold waits; it never vetoes.** LandWorkflow waits in its own loop, outside the Advance lock, without using up
  land attempts. It waits **before** an attempt's gates are worked out, so the gates come from the installations of
  the resolved trunk config; a hold that begins while the gates or the tests run is waited out and the gates run
  again. ForgeDO's `gate-missing` hold is read from ForgeDO in the same step (`registry.landContext`).
- **The hold is bounded and loud.** A batch held for 30 minutes ends with reason `config-hold`: its lanes are released
  (their owners can push again), its changes return to the queue unchanged, and the queue provider submits them again
  later. A `config-hold` never counts toward a queue's requeue limit, so a long hold delays changes and never ejects
  them. A hold that lasts 15 minutes is told once to the repository's Owners, since only an Owner can release it (keep
  last-good) or approve a lost gate again.
- **Each gate loss is its own hold.** ForgeDO's `gate-missing` hold carries a generation that every gate loss moves; a
  keep-last-good covers the generations present when it was set, so a second loss holds again.
- **Registry work re-evaluates trunk's config**, the newest trunk row, not the applied one, under a fence position of
  its own, so a configuration the old schema refused applies once an Owner allows it, and a `failed` head stays
  `failed` until trunk's configuration evaluates. While `needs-apply` holds, registry work re-applies the applied
  configuration and keeps `needs-apply` with its plan. ForgeDO pokes every repository whose trunk configuration was
  ever evaluated, applied or not.
- **No trunk row is left pending.** A row that a later policy-touching Advance superseded before it resolved is still
  evaluated, for the bases between the two; an import opens the imported tip's row as pending at once.

## Applying results

Repo policy is not applied; readers fetch it for each base. Installations and overlays are applied as follows.

**The approval is a condition of resolution, not only of apply.**

- A `repo-config` installation is in force only while the nearest Owner approval matches its extension id, version and
  package sha256, and needs no re-approval.
- Its grants and background role come from the approval's snapshot, never from the current manifest. A deploy that
  widens a bundled package's permissions therefore marks the approval for re-approval instead of widening silently.
- Revoking an approval, changing its version, moving a repository to a subtree without the approval, or archiving a
  node removes the affected rows in the same transaction.
- If a removed row carried a gate, that repository's lands hold until the re-apply commits.
- An Owner's "disabled" on a repo-config installation is never undone by a later apply: it is kept per (repository,
  extension), so removing and re-adding the entry, a version change and a revalidation all bring it back disabled.
  Only an Owner clears it.

**Fenced applies.** RepoDO records an apply intent and completes it with idempotent retries. ForgeDO applies inside
one transaction:

1. **Fence:** refuse a lower `(trunk position, registry epoch)` than the stored one; treat an equal one with the same
   key as a no-op.
2. **Schema:** recompute the schema key for the current epoch and refuse a mismatch.
3. **Checks:** run every check; any denial writes nothing.
4. **Reconcile:** update the installations and overlays, append one `extension.*` event per operation (with the
   source commit, the input key and the evaluator), write one audit row, and return what is now applied.

RepoDO stores exactly that answer, so an out-of-order or retried apply can never leave ForgeDO behind the page.

**Checks:**

| Rule            | Check                                                                                                           | Denial                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| shape           | strict envelope (`extensions`, `projects`, `global`), valid ids and project roots, at most 256 KiB and depth 32 | `shape`, `too_large`                  |
| approval        | the nearest approval binds the package version and sha256                                                       | `unapproved`                          |
| kind            | own install, repo policy or overlay, nothing else                                                               | `inherited`, `provider_floor`, `pack` |
| policy keys     | each repo-policy key is one the manifest lists in `config.repoPolicy`                                           | `policy_key`                          |
| overlay keys    | each overlay key is overridable and is not a target                                                             | `overlay_key`                         |
| K8              | an inherited gate cannot be disabled or shadowed                                                                | `locked_gate`                         |
| locked provider | a locked provider cannot be disabled or shadowed below its node                                                 | `locked_provider`                     |
| shadow          | shadow mode only for gates                                                                                      | `invalid`                             |
| same node       | no manual installation of the same extension at the repository node                                             | `conflict`                            |
| K12             | every target a setting names (each element of a list, at any depth) is a node path inside the repository's subtree | `scope`                            |

A denial of an installation entry fails the apply (`failed`, last-good installations stay) but does not invalidate
the repo policy of the same configuration: the two are independent.

**Who can do what:**

| Actor                          | Can                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner (SPA session)            | approve or revoke packages for repository config at a node; allow repo overrides on an installation; lock providers; install ancestor gates; keep last-good; disable a repo-config installation |
| Maintainer+ user (SPA session) | sign off a policy change; apply a `needs-apply` trunk config                                                                                                                                    |
| Agent                          | write root `*.cue` files in its own lanes and preview them; never sign off, apply, approve or override                                                                                          |

The audit names the signers of the landed change, the Maintainer who applied, or the Owner whose approval change led
to a re-apply (the installer and the event actor of that re-apply, with the configuration's signers after it).

## Invariant amendments

Accepted amendments:

- **K13:** policy files (every `*.cue` file directly in the repository root, which holds the CUE package `tartan` with
  the pipeline, the owners rules and the configured projects, and the zero-config test scripts the pipeline would use)
  are read from trunk for every decision: gates, routing, CI, the project graph and installations; from the trunk tip
  where the change's base is owner-controlled (a change's checks and review), from the candidate's base for a land.
  Lane and candidate policy files may be evaluated for display and validation only.
- **K13.1:** installations derived from trunk policy are resolved before a land of that repository tests or advances.
  `pending` waits (also while the evaluator is unavailable, unless an Owner keeps last-good), and `failed` keeps the
  last-good set.
- **K13.2:** a batch holds at most one policy-touching change, and its candidate's root `*.cue` files must be the ones
  its sign-off names.
- **K13.3:** a change touching a root `*.cue` file needs a kernel-recorded sign-off by a Maintainer+ user, bound to its
  head.
- **K4:** the reason chain of a policy-touching change includes its sign-off, which the kernel pins.
- **K9:** the K13.1 hold delays a land and never vetoes it. A batch held longer than 30 minutes returns to its queue
  unchanged (`land.failed` with reason `config-hold`, its lanes released) and never counts toward an ejection; a hold
  of 15 minutes is told to the repository's Owners. `policy-signoff`, `policy-batch` and `config-plan-changed` join
  gates, check verdicts, required reviews and compare-and-swap as the things that block.

## User interface

**Repository settings → Extensions** (`/<repoPath>/-/settings/extensions`, Reporter+ to view):

- **Header:** the state, "applied from package `tartan` @ `<sha>`, signed off by <user>", the CUE version and the
  short input key.
- **Effective config:** each extension's version, mode and source (`repo config`, `overlay on /rawkode`,
  `inherited from /rawkode` or `manual`), with overridable keys marked and resolved settings shown as text.
- **Repo policy:** the pipeline, the owners rules, and the projects and global files in force at the trunk tip, each
  with the commit it came from, marked "last good" when the newest configuration failed.
- **Issues and denials:**
  - issues with `file:line:col`, linked to the blob view only for a root `<name>.cue` path (forge-supplied positions
    link to the schema view);
  - denials with their code and JSON path, for example "K8: acme.no-secrets gates are enforced from /rawkode".
- **Actions:**
  - "Apply trunk config" and "Re-evaluate" (Maintainer+);
  - "Keep last-good" (Owner, while held);
  - "download schema" and a copyable `cue export` command.
- **Managed rows:** settings forms of repo-config installations and overlays are read-only ("managed by package
  `tartan`").
- **Migration hint:** when trunk still has a `.tartan/` directory, one line says it is no longer read and where its
  contents now go.

**Change page card "Repo config"**, shown when a change touches a root `*.cue` file. It is a kernel component declared
in the slot host.

- The route badge `human (K13)` and the sign-off state, with **Approve policy change** for Maintainer+ users.
- The plan against trunk's applied set and policy, for example "overlay tartan.weave (inherited from /rawkode): batch 4
  → 2", "install acme.no-secrets 0.2.0 (enforce)", "pipeline (tartan.ci): + job lint" or "no change" (an edit to
  another package's file).
- Errors at the lane head, denials, and "needs Owner approval" hints.
- Freshness ("evaluated at `<sha>`" or "evaluating…"), updated live.

## MCP, CLI and HTTP

**MCP kernel tools:**

- `repo_config_get {repo}`: state, plan, repo policy, issues and denials (Reporter+).
- `repo_config_schema {repo}`: the generated files and the schema key, to write config before pushing.
- `repo_config_preview {repo, laneId}`:
  - the lane must belong to the repository, and an agent may name only its own lanes;
  - it answers at once with a cached result or `{status: "evaluating", inputKey}`;
  - the result follows as an event, an inbox notice and through `repo_config_result {repo, inputKey}`.
- Every string the repository controls is returned in a fenced untrusted block.
- No tool signs off, applies, approves or overrides.
- Repositories that use config add one line to the protocol card: "Root `*.cue` files are Tartan policy; a change to
  any of them needs a human sign-off. Call `repo_config_preview` before you submit."

**CLI:** `tartan config show [repo]`, `tartan config vet [--lane <id>]` and `tartan config schema --out <dir>`.

**HTTP:**

| Route                                                                                   | Who                                |
| --------------------------------------------------------------------------------------- | ---------------------------------- |
| `GET /-/api/repos/:repo/config`, `…/config/schema`, `…/config/evals/:inputKey`          | Reporter+                          |
| `POST /-/api/repos/:repo/config/preview`, `GET /-/api/repos/:repo/lanes/:laneId/config` | lane readers; agents for own lanes |
| `POST`, `DELETE /-/api/repos/:repo/lanes/:laneId/policy-signoff`                        | Maintainer+, session only          |
| `POST /-/api/repos/:repo/config/apply`, `…/config/reevaluate`                           | Maintainer+, session only          |
| `POST /-/api/repos/:repo/config/override`                                               | Owner, session only                |
| `PUT`, `DELETE /-/api/nodes/:node/config-approvals/:extId`                              | Owner, session only                |
| `PUT /-/api/installations/:id/repo-overrides`                                           | Owner at the installation's node   |

## Build and deploy

- **No generated artifact is committed.** The schema is generated by ForgeDO at runtime, and there is no Wasm build.
- **Runner image:** a separate Dockerfile stage, selected by `TARGETARCH`, downloads the official
  `cue_v0.17.1_linux_<arch>.tar.gz`, checks it against a pinned sha256 for each architecture, installs `cue`, asserts
  `cue version`, and copies the committed `cue-job.sh`. The binary adds about 10 MB to the image. `/-/health` reports
  the CUE version.
- **Switch:** `render-config.ts` writes `TARTAN_REPO_CONFIG` as `off` (the default until the security review) or `on`, and
  `--no-containers` forces `off`.
  - With it `off`, nothing is evaluated, held or signed, and a forge has no repository config ("Retiring the YAML
    files"). Installations that repository config already made stay in force, because people approved them; the
    settings page says repository config is off; Owners can uninstall.
  - **Turning it on (again)** is a transition per repository, run by the first call that finds it on (and, through a
    registry epoch bump at that deploy, for every repository in the watch set). Root `*.cue` files may have changed
    on trunk with nobody's sign-off while it was off, so the repository drops its trunk config history (bases before
    the tip then read `expired`, or `none` when there was no history), opens the tip's row `pending` (readers wait,
    never `none`) and evaluates it. That row's config is not repo policy until a Maintainer applies it ("Apply trunk
    config", or a signed Advance supersedes it): readers get the last good config, not exact, so review routes every
    change to a person and CI plans zero-config; installations wait as `needs-apply`. A repository with no Tartan
    config at the tip reads no config once that evaluation ran. If trunk did not move while the switch was off, only
    the registry changes made meanwhile are re-evaluated.
- **Upgrading CUE** means bumping the version, both sha256 values and the evaluator id together. Repositories
  re-evaluate lazily.
- **Capacity:** two more sandboxes (`cue:trunk`, `cue:preview:0`), asleep when idle, each running one job at a time on
  the runner's instance type.

## Limits

| Limit                     | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| Files                     | 32 root `.cue` files of any package, 64 KiB each, 256 KiB in total          |
| Exported JSON             | 256 KiB, depth 32                                                           |
| Issues                    | 256 per evaluation, 4 KiB per message                                       |
| Stderr read               | 64 KiB                                                                      |
| Evaluation wall clock     | 10 s, then SIGKILL                                                          |
| Address space             | 2 GiB                                                                       |
| Host deadline per attempt | 75 s with a container start, 30 s otherwise                                 |
| Package `config.cue`      | 64 KiB                                                                      |
| Previews                  | one in flight per principal; a per-principal hourly budget; a bounded queue |
| Cache                     | 50 entries per repository plus the applied one and the kept history rows    |
| Trunk config history      | 50 rows per repository                                                      |

The file, deadline, preview and history numbers are starting values, to be tuned from the first live runs.

## Alternatives considered

| Option                                                                             | Outcome     | Reason                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUE compiled to WebAssembly in a Worker                                            | deferred    | Upstream's module loader does not build for that target, so the package loader would be hand-written and could disagree with the CLI on file selection. An in-isolate evaluator cannot be stopped by a process kill. It may replace the CLI later, on every path at once, behind the same contract |
| A Wasm preview evaluator beside the CLI                                            | rejected    | Two evaluators can disagree, so a preview could pass where trunk fails                                                                                                                                                                                                                             |
| CUE inside a Durable Object or the forge Worker                                    | rejected    | Untrusted evaluation would share the forge's memory and its blast radius                                                                                                                                                                                                                           |
| Rust bindings (cgo-based) compiled to Wasm                                         | rejected    | They link the Go implementation through cgo, which no Wasm target can link                                                                                                                                                                                                                         |
| Native Rust CUE implementations                                                    | rejected    | Not yet complete enough: closedness through imports and error positions are missing                                                                                                                                                                                                                |
| JavaScript CUE packages                                                            | rejected    | None embeds a current CUE release                                                                                                                                                                                                                                                                  |
| `cue vet` in the repository's own CI                                               | rejected    | The registry must not depend on a pipeline the repository can edit                                                                                                                                                                                                                                 |
| Committed, pre-exported JSON                                                       | last resort | The forge would not evaluate CUE, and the two files would drift                                                                                                                                                                                                                                    |
| A TypeScript subset of CUE                                                         | rejected    | Tartan would carry the conformance burden                                                                                                                                                                                                                                                          |
| A `.tartan/` directory of config files                                             | superseded  | Tartan config is an ordinary CUE package in the root, beside other tools' packages, organised as the team likes                                                                                                                                                                                    |
| A kernel parser of package clauses, so only package `tartan` files need a sign-off | rejected    | It would be a second loader; where it disagreed with the CLI, a configuration change could land without a person                                                                                                                                                                                   |
| The project list inside `tartan.ci`'s pipeline                                     | rejected    | The project graph is a kernel service with five readers; its configuration must not depend on which CI provider is installed                                                                                                                                                                       |
| Fetching registry imports inside the job                                           | deferred    | The job has no network; a read-only module cache prepared by the forge is the follow-up                                                                                                                                                                                                            |

## Projects in a monorepo

Planned separately: each project root will carry the same package `tartan`. CUE's loader already unifies a package's
files from the module root down to a package directory, which is one way a project's config could compose with the
repository's.

**Gate condition for any per-project config:** the change that first reads `*.cue` files at a project root as policy
also widens `isPolicyPath`, the evaluator's input set and the policy digest to them (every `*.cue` file at a project
root of the trunk-base graph, or every `*.cue` file), keeps the project graph that decides it trunk-derived, and adds
a regression test that a project-root edit needs a sign-off. Until then nothing reads project-root `*.cue` files as
policy, so an edit to one is an ordinary change.

## Testing

- **Deno unit tests:**
  - the CUE corpus through the contract with the real CLI (`CUE_BIN`), for valid, invalid and pathological inputs;
  - package selection by the CLI: a root with `package tartan` files beside another package that imports an
    unreachable module, `_`-prefixed, `_tool`, `_test`, `@if` and package-less files evaluates to the `tartan` files
    only, and a root with no `package tartan` file exports `{}`;
  - the schema layout, including unset optional overlay fields, settings and repo policy in one closed entry, and an
    unknown top-level field denied as `shape`;
  - each file rule, including a U+2028 name, a symlink named `*.cue` and the size limits counted across packages;
  - each refused import (registry, the repository's own module, the job's module), named in `INVALID_INPUT`;
  - input-key stability: an edit outside the root `*.cue` files gives the same key, an edit to another package's root
    file gives a new key and a no-op apply;
  - every registry denial on input that CUE accepts;
  - overlay isolation, and repo policy changing nothing in resolution;
  - the sign-off, with a fake auto-approving review provider, agent and PAT refusal, head binding, revocation,
    `policy-batch` and `config-plan-changed`;
  - repo policy at a base: exact, last good, pending, none and expired; a lane head refused; CI planning from the base
    pipeline (a change rewriting its own pipeline to `run: "true"` is tested with the base one); review routing a
    change that lowers its own owners sensitivity to a person; the project graph at a lane head using its base's
    projects;
  - every state transition, including injected `null` and empty reads, and each trunk move outside the Advance.
- **workerd tests:**
  - the apply fence (an older apply delivered last is refused);
  - approval binding after a version change, a move, an archive and a widened builtin;
  - timers not delayed by a slow sandbox;
  - previews never applying and never read as policy, and lane ownership;
  - a preview flood plus saturated CI that leaves a trunk evaluation within its deadline.
- **Container:** the corpus through `cueSubmit` in the runner image, the container healthy after every pathological
  case, and no token in the job environment.
- **Live,** before the switch goes on: cold and warm timings, the memory limit and the OOM backstop on the production
  architecture, no outbound network, and the demo end to end.

## Risks

- **Holding on an unavailable evaluator** trades availability for safety, per repository; "keep last-good" is the
  audited escape.
- **The sign-off adds a click** for every change to a root `*.cue` file, other tools' files included, until the
  evaluator can report which files it loaded.
- **No repository config while the switch is off.** The YAML files are retired, so a forge with the switch off (or
  deployed without containers) runs CI zero-config and review without owners rules.
- **Imports are limited** to the CUE standard library and `tartan.dev/ext` until a module cache exists; teams that
  share schemas across repositories have to inline them for now.
- **Overlays need an extension host change.** Without it, repository config still offers own installs and repo
  policy.
- **A shared preview sandbox** sees several repositories' files one after another, in per-job directories that are
  wiped and removed, with no token. A per-repository preview sandbox is the fallback if that is not enough for
  private repositories.
