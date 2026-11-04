# End-to-end tests

The e2e suites drive a real, deployed Tartan forge in a real browser and with stock git: sign-in through an OpenID
Connect provider, the setup wizard, groups and repos, git over smart HTTP and the gateway's push rules, lanes, MCP,
projects, repository config in CUE and the admin pages.

> **Spike branch (`spike/strip-down`).** This branch removed the first-party extensions, and with them the suites that
> exercised them: Issues and Changes, the extension tabs, the M1 loop (claim → radar → CI → review → Weave → Advance),
> the Classic and Swarm packs, the HUD and the `acme.no-secrets` WASM suite. Checks that need a change to land or a CI
> run (the landing freeze, multi-repo compose, a run dispatched from K2, a policy sign-off landing) are pending skips
> that name the reason. They use [e2e](https://github.com/tester-army/e2e) (npm `e2e` 0.16.0 with `@e2e-dev/web`
> 0.11.2 and Playwright 1.63.0, all Apache-2.0) as a **deterministic** test runner: locators, assertions and fixtures only.
> No model is configured, no test uses an agent step, `explore` or bug-bash, the replay cache is off, and telemetry is off
> for every process. The "agents" of the suites are scripted clients of Tartan's agent interface (MCP
> JSON-RPC and git with agent tokens), not models.

They run against their own stage, `dev-e2e`, and a mock identity provider deployed next to it. Nothing in Tartan changes
for them: no localhost or plain-HTTP flag, no test hook in the kernel.

## Layout

| Path                    | What                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/e2e.config.ts`     | The one e2e config (project root `e2e/`, output `e2e/.e2e/`, gitignored)                                                                                   |
| `e2e/support/`          | Stage reader and guards, fixtures, API, MCP and git helpers, the scripted agent, the fixture repos, the cross-worker store, slot counts and gateway checks |
| `e2e/tests/**/*.e2e.ts` | The suites; `auth.setup.e2e.ts` is the only setup test, `claim/claim.e2e.ts` runs only on a fresh forge                                                    |
| `e2e/tests/gateway/`    | The gateway suites: `s2-policy` (the gateway's ref-policy table, branch lanes) and `s3-ng` (the synthesized `ng`)                                          |
| `scripts/e2e/`          | The Deno launcher behind `deno task e2e`: stage lifecycle, provisioning, teardown, trace sweep, leak scan                                                  |
| `scripts/e2e/*.test.ts` | Unit tests of the launcher and of the suites' support code (part of `deno task test`)                                                                      |
| `tools/mock-idp/`       | The mock OIDC IdP Worker (`tartan-e2e--idp`), its own `wrangler.jsonc` and unit tests                                                                      |

The suites run under Node (the e2e CLI loads TypeScript itself); everything else is Deno. Suites import only `e2e`,
`@e2e-dev/web`, `node:*`, relative paths and **types** from `@tartan/contract`, which are erased before Node runs them.
`deno task check` type-checks `e2e/` as its own unit, so the contract's names (states, reasons, tools) are checked there.

## The stage and the mock IdP

```
deno task e2e -- <command>          scripts/e2e/main.ts (Deno)
  └─ node node_modules/e2e/dist/cli/bin.js run --config e2e/e2e.config.ts --no-cache …
       │   env: E2E_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1, no model keys, TARTAN_E2E_* run values
       ├─ Chromium ──https──▶ https://tartan-dev-e2e.<subdomain>.workers.dev   the forge (dev tools on)
       ├─ git, MCP ──https──▶ the same forge, with the run's PATs and agent tokens (from Node)
       └────────────https──▶ https://tartan-e2e--idp.<subdomain>.workers.dev   the mock IdP
```

- **The account** is the one `CLOUDFLARE_ACCOUNT_ID` names; no file in the repository names one, so any self-deployer
  runs the harness in their own account. Every stage command and `run` read it, check it is an account id, assert that
  the wrangler login can reach it, pin it for every wrangler child, and refuse a deploy record of another account.
- **The forge** is `deno task deploy -- --stage dev-e2e --dev-tools --no-print-url --account <id>` with, by default,
  containers and repository config on: `--image dockerfile` (wrangler builds the runner image with Docker and pushes it
  to the account's own `registry.cloudflare.com`) and `--repo-config` (each repo's root CUE package `tartan` is
  evaluated). `stage up --image registry` renders the ttl.sh digest that `containers/runner/publish.ts` records
  instead ([`deploy.md`](../deploy.md#the-runner-image)). `stage up --no-containers` turns containers and
  repository config off, and the suites that need them skip with the reason (the run's summary lists them).
- **The M2 switches** are deploy's own flags, passed through by `stage up` and recorded in the deploy record's
  `switches` (modes and booleans only), which the run hands to the suites (`TARTAN_E2E_SWITCHES`, `stage.switches`): a
  suite that needs a switch skips with the reason when the stage lacks it. The M2 acceptance stage is
  `stage up --k2 --k2-token-store <store id> --k2-token-secret <name> --lane-mode import --workload-transport k2
  --projects --build-ext --echo on`: the global log on the K2 stream `tartan_dev_e2e_log` with the Secrets Store consume
  token (bound, never read), per-agent lane repos created with `import()`, CI dispatched from the log, projects,
  the Rust → WASM packages built for publishing, and band-2 guidance on.
- **The mock IdP** is one Worker with one SQLite Durable Object: OIDC discovery, JWKS, open dynamic client registration
  (RFC 7591/7592), the authorization code flow with PKCE S256 and the RFC 9207 `iss` parameter, for four synthetic users
  (`e2e-owner`, `e2e-developer`, `e2e-reporter`, `e2e-outsider`). Their emails are on `.invalid` with
  `email_verified: false`, so no forge's sign-up rule can admit them. Passwords are derived from a seed secret
  (`HMAC-SHA256`, 43 characters); nobody stores them.
- **Only the dev-e2e forge can use it, by construction.** Every allowed redirect URI must match
  `https://tartan-dev-e2e.<subdomain>.workers.dev/-/auth/callback`; the check is in the IdP's code and runs on every
  request, and any other value makes the IdP answer 500 without a redirect. `redirect_uri` is compared exactly at
  `/register`, `/authorize` and `/token`. The sign-in form carries only a stored request id; codes live 60 seconds, are
  bound to the client, redirect, PKCE challenge and nonce, and are spent on every `/token` attempt. There is no IdP
  session cookie. A client that has redeemed a code is never evicted, and registrations and failed sign-ins are rate
  limited per hashed address. Responses are `no-store`; nothing is logged.
- **Names.** The launcher touches exactly two Worker names, `tartan-dev-e2e` and `tartan-e2e--idp` (a double hyphen no
  `deno task deploy --stage` can render), and has no code path for another Worker, a zone or DNS. The IdP's config turns
  metrics, observability and preview URLs off, and the launcher refuses to overwrite a Worker on its name that answers
  as a Tartan forge.
- **Exposure.** A public test forge with containers is a cost and, when it shares an account with production, an abuse
  report against it lands on that account. All e2e nodes are private (a suite checks that anonymous visitors see nothing
  under `/e2e`), `stage up` records an 8-hour expiry that `run` and `stage status` warn about, and the stage should be
  taken down when no e2e work is planned.

Local state lives in the checkout that ran `stage up`, all under gitignored `.wrangler/`: the deploy record (with the
commit it deployed), the setup URL file (0600, exact path, read only while the forge is unclaimed), and
`.wrangler/e2e/idp.json` (0600 in a 0700 directory: the seed, issuer, allow-list and key id; never the private key, which
exists only as a Worker secret). Files readable by the group or others are refused.

## Running

Prerequisites: Node 22.12 or newer, Deno 2.9, `npm ci` (the e2e packages are pinned dev dependencies), a wrangler login
that can reach your account, `CLOUDFLARE_ACCOUNT_ID` set to its id, and at least 1.5 GB free disk (every command checks).

```bash
export CLOUDFLARE_ACCOUNT_ID=<your account id>
deno task e2e -- install                 # Chromium and its headless shell into the Playwright cache (outside the repo)
deno task e2e -- stage up                # IdP + forge (containers, repo config); a fresh forge is claimed (phase A)
deno task e2e -- stage up --k2 --k2-token-store <id> --k2-token-secret <name> \
  --lane-mode import --workload-transport k2 --projects --build-ext --echo on   # the M2 acceptance stage
deno task e2e -- stage status            # what is deployed (commit, containers), health, key id, expiry, drift
deno task e2e -- list --tag smoke        # what a run would select (no app contact)
deno task e2e -- run                     # provision → suites → teardown → skipped list → trace sweep → leak scan
deno task e2e -- run tests/lanes/repo-lanes.e2e.ts
deno task e2e -- run tests/cue/cue-config.e2e.ts --tag smoke
deno task e2e -- run --repeat-each 5 tests/new-suite.e2e.ts   # before a new suite joins the default run
deno task e2e -- run --last-failed
deno task e2e -- evidence <runId>        # leak-scanned summary into .private/e2e/evidence/<runId>/
deno task e2e -- agent                   # one e2e-developer agent token + the e2e/swarm MCP URL, 0600 file (below)
deno task e2e -- stage down              # destroy the forge (deregisters its IdP client) and the IdP
deno task e2e -- stage reset             # stage down --keep-idp, then stage up (claims again)
```

`agent` mints one agent of `e2e-developer` (Developer on `e2e`, 1 day by default, `--ttl-days n`) for work after a run,
such as a model-driven session, and writes its token with the MCP URL of an e2e group (`e2e/swarm` by default,
`--group e2e/classic` or `--group e2e`) to
`.private/e2e/agent/agent.json`. `--out` may name another file under `.private/` or outside the checkout, in a directory
that is new (created 0700) or already 0700; anything else is refused before the agent is minted, and if the file cannot
be written the agent is disabled. Its health check retries a slow answer with backoff (1, 3 and 10 s).

`run` merges its defaults with the caller's flags: `--no-cache` always; `--exclude-tag quarantine,claim` (plus
`rate-limited` with `--repeat-each`) **plus** every tag the caller excludes; `--max-failures 50` unless the caller sets
one; the `list`, `junit` and `markdown` reporters **plus** any the caller adds (`evidence` reads junit and markdown).
`--drop-traces` deletes every retained trace after the run; `--keep-data` keeps the run's repos; `--allow-drift` runs
against a forge deployed from other code than this checkout (see the drift guard below) and says so.

Exit codes are e2e's own (0, 1, 2, 3, 4, 130), plus 2 for a failed guard or preflight and 1 for a leak-scan hit. The e2e
suites are a live tier, next to `smoke` and `live`: they are not part of `deno task verify`. Their unit tests are.

`npx e2e run` from a shell does not work on purpose: without the launcher's `TARTAN_E2E_*` values the config refuses to
load, and even then it turns telemetry off before anything else.

## What a run does

1. **Guards.** Disk; the account (`CLOUDFLARE_ACCOUNT_ID` equals the deploy record's); the deploy record (`dev-e2e`,
   workers.dev, no custom domain); **the drift guard**: the commit the record names must not differ from this
   checkout's working tree under `extensions/`, `packages/contract/src/`, `src/`, `web/src/` and `wrangler.jsonc`,
   because the suites derive names and contract values from them; the forge's `/-/health`
   (`product: "Tartan"`, `stage: "dev-e2e"`, claimed; retried after 1, 3 and 10 s); the IdP's health; the Playwright
   browser present (the engine must never download one). A run that starts within 90 s of a deploy waits until 90 s
   have passed.
2. **Provisioning** (idempotent), signed in headless as `e2e-owner` through the real flow with `redirect: "manual"`,
   refusing any redirect that is not the forge or the mock IdP's `/authorize` before a password is sent: the private
   groups `e2e`, `e2e/swarm` and `e2e/classic` (named after the packs they carried before this branch; nothing is
   installed at them now), the personas `e2e-developer` (Developer on
   `e2e`) and `e2e-reporter` (Reporter on `e2e`) through invites, and the run's credentials, each with a 1-day expiry,
   all limited to `e2e`: an owner PAT (with `admin`, which `import-complete` needs), a reporter PAT (with `repo:write` on
   purpose, so the role ceiling is what refuses its pushes), a read-only developer PAT (`repo:read`, so the scope is what
   refuses its pushes) and two developer agents, A and B. If provisioning fails half-way, what it minted is revoked or
   disabled before the error is reported. A janitor removes `e2e-*` tokens and agents older than a day and archives run nodes older than two hours (every live run repo costs each cron tick of the forge), reading every page of the run groups' children; teardown archives the run's own.
3. **The suites.** `auth.setup.e2e.ts` signs owner, developer and reporter in through the forge's sign-in page and the
   IdP's form, and saves one browser session each. Every other test restores one, or runs anonymous.
4. **Teardown**, whatever the outcome (also when provisioning or e2e never started): the run's tokens are revoked, its
   agents (including the one a UI test makes) are disabled, its repos and groups archived, the launcher's own sessions
   signed out, and the suites' shared scratch directory
   (`$TMPDIR/tartan-e2e-<runId>-shared/`) removed.
5. **What was skipped, and why.** The launcher reads `report.json`, prints every skip reason with its count, and writes
   `skipped.md` beside `summary.md` (a pending feature, a stage without containers, a known missing route, an excluded
   tag). `evidence` copies it.
6. **Trace sweep and leak scan** (see below), then the output directory is made private (directories 0700, files 0600).

Each run works in its own namespace: repos are `<group>/<runId>-<suite>`, agents and tokens `e2e-<runId>-<who>`, where
the run id is `r<yyyymmddhhmm><4 hex>`. Fixture repos start from deterministic histories (fixed files, author and dates,
`e2e/support/fixture-repo.ts`), so their SHAs are constants; a unit test rebuilds each with the local git and compares.

**Shared stage state and retries.** Some state outlives a run on purpose, and the suites read it accordingly: the global
log's parked records are forge-wide (the K2 suite fails only on a record parked during the run). The harness retries what a person or agent would retry, and says so: a sign-in that answers `unavailable, try
again` (a busy ForgeDO), and a git clone, fetch or push the forge answered with a transient 5xx. Each retry prints an
`e2e-retry:` line in the run's log, so a run that passed only after retries is visible as such.

## Suites

| File                       | Personas                                   | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Guards                                    |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `auth.setup.e2e.ts`        | owner, developer, reporter                 | Sign-in through the forge and the mock IdP; `/-/api/me` names the persona; only the owner is an admin                                                                                                                                                                                                                                                                                                                                                                                                                                                               | sign-in, PKCE, `iss`                      |
| `claim/claim.e2e.ts`       | anonymous, then owner                      | Phase A only: the wizard's steps, unlock with the deploy's token (pasted, never in a URL), environment checks, name and origin, the IdP through DCR, the claim; setup ends `done`                                                                                                                                                                                                                                                                                                                                                                                   | setup claim                               |
| `setup.e2e.ts`             | anonymous, owner                           | A claimed forge says it is set up; a fresh random token cannot unlock it (403 `setup`); the owner's forge has dev tools                                                                                                                                                                                                                                                                                                                                                                                                                                             | setup claim; wizard (pending part)        |
| `groups-repos.e2e.ts`      | owner, reporter, anonymous                 | Group and repo forms; crumbs; the repo tab bar (kernel tabs and Config, Settings for Owners only, no extension tab); a Reporter's read-only settings; anonymous visitors see nothing                                                                                                                                                                                                                                                                                                                                                                                | role matrix                               |
| `git-push.e2e.ts`          | owner PAT, reporter PAT, agent             | Push-mode import and `import-complete`; clone; `woven-by-tartan`; a Reporter's push refused by its role (403 and the gateway's reason); `agents-lanes-only`; History in order                                                                                                                                                                                                                                                                                                                                                                                       | trunk protection, roles                   |
| `browse-code.e2e.ts`       | developer                                  | Tree, blob, commit, compare; settled slots; the sidebar only when the view lists one; file A to file B re-renders the banner for B; the diffs' lines (`known-bug`)                                                                                                                                                                                                                                                                                                                                                                                                  | browse regressions                        |
| `gateway/s2-policy.e2e.ts` | agents A and B, owner, read PAT            | The gateway's ref-policy rows for branch lanes with stock git, each refusal by its `ng` reason and the ref it did not move; hidden refs; the advertisement allowlist; the parser probes; the landing freeze and public-view rows pending (the lane-repo rows are in the repo lanes suite)                                                                                                                                                                                                                                                                           | gateway ref policy; public view (pending) |
| `gateway/s3-ng.e2e.ts`     | owner, agents A and B                      | The synthesized `ng` on `main` in every way stock git can ask (report-status-v2 with side-band-64k, `-q`, `--atomic`, protocol v0 and v1, plain, `--porcelain`, `-v`); no control character in any output; the band-2 rows run on a stage deployed with `--echo on` (pending otherwise)                                                                                                                                                                                                                                                                             | push messages (`ng`, echo)                |
| `repo-config.e2e.ts`       | owner                                      | A root package `tartan` that does not evaluate: the failure with its file and line, on the API and the settings page; the `package cuenv` file beside it is not what failed                                                                                                                                                                                                                                                                                                                                                                                         | repository config (the ADR)               |
| `admin.e2e.ts`             | owner, reporter                            | Extensions, forge settings, a repo's lane settings (import or branch), an agent created (its POST, by method) and disabled; a Reporter's first view of Extensions without a not-found (`known-bug`); an installation's pages, console and dead letters pending (nothing is installed)                                                                                                                                                                                                                                                                               | admin regressions                         |
| `api-routes.e2e.ts`        | owner, developer, reporter, anon           | Every read route the SPA's client calls is served (no 405, 501, route 404 or 5xx); `/-/health`; `/-/agents.md`; `/-/api/me` per persona; a repo view with no slots or extension tabs; pending wizard routes                                                                                                                                                                                                                                                                                                                                                         | route coverage                            |
| `negative-auth.e2e.ts`     | outsider, anonymous                        | No account for a user never invited; a wrong password stays on the IdP; a forged callback state is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                          | identity                                  |
| `lanes/repo-lanes.e2e.ts`  | agents A and B, owner, reporter, anonymous | a lane is its own Artifacts repo created with `import()` (API, MCP, the lane page); its remote clones, pushes, forces and leases with stock git; a lane push never reaches the canonical repo; the lane-remote table, L0, L1, L3–L5, by their `ng` reasons (L3's stale old by a hand-built receive-pack); anonymous 401, members read, only the owner writes; the Owner's self-test through the real capability route; forged, expired and malformed capability URLs get an empty 404; the Owner's branch override; multi-repo compose and L2 while landing pending | `--lane-mode import`                      |
| `k2/global-log.e2e.ts`     | owner, agent A, reporter                   | the forge relay follows new events in order; the Owner's Global log tile; no dead letter parked during the run; only the forge Owner reads the log; a run dispatched from the log pending (no extension requests a run)                                                                                                                                                                                                                                                                                                                                             | `--k2`, `--workload-transport k2`         |
| `projects/projects.e2e.ts` | developer                                  | `package tartan` directories as the repo's projects under its root layer; the Projects card; a project's README                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `--projects`                              |
| `cue/cue-config.e2e.ts`    | owner, agents A and B                      | Repository config: trunk's package tartan (its projects) on the settings page; a lane's policy preview, touching repo policy with no sign-off; an invalid lane config with its position while trunk keeps its config; the sign-off and land pending                                                                                                                                                                                                                                                                                                                 | repository config                         |
| `placeholders.e2e.ts`      | -                                          | Skipped, tagged `pending`: per-project installations (not built yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | -                                         |

## Writing tests

- **Locators.** `getByRole`, `getByLabel` and `getByText` first; then `browser.locator` on stable attributes
  (`section[data-slot][data-ext]`, `[data-action]`, `nav[aria-label=…]`); a CSS class only where the SPA offers nothing
  else. Scope every query: e2e refuses ambiguous matches.
- **Settled slots.** After a page loads, `expectSlotsSettled(browser, view, RENDERED.<page>)` counts the slot instances
  the page must show (from `/-/api/view`), waits for that many hosts, then for none busy or loading, then for no error
  chip; a failure lists the chips' text (for example `tartan.weave: invalid ctx`).
- **Failing requests.** `watchApi(browser)` after `app.open`, `expectApiClean(browser)` at the end: no `/-/api/`
  request of the page may end in 404, 405 or 5xx unless the test declares it.
- **Which request.** `browser.waitForResponse` matches URLs only. To tell a page's POST from its own GET of the same
  path, or one slot render's ctx from a racing refresh, use `trackFetches(browser)` and `fetchMatching(browser, …)`:
  they record each `/-/api/` request's method, path, slot query and status in the page, never a header or a body.
- **In-view navigation.** `spaNavigate(browser, path)` moves through the SPA's own router, as a link inside the page
  does, so slot hosts stay mounted. Check the slot request's ctx with `ctxOfSlotRequest`.
- **Flows across tests.** Build shared state once with `sharedStore().once(key, work)` and check it in independent
  tests; never chain checks in a `serial` group (a failed member skips the rest). Claim the instance with
  `claimIndex(keyOf(title))` so `--repeat-each` gets one instance per repeat. Values in the store are ids and names only.
- **Credentials.** Passwords and the setup token are e2e credentials and secrets, filled with `fill(handle)` and
  redacted everywhere. Bearer tokens are used from Node only (`tokenApi`, `gitHttp`, `git`, `mcpClient`), never in
  `browser.evaluate`, a route handler or a URL; persona API calls go through `pageApi(browser)`, so session cookies
  never enter Node. Assert a token's shape with a boolean, never with a matcher that would print it. git gets its token
  as an extra header scoped to the forge origin through the environment, never argv, a URL or `.git/config`, and its
  output is scrubbed.
- **Waiting.** No fixed sleeps: polling matchers and `expect.poll` with explicit bounds in tests (10 s for UI, 90 s for
  an import, minutes for CI and an Advance), and bounded polling loops in the support code (an import's trunk, a lane
  opening, a config evaluation), each naming what it waited for when it gives up. Every Node-side request to the forge
  goes through `boundedFetch` (30 s, body included, so one request that never ends cannot stall the requests after it)
  and every git command through `git()` (killed after 60 s), so a hang fails its test with the request it was waiting
  for. The launcher bounds its own requests the same way (`scripts/e2e/http.ts`).
- **Names and labels** come from the contract (as types: `const CURRENT: RepoConfigStateDto["status"] = "current"` is
  checked by `deno task check`), never from literals, so renames need no test edit. Only the kernel views' own
  landmarks (headings, `aria-label`s) are written out.
- **Tags.** `smoke`, `regression`, a regression slug (`form-payload`, `lane-settings`, …) naming the bug a test guards, a persona (`owner`, `developer`, `reporter`,
  `anonymous`), `containers`, `rate-limited` (setup unlock and IdP failures, a few per 10 minutes per address),
  `pending` (a skip to flip when the feature lands), `known-bug` (a test that fails because of a known Tartan bug, kept
  running so the fix is seen), `m2-lanes`, `quarantine` and `claim`.
- **The source scan** (`scripts/e2e/no-model.test.ts`) fails on agent steps, `explore`, `unique()`, `e2e/agent`,
  `e2e/oauth`, model packages (also an installed or locked `ai` or `@ai-sdk/*` other than the interfaces-only
  `@ai-sdk/provider`), engine `headers`/`basicAuth`, token or session cookie literals, and Bearer credentials outside
  the Node-side helpers.

## Flakes

Retries are 0. A new suite must pass `--repeat-each 5` before it joins the default run; the ref-policy
suite, the synthesized-`ng` suite and the repo-config suite have not met that gate yet. A test that fails intermittently
is tagged `quarantine` (excluded by default) and is tracked until it is fixed. `--max-failures 50` stops a broken deploy
early while one failed shared setup (it fails every test waiting on it: the ref-policy suite's 35 rows) never stops a run. Each attempt gets a fresh browser context restored from its session;
personas never share one.

Quarantined now:

- `gateway/s2-policy.e2e.ts` "row 4: a stale old never moves a lane": quarantined until the race's refusal forms are
  pinned down; its message carries the loser's output.

## Results, traces and secrets

- **Output** is `e2e/.e2e/` (gitignored, made 0700 before the run and tightened to 0700/0600 after it): `report.json`,
  `junit.xml`, `summary.md`, `skipped.md`, `failures/`, `artifacts/` and the encrypted `sessions/` (deleted when the run
  ends). Traces are kept for failed attempts only.
- **Browser sessions stay valid after a run.** The forge session cookies the setup test mints for owner, developer and
  reporter exist only in e2e's encrypted per-run session store, whose key is in memory and whose directory is deleted
  at the end of the run; the launcher never sees them. On the forge they stay valid until they expire (12 hours idle, 7
  days absolute), because Tartan has no API to end all sessions of a principal yet.
- **Traces hold request headers**, so a retained `trace.zip` contains the session cookie of the persona it ran as
  (e2e rewrites only registered secrets in traces). After every run the launcher opens every retained trace, ends each
  session cookie in it (`POST /-/auth/logout`, logging only the count), and deletes all traces when one could not be
  ended or read, or with `--drop-traces`. The IdP sets no cookie at all, and its codes are single use. Traces stay
  local and never enter evidence; never attach them to an issue or a PR.
- **Leak scan.** After every run the scan reads every file in `e2e/.e2e/`, traces unzipped, with the smoke rules plus
  Tartan tokens, session, setup and login cookies, Bearer values, setup-URL fragments, IdP codes and every exact secret
  value of the run. In traces, a session cookie ended in this run and spent codes are counted, not failed; anything else
  is a leak. A hit fails the run (exit 1), names file, line and rule (never the value) and deletes the traces.
- **Output masking.** Everything a child prints (deploy, wrangler, the e2e list reporter, git) passes a masker with the
  same rules before it reaches the terminal.
- **Screenshots** are withheld in tests that restore a session whose setup filled a password (e2e's rule), so failure
  evidence is the trace and `failure/screen.txt`.
- **Evidence.** `deno task e2e -- evidence <runId>` copies `summary.md`, `skipped.md`, `junit.xml` and `failures/*.md`,
  after a strict leak scan, to `.private/e2e/evidence/<runId>/` (0600 files in 0700 directories). Cite a run only by
  its run id, counts and commit.

## Not covered yet

- The lane-remote table with a lane-pinned token (no route mints one) and a forced `import()` refusal falling back to branch lanes (no
  dev tool can make `import()` refuse): pending skips in the lanes suite.
- The K2 inline backstop with the bus paused (needs the dev key): pending in the global log suite.
- The CUE boot row of a repo that predates the switch, and a policy change's sign-off and land: pending in the CUE
  suite. The 30-minute config hold is left to the land workflow's tests.
- Everything that needs a change to land or a run to start (the landing freeze, multi-repo compose, L2, a run from
  the global log): pending, as no extension on this branch submits, lands or runs anything.
- Echo lines on an accepted push: no extension is installed, so none contributes one (pending in the synthesized-`ng`
  suite).
- The public-view upload-pack rows: the e2e groups stay private, so there is no public repo to probe (pending skips).
- The push size rows (`MAX_PUSH_BYTES`, a 33 MiB object): pending until a size tier exists.
- Deferred items (the wizard's self-test and root-key steps) and per-project installations: `pending` skips that must be flipped when they land.
