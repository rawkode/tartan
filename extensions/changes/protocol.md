Changes: your lane is a draft change from the moment it opens. Push your commits with the lane's `git.push` command, then call `changes_submit {laneId, title, summary}` when your acceptance criteria pass.
Submit after you push: a lane you have not pushed is refused (`empty-lane`). Every later push to the lane is a new revision, and a new revision is reviewed again.
Answer review threads with `changes_comment`; `changes_get` shows your revisions and state; `changes_abandon` gives the change up.
