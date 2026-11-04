# Repository config: the CUE package `tartan`

A repository configures its CI pipeline, its review owners, its global files and some of its extensions in
[CUE](https://cuelang.org), in an ordinary CUE package named `tartan` in the repository root. The forge evaluates it
with the official `cue` command-line tool (v0.17.1) in a sandbox, checks the result, and applies it from the
default branch only. Design: [`design/ADR-repo-config-cue.md`](design/ADR-repo-config-cue.md).

> **Spike branch (`spike/strip-down`).** The CI pipeline (`tartan.ci`), review owners (`tartan.review`) and Weave
> settings below came from first-party extensions that this branch removed. What stays is the kernel's part: the root
> package `tartan`, its evaluation, previews and sign-offs, and the `global` key.

> **Projects are not configured here.** They are discovered from `package tartan` files in non-root directories
> ([`projects.md`](projects.md)); a `projects` key here names nothing. Those files are read textually, are **not**
> evaluated by this page's pipeline and are **not** policy-gated: a project-root `.cue` edit lands without a sign-off.
>
> **An Owner's direct push is outside all of this.** It takes no sign-off, even for a root `*.cue` file, and the config
> in force does not follow it ([`limits.md`](limits.md#owner-pushes)). `deno task dev` keeps repository config off for that reason.

Repository config is **off** unless the forge was deployed with `--repo-config` ([`deploy.md`](deploy.md)). While it
is off, nothing is evaluated: CI runs zero-config and review has no owners rules.

## Writing it

Tartan config is every `*.cue` file directly in the repository root whose package clause is `package tartan`. Name and
split the files as you like. Files of other packages in the same directory (for example a cuenv `env.cue` with
`package cuenv`) are left alone, and subdirectories are never read by this config (a `package tartan` file there makes
a [project](projects.md)). The `cue` tool decides which files belong to
package `tartan`, with its own rules (`_`-prefixed names, `*_tool.cue`, `*_test.cue` and `@if(…)` attributes
included).

```text
tartan.cue    package tartan: global files, extension installs and overlays
ci.cue        package tartan: extensions: "tartan.ci": settings: pipeline {…}
review.cue    package tartan: extensions: "tartan.review": settings: owners {…}
env.cue       package cuenv: another tool's file, left alone
```

```cue
package tartan

extensions: "tartan.ci": settings: pipeline: {
	timeout: "15m"
	jobs: {
		install: run: "pnpm install --frozen-lockfile"
		lint: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm lint", optional: true}
		test: {needs: ["install"], each: "affected", cwd: "{{project.root}}", run: "pnpm test"}
	}
	on: {change: ["install", "lint", "test"], land: ["install", "test"]}
	lanes: ci: "on-submit"
}
```

```cue
package tartan

extensions: "tartan.review": settings: owners: rules: [
	{paths: ["services/api/**"], sensitivity: 2, owners: ["@platform"]},
]
```

```cue
package tartan

global: ["package.json", "pnpm-lock.yaml"]

// Weave is installed above this repository and its Owner allowed repo overrides.
extensions: "tartan.weave": settings: batch: 2
```

Hidden fields and definitions are not exported. Without a pipeline, CI keeps its zero-config detection.

## What it can set

| Top-level field | Meaning                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `global`        | globs whose change affects every project (root `*.cue` files always do)                                      |
| `extensions`    | one entry per extension id; what an entry may hold depends on the extension's place in the hierarchy (below) |

Any other top-level field is refused.

| Entry kind  | When                                                                                                                            | May set                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| repo policy | the extension is in force for the repository and declares repo-policy keys (`tartan.ci`: `pipeline`; `tartan.review`: `owners`) | `settings` with those keys; nothing is installed                                       |
| overlay     | an installation above the repository whose Owner turned on "allow repo overrides"                                               | `settings` with the keys its manifest marks overridable (Weave: `batch`, `debounceMs`) |
| own install | an Owner approved the package for this repository or a group above it, and it is installed nowhere above                        | `enabled`, `mode` (`enforce` or `shadow`) and `settings`                               |

Repository config can never install a provider of an interface (review, queue, checks), a pack, or anything an Owner
did not approve, and it can never disable, shadow or reconfigure an inherited gate beyond the keys above. CUE gives
shape, defaults and `file:line:col` errors; the forge checks every rule again on the result.

## Imports

Package `tartan` may import only the CUE standard library and `tartan.dev/ext` (the forge's schema). The repository's
own `cue.mod/` is never used, and nothing is fetched from a registry. Any other import fails with a message naming the
file, the position and the import. Repository-local and registry imports are planned.

## Checking it before you push

```sh
tt config schema --repo acme/platform/api --out /tmp/tartan-schema
cp *.cue /tmp/tartan-schema/ && cd /tmp/tartan-schema
CUE_REGISTRY=none cue export -E --out json .:tartan
```

That prints exactly what the forge evaluates. In the repository itself, `cue export .:tartan` gives the same values
without the forge's closedness checks.

On a lane, `tt config vet --repo <path> --lane <id>` (or the MCP tool `repo_config_preview`) evaluates the lane head and shows
the plan, the CUE errors and the forge's denials. The MCP tools `repo_config_get`, `repo_config_schema` and
`repo_config_result` read the state, the schema and a preview's result.

## How a change lands

- **A person signs off.** A change that touches any root `*.cue` file, of any package, needs a Maintainer's
  **Approve policy change** on the change page's "Repo config" card. The sign-off names the lane head and its root
  `*.cue` files; a new push needs a new one. Agents, tokens and review extensions cannot sign off. At most one such
  change lands per batch.
- **Policy is read at the base.** CI, review and the global files read the config in force at each change's base on
  the default branch, never the lane's own version.
- **Lands wait for the new config.** After a config change lands, other lands of that repository wait until it has
  been evaluated and applied. If it fails, the last good config stays in force and the settings page shows the
  errors; CI plans with the last good pipeline and review sends every change to a person until it is fixed.
- **Trunk moved another way** (an import, a reconciled ref): repo policy follows at once, and installations wait for a
  Maintainer's **Apply trunk config**.

**Repository → Config** (`/<repo>/-/settings/extensions`) shows the state, what applied it and who signed off, the
root `*.cue` files the forge read, errors with links to their lines, the effective extensions and where each comes
from, the repo policy in force, the approvals, and the schema. An Owner can **Keep last good** to release a hold.

## Limits

| Limit                | Value                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| Root `.cue` files    | 32 files of any package, 64 KiB each, 256 KiB in total                                  |
| File names           | ASCII letters, digits, `_`, `.` and `-`; regular files only (no symlinks or submodules) |
| Exported JSON        | 256 KiB, nesting depth 32                                                               |
| Errors shown         | 256 per evaluation, 4 KiB per message                                                   |
| Evaluation           | 10 s wall clock, then killed; 2 GiB of address space; no network                        |
| Previews             | one lane in flight per agent or person, an hourly budget, a bounded queue; retried      |
| Trunk config history | the newest 50 changes of the config per repository                                      |

The file, preview and history numbers are starting values.

## Moving from `.tartan/`

| Was                                                      | Now                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.tartan/pipeline.yaml` `timeout`, `jobs`, `on`, `lanes` | `extensions: "tartan.ci": settings: pipeline: {…}`                        |
| `.tartan/pipeline.yaml` `global`                         | top-level `global`                                                        |
| `.tartan/owners.yaml` `rules`                            | `extensions: "tartan.review": settings: owners: rules: [{paths: […], …}]` |
| `version: 1`                                             | dropped: the forge versions the schema                                    |

The forge reads nothing under `.tartan/`; the settings page shows a reminder while the default branch still has one.
