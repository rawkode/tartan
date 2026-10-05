/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The builtin tartan.weave (WP15) inside the real ExtensionDO in workerd:
// its migrations on DO SQLite through the host's SQL guard, events drained
// from a poke, the `tick` timer on the DO alarm, and `land.submit` through
// the real in-process KernelCaps (LandRequest schema, `provides queue@1`,
// the `land` grant) to fake kernel ports. Proposed by WP15 for the `exthost`
// project: it needs the kernel's ExtensionDO and fakes, which files under
// extensions/ may not import.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createUlid, extDoName, type LandRequest } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../test/env.ts";
import { builtins } from "../../../builtins.ts";
import { ExtensionDO } from "./do.ts";
import { createModuleRuntime } from "./runtime.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	type FakeKernel,
	NODES,
	PRINCIPALS,
} from "./testing/fakes.ts";

const ulid = createUlid();
const weave = builtins.get("tartan.weave")!;
const stream = `repo:${NODES.router.id}` as const;
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);

type Wired = {
	readonly kernel: FakeKernel;
	readonly stub: DurableObjectStub<ExtensionDO>;
	readonly installationId: string;
};

const wire = async (): Promise<Wired> => {
	const installationId = `i_${ulid()}`;
	const name = extDoName(installationId, {
		kind: "repo",
		repoId: NODES.router.id,
	});
	const kernel = createFakeKernel();
	const installations = createFakeInstallations(weave.manifest, {
		id: installationId,
		nodeId: NODES.router.id,
		nodePath: NODES.router.path,
		// The longest debounce, so the train's timer never fires on its own
		// under a loaded pool: `fireTimers` makes it due (a 0 ms debounce let
		// the real alarm run before the first assertion, a flake).
		config: { debounceMs: 60_000 },
	});
	// The Weave is the repo's queue@1 provider: the train asks before a batch
	// (WP12/WP15 hand-over).
	kernel.providers.set(`queue@1@${NODES.router.id}`, {
		installation: installations.snapshot!.installation,
		manifest: weave.manifest,
		depth: NODES.router.path.split("/").length - 1,
	});
	const stub = env.EXT.getByName(name);
	await runInDurableObject(stub, async (instance) => {
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			kernel: kernel.ports,
			installations,
			packages: () =>
				Promise.resolve({
					runtime: createModuleRuntime(() => weave.module),
					migrations: weave.migrations,
				}),
		}));
	});
	return { kernel, stub, installationId };
};

/** One submitted change on a submitted lane, approved at its head. */
const approvedChange = (k: FakeKernel, n: number) => {
	const laneId = `ln_${ulid()}`;
	const changeId = "klmnopqrstuvwxyz"[n].repeat(32);
	const lane = k.lanes.values().next().value!;
	k.lanes.set(laneId, {
		...lane,
		id: laneId,
		repoId: NODES.router.id,
		owner: PRINCIPALS.agent,
		head: HEAD,
		state: "submitted",
	});
	const submitted = k.addEvent(NODES.router.id, {
		type: "changes.submitted",
		data: {
			changeId,
			laneId,
			revision: 1,
			head: HEAD,
			base: BASE,
			affected: ["api"],
		},
	});
	const decided = k.addEvent(NODES.router.id, {
		type: "review.decided",
		data: {
			changeId,
			revision: 1,
			head: HEAD,
			decision: "approve",
			route: "auto",
			risk: 0.1,
			decidedBy: { kind: "ext", id: `x_i_${ulid()}` },
		},
	});
	return { laneId, changeId, submitted, decided };
};

const tables = <T>(stub: DurableObjectStub<ExtensionDO>, query: string) =>
	runInDurableObject(
		stub,
		(_i, state) => state.storage.sql.exec(query).toArray() as T[],
	);

/** Makes every pending timer due and runs the alarm. */
const fireTimers = async (stub: DurableObjectStub<ExtensionDO>) => {
	await runInDurableObject(stub, (_i, state) => {
		state.storage.sql.exec("UPDATE _timers SET at = 0");
	});
	await runDurableObjectAlarm(stub);
};

describe("tartan.weave in the ExtensionDO (workerd)", () => {
	it("enqueues on approve and submits a stored batch through KernelCaps with a K4 chain", async () => {
		const w = await wire();
		const a = approvedChange(w.kernel, 1);
		const b = approvedChange(w.kernel, 2);
		await w.stub.poke({ stream, head: w.kernel.head(NODES.router.id) });
		const queued = await tables<{ change_id: string; state: string }>(
			w.stub,
			"SELECT change_id, state FROM entries ORDER BY enqueued_at",
		);
		expect(queued.map((e) => e.state)).toEqual(["waiting", "waiting"]);

		await fireTimers(w.stub);
		const submits = w.kernel.called("land.submit");
		expect(submits).toHaveLength(1);
		const request = submits[0].args[1] as LandRequest;
		expect(request.batch.map((c) => [c.changeId, c.laneId, c.head])).toEqual([
			[a.changeId, a.laneId, HEAD],
			[b.changeId, b.laneId, HEAD],
		]);
		expect(request.reason.events).toEqual(
			expect.arrayContaining([
				a.submitted.id,
				a.decided.id,
				b.submitted.id,
				b.decided.id,
			]),
		);
		expect(submits[0].args[2]).toBe(`x_${w.installationId}`);
		const stored = await tables<{ batch_id: string; request_json: string }>(
			w.stub,
			"SELECT batch_id, request_json FROM batches",
		);
		expect(stored).toHaveLength(1);
		expect(JSON.parse(stored[0].request_json)).toEqual(request);
		const states = await tables<{ state: string }>(
			w.stub,
			"SELECT state FROM entries",
		);
		expect(states.map((s) => s.state)).toEqual(["landing", "landing"]);
		const types = w.kernel.appended.map((e) => e.type);
		expect(types).toEqual(
			expect.arrayContaining(["queue.enqueued", "queue.batched"]),
		);
	});

	it("after a lost land.submit answer the alarm resubmits the identical batch", async () => {
		const w = await wire();
		approvedChange(w.kernel, 3);
		let calls = 0;
		w.kernel.landSubmit = (request) => {
			calls += 1;
			if (calls === 1) return Promise.reject(new Error("internal: lost"));
			return Promise.resolve({
				batchId: (request as { batchId: string }).batchId,
				created: false,
			});
		};
		await w.stub.poke({ stream, head: w.kernel.head(NODES.router.id) });
		await fireTimers(w.stub);
		await fireTimers(w.stub);
		const submits = w.kernel.called("land.submit");
		expect(submits).toHaveLength(2);
		expect(submits[1].args[1]).toEqual(submits[0].args[1]);
		const batches = await tables<{ state: string }>(
			w.stub,
			"SELECT state FROM batches",
		);
		expect(batches.map((b) => b.state)).toEqual(["submitted"]);
	});
});
