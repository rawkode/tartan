/// <reference types="@cloudflare/vitest-pool-workers/types" />
// `node:crypto` `createHash('sha256')` is
// synchronous inside `transactionSync` under `nodejs_compat` in workerd, so the
// event hash chain (K3) can be computed in the same transaction as the append.
// Pass ⇒ WP6 uses node:crypto and drops `packages/sha256`.
//
// Scope of this evidence: the vitest pool's workerd (bundled with
// @cloudflare/vitest-pool-workers 0.22.0) at compat 2026-08-15 + nodejs_compat,
// not the edge.

import { runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { GENESIS_PREV_HASH } from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../test/env.ts";

// FIPS 180-2 / NIST CSRC example vectors for SHA-256.
const VECTORS: readonly (readonly [string, string])[] = [
	["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
	[
		"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
	],
	[
		"a".repeat(1_000_000),
		"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
	],
];

const subtleHex = async (data: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)),
		),
	].map((b) => b.toString(16).padStart(2, "0")).join("");

type ChainRow = { seq: number; data: string; prev_hash: string; hash: string };

describe("node:crypto createHash('sha256') inside transactionSync (0.9)", () => {
	it("hashes synchronously, matches NIST vectors, and chains rows in one transaction", async () => {
		const stub = env.REPO.getByName(uniqueName("test-sha256"));
		const result = await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec(
				"CREATE TABLE chain_probe (seq INTEGER PRIMARY KEY, data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)",
			);
			const returned = state.storage.transactionSync(() => {
				const digests = VECTORS.map(([input]) =>
					createHash("sha256").update(input).digest("hex")
				);
				let prev = GENESIS_PREV_HASH;
				for (let seq = 1; seq <= 3; seq++) {
					const data = JSON.stringify({ seq, type: "push.accepted" });
					const hash = createHash("sha256").update(prev).update(data).digest(
						"hex",
					);
					sql.exec(
						"INSERT INTO chain_probe (seq, data, prev_hash, hash) VALUES (?, ?, ?, ?)",
						seq,
						data,
						prev,
						hash,
					);
					prev = hash;
				}
				return { digests, head: prev };
			});
			return {
				// transactionSync hands back the callback's value itself, so every
				// digest above was computed before the transaction committed.
				isPromise: returned instanceof Promise,
				digests: returned.digests,
				head: returned.head,
				rows: sql.exec<ChainRow>("SELECT * FROM chain_probe ORDER BY seq")
					.toArray(),
			};
		});

		expect(result.isPromise).toBe(false);
		expect(result.digests).toEqual(VECTORS.map(([, hex]) => hex));
		expect(result.rows).toHaveLength(3);
		expect(result.rows[2].hash).toBe(result.head);

		// Independent check of the chain with WebCrypto (async, outside any transaction).
		let prev = GENESIS_PREV_HASH;
		for (const row of result.rows) {
			expect(row.prev_hash).toBe(prev);
			expect(row.hash).toBe(await subtleHex(prev + row.data));
			prev = row.hash;
		}
	});

	it("rolls the hashed rows back with the transaction", async () => {
		const stub = env.REPO.getByName(uniqueName("test-sha256"));
		const count = await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec(
				"CREATE TABLE chain_probe (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL)",
			);
			expect(() =>
				state.storage.transactionSync(() => {
					sql.exec(
						"INSERT INTO chain_probe (seq, hash) VALUES (1, ?)",
						createHash("sha256").update("event-1").digest("hex"),
					);
					throw new Error("abort after hashing");
				})
			).toThrow("abort after hashing");
			return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chain_probe")
				.one()
				.n;
		});
		expect(count).toBe(0);
	});
});
