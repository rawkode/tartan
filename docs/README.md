# Tartan documentation

Start with the [README](../README.md): what Tartan is, why it is agent-native, the status of each feature, the
one-command deploy and how to connect an agent.

## Using Tartan

| Page                                           | For                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`concepts.md`](concepts.md)                   | the coordination model: lanes, claims and footprints, conflict radar, the Weave, Advances, why-notes, protocol packs, scoped MCP |
| [`connecting-agents.md`](connecting-agents.md) | connecting Claude Code, Codex CLI or any MCP client: agent tokens, MCP, `/-/agents.md` and the lane flow with stock git          |
| [`agents/quickstart.md`](agents/quickstart.md) | the quick reference: the `tartan` CLI, what the forge refuses, troubleshooting                                                   |
| [`repo-config.md`](repo-config.md)             | repository config: the root CUE package `tartan` (pipeline, owners, projects, extensions)                                        |
| [`limits.md`](limits.md)                       | push, import and lane limits, and where each is enforced                                                                         |

## Running a forge

| Page                     | For                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| [`deploy.md`](deploy.md) | deploying, upgrading and destroying a forge: every step, flag, secret and preflight check |

## Extending Tartan

| Page                             | For                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`extensions.md`](extensions.md) | writing an extension: the manifest, hooks, events, gates, slots, `tartan-ui@1`, capabilities, a JavaScript example |
| [`ext/README.md`](ext/README.md) | building, publishing, replaying and promoting a `js` or `wasm` package, and testing it                             |
| [`ext/rust.md`](ext/rust.md)     | the Rust SDK `tartan-ext` for `wasm` extensions                                                                    |

## Design and development

| Page                                                             | For                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`design/OVERVIEW.md`](design/OVERVIEW.md)                       | the design overview: principles, kernel invariants, data model, lanes, flows, security    |
| [`design/README.md`](design/README.md)                           | the short design summary, and the kernel invariant ids (K1–K17) that source comments cite |
| [`architecture.md`](architecture.md)                             | how the Worker, Durable Objects, Workflows, Artifacts and containers fit together         |
| [`design/ADR-repo-config-cue.md`](design/ADR-repo-config-cue.md) | the decision record for repository config in CUE                                          |
| [`testing/e2e.md`](testing/e2e.md)                               | the end-to-end harness: a deployed forge driven through a browser, MCP and stock git      |

Working on the code itself: [`../AGENTS.md`](../AGENTS.md) (house style, ownership rules, the verification ladder).
The product view: [`../PRODUCT.md`](../PRODUCT.md). Names and signatures: `packages/contract` is the source of truth.

## Maintainers

| Page                   | For                                                                              |
| ---------------------- | -------------------------------------------------------------------------------- |
| [`SMOKE.md`](SMOKE.md) | how to run the smoke suites, locally or against throwaway Workers on a dev stage |
