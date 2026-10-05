// The `/-/live` store: one socket per repo,
// pattern routing, head tracking, resume with `since`, gap resync, backoff.

import { describe, expect, it } from "vitest";
import type { Envelope } from "@tartan/contract/events.ts";
import { createLiveStore, livePath, RECENT_MAX } from "../src/live/store.ts";
import { envelope, fakeClock, fakeSockets } from "./support/fakes.ts";

const REPO = "01k6g000000000000000000040";

describe("live store", () => {
	it("shares one socket per repo and routes events by pattern", () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		const a: string[] = [];
		const b: string[] = [];
		live.subscribe(REPO, {
			patterns: ["changes.*"],
			onEvents: (e) => a.push(...e.map((x) => x.type)),
		});
		live.subscribe(REPO, {
			patterns: ["checks.updated"],
			onEvents: (e) => b.push(...e.map((x) => x.type)),
		});
		expect(sockets).toHaveLength(1);
		expect(sockets[0]!.path).toBe(`/-/live?repo=${REPO}`);
		sockets[0]!.open();
		expect(live.status(REPO).value).toBe("open");
		sockets[0]!.send({ t: "hello", repo: REPO, head: 10 });
		sockets[0]!.send({
			t: "events",
			head: 12,
			events: [
				envelope("changes.opened"),
				envelope("checks.updated"),
				envelope("radar.updated"),
			],
		});
		expect(a).toEqual(["changes.opened"]);
		expect(b).toEqual(["checks.updated"]);
		expect(live.head(REPO)).toBe(12);
	});

	it("ignores malformed frames and does not deliver unmatched events", () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		const got: Envelope[][] = [];
		live.subscribe(REPO, {
			patterns: ["x.*"],
			onEvents: (e) => got.push([...e]),
		});
		sockets[0]!.onmessage?.({ data: "not json" });
		sockets[0]!.onmessage?.({
			data: JSON.stringify({ t: "events", events: "nope" }),
		});
		sockets[0]!.onmessage?.({ data: 42 });
		sockets[0]!.send({ t: "events", head: 1, events: [envelope("y.z")] });
		expect(got).toEqual([]);
	});

	it("reconnects with backoff and resumes from the head it saw", async () => {
		const clock = fakeClock();
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: clock });
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		sockets[0]!.open();
		sockets[0]!.send({ t: "events", head: 41, events: [envelope("a.b")] });
		sockets[0]!.drop();
		expect(live.status(REPO).value).toBe("reconnecting");
		await clock.advance(999);
		expect(sockets).toHaveLength(1);
		await clock.advance(1);
		expect(sockets).toHaveLength(2);
		expect(sockets[1]!.path).toBe(`/-/live?repo=${REPO}&since=41`);
		sockets[1]!.drop();
		await clock.advance(1999);
		expect(sockets).toHaveLength(2);
		await clock.advance(1);
		expect(sockets).toHaveLength(3);
		sockets[2]!.open();
		expect(live.status(REPO).value).toBe("open");
		sockets[2]!.drop();
		await clock.advance(1000);
		expect(sockets).toHaveLength(4); // backoff reset after a successful open
	});

	it("caps the backoff", async () => {
		const clock = fakeClock();
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({
			connect,
			scheduler: clock,
			maxBackoffMs: 4000,
		});
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		for (let i = 0; i < 6; i += 1) {
			sockets[sockets.length - 1]!.drop();
			await clock.advance(4000);
		}
		expect(sockets).toHaveLength(7);
	});

	it("tells subscribers to resync on a gap frame", () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		let resyncs = 0;
		live.subscribe(REPO, {
			patterns: ["*"],
			onEvents: () => {},
			onResync: () => resyncs++,
		});
		sockets[0]!.send({ t: "gap", from: 3, to: 900 });
		expect(resyncs).toBe(1);
		expect(live.head(REPO)).toBe(900);
	});

	it("closes the socket when the last subscriber leaves and does not reconnect", async () => {
		const clock = fakeClock();
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: clock });
		const off1 = live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		const off2 = live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		off1();
		expect(sockets[0]!.closed).toBe(false);
		off2();
		expect(sockets[0]!.closed).toBe(true);
		expect(live.status(REPO).value).toBe("closed");
		await clock.advance(60_000);
		expect(sockets).toHaveLength(1);
		expect(clock.pending()).toBe(0);
	});

	it("refuses a repo id that is not a ULID (no socket)", () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		live.subscribe("../../evil", { patterns: ["*"], onEvents: () => {} });
		expect(sockets).toHaveLength(0);
	});

	it("opens a fresh socket at the subscriber's since, so an event before the hello is replayed (e2e comment gap)", () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		const got: string[] = [];
		let resyncs = 0;
		// The slot rendered at cursor 4; the comment (seq 5) lands before the
		// socket's hello, which already says head 5.
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: (e) => got.push(...e.map((x) => x.type)),
			onResync: () => resyncs++,
			since: 4,
		});
		expect(sockets[0]!.path).toBe(`/-/live?repo=${REPO}&since=4`);
		sockets[0]!.open();
		sockets[0]!.send({ t: "hello", repo: REPO, head: 5 });
		// The kernel replays seq 5 after `since=4`.
		sockets[0]!.send({
			t: "events",
			head: 5,
			events: [envelope("work.commented")],
		});
		expect(got).toEqual(["work.commented"]);
		expect(resyncs).toBe(0);
	});

	it("resyncs a subscriber that joins a channel already past its since", async () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		sockets[0]!.open();
		sockets[0]!.send({ t: "hello", repo: REPO, head: 9 });
		let behind = 0;
		let current = 0;
		live.subscribe(REPO, {
			patterns: ["*"],
			onEvents: () => {},
			onResync: () => behind++,
			since: 7,
		});
		live.subscribe(REPO, {
			patterns: ["*"],
			onEvents: () => {},
			onResync: () => current++,
			since: 9,
		});
		await Promise.resolve();
		expect([behind, current]).toEqual([1, 0]);
		expect(sockets).toHaveLength(1);
	});

	it("resyncs a joiner past its since only for events it subscribed to", async () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		const at = (type: string, seq: number) => ({ ...envelope(type), seq });
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		sockets[0]!.open();
		sockets[0]!.send({ t: "hello", repo: REPO, head: 100 });
		// CI and agents keep the repo busy with events the slot never asked for.
		sockets[0]!.send({
			t: "events",
			head: 102,
			events: [at("checks.updated", 101), at("lane.pushed", 102)],
		});
		const counts = { unrelated: 0, matched: 0, unknown: 0 };
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: () => {},
			onResync: () => counts.unrelated++,
			since: 100,
		});
		live.subscribe(REPO, {
			patterns: ["lane.*"],
			onEvents: () => {},
			onResync: () => counts.matched++,
			since: 101,
		});
		// Before the socket's start: the channel cannot tell, so it refetches.
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: () => {},
			onResync: () => counts.unknown++,
			since: 99,
		});
		await Promise.resolve();
		expect(counts).toEqual({ unrelated: 0, matched: 1, unknown: 1 });
		// After a gap the channel no longer knows what it missed.
		sockets[0]!.send({ t: "gap", from: 102, to: 900 });
		let afterGap = 0;
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: () => {},
			onResync: () => afterGap++,
			since: 102,
		});
		await Promise.resolve();
		expect(afterGap).toBe(1);
	});

	it("resyncs everyone when a reconnect cannot resume (the first socket never said hello)", async () => {
		const { connect, sockets } = fakeSockets();
		const clock = fakeClock();
		const live = createLiveStore({ connect, scheduler: clock });
		let resyncs = 0;
		live.subscribe(REPO, {
			patterns: ["repo.config.*"],
			onEvents: () => {},
			onResync: () => resyncs++,
		});
		sockets[0]!.close();
		await clock.advance(1_000);
		expect(sockets).toHaveLength(2);
		expect(sockets[1]!.path).toBe(`/-/live?repo=${REPO}`);
		sockets[1]!.open();
		sockets[1]!.send({ t: "hello", repo: REPO, head: 42 });
		await Promise.resolve();
		expect(resyncs).toBe(1);
		// A later reconnect resumes from the head it saw: no resync.
		sockets[1]!.close();
		await clock.advance(1_000);
		expect(sockets[2]!.path).toBe(`/-/live?repo=${REPO}&since=42`);
		sockets[2]!.open();
		sockets[2]!.send({ t: "hello", repo: REPO, head: 42 });
		await Promise.resolve();
		expect(resyncs).toBe(1);
	});

	it("forgets the oldest events past RECENT_MAX and then resyncs a view older than them", async () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		sockets[0]!.open();
		sockets[0]!.send({ t: "hello", repo: REPO, head: 0 });
		const events = Array.from(
			{ length: RECENT_MAX + 10 },
			(_, i) => ({ ...envelope("checks.updated"), seq: i + 1 }),
		);
		sockets[0]!.send({ t: "events", head: events.length, events });
		let old = 0;
		let recent = 0;
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: () => {},
			onResync: () => old++,
			since: 5,
		});
		live.subscribe(REPO, {
			patterns: ["work.*"],
			onEvents: () => {},
			onResync: () => recent++,
			since: events.length - 3,
		});
		await Promise.resolve();
		expect([old, recent]).toEqual([1, 0]);
	});

	it("checks a subscriber that joins before the hello against where the socket starts", async () => {
		const { connect, sockets } = fakeSockets();
		const live = createLiveStore({ connect, scheduler: fakeClock() });
		// No `since` on the first: the socket starts at its hello's head.
		live.subscribe(REPO, { patterns: ["*"], onEvents: () => {} });
		expect(sockets[0]!.path).toBe(`/-/live?repo=${REPO}`);
		let resyncs = 0;
		const off = live.subscribe(REPO, {
			patterns: ["*"],
			onEvents: () => {},
			onResync: () => resyncs++,
			since: 3,
		});
		let gone = 0;
		const offGone = live.subscribe(REPO, {
			patterns: ["*"],
			onEvents: () => {},
			onResync: () => gone++,
			since: 1,
		});
		offGone();
		sockets[0]!.open();
		sockets[0]!.send({ t: "hello", repo: REPO, head: 6 });
		await Promise.resolve();
		// Seqs 4..6 were never sent: the view at 3 refetches; one that left does not.
		expect([resyncs, gone]).toEqual([1, 0]);
		off();
	});

	it("builds paths with since when known", () => {
		expect(livePath(REPO, null)).toBe(`/-/live?repo=${REPO}`);
		expect(livePath(REPO, 0)).toBe(`/-/live?repo=${REPO}&since=0`);
	});
});
