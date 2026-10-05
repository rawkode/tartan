// tartan.weave: the queue@1 provider of the Swarm pack, the Weave merge train.
// M1 runs one serial train per repo: batches of up to four approved changes
// land through `land.submit` (see `engine.ts`). Partitions with parallel
// sub-trains, bisect and resolver work items are M2.

import { createQueueExtension, type QueuePolicy } from "./engine.ts";

export { migrations } from "./migrations.ts";
export { protocol } from "./protocol.ts";
export { settingsCue } from "./settings-cue.ts";

export const POLICY: QueuePolicy = {
	extId: "tartan.weave",
	label: "weave",
	maxBatch: 4,
	humanOnly: false,
	defaultDebounceMs: 2000,
};

export const extension = createQueueExtension(POLICY);

export default extension;
