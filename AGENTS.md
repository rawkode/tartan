# Agent guidance for Tartan

Tartan is a self-deployable, agent-native Git forge on Cloudflare (Workers, Artifacts, Durable Objects, Workflows). One
deployment is one forge. License: **MIT** (`LICENSE`).

Sources of truth, in order:

1. [`docs/design/README.md`](docs/design/README.md): the design summary, the kernel invariants (K1–K17) and lanes
   (per-agent Artifacts repos created with `import()`, branch lanes as the fallback).
2. `packages/contract`: names, types and signatures.
3. The guides under [`docs/`](docs/README.md), starting with [`docs/architecture.md`](docs/architecture.md).

Work is split into work packages (WPs). In a maintainer checkout, the unpublished paths that `scripts/check-public.ts`
lists hold the full design notes and the WP plan; read what your WP lists before you write code. If code and design
disagree, raise it with the integrator (WP0). Do not quietly diverge.

## House style

- Tabs everywhere (`.editorconfig`), `deno fmt`, line width 80, markdown prose not rewrapped. YAML uses spaces.
- TypeScript strict, ES modules, explicit `.ts` extensions on relative imports.
- Functional modules: arrow functions, explicit dependencies, `createX(deps)` factories, immutable transformations.
- Classes only where Cloudflare requires them: `DurableObject`, `WorkerEntrypoint`, `WorkflowEntrypoint`, `RpcTarget`,
  and typed errors. Keep them as thin adapters that delegate to factory results. **RPC only exposes prototype members**,
  so declare RPC methods as `method() {}`, never as `method = () => {}`. workerd rejects the second form at call time.
- Hand-written `Env` interface (`src/env.ts`). No `wrangler types` codegen.
- No Effect, no Alchemy, no Drizzle. Use raw SQL with typed mappers.
- Runtime code never imports deploy tooling (`scripts/**`, wrangler).
- Never commit generated code, schemas, rendered docs or build outputs; commit their sources and generators. Generated
  contract JSON (`packages/contract/interfaces/*.json`, `schema/envelope-1.json`) comes from `deno task gen`. Lockfiles
  stay tracked.
- Keep only the current implementation: remove superseded code and fallbacks when replacing them (git has the history).

## Ownership and anti-conflict rules

Each WP works in its own git worktree. It writes only inside the paths it owns and reads anything. WPs consume each
other only through `packages/contract` types, facades and fakes.

1. **Shared files are integrator-only (WP0):** `wrangler.jsonc`, `package.json`, `package-lock.json`, `deno.json`,
   `tsconfig.json`, `vitest.config.ts`, `src/{index,env,router,builtins,constants}.ts`, `src/do/*.ts`,
   `packages/contract/**`, `scripts/{check,test,check-imports,check-public,render-config,license-check}.ts` and
   `.github/workflows/**`.
   If you need a dependency, binding, route, export or contract change, put a request block at the top of your PR
   description, for example `REQUEST: add dep foo@1.2.3 to package.json`. The integrator applies it in the next merge
   window.
2. **M0 pre-declares every cross-boundary item:** routes, DO facade getters, builtin ids, exported classes and SPA coord
   routes all exist as stubs. After M0, each stub file belongs to its owning WP.
3. **Migration number ranges** are fixed per module ("Data model" in `docs/design/README.md`). A migration outside your
   WP's range fails review.
4. **Thin DO classes.** Modules never call `setAlarm` and never implement `alarm()` or `webSocket*` themselves. They
   register with the WP0 `timers` API and the WebSocket dispatch table. In-DO cross-module calls use each module's
   synchronous `internal` API.
5. **Extensions import only `@tartan/contract`, `@tartan/ext-api`, and relative paths inside the same extension.**
   `deno task lint` enforces this (`scripts/check-imports.ts`).
6. **Bindings:** anything added to `wrangler.jsonc` is added to the inline miniflare options in `vitest.config.ts` in the
   same commit. The exceptions are `durable_object_io_tasks_prevent_eviction` and any compatibility date after
   2026-08-22: the vitest pool's workerd rejects both, so they go in the deployed config only. The global log's `k2`
   producer binding and its Secrets Store token are rendered per stage only (`render-config.ts --k2-stream`): the
   vitest pool's miniflare has no K2 plugin, so tests inject FakeK2 (`@tartan/testkit`).
7. **No secrets** in the repo, logs or evidence. `.dev.vars` is gitignored, and `.dev.vars.example` holds only empty
   placeholders. Smoke evidence is leak-scanned before it is shared.
8. **Public content.** Private notes and evidence never enter the repo, and the unpublished paths never enter a public
   snapshot. `scripts/check-public.ts` (part of `deno task lint`) fails on terms reserved for private notes. The term
   list is private too (`.private/public-terms.json` in the main checkout); hits name a term only by its number.
9. **Publishing.** The private history (`main` and the work branches) is never pushed. `deno task publish -- --push`
   commits a checked snapshot of `main` (without the unpublished paths) on the local `public` branch and pushes it to
   `origin main` (the public repository), never forced. Snapshots carry a public noreply identity (`--identity`,
   `TARTAN_PUBLISH_IDENTITY` or `git config tartan.publishIdentity`), never your git identity. Publish after every
   landing on `main`; never `git push` `main` or a work branch. A push also needs a leak review of the snapshot
   (the integrator records it); without one, publish commits locally, exits 2 and prints the diff to review.

Status: each WP writes only its own status file, and WP0 assembles them; neither is published. Only the
integrator commits to `main`.

## Dependencies

- npm owns dependencies: `package.json` and `package-lock.json`, with **exact pins** (no `^`/`~`). Deno reads the same
  `node_modules` (`"nodeModulesDir": "manual"`). There is no `deno.lock` and no second package manager.
- Workspace packages (`@tartan/*`) resolve from source. The mapping lives in three places that must stay in sync:
  `deno.json` `imports`, `tsconfig.json` `paths` (wrangler's esbuild uses it to bundle), and the `vitest.config.ts`
  aliases.
- `deno task license:check` (also run in CI) fails on GPL, AGPL or LGPL-only npm or Cargo dependencies. The only
  tolerated exceptions are reviewed, dev-only packages listed in `scripts/license-check.ts` (`DEV_EXCEPTIONS`; today
  that is miniflare's optional libvips binaries). The `git` binary in the runner image is a separate program and is
  not linked.

## Disk hygiene (the dev machine is short on space)

- Run `df -h /System/Volumes/Data` before any install or build. Stop and report if less than 1.5 GB is free.
- One `npm ci` in the main checkout only. Worktrees **symlink** that `node_modules`; never install inside a worktree
  or a package directory. Never `npm pack` into the repo.
- Rust uses one shared `CARGO_TARGET_DIR`. Container images are built only by the integrator, or not at all.
- Delete temporary build outputs (`dist/`, `.wrangler/tmp`, `--outdir` bundles) when you finish. Keep scratch files
  outside the repo.

## Verification ladder

Prerequisites: Deno 2.9 and Node 22. Run `npm ci` once.

| Task                                          | Runs                                                                                                                                                        | Proves                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `deno task gen`                               | `packages/contract/scripts/gen-schemas.ts` + `deno fmt` of its output                                                                                       | generated contract JSON (needed by the tests)     |
| `deno task fmt:check`                         | `deno fmt --check`                                                                                                                                          | formatting (tabs)                                 |
| `deno task lint`                              | `deno lint` + `scripts/check-imports.ts` + `scripts/check-public.ts`                                                                                        | lint, the import boundary, public-content grep    |
| `deno task check [path…]`                     | `scripts/check.ts`: one `deno check` per unit (`src/`, each `packages/*`, `extensions/*`, `tools/*`, `scripts/` with root configs); empty units are skipped | types (workers-types)                             |
| `deno task test [path…]`                      | `scripts/test.ts`: one `deno test -A` over every `*.test.ts` under the paths (default `src packages extensions tools scripts`)                              | pure modules (`node:sqlite` fakes, FakeArtifacts) |
| `deno task test:workers [--project p]`        | vitest 4.1.11 + vitest-pool-workers 0.22.0, inline miniflare, compat 2026-08-15                                                                             | DOs, Workflows and entrypoints in workerd         |
| `deno task check:web` / `deno task build:web` | `vue-tsc --noEmit -p web` / `vite build web`                                                                                                                | SPA types and build                               |
| `deno task dryrun`                            | `scripts/render-config.ts` + `wrangler deploy --dry-run`                                                                                                    | config and bundle validity (no Docker, no auth)   |
| `deno task dryrun:k2`                         | `dryrun` with the global log bindings rendered (a dummy stream and store id)                                                                                | the K2 config and bundle                          |
| `deno task e2e`                               | `scripts/e2e/main.ts`: tester-army/e2e on stage `dev-e2e` with the mock IdP, no model, telemetry off (`docs/testing/e2e.md`)                                | the deployed forge end to end (live)              |
| `deno task license:check`                     | `scripts/license-check.ts`                                                                                                                                  | no GPL/AGPL/LGPL-only dependencies                |
| `deno task verify`                            | gen, fmt:check, lint, check, test, license:check                                                                                                            | the fast local subset                             |
| `deno task check:public:history`              | `scripts/check-public.ts --history`: the terms over every commit of the published lineage (`public`, `origin/main`), messages and identities included       | the published history is clean                    |
| `deno task publish [-- --push]`               | `scripts/publish.ts`: snapshot of `main` without the unpublished paths, checked, committed on `public`, pushed to `origin main`                             | what the public repository receives               |

Test file conventions:

- `*.test.ts`: Deno unit tests. They run under `deno task test` and must not import `cloudflare:*`.
- `*.workers.test.ts`: workerd tests. Only vitest runs them; `deno test` excludes them. vitest projects partition them
  by owning area: `core` (`src/*`, `src/do`, `packages`), `identity` (`kernel/identity`, `kernel/http`), `tree`
  (`kernel/tree`, `kernel/browse`), `gateway`, `repo` (`kernel/repo` except `lanes/repo-backend`, `kernel/ingest`,
  `kernel/repoconfig`), `repo-backend` (`kernel/repo/lanes/repo-backend`), `events` (`kernel/events`, `kernel/inbox`;
  run alone), `exthost` (`kernel/exthost`, `kernel/caps`; the WASM runtime's workerd test is
  `kernel/exthost/host/facet/dynamic.workers.test.ts`), `probe`, `runs`, `land`, `mcp`, `swarm` (run alone last), `bus`
  (`kernel/bus`, the global log), `extensions` (`extensions`, `kernel/projects`; run alone), and `conformance` (the slot
  conformance test, `kernel/exthost/api/slot-conformance.workers.test.ts`, run alone). The `web` project runs the SPA's
  specs, the coordination views' included. `vitest.config.ts` `GROUP_ORDER` has the order.

Live tasks (`deploy`, `destroy`, `smoke`, `live`, `build:ext`, `e2e`, `seed`, `reset`) act on a deployed stage. Only
deploy `dev` or `dev-*` stages. Never deploy production, and never delete anything outside a dev stage.

Match the evidence to the claim. A formatter pass, type check, unit test, workerd test, dry run, deploy and live smoke
each prove different things. Report the commands you ran and their results, and say what you did not check.
