// The exthost cron backstop: every subscribing
// installation scope is poked with its stream heads, at most once per tick,
// bounded, with each poke isolated.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { ExtScope, StreamRef } from "@tartan/contract";
import { type ExthostCronDeps, runExthostCron } from "./cron.ts";
import {
	inForce,
	INSTALLATION_ID,
	NODES,
	OTHER_INSTALLATION_ID,
} from "./testing/fakes.ts";
import { helloManifest } from "./testing/hello.ts";

type Poke = { inst: string; scope: ExtScope; stream: StreamRef; head: number };

const deps = (
	overrides: Partial<ExthostCronDeps> = {},
): { deps: ExthostCronDeps; pokes: Poke[] } => {
	const pokes: Poke[] = [];
	const repoScoped = inForce(helloManifest());
	const nodeScoped = inForce(
		helloManifest({
			storage: { scope: "node", migrations: ["migrations/0001_init.sql"] },
			subscribe: [{ event: "node.*" }, { event: "x.tartan.hello.*" }],
		}),
		{ id: OTHER_INSTALLATION_ID, storageScope: "node" },
	);
	const silent = inForce(helloManifest({ subscribe: [] }), {
		id: "i_01k60000000000000000000209",
	});
	return {
		pokes,
		deps: {
			listRepos: (cursor) =>
				Promise.resolve(
					cursor === undefined
						? {
							repos: [{ id: NODES.router.id, path: NODES.router.path }],
							cursor: "2",
						}
						: {
							repos: [{
								id: NODES.platformApi.id,
								path: NODES.platformApi.path,
							}],
						},
				),
			inForce: () => Promise.resolve([repoScoped, nodeScoped, silent]),
			repoHead: (repoId) => Promise.resolve(repoId === NODES.router.id ? 7 : 3),
			forgeHead: () => Promise.resolve(42),
			poke: (inst, scope, input) => {
				pokes.push({ inst, scope, ...input });
				return Promise.resolve();
			},
			...overrides,
		},
	};
};

Deno.test("cron pokes each subscribing scope once per stream, with the stream's head", async () => {
	const { deps: d, pokes } = deps();
	const run = await runExthostCron(d);
	deepStrictEqual(run, { pokes: 5, failed: 0, capped: false });
	deepStrictEqual(
		pokes.map((
			p,
		) => [
			p.inst,
			p.scope.kind === "repo" ? p.scope.repoId : "node",
			p.stream,
			p.head,
		]),
		[
			[INSTALLATION_ID, NODES.router.id, `repo:${NODES.router.id}`, 7],
			[OTHER_INSTALLATION_ID, "node", `repo:${NODES.router.id}`, 7],
			[OTHER_INSTALLATION_ID, "node", "forge", 42],
			[
				INSTALLATION_ID,
				NODES.platformApi.id,
				`repo:${NODES.platformApi.id}`,
				3,
			],
			[OTHER_INSTALLATION_ID, "node", `repo:${NODES.platformApi.id}`, 3],
		],
	);
});

Deno.test("cron fan-out is bounded and one failing poke never stops the rest", async () => {
	const { deps: d, pokes } = deps({
		poke: (inst, scope, input) => {
			if (inst === OTHER_INSTALLATION_ID) {
				return Promise.reject(new Error("down"));
			}
			pokes.push({ inst, scope, ...input });
			return Promise.resolve();
		},
	});
	const run = await runExthostCron(d, 3);
	deepStrictEqual(run, { pokes: 3, failed: 2, capped: true });
	strictEqual(pokes.length, 1);
});

Deno.test("a capped cron rotates its window, so every scope is poked within ⌈candidates / max⌉ ticks", async () => {
	const seen = new Set<string>();
	for (let tick = 0; tick < 2; tick++) {
		const { deps: d, pokes } = deps();
		const run = await runExthostCron(d, 3, tick);
		deepStrictEqual(run, { pokes: 3, failed: 0, capped: true });
		for (const p of pokes) {
			seen.add(
				`${p.inst}|${
					p.scope.kind === "repo" ? p.scope.repoId : "node"
				}|${p.stream}`,
			);
		}
	}
	// Five candidates (see the first test), max 3: two ticks reach all five.
	strictEqual(seen.size, 5);
});

Deno.test("cron pokes at most `parallel` scopes at once, and all of them", async () => {
	let inFlight = 0;
	let peak = 0;
	const { deps: d, pokes } = deps({
		listRepos: () =>
			Promise.resolve({
				repos: Array.from({ length: 30 }, (_, i) => ({
					id: `01k6repo${String(i).padStart(18, "0")}`,
					path: `acme/r${i}`,
				})),
			}),
		poke: async (inst, scope, input) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			if (inst === OTHER_INSTALLATION_ID && input.stream === "forge") {
				throw new Error("down");
			}
			pokes.push({ inst, scope, ...input });
		},
	});
	const run = await runExthostCron(d, 500, 0, 4);
	// 30 repos: one repo-scoped and one node-scoped installation each, plus
	// the node scope's forge stream once.
	deepStrictEqual(run, { pokes: 61, failed: 1, capped: false });
	strictEqual(pokes.length, 60);
	strictEqual(peak, 4);
});
