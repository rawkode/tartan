# Agents quick reference: the `tartan` CLI, refusals and troubleshooting

[`../connecting-agents.md`](../connecting-agents.md) connects Claude Code or Codex CLI to a forge step by step: the
agent token, MCP, `/-/agents.md`, git and the lane loop. This page is the reference that goes with it. The examples use
a forge at `https://git.example.com` and the Swarm subtree `acme/platform`.

## The `tartan` CLI

```sh
deno compile -A -o tartan tools/cli/main.ts      # or: alias tartan="deno run -A tools/cli/main.ts"
tartan login https://git.example.com                # paste the token (or --token-stdin); stored 0600
tartan credential install --global                  # git asks tartan for every URL on the forge
tartan hooks install --git                          # in a clone: pre-push target and size check
tartan lane open --repo acme/platform/router --purpose "fix routing" --prefix src/router/
tartan lane status ln_…                             # or: tartan lane list --repo acme/platform/router --mine
tartan inbox --wait --ack                           # notices, long-poll up to 25 s
```

`tartan lane open` waits while the lane is `opening`, adds a `lane-<n>` remote for a lane that is its own repository and
prints the start and push commands. The pre-push hook refuses, before any upload, a push to the repo's `main`, to a lane
that is not yours, to any other branch (as an agent), an object of 31 MiB or more, and a push whose estimated size is over
the forge's limit; `git push --no-verify` skips it (the forge still applies its rules).

## What the forge refuses

Every refused push is answered with an `ng` line that git prints as `! [remote rejected] <ref> (<reason>)`:

| You push                                                                         | Answer                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------- |
| `main` of the repo                                                               | `woven-by-tartan`: push your lane instead |
| another agent's lane (its lane remote or its `refs/heads/lanes/<id>`)            | `not-your-lane`                           |
| any other branch (as an agent)                                                   | `agents-lanes-only`                       |
| a branch a person turned into a lane, if it is not yours                         | `lane-owned`                              |
| a tag (as an agent, or below Maintainer)                                         | `tags-maintainer`                         |
| a ref other than `main` on a lane remote                                         | `lane-main-only`                          |
| your lane while it is `opening` or `landing`                                     | `lane-opening` / `lane-landing`           |
| an object of 32 MiB or more, or a push over the forge's limit (95 MB by default) | `object-too-large` / `push-too-large`     |

An agent without an open branch lane in the repository (for example, on a repository that uses lane repositories) gets
`agents-lanes-only` for any push to the repository's own URL, `main` included. The whole push is uploaded before the
forge can answer, so install the pre-push check to fail fast.

## Troubleshooting

| Symptom                  | Cause                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `401` from `/-/mcp`      | no or invalid token (cookies are never accepted on `/-/mcp`)                    |
| `403 scopes`             | the token lacks the `mcp` scope                                                 |
| `403 host`               | use the forge's canonical URL, not `*.workers.dev`                              |
| `403 csrf`               | a browser `Origin` other than the forge's; MCP clients send none                |
| `404` on `/-/mcp/<path>` | the path does not exist, is outside the token's node, or you have no role there |
| `invalid: repo required` | name the repo (`repo`), or use the MCP URL of a repo                            |
| `protocol_mismatch`      | the repo you named runs another protocol: register the `mcpUrl` it gives you    |
