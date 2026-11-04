# t21

Mockup UI for a single-user Git forge. Astro, static mock data, no backend.

```sh
bun install
bun run dev
```

Specs and change proposals live in `openspec/`, managed with [OpenSpec](https://github.com/Fission-AI/OpenSpec) (`bun x --bun openspec`).

## Model

- **One owner.** Only the owner creates groups and repos, and sees settings. Registered contributors can open issues and changes, and add notes. Use "View as" to switch between them.
- **Addresses.** Groups and repos join with `/`, a project joins its repo with `:`, as in `oss/devtools/build/kiln:lsp`. The Jump box matches prefixes of each segment, so `o/d/k:l` finds that address.
- **Projects** come from `.forge/projects.cue` in the repo, each on its own path. A repo without that file is a single project. `root` holds files no other project claims. The Projects tab on the root and on every group lists all the projects below it.
- **Issues** belong to one project and are numbered per project (`kiln:lsp#128`). They can move, and the old address redirects.
- **Changes** belong to a repo and are numbered per repo (`kiln!412`). They list every project they edit or rebuild, and each edited project is reviewed separately.
- **Settings** inherit down the tree. For a value, the nearest level wins unless a level above locked it. For a list, each level adds and can drop.

## URLs

`/-/` separates an address from a page on it. The app is one Vue island on a statically built page per address, so links work on a fresh load.

| URL | Page |
| --- | --- |
| `/` | Everything |
| `/oss/devtools/build` | Group |
| `/oss/devtools/build/-/projects` | Every project below a group (also `/-/projects` for all of them) |
| `/oss/devtools/build/kiln` | Monorepo |
| `/oss/devtools/build/kiln:lsp` | Project |
| `/oss/devtools/build/kiln:lsp/-/issues/128` | One issue |
| `/oss/devtools/build/kiln/-/changes/412` | One change |
| `/oss/devtools/build/kiln/-/settings` | Settings at that level (also `issues`, `changes`, `activity`) |
| `/oss/-/new/repo` | New repo in a group (also `new/group`) |

Sample data is in `src/data/forge.ts`, settings logic in `src/data/settings.ts`. Actions change `src/data/store.ts`, which lives in memory, so a full page load resets them.

## Design system

Browse it at `/design-system`.

- `src/design-system/theme/academy.ts`: Rawkode Academy tokens, copied from the private `packages/design-system` package. Change values there first.
- `src/design-system/theme/recipes.ts`: Panda recipes, written against those tokens. `strictTokens` is on.
- `src/design-system/*.vue`: Vue components. Ark UI handles behaviour for `Select`, `Segmented`, `SplitPane` and `Field`, and for the Jump box and tree accordion in `src/components/forge`.

The layout comes from the "Personal Git Forge" design canvas. Its colours and fonts are replaced with Academy tokens.
