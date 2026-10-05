/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Uninstall cleanup in workerd: an uninstalled installation's ExtensionDO
// stops retrying its timers (no `_timers` row, no alarm), and the uninstall
// cleanup (`cleanUpHosts` over `depsFromEnv`) empties the real DO's storage
// over RPC.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createUlid, extDoName, type NodeDto } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../test/env.ts";
import { depsFromEnv } from "../api/deps.ts";
import { cleanUpHosts } from "../api/installations.ts";
import { ExtensionDO } from "./do.ts";
import { createModuleRuntime } from "./runtime.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	type FakeInstallations,
	NODES,
} from "./testing/fakes.ts";
import {
	HELLO_MIGRATIONS_V1,
	helloManifest,
	helloModule,
} from "./testing/hello.ts";

const ulid = createUlid();

const wire = async () => {
	const installationId = `i_${ulid()}`;
	const scope = { kind: "repo", repoId: NODES.router.id } as const;
	const kernel = createFakeKernel();
	const installations: FakeInstallations = createFakeInstallations(
		helloManifest(),
		{ id: installationId },
	);
	const stub = env.EXT.getByName(extDoName(installationId, scope));
	// The host's clock runs ahead on demand, so a future timer becomes due.
	let ahead = 0;
	await runInDurableObject(stub, async (instance) => {
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			clock: { now: () => Date.now() + ahead },
			kernel: kernel.ports,
			installations,
			packages: () =>
				Promise.resolve({
					runtime: createModuleRuntime(() => helloModule),
					migrations: HELLO_MIGRATIONS_V1,
				}),
		}));
	});
	/** Sets an extension timer through the hello module (its `timer` event). */
	const scheduleTimer = async () => {
		kernel.addEvent(NODES.router.id, {
			type: "x.tartan.hello.timer",
			data: { key: "tick", inMs: 60_000 },
		});
		await stub.poke({
			stream: `repo:${NODES.router.id}`,
			head: kernel.head(NODES.router.id),
		});
	};
	const state = () =>
		runInDurableObject(stub, async (_instance, s) => ({
			timers: s.storage.sql.exec("SELECT module, key FROM _timers").toArray(),
			alarm: await s.storage.getAlarm(),
			tables: s.storage.sql.exec(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'",
			).toArray().map((r) => r.name),
		}));
	const advance = (ms: number) => {
		ahead += ms;
	};
	return {
		installationId,
		scope,
		installations,
		stub,
		scheduleTimer,
		state,
		advance,
	};
};

describe("uninstall (workerd)", () => {
	it("an uninstalled installation's timer is dropped: no row, no alarm, nothing retried", async () => {
		const w = await wire();
		await w.scheduleTimer();
		const before = await w.state();
		expect(before.timers).toEqual([{ module: "ext", key: "tick" }]);
		expect(before.alarm).not.toBeNull();
		// The registry forgets it (bumping its version), as an uninstall does.
		w.installations.set((s) => s);
		w.installations.snapshot = null;
		w.advance(120_000);
		expect(await runDurableObjectAlarm(w.stub)).toBe(true);
		const after = await w.state();
		expect(after.timers).toEqual([]);
		expect(after.alarm).toBeNull();
		expect(await runDurableObjectAlarm(w.stub)).toBe(false);
	});

	it("the uninstall cleanup deletes the ExtensionDO's data over RPC: tables, timers and alarm", async () => {
		const w = await wire();
		await w.scheduleTimer();
		const before = await w.state();
		expect(before.tables.length).toBeGreaterThan(0);
		expect(before.alarm).not.toBeNull();
		const repo = {
			id: NODES.router.id,
			path: NODES.router.path,
		};
		const node = { id: NODES.acme.id, path: NODES.acme.path } as NodeDto;
		const logs: unknown[] = [];
		await cleanUpHosts(
			{
				...depsFromEnv(env),
				tree: () => ({
					resolvePath: () => Promise.resolve(null),
					node: () => Promise.resolve(null),
					listRepos: () => Promise.resolve({ repos: [repo] }),
					childrenAccess: () => Promise.resolve({ nodes: [] }),
				}),
				log: (entry) => logs.push(entry),
			},
			[{ ...w.installations.snapshot!.installation }],
			node,
		);
		expect(logs).toEqual([]);
		w.installations.snapshot = null;
		const after = await w.state();
		expect(after.tables).toEqual([]);
		expect(after.timers).toEqual([]);
		expect(after.alarm).toBeNull();
		expect(await runDurableObjectAlarm(w.stub)).toBe(false);
	});
});
