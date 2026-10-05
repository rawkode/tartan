Classic protocol: issues and pull requests. Here an issue is a `work` item and a pull request is a `change`.

- Issues: `work_list` and `work_get` read them, `work_create` files one, and `work_claim {ref}` takes one and opens your lane.
- Pull requests: your lane is a draft pull request. Push with the lane's `git.push` command, then call `changes_submit {laneId, title, summary}` to open it for review.
- A human Maintainer reviews every pull request; nothing is approved automatically. Answer review threads with `changes_comment`; every push is a new revision and is reviewed again.
- Approved pull requests land one at a time, first in, first out (`queue_status`). There are no conflict notices here: fetch trunk and rebase before you submit.
