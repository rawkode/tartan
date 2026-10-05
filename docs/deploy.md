# Deploying Tartan

One deployment is one forge: one Worker `tartan-<stage>` and the resources named after it. `--stage` picks the
names, so several forges (say `prod` and `staging`) can live in one account.

```sh
deno task deploy -- --stage <stage> [--domain <host>] [options]
deno run -A scripts/preflight.ts --stage <stage> [--domain <host>] [options]
deno task destroy -- --stage <stage> [options]
```

`wrangler.jsonc` is the source of truth for the Worker's bindings. The deploy never edits it: it renders
`.wrangler/deploy/wrangler.<stage>.jsonc` from it (comments preserved) and deploys that.

## What `deploy` does

The command is idempotent; run it again to upgrade a forge. Durable Object data survives redeploys.

| Step | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `npm ci` when `node_modules` is missing or does not match the exact pins in `package.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1    | `npx wrangler whoami`; `npx wrangler login` when you are not logged in and a terminal is attached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2    | **Preflight** (below). Any `fail` stops the deploy before anything changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3    | With `--image registry` and no usable record: publish the runner image (`containers/runner/publish.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4    | Render the stage config: Worker `tartan-<stage>`, Artifacts namespace `tartan-<stage>` (binding and event trigger), Workflows `tartan-<stage>-{run,land,ingest,swarm}`, bucket `tartan-<stage>-blobs`, `TARTAN_STAGE`, the `--domain` route, the image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5    | `npm run build:web` (the SPA), then `npx wrangler deploy -c <rendered>`. The KV namespace and the R2 bucket are provisioned on the first deploy. A container registry push that times out is retried once. With `--image registry`, the deployed container application must report the recorded digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6    | Secrets, generated here (32 random bytes each) and written through `wrangler secret put`'s stdin, never through arguments or files: on the first deploy `TARTAN_SECRET` and `TARTAN_SETUP_TOKEN`; on a redeploy of a forge that is not claimed yet, a new `TARTAN_SETUP_TOKEN` (so the setup URL can be printed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7    | Poll `/-/health` on `tartan-<stage>.<subdomain>.workers.dev` until it answers 200 for this stage with every binding `ok` (up to 3 minutes, the same poll as step 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8    | Containers only: `POST /-/health/warm`, for up to 2 minutes, so the runner image's first start happens now and not in the first CI run. Each request gives up after 90 seconds (a new container app's first start took about 54 s) and never runs past the 2 minutes. `/-/health` then shows the runner's git version and image                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9    | With `--domain`: poll `/-/health` on the custom domain until this stage answers 200 (up to 10 minutes). Every attempt opens a new connection, so a cached DNS answer or a kept-alive connection to the hostname's old server cannot stick, and gives up after 10 seconds. Each attempt is classified as `dns` (the hostname does not resolve yet), `tls` (the TLS handshake failed: the certificate is probably still being issued), `unreachable` (refused, reset or no answer in time), `foreign` (a server answered, but not this stage's `/-/health`), `unhealthy` (this stage answered, but not 200) or `healthy` (the deploy goes on). A line with the elapsed time is printed each time the class changes; what to do for each is under [Troubleshooting](#troubleshooting) |
| 10   | Print the single-use setup URL `https://<host>/-/setup#t=<token>` once, with the IdP hint. `--no-print-url` writes it to a 0600 file instead (`.wrangler/deploy/setup-url.<stage>.txt`, or `--url-file`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11   | Write the deploy record `.wrangler/deploy/record.<stage>.json` (hostname, version, image, commit, setup state); `destroy` adds the DCR outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

After the claim, the next deploy offers to delete `TARTAN_SETUP_TOKEN` (`--delete-setup-token` does it without asking).
A new value set later with `wrangler secret put TARTAN_SETUP_TOKEN` is how an owner recovers a forge; a consumed value
is refused forever.

The token rides in the URL fragment (`#t=`), so it never reaches a server log; the setup page reads it and removes it
from the address bar before anything renders.

## Preflight

Every check passes, warns (it could not decide; the setup wizard re-checks) or fails with a fix-it line.

| Check              | How                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`, `deno`     | Node 22+, Deno 2.9+                                                                                                                                        |
| `wrangler`         | the pinned devDependency in `node_modules`                                                                                                                 |
| `login`            | `npx wrangler whoami --json`; several accounts need `--account` or `CLOUDFLARE_ACCOUNT_ID`                                                                 |
| `api-token`        | `npx wrangler auth token --json`, or `CLOUDFLARE_API_TOKEN` if set. Without a token the account checks below are skipped with a warning                    |
| `artifacts`        | `GET /accounts/{id}/artifacts/namespaces`: 200 entitled, 401 the token was rejected, 403/404 Artifacts is not enabled on the account                       |
| `workers.dev`      | the account's workers.dev subdomain (the health poll uses it)                                                                                              |
| `workers-paid`     | the account's subscriptions, when the token may read them (a wrangler login usually may not: then a warning)                                               |
| `runner-image`     | `--image registry` only: the recorded digest is under 23 hours old and was built from this commit, or from one with the same `containers/runner/`          |
| `container-engine` | only when an image is built on this machine (`--image dockerfile`, or `registry` without a usable record): `docker info`                                   |
| `disk`             | the same condition: at least 5 GB free for the image build                                                                                                 |
| `domain-zone`      | `--domain`: a zone for the hostname exists in this account                                                                                                 |
| `domain-takeover`  | `--domain`: the hostname is not another Worker's Custom Domain. Refused unless `--take-domain`, so a scratch stage can never take over a live forge's host |
| `domain-dns`       | `--domain`: no DNS record on the hostname (a warning when the token cannot read DNS; wrangler then names any conflicting record)                           |

## Flags

| Flag                           | Effect                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stage <stage>`              | required; lowercase letters, digits and single hyphens, at most 32 characters                                                                        |
| `--domain <host>`              | a Workers Custom Domain on a zone in the same account                                                                                                |
| `--take-domain`                | move `<host>` from another Worker on purpose                                                                                                         |
| `--no-containers`              | no runner image: CI and container git jobs show "unavailable"                                                                                        |
| `--image dockerfile`           | the default: build `containers/runner/Dockerfile` here (needs Docker)                                                                                |
| `--image registry`             | render the digest that `containers/runner/publish.ts` recorded (`--image-record <path>`); a tag reference is always refused                          |
| `--no-eviction-flag`           | drop `durable_object_io_tasks_prevent_eviction` from the rendered config                                                                             |
| `--dev-tools`                  | `TARTAN_DEV_TOOLS=1` (swarm, bulk agent tokens, reset); only for `dev` and `dev-*` stages, and the UI shows a red bar                                |
| `--repo-config`                | `TARTAN_REPO_CONFIG=on`: evaluate each repository's root CUE package `tartan` ([`repo-config.md`](repo-config.md)); needs containers; off by default |
| `--no-print-url`, `--url-file` | write the setup URL to a 0600 file                                                                                                                   |
| `--keep-setup-token`           | do not issue a new setup token on an unclaimed forge                                                                                                 |
| `--delete-setup-token`         | after the claim, delete `TARTAN_SETUP_TOKEN` without asking                                                                                          |
| `--skip-build`                 | reuse `web/dist`                                                                                                                                     |
| `--account <id or name>`       | pick the Cloudflare account                                                                                                                          |

## Secrets and vars

| Name                            | Kind   | Set by                                                                                                                                                                                                      |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARTAN_SECRET`                 | secret | the first deploy. The root key: every other key (sealing, cookie MACs, lane capability URLs) is derived from it. A redeploy never replaces it: a forge that generated its own root key keeps using that key |
| `TARTAN_SETUP_TOKEN`            | secret | the deploy; single-use; delete it after the claim                                                                                                                                                           |
| `TARTAN_DESTROY_TOKEN`          | secret | `destroy` only, once, to authorize the DCR deregistration                                                                                                                                                   |
| `OIDC_CLIENT_SECRET`            | secret | you, only for a confidential client set up by hand; DCR and public clients need none                                                                                                                        |
| `TARTAN_STAGE`                  | var    | the render                                                                                                                                                                                                  |
| `TARTAN_MAX_PUSH_MB`            | var    | `wrangler.jsonc` (default 95); never above your zone plan's request-body limit                                                                                                                              |
| `TARTAN_FEATURES`               | var    | `wrangler.jsonc`                                                                                                                                                                                            |
| `TARTAN_REPO_CONFIG`            | var    | the render with `--repo-config` (`on`); absent means off: no repository config is evaluated, CI runs zero-config and review has no owners rules                                                             |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | var    | optional GitOps override of the wizard                                                                                                                                                                      |

## Custom domain

`--domain git.example.com` renders `routes: [{ pattern: "git.example.com", custom_domain: true }]`; wrangler creates the
DNS record and the certificate. The deploy waits until this stage answers on that hostname before it prints the setup URL. Run the wizard on
that host (or **Settings → Domain** later) so it becomes the canonical origin: other hosts then redirect there, and a
DCR client is moved to the new redirect URI automatically.

If the zone challenges non-browser clients (Bot Fight Mode, WAF managed challenges, rate limiting, an Access
application on the hostname), exempt `/-/cap/*`: Artifacts' importer fetches lane seeds from there without cookies.
The post-claim self-test names this cause when it fails.

## The runner image

CI jobs and kernel git jobs (composing candidates, notes, lease pushes) run in a Sandbox container built from
`containers/runner/Dockerfile`: the sandbox base image pinned by digest, plus a pinned git 2.38+ and pnpm. The image is
about 300 MB; `wrangler deploy` builds it with your local engine and pushes it to Cloudflare's registry in about two
minutes.

The `registry` variant skips the local build at deploy time: `containers/runner/publish.ts` builds the same Dockerfile
from a clean checkout, pushes it to an ephemeral public registry and records the digest, and the deploy renders the
image by digest only. It is meant for the authors' dev and demo stages; it still needs an engine wherever the image is
published, and the ephemeral registry keeps images for at most 24 hours. Self-deployers use `dockerfile` until a
permanent registry exists.

## Destroy

```sh
deno task destroy -- --stage <stage> [--yes] [--keep-repos] [--delete-namespace]
```

It touches only resources whose names the stage determines, and refuses if the Worker's `/-/health` reports a
different stage. It prints an inventory and asks you to type the stage name (or takes `--yes`). Then:

1. **The OIDC client goes first.** It sets a one-time `TARTAN_DESTROY_TOKEN` and calls `POST /-/admin/idp/deregister`;
   the Worker sends the RFC 7592 `DELETE` for the client it registered by DCR. If that fails, the client id is printed
   so you can remove it at the IdP by hand.
2. The Worker (which also releases its Custom Domain and deletes its Durable Objects), the four Workflows, the
   container application and its registry images, the R2 bucket (emptied first) and the KV namespace.
3. The stage's Artifacts repositories (canonical `r-*` and lane `l-*`) are listed and deleted after their own
   confirmation; `--keep-repos` keeps them.
4. **The Artifacts namespace needs a REST call.** wrangler has no command to delete a namespace, so destroy prints the
   `curl -X DELETE …/accounts/<id>/artifacts/namespaces/tartan-<stage>` line, or sends it with `--delete-namespace`.
5. Local files: the rendered config and the setup URL file are removed; the deploy record keeps what was removed and
   the DCR outcome.

## Troubleshooting

| Symptom                                                                 | Cause and fix                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| preflight `artifacts` fails with 403 or 404                             | the account has no Artifacts access yet; request it, then rerun                                                                                                                                                                                                                                                                                                     |
| preflight `container-engine` fails                                      | start Docker Desktop, OrbStack or colima, or deploy with `--no-containers`                                                                                                                                                                                                                                                                                          |
| `domain-takeover` fails                                                 | another Worker serves that hostname; pick another, destroy that stage, or pass `--take-domain` on purpose                                                                                                                                                                                                                                                           |
| health poll: `the hostname does not resolve yet` (`dns`)                | the Custom Domain's DNS record is not visible from this machine yet. It usually appears within a minute or two; if not, check the Worker's **Settings → Domains & Routes** and the zone's DNS records                                                                                                                                                               |
| health poll: `the TLS handshake failed` (`tls`)                         | the certificate is probably still being issued; wait, or check **SSL/TLS → Edge Certificates** for the hostname. An untrusted certificate in the detail can also mean the hostname still reaches an old server (see `foreign`)                                                                                                                                      |
| health poll: `no answer` (`unreachable`)                                | the connection was refused or reset, or nothing answered within 10 seconds: check this machine's network, VPN or proxy                                                                                                                                                                                                                                              |
| health poll: `the answer is not from Tartan stage <stage>` (`foreign`)  | another server answers for the hostname: an old A, AAAA or CNAME record that is still in place, this machine's cached lookup of it (it expires with that record's TTL; flushing the OS DNS cache helps), Cloudflare's own page before the route is live, or another stage that still holds the domain. Remove the old record so the Custom Domain owns the hostname |
| health poll: `answered, but is not healthy yet` (`unhealthy`)           | this stage answers 503; the line names the bindings that are not `ok`. If that lasts, check those bindings in the rendered config and the account                                                                                                                                                                                                                   |
| health poll: `healthy`                                                  | nothing to do: the deploy goes on                                                                                                                                                                                                                                                                                                                                   |
| health poll ends with `did not answer as Tartan stage <stage> within …` | the error names the last class and how long it lasted: fix that as above, then rerun the deploy (it is idempotent)                                                                                                                                                                                                                                                  |
| the setup URL says "invalid setup token or code"                        | a later deploy issued a new token; use the newest URL. Too many wrong attempts are rate-limited for a few minutes                                                                                                                                                                                                                                                   |
| `/-/health` shows no `runner` after a container deploy                  | the warm-up did not finish in 2 minutes; `POST /-/health/warm` again after 10 minutes, or let the first CI run start it                                                                                                                                                                                                                                             |
