// One in-memory FIFO async mutex per ExtensionDO. A
// DO's input gate closes only during storage operations, so awaits on
// capabilities or RPCs let other calls interleave; every entry point that may
// write runs under this mutex. `render`, `context` and non-mutating tools
// bypass it (they are read-only).

export type Mutex = {
	/** Runs `fn` after every earlier task has settled; tasks run one at a time, in order. */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** True while a task holds the mutex. */
	readonly locked: boolean;
	/** Tasks waiting behind the holder. */
	readonly waiting: number;
};

export const createMutex = (): Mutex => {
	let tail: Promise<void> = Promise.resolve();
	let holders = 0;
	let queued = 0;
	return {
		run: <T>(fn: () => Promise<T>): Promise<T> => {
			queued += 1;
			const result = tail.then(async () => {
				queued -= 1;
				holders += 1;
				try {
					return await fn();
				} finally {
					holders -= 1;
				}
			});
			// The chain continues whatever `fn` did.
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		get locked() {
			return holders > 0;
		},
		get waiting() {
			return queued;
		},
	};
};
