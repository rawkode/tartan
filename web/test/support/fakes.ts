// Fake clock and sockets for the live store, slot controller and setup checks.

import type { Scheduler } from "../../src/live/scheduler.ts";
import type { SocketLike } from "../../src/live/store.ts";

export type FakeClock = Scheduler & {
	/** Advances time, running due timers in order. */
	readonly advance: (ms: number) => Promise<void>;
	readonly pending: () => number;
};

export const fakeClock = (start = 1_000_000): FakeClock => {
	let now = start;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimeout: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { at: now + Math.max(0, ms), fn });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		pending: () => timers.size,
		advance: async (ms) => {
			const end = now + ms;
			for (;;) {
				// Let pending promise chains register their timers first.
				for (let i = 0; i < 10; i += 1) await Promise.resolve();
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				// Let promise continuations scheduled by the timer run.
				for (let i = 0; i < 5; i += 1) await Promise.resolve();
			}
			now = end;
			for (let i = 0; i < 5; i += 1) await Promise.resolve();
		},
	};
};

export type FakeSocket = SocketLike & {
	readonly path: string;
	closed: boolean;
	readonly open: () => void;
	readonly send: (frame: unknown) => void;
	readonly drop: () => void;
};

export const fakeSockets = (): {
	readonly connect: (path: string) => SocketLike;
	readonly sockets: FakeSocket[];
} => {
	const sockets: FakeSocket[] = [];
	return {
		sockets,
		connect: (path) => {
			const socket: FakeSocket = {
				path,
				closed: false,
				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
				close: () => {
					socket.closed = true;
					socket.onclose?.({});
				},
				open: () => socket.onopen?.({}),
				send: (frame) => socket.onmessage?.({ data: JSON.stringify(frame) }),
				drop: () => {
					socket.onerror?.({});
					socket.onclose?.({});
				},
			};
			sockets.push(socket);
			return socket;
		},
	};
};

let seq = 0;
export const envelope = (type: string, at = 0) => ({
	id: `01k6g${String(++seq).padStart(21, "0")}`,
	seq,
	stream: { kind: "repo", id: "r" },
	type,
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: "n",
	depth: 0,
	shadow: false,
	at,
	data: {},
});
