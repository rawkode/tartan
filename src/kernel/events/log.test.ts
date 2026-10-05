// The per-repo event log over a `node:sqlite` fake (WP6: total
// order, idempotent appends, depth guard, shadow isolation, K10 namespace and
// schema re-checks, the hash chain and its verification across pruning).

import {
	deepStrictEqual as assertEquals,
	ok as assert,
} from "node:assert/strict";
import {
	type AppendInput,
	createUlid,
	EVENT_DATA_MAX_BYTES,
	isTartanError,
} from "@tartan/contract";
import {
	EVENT_RETENTION_MS,
	GENESIS_PREV_HASH,
	SIM_EVENT_RETENTION_MS,
} from "@tartan/contract/kernel.ts";
import {
	createEventLog,
	type EventLog,
	REPO_EVENTS_MIGRATIONS,
} from "./log.ts";
import type { SqlExec } from "./sql.ts";
import { applyMigrations, createFakeStorage } from "./testing/sqlite.ts";

const REPO = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "01k6bbbbbbbbbbbbbbbbbbbbbb";
const USER = "u_01k6cccccccccccccccccccccc";
const INST = "i_01k6dddddddddddddddddddddd";
const LANE = "ln_01k6eeeeeeeeeeeeeeeeeeeeee";
const SHA = "a".repeat(40);
const CHANGE = "k".repeat(32);

type Harness = {
	log: EventLog;
	now: { value: number };
	lane: string[];
	appended: string[];
};

const harness = (
	repoId: string | null = REPO,
	simulated?: () => boolean,
): Harness => {
	const storage = createFakeStorage();
	applyMigrations(storage, REPO_EVENTS_MIGRATIONS);
	const now = { value: Date.UTC(2026, 9, 2) };
	const lane: string[] = [];
	const appended: string[] = [];
	const log = createEventLog({
		sql: storage.sql as unknown as SqlExec,
		transact: storage.transactionSync,
		clock: { now: () => now.value },
		ids: { ulid: createUlid({ now: () => now.value }) },
		repoId: () => repoId,
		applyLaneEvent: (event) => lane.push(event.type),
		onAppend: (event) => appended.push(event.id),
		...(simulated ? { simulated } : {}),
	});
	return { log, now, lane, appended };
};

let counter = 0;
const pushAccepted = (
	overrides: Partial<AppendInput> = {},
): AppendInput => ({
	type: "push.accepted",
	source: { kind: "kernel" },
	actor: { kind: "user", id: USER },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	data: {
		pushId: `p${counter}`,
		target: "repo",
		ref: "refs/heads/main",
		before: SHA,
		after: "b".repeat(40),
		via: "gateway",
	},
	idemKey: `kernel:req${counter++}:push.accepted:0`,
	...overrides,
});

const extEvent = (overrides: Partial<AppendInput> = {}): AppendInput => ({
	type: "x.acme.radar.ping",
	source: { kind: "installation", id: INST, ext: "acme.radar@1.0.0" },
	actor: { kind: "ext", id: `x_${INST}` },
	node: REPO,
	depth: 1,
	shadow: false,
	data: { n: counter },
	idemKey: `${INST}:c${counter++}:x.acme.radar.ping:0`,
	...overrides,
});

const errorCode = (fn: () => unknown): string => {
	try {
		fn();
	} catch (error) {
		assert(isTartanError(error), String(error));
		return `${error.code}${error.reason ? `:${error.reason}` : ""}`;
	}
	throw new Error("expected a throw");
};

Deno.test("appends get strictly increasing seqs and a chained hash", () => {
	const { log, appended } = harness();
	const results = Array.from(
		{ length: 5 },
		() => log.appendSync(pushAccepted()),
	);
	assertEquals(results.map((r) => r.seq), [1, 2, 3, 4, 5]);
	assert(results.every((r) => r.created));
	assertEquals(appended.length, 5);
	const events = log.read({ since: 0 });
	assertEquals(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
	assertEquals(events[0].stream, `repo:${REPO}`);
	assertEquals(events.map((e) => e.hash), results.map((r) => r.hash));
	assertEquals(log.headSync(), { seq: 5, hash: results[4].hash });
	assertEquals(log.verifyChain(1, 5), { ok: true });
});

Deno.test("appends are idempotent on idemKey", () => {
	const { log, appended } = harness();
	const input = pushAccepted();
	const a = log.appendSync(input);
	const b = log.appendSync({ ...input, data: { different: true } });
	assertEquals(b, { ...a, created: false });
	assertEquals(log.headSync().seq, 1);
	assertEquals(appended.length, 1);
});

Deno.test("K10 depth guard: > 8 is denied and causedBy raises the depth", () => {
	const { log } = harness();
	assertEquals(
		errorCode(() => log.appendSync(extEvent({ depth: 9 }))),
		"denied:depth",
	);
	const root = log.appendSync(extEvent({ depth: 8 }));
	// A child claiming depth 0 is stored one below its cause … and so denied.
	assertEquals(
		errorCode(() => log.appendSync(extEvent({ depth: 0, causedBy: root.id }))),
		"denied:depth",
	);
	const shallow = log.appendSync(extEvent({ depth: 2 }));
	const child = log.appendSync(extEvent({ depth: 0, causedBy: shallow.id }));
	assertEquals(log.getSync([child.id])[0].depth, 3);
});

Deno.test("K10 namespaces and payload schemas are re-checked", () => {
	const { log } = harness();
	const installation = {
		kind: "installation" as const,
		id: INST,
		ext: "acme.radar@1.0.0",
	};
	// An installation cannot emit kernel types or another extension's events.
	assertEquals(
		errorCode(() => log.appendSync(pushAccepted({ source: installation }))),
		"denied:namespace",
	);
	assertEquals(
		errorCode(() => log.appendSync(extEvent({ type: "x.acme.other.ping" }))),
		"denied:namespace",
	);
	// The kernel cannot emit forge-only or unknown types.
	assertEquals(
		errorCode(() =>
			log.appendSync(pushAccepted({ type: "node.created", data: {} }))
		),
		"denied:namespace",
	);
	// A kernel payload that fails its schema.
	assertEquals(
		errorCode(() => log.appendSync(pushAccepted({ data: { pushId: "x" } }))),
		"invalid",
	);
	// Data over 16 KB.
	assertEquals(
		errorCode(() =>
			log.appendSync(
				extEvent({ data: { blob: "x".repeat(EVENT_DATA_MAX_BYTES) } }),
			)
		),
		"payload_too_large",
	);
	// Events for another repo.
	assertEquals(
		errorCode(() => log.appendSync(extEvent({ node: OTHER }))),
		"invalid",
	);
	assertEquals(log.headSync().seq, 0);
});

Deno.test("shadow events are isolated and never move lanes", () => {
	const { log, lane } = harness();
	const changes = {
		kind: "installation" as const,
		id: INST,
		ext: "tartan.changes@0.1.0",
	};
	const submitted = (shadow: boolean) =>
		extEvent({
			type: "changes.submitted",
			source: changes,
			shadow,
			data: {
				changeId: CHANGE,
				laneId: LANE,
				revision: 1,
				head: SHA,
				base: SHA,
				affected: [],
			},
		});
	const shadowed = log.appendSync(extEvent({ shadow: true }));
	assertEquals(log.read({ since: 0 }).length, 0);
	const all = log.read({ since: 0, includeShadow: true });
	assertEquals(all.map((e) => [e.id, e.shadow]), [[shadowed.id, true]]);
	// Lane transitions only for non-shadow lane events.
	log.appendSync(submitted(true));
	assertEquals(lane, []);
	log.appendSync(submitted(false));
	assertEquals(lane, ["changes.submitted"]);
});

Deno.test("read filters by patterns and pages by since/limit", () => {
	const { log } = harness();
	log.appendSync(pushAccepted());
	log.appendSync(extEvent());
	log.appendSync(pushAccepted());
	assertEquals(
		log.read({ since: 0, patterns: ["push.*"] }).map((e) => e.seq),
		[1, 3],
	);
	assertEquals(
		log.read({ since: 0, patterns: ["x.acme.radar.ping"] }).map((e) => e.seq),
		[2],
	);
	assertEquals(log.read({ since: 1, limit: 1 }).map((e) => e.seq), [2]);
	assertEquals(log.read({ since: 0, patterns: [] }), []);
	assertEquals(
		errorCode(() => log.read({ since: 0, patterns: ["bad pattern"] })),
		"invalid",
	);
});

Deno.test("get, existing and pin", () => {
	const { log } = harness();
	const a = log.appendSync(pushAccepted());
	const b = log.appendSync(pushAccepted());
	assertEquals(log.existingSync([b.id, "nope", a.id]), [a.id, b.id]);
	assertEquals(log.getSync([b.id, a.id]).map((e) => e.seq), [1, 2]);
	log.pinSync([a.id]);
});

Deno.test("tampering is detected by verifyChain", () => {
	const storage = createFakeStorage();
	applyMigrations(storage, REPO_EVENTS_MIGRATIONS);
	const ulid = createUlid();
	const log = createEventLog({
		sql: storage.sql as unknown as SqlExec,
		transact: storage.transactionSync,
		clock: { now: () => 1_000 },
		ids: { ulid },
		repoId: () => REPO,
	});
	for (let i = 0; i < 10; i++) log.appendSync(pushAccepted());
	assertEquals(log.verifyChain(1, 10), { ok: true });
	storage.sql.exec("UPDATE events SET data_json = '{}' WHERE seq = 4");
	assertEquals(log.verifyChain(1, 10), { ok: false, brokenAt: 4 });
	assertEquals(log.verifyChain(5, 10), { ok: true });
});

Deno.test("the chain verifies across pruning via checkpoints", () => {
	const { log, now } = harness();
	const t0 = now.value;
	const pinned: string[] = [];
	for (let i = 1; i <= 2500; i++) {
		const result = log.appendSync(pushAccepted());
		if (i === 1500) pinned.push(result.id);
	}
	log.pinSync(pinned);
	// Sim events after them, then time passes beyond both retentions.
	now.value = t0 + EVENT_RETENTION_MS + 1;
	for (let i = 0; i < 3; i++) log.appendSync(pushAccepted({ sim: true }));
	const head = log.headSync();
	assertEquals(head.seq, 2503);
	const { deleted } = log.prune(now.value);
	// Everything older than 30 d except the pinned event.
	assertEquals(deleted, 2499);
	assertEquals(log.oldestSeqSync(), 1500);
	assertEquals(log.read({ since: 0, limit: 10 }).map((e) => e.seq), [
		1500,
		2501,
		2502,
		2503,
	]);
	// Block 1 (1–1000) is gone entirely; block 2 keeps skeletons (pinned row);
	// block 3 (2001–2500) is incomplete and keeps skeletons.
	assertEquals(log.verifyChain(1, head.seq), { ok: true });
	assertEquals(log.verifyChain(1200, 2503), { ok: true });
	// Sim events expire after 24 h.
	now.value += SIM_EVENT_RETENTION_MS + 1;
	log.appendSync(pushAccepted());
	assertEquals(log.prune(now.value).deleted, 3);
	assertEquals(log.verifyChain(1, log.headSync().seq), { ok: true });
	// The head is never pruned.
	now.value += EVENT_RETENTION_MS * 2;
	log.prune(now.value);
	assertEquals(log.headSync().seq, 2504);
});

Deno.test("an empty log starts at the genesis hash", () => {
	const { log } = harness();
	assertEquals(log.headSync(), { seq: 0, hash: GENESIS_PREV_HASH });
	assertEquals(log.verifyChain(1, 100), { ok: true });
	assertEquals(log.oldestSeqSync(), null);
});

Deno.test("an unknown repo id is learned from the events (repoId null)", () => {
	const { log } = harness(null);
	log.appendSync(pushAccepted({ node: OTHER, repo: OTHER }));
	assertEquals(log.read({ since: 0 })[0].stream, `repo:${OTHER}`);
});

Deno.test("lane events reach applyLaneEvent", () => {
	const { log, lane } = harness();
	log.appendSync(
		extEvent({
			type: "changes.abandoned",
			source: { kind: "installation", id: INST, ext: "tartan.changes@0.1.0" },
			data: { changeId: CHANGE, laneId: LANE, reason: "x" },
		}),
	);
	assertEquals(lane, ["changes.abandoned"]);
});

Deno.test("a swarm shard's log flags every append sim (WP20), whatever the producer said", () => {
	let shard = false;
	const { log, now } = harness(REPO, () => shard);
	log.appendSync(pushAccepted());
	shard = true;
	log.appendSync(pushAccepted());
	log.appendSync(pushAccepted({ sim: false }));
	assertEquals(
		log.read({ since: 0, limit: 10 }).map((e) => e.sim === true),
		[false, true, true],
	);
	// Sim events keep the 24 h retention (the head is never pruned).
	now.value += 24 * 60 * 60 * 1000 + 1;
	assertEquals(log.prune(now.value).deleted, 1);
	assertEquals(log.read({ since: 0, limit: 10 }).map((e) => e.seq), [1, 3]);
	// The chain still verifies: `sim` is a hashed field like any other.
	assertEquals(log.verifyChain(1, 3), { ok: true });
});
