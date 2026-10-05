// Pure WP6 pieces: the chain verifier's gap rules, the coalescer's ≤ 4/s
// bound, subscriber matching (shadow and disabled), registry → subscriber
// rows, and the forge stream's K12 subtree filter.

import { deepStrictEqual, equal } from "node:assert/strict";
import { createUlid, type Envelope, extDoName } from "@tartan/contract";
import {
	EVENT_CHECKPOINT_EVERY,
	GENESIS_PREV_HASH,
	type InstallationInForce,
} from "@tartan/contract/kernel.ts";
import {
	canonicalEventRow,
	chainHash,
	type ChainItem,
	createChainVerifier,
	type HashedEventFields,
	sha256Hex,
} from "./chain.ts";
import { createCoalescer } from "./coalesce.ts";
import { forgeEventNode, visibleInSubtree } from "./forge-filter.ts";
import { allHosts, hostsToPoke, subscriberRows } from "./subscribers.ts";

const ulid = createUlid();

const fields = (seq: number): HashedEventFields => ({
	seq,
	id: `id${seq}`,
	idem_key: `k${seq}`,
	type: "push.accepted",
	v: 1,
	source: "kernel",
	source_ext: null,
	shadow: 0,
	sim: 0,
	actor_kind: "user",
	actor_id: "u_x",
	on_behalf_of: null,
	subject_kind: null,
	subject_id: null,
	caused_by: null,
	correlation: null,
	depth: 0,
	node: "n",
	repo: "n",
	data_json: "{}",
	at: seq,
});

/** A valid chain of `n` rows. */
const chain = (n: number): ChainItem[] => {
	const items: ChainItem[] = [];
	let prev = GENESIS_PREV_HASH;
	for (let seq = 1; seq <= n; seq++) {
		const row = fields(seq);
		const hash = chainHash(prev, row);
		items.push({ kind: "row", seq, prevHash: prev, hash, row });
		prev = hash;
	}
	return items;
};

const checkpoints = (items: ChainItem[]) =>
	new Map(
		items.filter((i) => i.seq % EVENT_CHECKPOINT_EVERY === 0).map((
			i,
		) => [i.seq, i.hash]),
	);

const verify = (
	items: ChainItem[],
	cps: Map<number, string>,
	from = 1,
	anchor: string | null = GENESIS_PREV_HASH,
) => {
	const v = createChainVerifier({
		from,
		anchor,
		checkpoint: (s) => cps.get(s) ?? null,
	});
	for (const item of items) if (!v.push(item)) break;
	return v.result();
};

Deno.test("sha256Hex matches a NIST vector; the canonical row is a fixed-order array", () => {
	equal(
		sha256Hex("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	const row = canonicalEventRow(fields(7));
	equal(JSON.parse(row)[0], 7);
	equal(JSON.parse(row).length, 21);
});

Deno.test("chain verifier: links, content, checkpoints and aligned gaps", () => {
	const items = chain(2500);
	const cps = checkpoints(items);
	deepStrictEqual(verify(items, cps), { ok: true });
	// Block 2 (1001–2000) dropped: the gap is anchored by checkpoint 2000.
	const dropped = items.filter((i) => i.seq <= 1000 || i.seq > 2000);
	deepStrictEqual(verify(dropped, cps), { ok: true });
	// A gap that is not whole blocks breaks at the first item after it.
	const ragged = items.filter((i) => i.seq < 1500 || i.seq > 2000);
	deepStrictEqual(verify(ragged, cps), { ok: false, brokenAt: 2001 });
	// Skeletons keep links only.
	const skeletons: ChainItem[] = items.map((i) =>
		i.seq > 10 && i.seq < 20
			? { kind: "skeleton", seq: i.seq, prevHash: i.prevHash, hash: i.hash }
			: i
	);
	deepStrictEqual(verify(skeletons, cps), { ok: true });
	// A tampered row, link or checkpoint is found.
	const tampered = items.map((i) =>
		i.seq === 5 && i.kind === "row"
			? { ...i, row: { ...i.row, data_json: '{"x":1}' } }
			: i
	);
	deepStrictEqual(verify(tampered, cps), { ok: false, brokenAt: 5 });
	const badCps = new Map(cps).set(1000, "f".repeat(64));
	deepStrictEqual(verify(items, badCps), { ok: false, brokenAt: 1000 });
	// Unknown anchor: the first link is not checked, the rest is.
	deepStrictEqual(verify(items.slice(9), cps, 10, null), { ok: true });
	deepStrictEqual(verify(items.slice(9), cps, 10, "0".repeat(64)), {
		ok: false,
		brokenAt: 10,
	});
});

Deno.test("coalescer: 25 ms idle, then at most one run per 250 ms", () => {
	let now = 0;
	const queue: { at: number; fn: () => void }[] = [];
	const runs: number[] = [];
	const c = createCoalescer({
		delayMs: 25,
		minIntervalMs: 250,
		now: () => now,
		schedule: (fn, ms) => queue.push({ at: now + ms, fn }),
		run: () => {
			runs.push(now);
		},
	});
	const advance = (to: number) => {
		while (now < to) {
			now++;
			for (const due of queue.filter((q) => q.at <= now)) {
				queue.splice(queue.indexOf(due), 1);
				due.fn();
			}
		}
	};
	c.trigger();
	c.trigger();
	advance(30);
	deepStrictEqual(runs, [25]);
	// A trigger every millisecond for 2 s.
	for (let t = 30; t < 2030; t++) {
		c.trigger();
		advance(t + 1);
	}
	advance(2400);
	const gaps = runs.slice(1).map((r, i) => r - runs[i]);
	equal(gaps.every((g) => g >= 250), true);
	equal(runs.length <= 1 + Math.ceil(2000 / 250) + 1, true);
});

const sub = (host: string, pattern: string, mode = "enforce") => ({
	installation_id: `i_${host}`,
	host_name: host,
	pattern,
	mode,
	ext_version: 3,
});

Deno.test("subscriber matching respects patterns, shadow and disabled", () => {
	const subs = [
		sub("a", "push.*"),
		sub("b", "changes.submitted"),
		sub("s", "*", "shadow"),
		sub("off", "*", "disabled"),
		sub("a", "changes.*"),
	];
	deepStrictEqual(
		hostsToPoke(subs, [{ type: "push.accepted", shadow: false }]).sort(),
		["a", "s"],
	);
	deepStrictEqual(
		hostsToPoke(subs, [{ type: "changes.submitted", shadow: true }]),
		["s"],
	);
	deepStrictEqual(hostsToPoke(subs, []), []);
	deepStrictEqual(allHosts(subs).sort(), ["a", "b", "s"]);
});

Deno.test("registry installations become subscriber rows with their ExtensionDO host", () => {
	const repo = ulid();
	const node = `i_${ulid()}`;
	const scoped = `i_${ulid()}`;
	const off = `i_${ulid()}`;
	const inForce = [
		{ id: node, scope: "node", mode: "enforce", events: ["push.*", "push.*"] },
		{ id: scoped, scope: "repo", mode: "shadow", events: ["changes.*"] },
		{ id: off, scope: "node", mode: "disabled", events: ["*"] },
	].map((i) => ({
		installation: { id: i.id, storageScope: i.scope, mode: i.mode },
		manifest: { subscribe: i.events.map((event) => ({ event })) },
		depth: 0,
	})) as unknown as InstallationInForce[];
	deepStrictEqual(subscriberRows(repo, inForce, 9), [
		{
			installation_id: node,
			host_name: extDoName(node, { kind: "node" }),
			pattern: "push.*",
			mode: "enforce",
			ext_version: 9,
		},
		{
			installation_id: scoped,
			host_name: extDoName(scoped, { kind: "repo", repoId: repo }),
			pattern: "changes.*",
			mode: "shadow",
			ext_version: 9,
		},
	]);
});

const forgeEvent = (type: string, node: string, data: unknown): Envelope => ({
	id: ulid(),
	seq: 1,
	stream: "forge",
	type,
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node,
	depth: 0,
	shadow: false,
	at: 1,
	data,
});

Deno.test("forge stream K12 filter", () => {
	const inside = ulid();
	const outside = ulid();
	const check = {
		within: (n: string) => n === inside,
		principalWithin: (p: string) => p === "u_member",
	};
	const cases: [Envelope, boolean][] = [
		[forgeEvent("node.created", outside, { nodeId: inside }), true],
		[forgeEvent("node.moved", inside, { nodeId: outside }), false],
		[forgeEvent("principal.created", inside, { principalId: "u_x" }), false],
		[
			forgeEvent("principal.created", outside, { principalId: "u_member" }),
			true,
		],
		[forgeEvent("extension.installed", outside, { node: inside }), true],
		[forgeEvent("extension.error", inside, { node: outside }), true],
		[forgeEvent("repo.created", outside, { repoId: inside }), true],
		[forgeEvent("repo.imported", inside, { repoId: outside }), false],
	];
	for (const [event, visible] of cases) {
		equal(visibleInSubtree(event, check), visible, event.type);
	}
	equal(forgeEventNode(forgeEvent("principal.created", inside, {})), null);
});
