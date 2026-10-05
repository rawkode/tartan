# Smoke tests

The smoke suites check what only the platform can tell us: how Artifacts, Workflows, Dynamic Workers and containers
behave on the edge. Each check prints `PASS` or `FAIL` with its numbers and the switch or design fact it decides, and
is kept as JSON evidence. This page says how to run them and lists their state. A result changes a switch only after
review.

## Layout

| Path                              | What                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `scripts/smoke/run.ts`            | The runner behind `deno task smoke`                                                                   |
| `scripts/smoke/suites/git.ts`     | A1–A5, S4b, U45–U48, S3-raw, the FakeArtifacts conformance run (`CONF`)                               |
| `scripts/smoke/suites/lanes.ts`   | U51–U55, U57, U59 and the capability-route security probes (`CAP`)                                    |
| `scripts/smoke/suites/box.ts`     | S7, S8, S11                                                                                           |
| `scripts/smoke/suites/runtime.ts` | S6: B1–B5 and Tails                                                                                   |
| `scripts/smoke/worker-git/`       | `tartan-smoke-git`: binding ops, a minimal gateway, a synthesized-`ng` route, the push-event Workflow |
| `scripts/smoke/worker-lanes/`     | `tartan-smoke-lanes`: the v1 capability route (`/-/cap/v1/…`) and imports                             |
| `scripts/smoke/worker-box/`       | `tartan-smoke-box`: a Sandbox subclass, S8 land scripts, the AI judge                                 |
| `scripts/smoke/worker-runtime/`   | `tartan-smoke-rt`: Dynamic Workers, facets, tails; `wasm/` is B2's Rust module                        |
| `scripts/smoke/lib/`              | Evidence recorder, leak scan, git runner, shared binding ops                                          |

The smoke Workers are throwaway and never part of the product Worker or its `wrangler.jsonc`. Every Worker, Workflow,
Artifacts namespace and repo they create starts with `tartan-smoke-`.

## Running

Local (no account, no network beyond loopback): the drivers run against the smoke Workers' handlers in process, with
`@tartan/testkit`'s FakeArtifacts behind them and stock git on loopback ports. This proves the drivers and handlers
work. It says nothing about the platform.

```bash
deno task smoke -- --local                       # git and lanes suites
deno task smoke -- --local --only U59,CAP        # selected checks
```

Live, against your own account (only `dev` or `dev-*` stages; never production):

```bash
deno task smoke -- --stage dev --suite git,lanes --deploy        # deploy the smoke Workers, then run
deno task smoke -- --stage dev --suite git --only U45,U46,U47,U48,S3-raw
deno task smoke -- --stage dev --suite runtime --deploy
deno task smoke -- --stage dev --suite box --deploy               # classic image (S7a only)
deno task smoke -- --stage dev --suite box --deploy --box-dockerfile   # builds the image: integrator only
deno task smoke -- --stage dev --suite git,lanes --teardown       # delete tartan-smoke-* repos and Workers
```

- Keys live in `scripts/smoke/.dev.vars` (gitignored, mode 600): `SMOKE_KEY` (the drivers' key) and `LANE_CAP_KEY` (the
  lane smoke Worker's dedicated capability key). They are generated on first use, put as Worker secrets by `--deploy`,
  and never printed. Deployed URLs are kept there too.
- Credentials never go into remote URLs. git gets them per command as `http.extraHeader`, so no `.git/config` holds a
  secret.
- Evidence goes to `scripts/smoke/evidence/<date>/<suite>-<stage>.json` (gitignored), redacted with the contract's
  `redactSecrets`. The runner leak-scans it at the end. Run the scan by hand before sharing anything:
  `deno run -A scripts/smoke/lib/leakscan.ts`. It fails on Artifacts tokens in any version (including the live
  `art_v2_x_…?expires=…` shape), unredacted `/-/cap/` paths, credentials in URLs or Authorization headers, smoke keys,
  and any `.git/config` or `.dev.vars` file in the evidence tree.
- Teardown deletes the repos and the Workers. wrangler has no command for an empty Artifacts namespace; delete it with
  `DELETE https://api.cloudflare.com/client/v4/accounts/<account>/artifacts/namespaces/<namespace>` and the token from
  `npx wrangler auth token --json` (never echo it).
- The lane smoke Worker and its repos are deleted when its probes are done.

## State

Status key: **local** means the check passed in `--local` mode against FakeArtifacts (driver and handler verified, the
platform not); **remaining** means it has not run live yet. No live run happened in the WP1 M1 wave.

| ID                | Check                                                                                                                                                                                                          | Decides                           | State                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| A1                | Token shape and TTL bounds, push with Bearer and Basic, `ls-remote` auth matrix, read-token push refused, binding reads, `lastPushAt` null, mint latency                                                       | `UPSTREAM_AUTH`, token cache      | local; live (before the port)                        |
| A2                | Name lengths (lane repos need 57), case folding, characters, `delete(missing)`                                                                                                                                 | Artifacts names                   | local; live                                          |
| A3                | 401 before the body, clones v2/v1/v0 through a gateway, no pack without credentials, push sizes, multi-ref, delete, gzip upload-pack, latency                                                                  | gateway shape                     | local; live                                          |
| A4                | `readCommit` drops headers, notes by SHA, ref spellings (K15), header survives clones                                                                                                                          | K15                               | local; live                                          |
| A5                | One push event per ref update, no duplicates, commit caps                                                                                                                                                      | `TRIGGER_ENABLED`, `WAIT_MODE`    | local (fake trigger); live                           |
| S4b               | Binding reads at a sustained rate                                                                                                                                                                              | `REPO_READER_LIMITS`              | local; live                                          |
| U45               | `refs/heads/Lanes/x` next to `refs/heads/lanes/y`                                                                                                                                                              | case-folded lane refs             | local; remaining                                     |
| U46               | Ref-only create with an empty pack                                                                                                                                                                             | kernel ref-only writes            | local; remaining                                     |
| U47               | Stock git's `ref-prefix` for a lane fetch and an `ls-remote` pattern                                                                                                                                           | hidden-namespace filtering        | local; remaining                                     |
| U48               | Raw receive-pack: wrong old SHA, create of an existing ref                                                                                                                                                     | ref compare-and-swap              | local; remaining                                     |
| S3-raw            | Stock git shows a synthesized 200 report-status `ng` and band-2 lines (plain, `--porcelain`, `-q`)                                                                                                             | `ECHO_ENABLED` pre-check          | local; remaining                                     |
| CONF              | FakeArtifacts conformance (C1–C6) against a deployed binding                                                                                                                                                   | testkit fidelity                  | local; remaining                                     |
| U51               | Import round trip by size                                                                                                                                                                                      | `LANE_IMPORT_MAX_BYTES`           | local (small sizes); remaining                       |
| U52               | Import idempotency and races (informational)                                                                                                                                                                   | none                              | local; remaining                                     |
| U53               | Revoking the import's 24 h token                                                                                                                                                                               | K11                               | local; remaining                                     |
| U54               | Concurrent imports into a populated namespace, `list()` paging, delete rate                                                                                                                                    | `MAX_ACTIVE_LANES_REPO_BACKEND`   | local (small); remaining                             |
| U55               | Trunk moved after minting: 503, or the pinned base served                                                                                                                                                      | `LANE_CAP_PIN_BASE`               | local; remaining                                     |
| U57               | Push events for imported repos (informational)                                                                                                                                                                 | IngestWorkflow seed mapping       | local; remaining                                     |
| U59               | A `master` trunk imports as exactly `HEAD` → `refs/heads/main`                                                                                                                                                 | non-`main` repos on `import`      | local; remaining                                     |
| CAP               | Forged, expired and non-upload-pack requests are 404 with zero state calls; the advertisement is only `HEAD` → `refs/heads/main`; the single-want parser; single-use pack requests; per-request tokens revoked | capability route                  | local; remaining                                     |
| S6 (B1–B5, Tails) | Dynamic Workers, WASM by bytes, capabilities, facets, limits, concurrency, tails                                                                                                                               | `EXT_DYNAMIC_ENABLED` and breaker | ported; live (before the port); not runnable locally |
| S7, S8, S11       | Containers, land ops in a sandbox, AI judge                                                                                                                                                                    | `IMAGE_VARIANT`, U7/U8, U26       | ported; live (before the port); not runnable locally |

Not ported or not yet written: B8 (a jco component built outside this repo; WP17's WASM SDK covers that path), S1,
S9 with U60, S10, S2-rem, S3 through the product gateway, S15, S4c, S5-rem,
S7-rem, S7d, S12, S14 and S16. They belong to later milestones or need other WPs' code.
