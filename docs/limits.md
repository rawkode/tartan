# Limits

What a Tartan forge accepts, and where each limit is enforced. Rejections say which limit was hit.

## Pushes

| Limit                | Value                                                                                                                 | Enforced by                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| One git object       | under 32 MiB                                                                                                          | the forge, after the upload: the push is refused with `object-too-large`                                                     |
| One push request     | `TARTAN_MAX_PUSH_MB`, default 95 MB; keep it at or below your zone plan's request-body limit (100 MB on Free and Pro) | the gateway, from `Content-Length`, before anything is sent upstream                                                         |
| Upload               | the whole request body is uploaded before the forge answers                                                           | `tartan hooks install --git` adds a pre-push check that refuses early, on the client, including any object of 31 MiB or more |
| Ref updates per push | 1,000 for people, 8 for agents                                                                                        | the gateway's receive-pack parser                                                                                            |

A push to a protected branch (such as `main`) is refused with a synthesized `ng` line (`woven-by-tartan`);
only the Advance moves protected branches. Agents may push only to their own lanes.

## Importing a repository

- **From a public URL**: Artifacts fetches it server-side, so the request-body limit and the gateway are not involved.
- **Push-mode import** for private or very large repositories: the owner creates the repository in import mode
  (`POST /-/api/nodes/repos` with `"import": {"mode": "push"}`) and pushes history in segments that each stay under the
  push limit, then marks the import complete (`POST /-/api/repos/<id>/import-complete`). Agents cannot push while a
  repository is importing, and protection and lanes start when the import is marked complete.

## Lanes

| Item                                      | Value                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lanes                                     | per-agent Artifacts repositories created with `import()`, with branch lanes (`refs/heads/lanes/<id>` in the canonical repository) as the fallback |
| Active lanes per principal per repository | 20                                                                                                                                                |
| Active lanes per repository               | a cap shown in the repository's lane settings; an Owner can change it (`maxActiveLanes`, up to 10,000)                                            |
| Lane opens                                | 30 per minute per principal                                                                                                                       |
| Attic (archived lanes)                    | kept for the repository's attic retention, an owner setting of 1-30 days (default 7), readable by members, then deleted                           |

## Custom domains

The hostname must be on a zone in the same Cloudflare account, with no DNS record of its own. Zone security features
that challenge non-browser clients must exempt `/-/cap/*` (see [deploy.md](deploy.md#custom-domain)).

## Repository config

The root CUE package `tartan` has its own limits (files, sizes, evaluation time and memory, previews); see
[`repo-config.md`](repo-config.md#limits).
