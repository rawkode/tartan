# Projects

A repository has projects. There is no list of them anywhere: they are discovered from the tree, on every push to the
default branch, and cached by commit.

## What makes a project

A project is any directory other than the repository root that holds a `.cue` file whose package clause is
`package tartan`, under any filename (`forge.cue` by convention):

```cue
package tartan

name: "api"              // optional: the directory's name otherwise
deps: ["shared"]         // optional: other projects, by name

extensions: "rawkode.issues": enabled: false   // optional: on unless a project says otherwise
```

- `.cue` files the CUE loader skips by default do not count: `_`- and `.`-prefixed names, `*_tool.cue`, `*_test.cue`.
- The walk skips `.`- and `_`-prefixed directories, `node_modules`, `testdata`, `vendor`, `target`, `dist` and
  `cue.mod`. A nested `cue.mod` is not a boundary.
- Root `*.cue` files stay repository config ([`repo-config.md`](repo-config.md)), never a project.
- A project under a project keeps both; a path belongs to the longest root.
- A repository with no such directory has no projects in the graph; the UI shows it as one project named after the
  repository. Files no project claims belong to an implicit root project: a change to one counts as global.
- Workspace manifests (pnpm, npm, Deno, Cargo, `go.work`) name no projects and add no edges. They only contribute their
  lockfiles to the global files.

Addresses: `/` joins groups and repos, `:` joins a project to its repo (`oss/devtools/build/kiln:lsp`), and `/-/`
separates a page. These are the SPA's addresses (`web/src/router/address.ts`); the kernel's API only knows node paths and
repo ids. The Worker's asset layer redirects a path with a `:` to its `%3A` spelling, and the SPA puts the colon back in the
address bar when it loads.

## This is a textual read

The kernel never evaluates these files. It reads literal values with a small tokenizer, in the one-line and the block
form. Whatever is not a literal cannot be read, and the result is the safe one with a warning on the project:

| Written                                                 | Result                                    |
| ------------------------------------------------------- | ----------------------------------------- |
| `name: strings.ToLower("X")`                            | the directory's name, `computed-name`     |
| `deps: other` or `deps: ["a", other]`                   | the literal strings only, `computed-deps` |
| `deps: ["nope"]`                                        | dropped, `unknown-dep`                    |
| `extensions: "rawkode.issues": enabled: *false \| bool` | **enabled**, `extension-config-unread`    |
| `rawkode.issues` written anywhere else in the file      | **enabled**, `extension-config-unread`    |

So a CUE file that evaluates to `enabled: false` through a definition, a comprehension or an import still reads as
enabled here.

## Per-project config is not enforced

A project's `extensions` switch is on/off only, and **it is not policy-gated**. The ADR
([`design/ADR-repo-config-cue.md`](design/ADR-repo-config-cue.md)) says the change that first reads project-root `*.cue`
as policy must widen `isPolicyPath`, the evaluator's input set and the policy digest, and add a regression test that a
project-root edit needs a sign-off. None of that was done, by decision:

- An edit to a project's `.cue` file lands **without a sign-off**, through a lane like any other file.
- The switch scopes the Issues route for the UI (`extension_disabled`). It is not a security boundary: anyone who can
  land a change in the repository can flip it, and a repo-wide tool call still sees the whole repository.
- The graph that a lane's checks use is computed at the lane's own head, so a lane can change its own graph.

Do not describe this switch as enforced.

## The trunk push

A push that moves the default branch computes and caches the graph of its new commit, best effort: a failure is logged
and never fails the push, and the first read detects instead. Later reads of that commit do not read the tree again.
A push to any other ref does not change the graph at the trunk tip, and discovers nothing. An Advance has no such step:
the graph of a landed commit is detected on its first read. Discovery runs on forges with `TARTAN_PROJECTS=scan`
(`deploy --projects`, always in `deno task dev`), which also serves the project surfaces.

## Reading them

```text
GET /-/api/repos/<repoId>/projects[?sha=<trunk commit>]
```

Each project carries `{name, root, manifestPath, deps, extensions: {"rawkode.issues": {enabled}}}`, plus `slug`,
`dependents`, `nameSource` and `issues`.

An extension's tools are JSON for a session, with the same cookie, CSRF and role rules as other `/-/api` routes:

```text
POST /-/api/repos/<repoId>/ext/<extensionId>/tools/<toolName>
{"args": {…}, "project": "<project name>"}
→ {"result": …} or {"error": {"code": "…", "message": "…"}}
```

- 404 `not_installed`: no installation of the extension in force at the repository.
- With `project`: it must exist in the graph at the trunk tip (404 `not_found`), its root goes to the tool as
  `args.project`, and a project with the extension off gets 403 `extension_disabled`.
- Without `project`: the tool runs repo-wide, and any `args.project` the caller sent is dropped.
- The host's own role check applies. The router's refusals before the handler (401, CSRF) keep the shape of every
  other route: `{"error": "<code>", "message": "…"}`.

## Issues in a project

Issues (`rawkode.issues` 0.2.0) is installed on a repository, with one database per repository and one numbering. The
route above passes the project's **root path** to the tool, and that path is what an issue stores in its nullable
`project`. So a project's Issues are a filtered view of the repository's, and a repo-wide `list` shows them all.

- Changing `name:` keeps a project's issues, because the root did not change. The old name stops resolving: a project
  route with it answers 404 `not_found`.
- **Moving a project's directory loses its issues from the project's view.** The new root starts empty, and the project's
  `get`, `close` and `reopen` answer 404 for the old ones. They stay in the repository under the old path, reachable
  repo-wide. Nothing rewrites them, and there is no tool to refile one. A deleted project's issues stay the same way.
- **The switch and the project check are the route's, not the extension's.** The extension cannot see the graph. Over MCP
  `issues_create` stores whatever `project` the caller writes, including an unknown path or a project with Issues off, and
  an agent's repo-wide calls reach every issue.
- There is no in-place upgrade. Installing another version at a node with one in force is 409 `conflict`, and uninstalling
  deletes the data, so a repository on 0.1.0 cannot reach 0.2.0 and keep its issues through the API. Migration `0002` is
  additive and tested on a database with rows, but only a fresh install has run it on workerd.

## Trying it

```sh
nix develop -c deno task poc
```

This boots `deno task dev` on port 8801 (`--port` for another), runs setup and sign-in, builds and publishes
`rawkode.issues`, creates a sample hierarchy (`scripts/poc/sample.ts`), installs Issues, pushes each repository's history
directly to `main` as the Owner and opens sample issues through the route above. It prints the URL and how to sign in, and
stays up until Ctrl-C. State is in memory, so re-seeding is the same command again.

`nix develop -c deno task poc:proof --session .wrangler/poc/8801/session.json` then checks the result over HTTP.

`nix develop -c deno task poc:e2e --session .wrangler/poc/8801/session.json [--shots <dir>]` drives the same forge through
headless Chrome and stock git, as the Owner, as a contributor and anonymously. It adds to the seeded state, so like the
proof it runs once per forge, and the two should not share one.

The local IdP signs every browser in as the Owner, except a sign-in that carries an invite code, which is a new person for each
invite (`tools/dev/worker.ts`). That is how `poc:e2e` gets a contributor. It does not exist outside `deno task dev`.

## What the shell leaves out

The forge shell (`web/src/forge`) shows only what the kernel can answer. These have no backend here, so they have no
control, tab or link:

- changes and pull requests, CI status and releases;
- the settings matrix: Settings goes to Tartan's own node settings;
- an issue's notes, labels, affected projects, moves and "found in", since `rawkode.issues` has none of them;
- rollups of activity above a repo, or per project: Activity is one repo's event log, and a project shows its commits;
- a one-project clone command. `git clone` of the whole repo is what works;
- a page at `<repo>:root`. The implicit root project is a row linking to the repo's files, and issues with no project show
  only on the repo;
- installing Issues from the shell. A new repo has no Issues until it is installed through Extensions.

A number with no source is left out, not shown as 0: a stranger sees no issue counts, and a repo without Issues has none.

A repository can sit at any level, the top of the tree included: the sample's `dotfiles` has no group above it. A move
still needs a new parent, so nothing moves up to the top; create it there.
