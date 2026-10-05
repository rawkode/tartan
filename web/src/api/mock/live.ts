// A mock `/-/live` socket: says hello, then sends a coalesced `events` frame
// every `intervalMs` so slot hosts visibly refresh and the Change Graph gets
// push ticks in mock builds. Seqs continue after the fixture log's head.

import type { LiveFrame } from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import type { SocketLike } from "../../live/store.ts";
import { EVENTS_HEAD, livePush } from "./coord.ts";
import { MOCK_LIVE_EVENT_TYPES, mockUlid, REPO_ID } from "./fixtures.ts";

export const createMockConnect =
	(intervalMs = 8000) => (path: string): SocketLike => {
		const url = new URL(path, "https://forge.test");
		const repo = url.searchParams.get("repo") ?? REPO_ID;
		let head = Math.max(
			EVENTS_HEAD,
			Number(url.searchParams.get("since") ?? EVENTS_HEAD),
		);
		let timer: ReturnType<typeof setInterval> | null = null;
		const socket: SocketLike = {
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			close: () => {
				if (timer !== null) clearInterval(timer);
				timer = null;
				socket.onclose?.({});
			},
		};
		const send = (frame: LiveFrame): void => {
			socket.onmessage?.({ data: JSON.stringify(frame) });
		};
		const envelope = (
			type: string,
			data: Readonly<Record<string, unknown>>,
		): Envelope => ({
			id: mockUlid(9000 + head),
			seq: head,
			stream: `repo:${repo}`,
			type,
			v: 1,
			source: { kind: "kernel" },
			actor: { kind: "system", id: "sys_kernel" },
			node: repo,
			repo,
			depth: 0,
			shadow: false,
			at: Date.now(),
			data,
		});
		setTimeout(() => {
			socket.onopen?.({});
			send({ t: "hello", repo, head });
			timer = setInterval(() => {
				head += 1;
				const tick = head % (MOCK_LIVE_EVENT_TYPES.length + 1);
				const event = tick === 0
					? (() => {
						const p = livePush(head);
						return envelope(p.type, p.data);
					})()
					: envelope(MOCK_LIVE_EVENT_TYPES[tick - 1] ?? "checks.updated", {});
				send({ t: "events", events: [event], head });
			}, intervalMs);
		}, 50);
		return socket;
	};
