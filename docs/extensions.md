# Extensions overview

Everything people think of as "the forge" is an extension on one public contract: work items, changes, conflict
radar, CI policy, review, the Weave (merge train), FIFO, boards, epics, the HUD, and third-party
policies. First-party extensions use exactly the contract that third-party ones use. This page is the overview;
the authoring guide is [`docs/ext/`](ext/README.md) (Rust and WASM in [`docs/ext/rust.md`](ext/rust.md)).

## Installed on the hierarchy

An extension is installed on a node (a user, group or repository) and applies to that node's subtree. For each
interface, **the nearest installation wins**, so the coordination protocol is data and differs per subtree:
`acme/platform/**` can run the Swarm pack (claims with footprints, lanes, radar, an affected-only Weave)
while `acme/docs` runs Classic (human approval, FIFO). A **pack** is such a set of installations.

Gates are the exception to "nearest wins": every `gate:ref.advance` on the path from the root to the repository runs
on every Advance, and a gate cannot be removed below the node that installed it.

A repository can also configure extensions from its own root CUE package `tartan`: the CI pipeline, the review owners,
its projects, overlays of settings an Owner opened to it, and installs of packages an Owner approved. Changes to it
land only with a person's sign-off; see [`repo-config.md`](repo-config.md).

## The contract

| Part                   | What it does                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest `tartan.json` | id, version, runtime, the interfaces it provides and requires, events, gates, slots, tools, capabilities and storage                        |
| Interfaces             | versioned, replaceable coordination contracts: `work@1`, `changes@1`, `conflicts@1`, `checks@1`, `review@1`, `queue@1`, `context@1`, …      |
| Events                 | ordered per repository, delivered by pull with pokes, with dedupe, retries and dead letters per installation                                |
| Gates                  | a yes or no on an Advance, with inputs prefetched; can run in **shadow** mode, be replayed against real history and be promoted             |
| Slots and actions      | server-driven UI (`tartan-ui@1` JSON) in named places of the SPA, and the actions behind its buttons                                        |
| Tools                  | MCP tools contributed to agents at the installation's scope                                                                                 |
| Capabilities           | what the extension may ask the kernel for (`KernelCaps`), granted at install time and re-checked on every call against the acting principal |
| Storage                | the extension's own SQL tables in its own Durable Object                                                                                    |

## Runtimes

- **builtin**: TypeScript in the Worker bundle, run inside the installation's own Durable Object. The first-party
  extensions use this.
- **js**: a JavaScript bundle loaded at runtime with Worker Loader, isolated per installation and package version.
- **wasm**: a WebAssembly component (for example a Rust policy gate) on the `tartan:ext` WIT world, loaded the same way.

Each installation scope has its own Durable Object, so a runaway extension stalls only itself, and a circuit breaker
and a kill switch stop it.

## First-party extensions

| Extension                | Provides                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| work, changes            | work items with claims and footprints; changes (the reviewable unit) and their revisions                     |
| radar                    | conflict prediction between lanes and trunk, delivered to `git push`, MCP results and the Lanes view         |
| ci                       | the pipeline in package `tartan` (`"tartan.ci": settings: pipeline`), affected-only job graphs, result reuse |
| review                   | risk scoring and review by exception, with an evidence bundle                                                |
| weave, fifo              | merge trains: affected sub-trains with real `merge-tree` composition, or first in first out                  |
| board, epics, hud, packs | Kanban and epics rebuilt from history, the swarm HUD, the Swarm and Classic packs                            |
