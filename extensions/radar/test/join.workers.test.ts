/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createGuardedSql } from "@tartan/ext-api/sqlguard.ts";
import { db } from "@tartan/ext-api";
import { describe, expect, it } from "vitest";
import { analyzeLane } from "../src/analyze.ts";
import { migrations } from "../src/migrations.ts";
import { HOT, seedBench, SPREAD } from "./bench.ts";

const EXT = (env as unknown as { EXT: DurableObjectNamespace }).EXT;
const lane = (i: number) => `ln_01k6${String(i).padStart(22, "0")}`;

describe("tartan.radar join in a Durable Object", () => {
	for (const [name, shape] of [["spread", SPREAD], ["hot", HOT]] as const) {
		it(`${name}: 1,000 lanes × 10 paths, each join < 50 ms`, async () => {
			const stub = EXT.getByName(`radar-bench:${name}:${crypto.randomUUID()}`);
			await runInDurableObject(stub, (_instance, state) => {
				const sql = createGuardedSql(state.storage, { readOnly: false });
				for (const m of migrations) state.storage.sql.exec(m.sql);
				seedBench(sql, shape);
			});
			const times: number[] = [];
			for (let s = 0; s < 25; s++) {
				const id = lane(1 + Math.floor((s * shape.lanes) / 25));
				const t0 = Date.now(); // workerd freezes the clock inside the DO: time from outside
				await runInDurableObject(
					stub,
					(_i, state) =>
						analyzeLane(
							db(createGuardedSql(state.storage, { readOnly: true })),
							id,
						).length,
				);
				times.push(Date.now() - t0);
			}
			expect(Math.max(...times)).toBeLessThan(50);
		});
	}
});
