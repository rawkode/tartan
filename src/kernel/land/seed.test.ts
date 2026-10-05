// The dev-only audited history seeding (WP10): labelled `done`
// Advances on trunk through the K1 ledger, read back by `advances()` and by
// the gate replay's range rule, on the land harness (real modules,
// FakeArtifacts over loopback).

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fromRpcError, repoArtifactsName, trunkRef } from "@tartan/contract";
import {
	fakeKeyPositions,
	SEED_FAKE_KEY,
	SEED_MAX,
	SEEDED_FILE,
} from "./seed.ts";
import { landTest } from "./testing/harness.ts";

const OWNER = { kind: "user" as const, id: "u_01k6ownerownerownerownerow" };

const codeOf = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		return fromRpcError(error).code;
	}
	return "ok";
};

Deno.test("two fake keys, about 30 % and 75 % of the way", () => {
	deepStrictEqual(fakeKeyPositions(41), [12, 31]);
	deepStrictEqual(fakeKeyPositions(1), []);
	deepStrictEqual(fakeKeyPositions(2), [1, 2]);
	for (let n = 2; n <= SEED_MAX; n++) {
		const [a, b] = fakeKeyPositions(n);
		ok(a >= 1 && b <= n && a < b, `${n}: ${a}, ${b}`);
	}
});

landTest(
	"seedHistory needs dev tools; elsewhere it does not exist",
	async (h) => {
		equal(
			await codeOf(h.land.seedHistory({ count: 3, actor: OWNER })),
			"not_found",
		);
		h.devTools = true;
		equal(
			await codeOf(h.land.seedHistory({ count: 0, actor: OWNER })),
			"invalid",
		);
		equal(
			await codeOf(h.land.seedHistory({ count: SEED_MAX + 1, actor: OWNER })),
			"invalid",
		);
		equal(
			await codeOf(
				h.land.seedHistory({ count: 2, actor: { kind: "user", id: "" } }),
			),
			"invalid",
		);
		equal((await h.land.advances({})).advances.length, 0, "nothing written");
	},
);

landTest(
	"41 labelled Advances on trunk, one commit each, two with a fake key, through the K1 ledger",
	async (h) => {
		h.devTools = true;
		const trunk = trunkRef("main");
		const before = await h.core.resolveRef(trunk);
		ok(before !== null);
		const seeded = await h.land.seedHistory({ count: 41, actor: OWNER });
		equal(seeded.advances, 41);
		deepStrictEqual(seeded.withFakeKeys, [12, 31]);

		// Trunk moved to the last seeded commit, in the index and on Artifacts.
		equal(await h.core.resolveRef(trunk), seeded.head);
		equal(h.fake.inspect.refs(h.canonical)[trunk], seeded.head);

		// One kernel write, purpose seed, pushed (the index and push log follow).
		const writes = h.storage.sql.exec<
			{ purpose: string; state: string; expect_old: string; new_sha: string }
		>(
			"SELECT purpose, state, expect_old, new_sha FROM kernel_writes WHERE purpose = 'seed'",
		).toArray();
		deepStrictEqual(writes, [{
			purpose: "seed",
			state: "pushed",
			expect_old: before,
			new_sha: seeded.head,
		}]);

		// `advances()` pages them newest first, labelled, as a chain on trunk.
		const page1 = await h.land.advances({ limit: 30 });
		equal(page1.advances.length, 30);
		ok(page1.cursor !== undefined);
		const page2 = await h.land.advances({ cursor: page1.cursor, limit: 30 });
		const all = [...page1.advances, ...page2.advances];
		equal(all.length, 41);
		ok(all.every((a) => a.seeded === true && a.state === "done"));
		equal(all[0].newSha, seeded.head, "newest first");
		equal(all.at(-1)!.expectOld, before, "the oldest starts at the old trunk");
		for (let i = 0; i < all.length - 1; i++) {
			equal(all[i].expectOld, all[i + 1].newSha, `a chain at ${i}`);
		}

		// Each range adds one line to the seeded file; the key commits add a
		// .env file holding the example key (what the replay's probe reads).
		const repo = await h.fake.get(repoArtifactsName(h.repoId));
		const oldestFirst = [...all].reverse();
		for (const [i, advance] of oldestFirst.entries()) {
			const commit = await repo.readCommit(advance.newSha!);
			ok(commit !== null);
			equal(commit.parents[0], advance.expectOld);
			const entries = (await repo.readTree(commit.treeHash)) ?? [];
			const names = entries.map((e) => e.name);
			ok(names.includes(SEEDED_FILE));
			const envFile = `seeded-${i + 1}.env`;
			if ([12, 31].includes(i + 1)) {
				const entry = entries.find((e) => e.name === envFile);
				ok(entry !== undefined, envFile);
				const text = await (await repo.readBlob(entry.hash))!.text();
				ok(text.includes(SEED_FAKE_KEY));
			} else {
				equal(
					names.includes(envFile),
					false,
					`${envFile} only on a key commit`,
				);
			}
		}
		const last = await repo.readCommit(seeded.head);
		const logEntry = ((await repo.readTree(last!.treeHash)) ?? []).find((e) =>
			e.name === SEEDED_FILE
		)!;
		const log = await (await repo.readBlob(logEntry.hash))!.text();
		equal(log.trim().split("\n").length, 41);

		// No event: a seeded Advance never ran gates or landed a change.
		const types = h.events.read({ since: 0, limit: 500 }).map((e) => e.type);
		ok(!types.includes("ref.advanced"), types.join(","));

		// A second seed continues the history from the new tip.
		const again = await h.land.seedHistory({ count: 2, actor: OWNER });
		const newest = (await h.land.advances({ limit: 2 })).advances;
		equal(newest[0].newSha, again.head);
		equal(newest[1].expectOld, seeded.head);
		const log2Entry = ((await repo.readTree(
			(await repo.readCommit(again.head))!.treeHash,
		)) ?? []).find((e) => e.name === SEEDED_FILE)!;
		const log2 = await (await repo.readBlob(log2Entry.hash))!.text();
		equal(log2.trim().split("\n").length, 43, "appended, not replaced");
	},
);

landTest(
	"a seed waits for no one: an Advance in flight on trunk refuses it",
	async (h) => {
		h.devTools = true;
		h.storage.sql.exec(
			`INSERT INTO land_batches (id, instance_id, ref, instance_created, requested_by, base_sha,
		   changes_json, reason_json, test_policy, state, request_hash, created_at)
		 VALUES ('lb_01k6zzzzzzzzzzzzzzzzzzzzzz', 'x', ?, 1, 'u', ?, '[]', '{}', 'none', 'advancing', 'h', 1)`,
			trunkRef("main"),
			"a".repeat(40),
		);
		h.storage.sql.exec(
			`INSERT INTO advances (id, batch_id, attempt, ref, expect_old, owner_instance, lease_until, step, state, created_at)
		 VALUES ('adv_01k6zzzzzzzzzzzzzzzzzzzzzz_1', 'lb_01k6zzzzzzzzzzzzzzzzzzzzzz', 1, ?, ?, 'x', 9999999999999, 'locked', 'locked', 1)`,
			trunkRef("main"),
			"a".repeat(40),
		);
		await rejects(
			h.land.seedHistory({ count: 2, actor: OWNER }),
			(e: unknown) => fromRpcError(e).code === "conflict",
		);
	},
);
