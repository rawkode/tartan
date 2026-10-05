// WP13: 1,000 lanes × 10 paths join < 50 ms. Here on the Deno
// harness storage (node:sqlite behind the same SQL guard the builtin host
// applies); the Durable Object run is `join.workers.test.ts`.

import { HOT, seedBench, SPREAD, timeJoin } from "./bench.ts";
import { createRadar, laneOpened, ok, pushed, putLane, sha } from "./kit.ts";

const LIMIT_MS = 50;

for (const [name, shape] of [["spread", SPREAD], ["hot", HOT]] as const) {
	Deno.test(`perf (${name}): 1,000 lanes × 10 paths, one lane's join < ${LIMIT_MS} ms`, async () => {
		const r = createRadar();
		await r.init();
		const sql = r.ctx().sql;
		seedBench(sql, shape);
		const result = timeJoin(sql, shape);
		console.log(
			`radar join (${name}): median ${result.medianMs.toFixed(2)} ms, max ${
				result.maxMs.toFixed(2)
			} ms over ${result.samples} lanes, ${result.findings} findings`,
		);
		ok(result.findings > 0, "the join found overlaps");
		ok(result.maxMs < LIMIT_MS, `max ${result.maxMs} ms`);
	});
}

for (
	const [name, shape, paths, budget] of [
		[
			"spread",
			SPREAD,
			(i: number) => `services/s3/src/m${i % 7}/f${i}.ts`,
			500,
		],
		["hot", HOT, (i: number) => `services/s0/src/m${i % 7}/f${i}.ts`, 5000],
	] as const
) {
	Deno.test(`perf (${name}): a push handled end to end among 1,000 lanes stays inside the event budget`, async () => {
		const r = createRadar();
		await r.init();
		seedBench(r.ctx().sql, shape);
		const me = putLane(r.world, { n: 5000 });
		await r.deliver(laneOpened(me));
		const t0 = performance.now();
		await r.deliver(pushed(r.world, me.id, {
			after: sha(777),
			paths: Array.from({ length: 10 }, (_, i) => paths(i)),
		}));
		const ms = performance.now() - t0;
		const rows = r.q<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts")[0].n;
		console.log(
			`radar push.diffed among 1,000 lanes (${name}): ${
				ms.toFixed(2)
			} ms, ${rows} conflict rows`,
		);
		ok(ms < budget, `${ms} ms`);
	});
}
