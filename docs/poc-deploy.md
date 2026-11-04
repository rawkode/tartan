# Deploying the POC to Cloudflare

The concrete plan for putting the `poc/tartan` branch on your own Cloudflare account. [`deploy.md`](deploy.md) is the
reference for every flag and step; this page says which of them to use for the POC and what is still unknown.

**Nothing here has been run against Cloudflare.** This branch has never been deployed, and no credentials were used to
write this page. README claims of "Live-proven" describe earlier builds of the forge, not this branch. What was actually
run is under [What has been proven](#what-has-been-proven).

## The recommendation

Deploy the POC as one disposable stage, without containers:

```sh
deno task deploy -- --stage poc --no-containers --projects --no-print-url
```

- It is the configuration closest to what runs locally, since `deno task dev` has no containers either.
- It needs no Docker. This machine has none: only `podman`, and preflight calls `docker` by name.
- It keeps the cost small. Containers are the only part billed by the second while they run.

The price is that **only the Owner's direct push can move trunk**. With no containers there is no CI and no Advance, so
a contributor's or agent's lane can never land. Adding containers is [a second phase](#phase-2-containers).

## Required bindings

Every binding below is declared in `wrangler.jsonc`, and `/-/health` answers 503 unless each of them is present
(`BINDING_NAMES` in `src/env.ts`).

**The whole stack needs Workers Paid ($5/month).** Artifacts and Dynamic Workers are unavailable on Workers Free. Prices
are from Cloudflare's docs as read on 2026-11-04; check them again before relying on them.

| Binding                                           | Stage `poc` resource                           | Availability            | Cost beyond the included amount                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIFACTS`                                       | namespace `tartan-poc`                         | Paid only; open beta    | $0.15 per 1,000 operations past 10,000, $0.50/GB-month past 1 GB. Billing starts 2026-11-12                                         |
| `LOADER` (Worker Loader)                          | none, API only                                 | Paid only; open beta    | 1,000 Dynamic Workers/month, then $0.002 per Worker per day, plus Workers rates                                                     |
| `FORGE`, `REPO`, `INBOX`, `EXT`, `SANDBOX`, `BUS` | SQLite Durable Objects, migrations `v1`, `v2`  | Free and Paid           | Durable Objects compute and storage                                                                                                 |
| `RUNS`, `LAND`, `INGEST`, `SWARM`                 | Workflows `tartan-poc-{run,land,ingest,swarm}` | Free and Paid           | 500,000 steps/month, then $0.80 per 100,000; storage past 1 GB-month at $0.20                                                       |
| `BLOBS`                                           | R2 bucket `tartan-poc-blobs`                   | see below               | R2 storage and operations                                                                                                           |
| `OAUTH_KV`                                        | KV, auto-provisioned                           | Free and Paid           | KV rates                                                                                                                            |
| `AI`                                              | none, API only                                 | Free and Paid, by model | Workers AI rates; called by the setup check and the extension capability port                                                       |
| `ASSETS`                                          | `web/dist`, 101 files                          | Free and Paid           | none for static requests                                                                                                            |
| Sandbox container (`containers`)                  | **omitted in phase 1**                         | Paid only               | `standard-1` (1/2 vCPU, 4 GiB): about $0.04/hour per running instance, up to about $0.07 with the CPU busy, past the included usage |

Three things are gated in ways preflight cannot fully tell you:

- **Artifacts.** Preflight calls `GET /accounts/{id}/artifacts/namespaces`: 200 is entitled, 403 or 404 is not.
  `deploy.md` says to request access on a 403. Cloudflare's docs now say open beta on Workers Paid, so look at the plan
  first.
- **Workers Paid.** Preflight warns rather than fails when the wrangler login cannot read subscriptions.
- **R2, Worker Loader and Workflows are not checked at all.** A problem with any of them appears during `wrangler deploy`
  or at `/-/health`. An account that has never used R2 may need it enabled in the dashboard first. That comes from
  memory and I could not confirm it in the current docs.

K2 and Secrets Store are not used here: without `--k2` the forge has no global log and dispatches inline.

## What this POC changes

| Thing             | What to do                               | Why                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project discovery | Pass `--projects`, **on every deploy**   | It renders `TARTAN_PROJECTS=scan`. Switches are per render, so a redeploy without the flag turns the project routes off (404), and repeating is the only way to keep it                                                                                                                                              |
| Repository config | **Do not pass `--repo-config`**          | The ADR's repository config evaluates root `*.cue` from trunk, but an Owner's direct push never reaches that module, so a pushed root `*.cue` would leave config silently stale while the forge reported it as evaluated. Absent means off; `deno task dev` sets `off` for the same reason. It also needs containers |
| Owner direct push | Nothing: it is compiled in, with no flag | The forge's owner can push the default branch, fast-forward only. There is no switch to turn it off on a deployed forge                                                                                                                                                                                              |
| Dev tools         | **Do not pass `--dev-tools`**            | The stage is not `dev*`, so it would be refused anyway                                                                                                                                                                                                                                                               |

Two weakenings ship with this and are decided, not bugs. They apply on the public internet from the moment the forge is
claimed:

- **Trunk does not move only through the Advance.** An Owner's push is untested, has no why-note, passes no gates and
  takes no sign-off. See [Owner pushes](limits.md#owner-pushes).
- **A project's `.cue` file is not enforced.** `extensions: "rawkode.issues": enabled: false` is read textually, and a
  project-root `.cue` edit lands without the ADR's sign-off. The switch scopes the Issues route for the UI; over MCP, a
  repo-wide tool call still sees everything. See [`projects.md`](projects.md#per-project-config-is-not-enforced). Do not
  describe it as a security boundary.

## Identity

Local sign-in does not exist on a deployed forge. Every browser being `dev` is `tools/dev/worker.ts`, which is never
deployed. **You need a real OpenID Connect provider.**

| Option                                                 | Works for `tartan-poc`? | Notes                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A real IdP with dynamic client registration (RFC 7591) | **Yes, the simplest**   | Paste the issuer in the wizard. It registers a public PKCE client, and `destroy` deregisters it                                                                                                                                       |
| A real IdP without it                                  | Yes                     | Register `https://<host>/-/auth/callback` by hand and paste the client id. A confidential client also needs `wrangler secret put OIDC_CLIENT_SECRET`                                                                                  |
| `tools/mock-idp`                                       | **No, by construction** | It answers 500 unless every redirect URI matches `https://tartan-dev-e2e.<subdomain>.workers.dev/-/auth/callback` (`REDIRECT_URI_RE` in `config.ts`). Do not relax that check. It is for `deno task e2e` and the `dev-e2e` stage only |

What changes when the identity is real:

- **Your addresses change.** The root is your IdP handle (`username_claim`, then `preferred_username`), so paths are
  `<handle>/oss/...`, not `dev/oss/...`. The product's `oss/devtools/build/kiln:lsp` shape, with no owner prefix, is not
  implemented, and a repository cannot sit at the top of the tree. Check what handle your IdP sends before you claim: the
  claim creates the root under it.
- **Others cannot get in without an invite.** A sign-in with no account gets 403 "No account here yet". Leave
  `jitProvisioning` off: with it on, anyone with a verified email in the allowed domains gets an account.
- **Contributors come by invite link** (`POST /-/api/invites`, from a signed-in browser: a bearer token gets 403), with a
  role on one node. The local IdP mints a new person
  per invite; a real one signs in whoever opens the link, so send it only to the person you mean.

## Steps

Run these yourself, from the repository root, in the dev shell (`nix develop`). Steps 1 and 2 touch nothing remote. From
step 4 on, resources are created and may be billed. `$ORIGIN` is the forge's URL.

### 1. Check the commit

```sh
git switch poc/tartan && git status --short && git rev-parse --short HEAD
deno task test
```

The deploy record stores the commit, and a dirty tree would be deployed as it stands. Decide first whether this branch
should be public (see [Open questions](#open-questions)).

### 2. Prove the bundle offline

```sh
deno run -A scripts/render-config.ts --stage poc --no-containers --projects scan
npx wrangler deploy --dry-run -c .wrangler/deploy/wrangler.poc.jsonc --outdir .wrangler/dry-poc
```

It should list the bindings above and end with `--dry-run: exiting now.`

### 3. Log in and run preflight

```sh
npx wrangler login
npx wrangler whoami
export CLOUDFLARE_ACCOUNT_ID=<your account id>
deno run -A scripts/preflight.ts --stage poc --no-containers
```

Preflight takes the plan flags only, so `--projects` is left out here. Fix anything marked `fail`. Stop if `artifacts`
fails, since nothing works without it.

Optional, and not run for this page: `deno task smoke -- --stage dev --suite git,lanes --deploy`, then
`--suite runtime --deploy`, then `--suite git,lanes --teardown`. These exercise the real bindings from throwaway Workers,
but they do not cover the direct push or Issues.

### 4. Deploy

```sh
deno task deploy -- --stage poc --no-containers --projects --no-print-url
```

Add `--domain <host>` for a Custom Domain on a zone in the account. Without it the forge is at
`https://tartan-poc.<subdomain>.workers.dev`. Never use `--take-domain` for this: it moves a hostname away from another Worker, and the README names a demo host.

It writes the single-use setup URL to `.wrangler/deploy/setup-url.poc.txt` (0600) and the record to
`.wrangler/deploy/record.poc.json`. **Treat the setup URL as a credential.** Until the claim, whoever holds it can own
the forge. Do the next step straight away.

`--skip-build` skips only the script's own build: wrangler still runs `build.command` from the config. So a normal deploy
builds the SPA twice, which is harmless.

### 5. Claim the forge

Open the URL in a browser and go through the wizard: forge name, canonical origin (`$ORIGIN`) and the IdP issuer. Sign
in; that identity becomes the Owner. The container check reports `unavailable`, which is expected and marked optional.

Then remove the setup token:

```sh
npx wrangler secret delete TARTAN_SETUP_TOKEN --name tartan-poc
rm -f .wrangler/deploy/setup-url.poc.txt
```

### 6. Mint a token

There is no page for this. Publishing needs a personal token with `admin`, the Agents page only makes agent tokens, and
`POST /-/api/tokens` refuses a bearer token (403 "use a browser session for this"). In the browser's console, on the
forge's origin, while signed in:

```js
await (await fetch("/-/api/tokens", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		name: "poc-admin",
		scopes: ["repo:read", "repo:write", "api", "admin"],
		expiresInDays: 30,
	}),
})).json();
```

```sh
export ORIGIN=https://<host> TOKEN=<the token> HANDLE=<your handle>
```

The answer holds `token` and `tokenId`. Revoke it when you are done: `DELETE /-/api/tokens/<tokenId>`.

### 7. Publish `rawkode.issues`

```sh
deno task build:ext issues
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X PUT "$ORIGIN/-/api/packages" --data-binary @extensions/issues/dist/publish.json
```

Expect 201 with `manifest.version` `0.2.0`. `dist/` is built and gitignored, and versions are immutable. The package goes
to R2 under `ext/rawkode.issues/0.2.0/<sha256>/`.

Build here rather than with `deploy --build-ext`. **That flag fails in this dev shell**, even though the shell has the
target: its check asks `rustup target list --installed`, and the shell's Rust does not come from rustup. Run for this
page, it answered `the wasm32-unknown-unknown target is missing`, which would stop the deploy.

### 8. Make a repository and install Issues

```sh
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "$ORIGIN/-/api/nodes" \
  -d "{\"parent\":\"$HANDLE\",\"kind\":\"group\",\"slug\":\"poc\",\"visibility\":\"private\"}"
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "$ORIGIN/-/api/nodes/repos" \
  -d "{\"parent\":\"$HANDLE/poc\",\"slug\":\"smoke\",\"visibility\":\"private\"}"
# note its "id" as REPO_ID
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "$ORIGIN/-/api/installations" \
  -d "{\"extId\":\"rawkode.issues\",\"version\":\"0.2.0\",\"node\":\"$HANDLE/poc/smoke\",\"mode\":\"enforce\"}"
```

Start private. A public node on a public forge is readable by anyone.

### 9. Push and check

Clone first: a new repository already has a genesis commit, so pushing an unrelated history is refused.

```sh
git -c credential.helper= -c "http.extraHeader=Authorization: Bearer $TOKEN" clone "$ORIGIN/$HANDLE/poc/smoke.git"
cd smoke
mkdir -p api && printf 'package tartan\n\nname: "api"\n' > api/forge.cue
git add . && git commit -m "feat: add the api project"
git -c credential.helper= -c "http.extraHeader=Authorization: Bearer $TOKEN" push origin main
git commit --amend -m rewrite
git -c credential.helper= -c "http.extraHeader=Authorization: Bearer $TOKEN" push --force origin main   # must be refused
git reset --hard origin/main
```

```sh
curl -sS -H "authorization: Bearer $TOKEN" "$ORIGIN/-/api/repos/$REPO_ID/projects"
curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "$ORIGIN/-/api/repos/$REPO_ID/ext/rawkode.issues/tools/create" \
  -d '{"args":{"title":"first deployed issue"},"project":"api"}'
```

**Then wait at least three minutes, and read the event log:**

```sh
curl -sS -H "authorization: Bearer $TOKEN" "$ORIGIN/-/api/events?repo=$REPO_ID&types=ref.tampered"
curl -sS "$ORIGIN/-/health"
```

The result the POC depends on is **no `ref.tampered`**. The real push trigger is asynchronous and the grace window is two
minutes, so this cannot be judged sooner. If one appears, landing is paused for that repository; see
[Risks](#risks).

Finally, in a browser: the repository page, `<handle>/poc/smoke:api` (a real address with a colon), the project's Issues,
an invite link opened in a private window, and signing out.

### Phase 2: containers

Only if you want CI, the Advance, or contributors' lanes landing:

1. Install Docker. Preflight runs `docker info` by name, so `WRANGLER_DOCKER_BIN=podman` satisfies wrangler but not
   preflight.
2. Run `deno task deploy -- --stage poc --projects --no-print-url` (the same command, without `--no-containers`).
3. Wait several minutes for the first provisioning, and check `/-/health` shows a `runner`.

A redeploy without `--no-containers` is a switch to containers, so keep the flag until you mean it. Still do not pass
`--repo-config`: its problem is the direct push, and containers do not change that.

## Local and deployed are different

|                  | `deno task dev`                                    | Deployed `poc`                                                                   |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Artifacts        | `FakeArtifacts` in the dev Worker                  | The real service                                                                 |
| Push trigger     | The fake starts `IngestWorkflow` per push          | `cf.artifacts.repo.pushed`, asynchronously, per ref                              |
| Containers       | None; `TartanSandbox` is a plain Durable Object    | None in phase 1; real ones in phase 2                                            |
| Sign-in          | Automatic as `dev`; a new person per invite        | Your IdP                                                                         |
| Paths            | `dev/...`                                          | `<handle>/...`                                                                   |
| Workers AI       | A fake that answers empty                          | Real and billed                                                                  |
| State            | Memory; gone when the process stops                | Durable, and billed until destroyed                                              |
| Outbound `fetch` | Through the dev Worker's `Outbound` service        | `global_fetch_strictly_public` to the internet                                   |
| Cron             | `scheduled()` once at start and every 5 minutes    | Cron Trigger `*/5 * * * *`                                                       |
| Compat flags     | Without `durable_object_io_tasks_prevent_eviction` | With it; `--no-eviction-flag` is the fallback if the edge refuses it             |
| Setup            | A setup code from the log                          | The setup URL; `deno task poc`, `poc:proof` and `dev:bootstrap` do not work here |

**Never exercised deployed, on this branch.** Each of these has only ever met a fake or a test double:

1. **The direct push against real Artifacts.** It uploads under `refs/tartan/direct/<id>`, has RepoProbe read that commit
   through the binding, then sends a ref-only receive-pack that moves trunk and deletes the quarantine ref. Whether real
   Artifacts accepts each of those, and serves the commit immediately, is the POC's largest unknown. The failure is
   designed to be safe: a probe failure refuses the push, and a client sees 502 or a rejected ref.
2. **The trigger against that sequence.** One push is three ref updates, so three events, racing the push's own record.
   The observers are written to ignore the quarantine prefix and to explain the rest. Only a deployed forge can show it.
3. **Discovery on real data:** the `waitUntil` after a push, and tree reads through the binding's limits.
4. **Issues on the platform:** `PUT /-/api/packages` to real R2, and the WASM package as a Worker Loader facet of
   `ExtensionDO`. The README lists the extension runtimes as built and tested, not live-proven.
5. **The new SPA on real assets.** That includes the redirect from `:` to `%3A`, seen only under miniflare, and the CSP.
6. **A real IdP against this branch**, an invite accepted through one, and the Vue shell's sign-in return.
7. **A redeploy with data**, and with it Durable Object schema changes applied to existing rows. Local state never
   survives a restart, so this code path has not run for this branch's schema.
8. **The edge's own checks:** the eviction flag, `triggers.events`, `limits.cpu_ms` and the 1-second Worker startup limit.

## What has been proven

Run on 2026-11-04 at `eda2fcb`, with no credentials and no deploy.

| Ran                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                      | Proves                                                                                                 | Does not prove                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `render-config --stage poc --no-containers --projects scan`, then `wrangler deploy --dry-run`, inside `unshare -rn` (no network), no `CLOUDFLARE_*` variables, a scratch `XDG_CONFIG_HOME`                               | Exit 0. 3,828 KiB, 825 KiB gzipped; 101 asset files; 24 bindings and vars listed; `tartan-poc` names rendered through; `TARTAN_PROJECTS` set, `TARTAN_REPO_CONFIG` absent                                                                   | The SPA builds, wrangler 4.145.0 bundles the Worker and accepts the config, with no account or network | Anything about the account, the edge or the runtime. A dry run validates nothing on Cloudflare's side |
| The same with containers (`--stage pocc`)                                                                                                                                                                                | Exit 1: `The Docker CLI is needed to build the configured image before deploying (even in dry-run mode)`                                                                                                                                    | Phase 2 cannot even be dry-run here without an engine                                                  | The runner image, which was not built                                                                 |
| `optionsFromArgs` with the step 4 flags                                                                                                                                                                                  | Parsed: `projects` true, `repoConfig` false, containers false                                                                                                                                                                               | `deploy.ts` accepts the flags                                                                          | The deploy itself                                                                                     |
| `extToolchainIssues` in the dev shell                                                                                                                                                                                    | Reports the wasm32 target missing                                                                                                                                                                                                           | `--build-ext` is unusable here                                                                         |                                                                                                       |
| Steps 6 to 9 against `deno task dev` on a local port, with private nodes and a token of exactly the step 6 scopes (minted by cookie): publish, install, clone, direct push, forced rewrite, projects, tool route, events | 201s; `main` moved; rewrite got `non-fast-forward`; `api` discovered; issue created with `"project":"api"`; events show no `ref.tampered`; an anonymous read of the private repo got 404. A token mint and an invite by bearer each got 403 | These API calls are spelled correctly, and behave this way **against fakes**                           | Real Artifacts, R2, Worker Loader or an IdP                                                           |
| `wrangler check startup`                                                                                                                                                                                                 | Did not produce a profile: it reported wrangler's Docker error                                                                                                                                                                              | Nothing. Startup time is unmeasured                                                                    |                                                                                                       |

Not run: the browser console snippet in step 6 (the same request by cookie was), revoking a token, the smoke suites,
`deno task preflight`, and anything that needs a login. The prices and availability above come from Cloudflare's docs, not from your account.

## Rollback

There is no data rollback. Decide what you are undoing.

**A bad Worker version:**

```sh
npx wrangler versions list --name tartan-poc
npx wrangler rollback <version-id> --name tartan-poc -m "<why>"
```

- It is blocked if a Durable Object class change happened in between. This branch adds none, as `wrangler.jsonc` still
  has `v1` and `v2`.
- **Do not roll back to the first version.** `versionId` in the deploy record comes from `wrangler deploy`, which on a
  first deploy runs _before_ the secrets are put. Cloudflare's rollback page does not say how secrets behave. If that
  version ran without `TARTAN_SECRET`, the forge would use another root key and its sealed values would be unreadable.
  Choose a version from after the secrets, and treat this as untested.
- It does not undo schema changes a newer version already made in Durable Objects.

**A bad switch:** run the deploy again with the flags you want. It is idempotent, and it never replaces `TARTAN_SECRET`.

**Bad data:** there is no tool for it. A fast-forward on trunk cannot be rewritten through the forge, by design. Versions
of a package are immutable, and uninstalling Issues deletes its data. There is no in-place upgrade from one version to
another either. Durable Objects' point-in-time recovery exists on the platform but nothing here uses it.

**The whole forge:**

```sh
deno task destroy -- --stage poc --delete-namespace
```

It refuses if `/-/health` names another stage, shows an inventory, and asks you to type the stage name. It removes the
OIDC client first, then the Worker and its Durable Objects, Workflows, bucket, KV, and after a second confirmation the
Artifacts repositories. **This is permanent:** `--keep-repos` keeps the git data, nothing keeps the Durable Objects, so
issues and the tree are gone. Since the POC holds nothing you need, this is the rollback to prefer.

## Risks

| Risk                                                            | Likelihood                                | Effect                                                                                                                   | What to do                                                                                                                     |
| --------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| The direct push fails on real Artifacts                         | Unknown; the main reason to deploy at all | The Owner cannot push, and with no containers nothing can move trunk                                                     | Step 9 finds it at once. No data is at stake: fix it locally and redeploy, or `destroy`                                        |
| `ref.tampered` fires after a real push                          | Unknown                                   | Landing paused for that repo. With no containers nothing lands anyway, but the forge reports tampering it did not suffer | Read the event log in step 9, and treat it as a bug in the observers                                                           |
| Setup URL leaks before the claim                                | Low                                       | Someone else owns the forge                                                                                              | `--no-print-url`, claim immediately, delete the token and the file                                                             |
| Unexpected spend                                                | Low without containers                    | Artifacts billing starts 2026-11-12; `/-/health/warm` and containers cost more in phase 2                                | Set a budget alert before step 4. `max_instances` is 20, so a public forge with containers needs watching. `destroy` when done |
| An issue, `.cue` file or switch is taken for a security control | Medium                                    | A false sense of isolation                                                                                               | Repeat the [weakenings](#what-this-poc-changes) to anyone you invite. Keep nodes private                                       |
| Invite goes to the wrong person                                 | Low                                       | They get that node's role                                                                                                | Invites are single-use and can be revoked; give the lowest useful role                                                         |
| The zone challenges non-browsers                                | With `--domain`, on a zone with bot rules | git and `/-/cap/*` break                                                                                                 | See [Custom domain](deploy.md#custom-domain)                                                                                   |
| Beta services change                                            | Medium                                    | Artifacts and Dynamic Workers are betas, and `wrangler.jsonc` pins behaviour by compat date only                         | Keep this disposable. Do not store anything here you cannot recreate                                                           |
| Stale docs mislead                                              | Certain                                   | Much of `README.md` and `docs/` still describes the full forge (lanes landing, CI, extensions removed from this branch)  | This page and [`projects.md`](projects.md) win for the POC                                                                     |

## Open questions

These are for the owner and are not settled here:

1. **The stage's name and host.** `poc` on workers.dev is assumed. A custom host changes step 4 and the IdP redirect.
2. **Which IdP, and what handle it sends.** The handle becomes your root path, and step 5 cannot start without an IdP.
3. **Is `poc/tartan` meant to be public?** It is, and that goes against `AGENTS.md` rule 9. Commit `f01c0c7` also exposes
   an email address, and removing it needs a force push.
4. **Containers or not.** Phase 1 assumes not. Without them, nothing a contributor pushes can reach trunk.
