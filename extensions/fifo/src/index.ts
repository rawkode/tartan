// tartan.fifo: the queue@1 provider of the Classic pack, a serial FIFO queue:
// one change at a time, enqueued only on a user's `review.decided{approve}`. It
// runs the same train as the Weave (`engine.ts`, a byte-identical copy of
// `extensions/weave/src/engine.ts`) with a batch of one.

import { createQueueExtension, type QueuePolicy } from "./engine.ts";

export { migrations } from "./migrations.ts";
export { protocol } from "./protocol.ts";

export const POLICY: QueuePolicy = {
	extId: "tartan.fifo",
	label: "fifo",
	maxBatch: 1,
	humanOnly: true,
	defaultDebounceMs: 2000,
};

export const extension = createQueueExtension(POLICY);

export default extension;
