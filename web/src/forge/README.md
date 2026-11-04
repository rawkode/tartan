# Forge shell

The address bar, resizable tree and pages at a forge address. It runs inside the Tartan SPA, under the same CSP as every other view. Tartan's own views (setup, sign-in, invites, extension settings, repo code, lanes, runs) are separate routes with their own header.

It reads the kernel through one module boundary: everything imports `data/index.ts`, and `data/store.ts` holds the tree and each repo's projects and issues for the life of the page, re-reading a copy once it is 30 seconds old. The kernel takes node paths for browsing and repo ids for projects, events and tools; only the store knows which. Anything with no source is left out, not faked: there are no pull requests, CI results or releases here.

Issues are `rawkode.issues` tools, called over `POST /-/api/repos/<id>/ext/rawkode.issues/tools/<tool>`. An address the kernel has no answer for shows "Nothing at that address".

## Model

- **One owner.** Only the owner creates groups and repos. Contributors can open issues. `<html data-role>` comes from the session and only decides which controls show; the kernel still authorises every action.
- **Addresses.** Groups and repos join with `/`, a project joins its repo with `:`, as in `oss/devtools/build/kiln:lsp`. `router/address.ts` splits them before anything reaches the kernel. The Jump box matches prefixes of each segment, so `o/d/k:l` finds that address.
- **Projects** are the non-root directories holding a `.cue` file in `package tartan`, discovered on every push to main and cached by commit. A repo with none is a single project. Files no other project claims belong to an implicit root project, which has no address of its own: its row on a monorepo links to the repo's files, and an issue with no project sits on the repo.

## URLs

`/-/` separates an address from a page on it.

| URL                                         | Page                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `/`                                         | Everything                                                       |
| `/oss/devtools/build`                       | Group                                                            |
| `/oss/devtools/build/-/projects`            | Every project below a group (also `/-/projects` for all of them) |
| `/oss/devtools/build/kiln`                  | Monorepo                                                         |
| `/oss/devtools/build/kiln:lsp`              | Project                                                          |
| `/oss/devtools/build/kiln:lsp/-/issues`     | Issues (also `/-/issues`)                                        |
| `/oss/devtools/build/kiln:lsp/-/issues/128` | One issue                                                        |
| `/oss/devtools/build/kiln:lsp/-/issues/new` | New issue                                                        |
| `/oss/devtools/build/kiln/-/activity`       | Activity, from the repo's event log                              |
| `/oss/-/new/repo`                           | New repo in a group (also `/-/new/repo` at the root)             |
| `/oss/-/new/group`                          | New group (also `/-/new/group` at the root)                      |
| `/-/design-system`                          | The design system gallery                                        |

## Design system

- `src/design-system/theme/academy.ts`: Rawkode Academy tokens, copied from the private `packages/design-system` package. Change values there first.
- `src/design-system/theme/recipes.ts`: Panda recipes, written against those tokens. `strictTokens` is on.
- `src/design-system/*.vue`: Vue components. Ark UI handles behaviour for `Select`, `Segmented`, `SplitPane` and `Field`, and for the Jump box and tree accordion in `src/forge`.

## Styles

Panda's CSS is in cascade layers, and unlayered CSS beats every layer. So Tartan's element rules sit in `tartan-base`, the lowest layer (`styles/base.css`), and Panda's preflight and element styles are scoped to `[data-forge]` (`panda.config.ts`). `styles/tokens.css` points the `--tt-*` tokens at the Academy values, so Tartan's views and `tartan-ui@1` documents match. `styled-system/` is generated and gitignored: `deno task codegen:web`.

No `:style` bindings (`test/source-audit.spec.ts`). A computed size uses `v-bind()` in a scoped `<style>`.
