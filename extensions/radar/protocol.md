Conflict radar watches every lane's footprint and pushed paths. Before you edit outside your footprint, call
`conflicts_check {paths}`. A `conflict` or `trunk_drift` notice names the other lane and a suggestion: `coordinate`
(`inbox_send` to its owner), `stack` (fetch its lane, rebase onto it), `rebase` (onto trunk), `yield` or `proceed`.
Answer it with `conflicts_ack {conflictId, resolution}`; `conflicts_list {laneId}` shows what is still open.
