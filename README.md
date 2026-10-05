# Tartan

Tartan is a Git forge for teams of people and coding agents. You deploy it into your own Cloudflare account with one
command, and it runs entirely on Cloudflare: one Worker, Durable Objects, Workflows, Artifacts (the Git storage), R2 and
Sandbox containers for CI. One deployment is one forge, on your domain, signed in through your identity provider.

The kernel knows nothing about issues, pull requests or merge queues. It owns only what security and accountability
depend on: identity, a nested hierarchy of users, groups and repositories, lanes (one per unit of work, writable only
by its owner), a hash-chained event log per repository, and one chokepoint that can move a protected branch, the
**Advance**. Everything people think of as "the forge" (work items, changes, conflict radar, CI policy, review, the
merge train) is an extension on one public contract, installed on a node of the hierarchy. So the coordination
protocol is data, and it can differ per subtree.

Agents connect over MCP and plain `git`. Claude Code, Codex CLI and any other MCP client get the protocol in force
at their scope from the forge itself.

> **Status (October 2026): under construction.** The deploy, preflight and destroy tooling, the health and setup
> endpoints, identity (OIDC with dynamic client registration), the event log, the run executor and the extension host
> are built and tested. The Git gateway, repository creation, the Advance and the MCP host are in progress, so the
> end-to-end agent loop below does not run on a deployed forge yet.

## The five answers

**1. How do agents know what others are doing?** They are told where they already look, before they collide. A claim
declares a footprint (projects and path prefixes), and the claim response lists overlapping work in flight with a
suggestion. Every lane push is compared with every other lane and with trunk; the pusher's own `git push` prints
`remote: tartan ▸ radar: …` lines, and the other agent's next MCP tool result carries the notice. The Lanes view shows
every lane, agent, footprint and conflict live.

**2. What happens when changes conflict?** Conflicts are predicted and graded while the work happens (declared,
same project, same file, adjacent, textual) and recorded as non-blocking records. At land time the merge train
composes candidates with real `git merge-tree`. A real conflict ejects the change and opens a resolver work item that
holds both intents, both diffs and the conflict regions. Trunk moves only through the Advance (compare-and-swap,
gates, verdicts bound to the tested candidate), so there are no lost updates and no untested landings.

**3. How do you review everything?** By exception. The review extension scores risk (path sensitivity, blast radius
from the project graph, size, radar history, CI, weakened tests) and routes only the exceptions to a person, with an
evidence bundle. Policy files are always read from trunk, never from the change under review, and a change to them
always goes to a person. Every Advance runs every gate installed on the path from the root to the repository.

**4. How do you track why a change was made?** Every event carries its cause, a correlation id and a position in the
repository's hash chain. The Advance requires a reason chain (the causal events, including the change's submission
and its approval), writes trailers on the squash commit and always writes a note under `refs/notes/tartan`.
`git clone … && git log --notes=tartan` shows it with stock git.

**5. How do you compare several changes and pick the one that ships?** On evidence, through the queue. Every change
carries its evidence: CI per affected project, its conflicts with in-flight lanes and trunk drift, review risk with its
factors, and its diff per revision. Review by exception sends only the exceptions to a person, and the merge-queue
provider decides what lands and in which order (the Weave lands disjoint changes in parallel and ejects a real conflict
into a resolver work item). The same idea works one level up: a gate or review policy can be installed in shadow mode,
replayed against real history and compared before it is enforced.

**Lanes.** Lanes are per-agent Artifacts repositories created with `import()`, with branch lanes as the fallback; the
gateway lets each agent push only to its own lanes.

## Deploy (Path A: one command)

You need a Cloudflare account on Workers Paid with Artifacts enabled, Node 22+, Deno 2.9+ and, for CI, a Docker-compatible
engine.

```sh
git clone https://github.com/<you>/tartan && cd tartan
deno task deploy -- --stage prod --domain git.example.com
```

`--domain` is optional (without it the forge is on `tartan-<stage>.<your-subdomain>.workers.dev`). The command runs
`npm ci` if needed and `npx wrangler login` if you are not logged in, runs a preflight that stops with a fix-it message
for anything missing, deploys, generates the secrets, waits until the forge is healthy and prints a **single-use setup
URL**. Open it, paste your identity provider's issuer URL, and sign in to become the owner.

Useful variants:

```sh
deno run -A scripts/preflight.ts --stage prod          # the checks alone, changes nothing
deno task deploy -- --stage prod --no-containers       # no Docker needed; CI shows "unavailable"
deno task deploy -- --stage prod --no-print-url        # setup URL goes to a 0600 file (for recordings)
deno task destroy -- --stage prod                      # remove the stage (asks first)
```

[`docs/deploy.md`](docs/deploy.md) explains every step and flag, the secrets, custom domains, the runner image and
`destroy`. [`docs/limits.md`](docs/limits.md) lists the push and import limits.

**Path B, the Deploy to Cloudflare button**, is not verified yet: the button must provision Artifacts, Worker Loader,
containers and event triggers and build the runner image. Use Path A until it is.

## Manual steps that remain

Everything else is automated. These steps need you, because they involve consent, billing or systems Tartan does not
own.

| # | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Time                                                                        |
| - | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1 | Subscribe to **Workers Paid** ($5/month). Preflight warns when its token cannot read the subscription.                                                                                                                                                                                                                                                                                                                                                               | 2 min                                                                       |
| 2 | Have **Artifacts access** on the account. Preflight tells you: 200 is entitled; 403/404 means request access first.                                                                                                                                                                                                                                                                                                                                                  | minutes to days                                                             |
| 3 | `npx wrangler login` in a browser (the deploy runs it for you if needed).                                                                                                                                                                                                                                                                                                                                                                                            | 1 min                                                                       |
| 4 | **A Docker-compatible engine** (Docker Desktop, OrbStack or colima) running, with about 5 GB free, because the deploy builds the runner image `containers/runner/Dockerfile` locally (it adds a pinned git 2.38+ for `merge-tree --write-tree`, and pnpm, to the sandbox base image). Not needed with `--no-containers`, which turns CI and container git jobs off. A prebuilt image for self-deployers needs a permanent public registry, which does not exist yet. | 5 min                                                                       |
| 5 | Node 22+ and Deno 2.9+ installed.                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2 min                                                                       |
| 6 | **Paste your IdP's issuer URL** into the setup wizard. With RFC 7591 dynamic client registration Tartan registers itself as a public PKCE client. Without it, register one OIDC client with the redirect URI the wizard shows and paste its client id. Cloudflare Access also works, but an account without Zero Trust first has to create a Zero Trust organization (free plan).                                                                                    | about 1 min with DCR; 3-5 min by hand; 10-15 min with Zero Trust onboarding |
| 7 | Open the setup URL the deploy printed (single-use). Without a deployed setup token the Worker writes a claim code to **Workers Logs** instead: until the forge is claimed, anyone who can read the account's Workers Logs can claim it.                                                                                                                                                                                                                              | 30 s                                                                        |
| 8 | Optional own domain: a zone **in the same account**, with no DNS record on the hostname. If the zone has security features that challenge non-browser clients (Bot Fight Mode, WAF managed challenges, rate-limiting rules, an Access application on the hostname), **exempt `/-/cap/*`**, or agent lanes cannot be created by import and fall back to branch lanes.                                                                                                 | 2 min                                                                       |
| 9 | Optional, after the claim: delete `TARTAN_SETUP_TOKEN` (the next deploy offers it). On a forge that generated its own root key, move it into `TARTAN_SECRET` (the wizard shows the command).                                                                                                                                                                                                                                                                         | 1 min                                                                       |

To run agents against the forge you also need their own accounts (Claude Code, Codex CLI); Tartan does not dispatch
agents itself in v1.

## Repository layout

| Path                       | What                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `src/`                     | the Worker: router, kernel modules, Durable Objects, Workflows                         |
| `packages/`                | the contract (`@tartan/contract`), git protocol, diff, monorepo planner, extension API |
| `extensions/`              | first-party extensions, built on the same contract as third-party ones                 |
| `web/`                     | the Vue SPA served from the Worker's static assets                                     |
| `containers/runner/`       | the runner image for CI and kernel git jobs                                            |
| `scripts/`                 | deploy, preflight, destroy, checks, smoke and live tests                               |
| [`docs/`](docs/README.md)  | architecture overview, deploy guide, limits, design summary, smoke tests               |
| [`AGENTS.md`](AGENTS.md)   | how to work on this repository (people and agents)                                     |
| [`PRODUCT.md`](PRODUCT.md) | what Tartan is for, in product terms                                                   |

Development: `deno task verify` runs the fast checks (format, lint, types, unit tests, licenses); `deno task
test:workers` runs the Durable Object and Workflow tests in workerd. See [`AGENTS.md`](AGENTS.md).

## License

MIT; see [`LICENSE`](LICENSE). CI runs `deno task license:check`, which fails on GPL, AGPL or LGPL-only dependencies.
There are two notes:

- The runner container image (`containers/runner/`, used for runs and kernel git jobs) includes `git`, which is
  GPL-2.0. It is a separate program that Tartan runs. Tartan does not link it.
- One reviewed exception is listed in `scripts/license-check.ts`. miniflare, a dev-only test tool, pulls in libvips
  (LGPL-3.0) as optional prebuilt binaries. They are never bundled into the Worker.
