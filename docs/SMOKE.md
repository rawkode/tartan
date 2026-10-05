# Smoke tests

The smoke suites run small, throwaway Workers that exercise the Cloudflare bindings Tartan uses (Artifacts, Workflows,
Dynamic Workers and containers), outside the product Worker. This page says how to run them. Each check prints `PASS` or
`FAIL`; `--local` runs the git and lanes suites against FakeArtifacts.

## Layout

| Path                              | What                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `scripts/smoke/run.ts`            | The runner behind `deno task smoke`                                                                   |
| `scripts/smoke/suites/git.ts`     | binding operations, the gateway shape, git protocol checks and the FakeArtifacts conformance run      |
| `scripts/smoke/suites/lanes.ts`   | lane repositories created with `import()`, and the capability route's security probes                 |
| `scripts/smoke/suites/box.ts`     | Sandbox containers and land operations in a sandbox                                                   |
| `scripts/smoke/suites/runtime.ts` | Dynamic Workers, WASM by bytes, capabilities, facets and tails                                        |
| `scripts/smoke/worker-git/`       | `tartan-smoke-git`: binding ops, a minimal gateway, a synthesized-`ng` route, the push-event Workflow |
| `scripts/smoke/worker-lanes/`     | `tartan-smoke-lanes`: the v1 capability route (`/-/cap/v1/…`) and imports                             |
| `scripts/smoke/worker-box/`       | `tartan-smoke-box`: a Sandbox subclass and land scripts                                               |
| `scripts/smoke/worker-runtime/`   | `tartan-smoke-rt`: Dynamic Workers, facets, tails; `wasm/` is a Rust module                           |
| `scripts/smoke/lib/`              | Evidence recorder, leak scan, git runner, shared binding ops                                          |

The smoke Workers are throwaway and never part of the product Worker or its `wrangler.jsonc`. Every Worker, Workflow,
Artifacts namespace and repo they create starts with `tartan-smoke-`.

## Running

Local (no account, no network beyond loopback): the drivers run against the smoke Workers' handlers in process, with
`@tartan/testkit`'s FakeArtifacts behind them and stock git on loopback ports. This proves the drivers and handlers
work. It says nothing about the platform.

```bash
deno task smoke -- --local                       # git and lanes suites
deno task smoke -- --local --only <id>,<id>      # selected checks, by the ids a run prints
```

Live, against your own account (only `dev` or `dev-*` stages; never production):

```bash
deno task smoke -- --stage dev --suite git,lanes --deploy        # deploy the smoke Workers, then run
deno task smoke -- --stage dev --suite git --only <id>,<id>
deno task smoke -- --stage dev --suite runtime --deploy
deno task smoke -- --stage dev --suite box --deploy               # the Sandbox base image
deno task smoke -- --stage dev --suite box --deploy --box-dockerfile   # builds the runner image: integrator only
deno task smoke -- --stage dev --suite git,lanes --teardown       # delete tartan-smoke-* repos and Workers
```

- Keys live in `scripts/smoke/.dev.vars` (gitignored, mode 600): `SMOKE_KEY` (the drivers' key) and `LANE_CAP_KEY` (the
  lane smoke Worker's dedicated capability key). They are generated on first use, put as Worker secrets by `--deploy`,
  and never printed. Deployed URLs are kept there too.
- Credentials never go into remote URLs. git gets them per command as `http.extraHeader`, so no `.git/config` holds a
  secret.
- Evidence goes to `scripts/smoke/evidence/<date>/<suite>-<stage>.json` (gitignored), redacted with the contract's
  `redactSecrets`. The runner leak-scans it at the end. Run the scan by hand before sharing anything:
  `deno run -A scripts/smoke/lib/leakscan.ts`. It fails on Artifacts tokens in any version, unredacted `/-/cap/` paths,
  credentials in URLs or Authorization headers, smoke keys, and any `.git/config` or `.dev.vars` file in the evidence
  tree.
- Teardown deletes the smoke repos and Workers. The lane smoke Worker and its repos are deleted when its probes are
  done.

The gateway's ref-policy and synthesized-`ng` checks also run through the product gateway in the end-to-end harness
([`testing/e2e.md`](testing/e2e.md)).
