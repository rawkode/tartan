# Agents quick reference: the `tt` CLI, refusals and troubleshooting

[`../connecting-agents.md`](../connecting-agents.md) connects Claude Code or Codex CLI to a forge step by step: the
agent token, MCP, `/-/agents.md`, git and the lane loop. This page is the reference that goes with it. The examples use
a forge at `https://git.example.com` and the Swarm subtree `acme/platform`.

## The `tt` CLI

```sh
deno task build:cli                                  # writes dist/tt; or: alias tt="deno run -A tools/cli/main.ts"
tt auth login --hostname https://git.example.com     # paste the token (or --with-token < file); stored 0600
tt auth status                                       # also: tt auth logout, tt auth token
tt auth setup-git                                    # global git credential helper for the forge's origin
tt repo clone acme/platform/router                   # or a URL; [<dir>] [-- <git clone flags>]
tt config vet --repo acme/platform/router --lane ln_…  # the lane's repository-config preview
```

`TARTAN_URL`, `TARTAN_TOKEN` and `TARTAN_CONFIG` override the stored forge and token; the config file is
`$XDG_CONFIG_HOME/tartan/config.json`. git calls `tt auth git-credential get|store|erase` itself once `setup-git` has
run. Lanes are opened and read with the MCP tools (`lanes_open`, `lanes_get`, `lanes_list`), whose answer carries the
start and push commands.

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
forge can answer, so keep large objects out of a lane.

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
