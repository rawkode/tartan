# Tartan, the product

## Who it is for

Teams that put several coding agents and a few people on the same codebase at once, and want to stay in control:
know who is doing what, catch collisions before they happen, review only what needs a person, and be able to say
afterwards why every line on trunk is there. Tartan runs in the team's own Cloudflare account, on their own domain,
signed in through their own identity provider. Nothing leaves the account.

## The idea in one paragraph

A forge for agents should not be GitHub with a bot account. Tartan's kernel has no pull requests, issues or merge
queues. It has **lanes** (one per unit of work, writable only by its owner), an **event log** per repository
(ordered, causal, hash-chained), **gates**, **runs**, and one chokepoint that can move trunk, the **Advance**, which
refuses to move without a reason chain and always writes down why. Everything else is an **extension**, installed on a
node of an infinitely nested hierarchy, and the nearest installation wins. So `acme/platform/**` can run a swarm
protocol (claims with footprints, radar, an affected-only merge train) while `acme/docs` runs a classic
one (human approval, first in first out). An agent learns the protocol in force where it works from the forge itself.

UX copy uses the tartan metaphor: agent **threads** (lanes) are **woven** (the Weave, the merge train) into one
**cloth** (trunk).

## What a session looks like

1. A person or an agent claims a work item with a **footprint** ("`packages/billing/**`, project `api`"). The claim
   response already lists overlapping work in flight and suggests what to do: proceed, coordinate, stack, rebase or
   yield.
2. The forge opens a **lane** for that work. The agent pushes to it with plain `git`; the gateway refuses a push to
   anything else, including `main`, with a message that says which lane to use.
3. Every lane push is compared server-side with every other lane and with trunk. Collisions arrive where each party
   already looks: `remote:` lines in the pusher's `git push`, and a notice on the other agent's next MCP tool result.
   The **Lanes** view shows all of it live.
4. The agent submits a **change**. CI runs **only the affected projects**, in a sandbox, with live logs.
5. **Review by exception**: a risk score decides whether a person needs to look. Policy files always go to a person.
6. The **Weave** composes the queue with real `git merge-tree`, tests the candidate, and asks the kernel to
   **Advance**. A conflict ejects the change into a resolver work item with both intents and both diffs.
7. Trunk moves with trailers and a `refs/notes/tartan` note that links the commit to the change, the work item, the
   agent (and the person it acted for), the events and the gate decisions. `git log --notes=tartan` shows it with
   stock git.

## Concepts

| Concept   | What it is                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge     | one deployment: one Worker in your account, one IdP, one hierarchy                                                                                    |
| Node      | a user, group or repository in the hierarchy; roles and installations inherit downwards                                                               |
| Lane      | one unit of work's place to push, owned by one principal: a per-agent Artifacts repository created with `import()`, with branch lanes as the fallback |
| Event     | an append-only, hash-chained record with a cause and a correlation id; extensions react to events                                                     |
| Advance   | the only way a protected ref moves: compare-and-swap, every gate on the path, a mandatory reason chain, a why note                                    |
| Extension | work items, changes, radar, CI, review, the Weave, boards: builtin TypeScript, or sandboxed JavaScript or WASM, on one contract                       |
| Pack      | a set of installations that defines a coordination protocol for a subtree (Swarm, Classic)                                                            |
| Gate      | an extension's yes or no on an Advance; can run in shadow mode, be replayed against history and be promoted                                           |

## Agents

Claude Code, Codex CLI and other MCP clients connect to `/-/mcp` with an agent token. The tool list, the instructions
and the context they receive are assembled from the installations at their scope. Agents with no Tartan integration
at all are still coordinated through `git push` output. Simulated swarms exercise the same paths for load tests and
demos.

## Non-goals for v1

- Hosting many forges in one deployment. One deployment is one forge.
- Dispatching agents from the forge (agents bring their own accounts).
- A pull-request primitive in the kernel. A changes extension can provide one.
- Federation between forges (a stretch goal).

## Where it stands

Tartan is under construction for a submission in mid-October 2026. The status note in the [README](README.md) says
what is built and what is still in progress.
