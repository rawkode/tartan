/// <reference types="@cloudflare/vitest-pool-workers/types" />
// RepoDO core in workerd (WP5a): the module on real Durable Object SQLite
// and the real WP0 host (migrations, timer multiplexer, RpcTarget facades),
// with WP6's event log faked in the same database until WP6 merges, and the
// real FakeArtifacts service binding of the pool for upstream tokens.
//
// The host runs on the storage of a real `RepoDO` (which already applied the
// common and `core` migrations) with a clock far in the future, so the DO's
// own alarm never fires during a test; timers are driven with `host.alarm()`.

import { runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	fromRpcError,
	LANE_LEASE_MS,
	type LaneMode,
	repoArtifactsName,
	repoDoName,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type DiffResult,
	type DoModule,
	type KernelWriteIntent,
	MIGRATION_RANGES,
	type RepoBackend,
	type RepoCoreInternal,
	type RepoEventsInternal,
	type RepoInternals,
	type RepoStore,
	type TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { GitRemote } from "@tartan/gitproto";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { createDoHost } from "../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../do/migrations.ts";
import type { Env } from "../../env.ts";
import { repoProbeModule } from "../probe/module.ts";
import { repoRunsModule } from "../runs/module.ts";
import type { CorePorts } from "./core.ts";
import { createRepoBackend } from "./lanes/repo-backend/index.ts";
import { createRepoCoreModule } from "./module.ts";
import { OBSERVE_GRACE_MS } from "./observe.ts";
import {
	createFakeEvents,
	createFakeLand,
	EVENTS_DDL,
	type FakeEvents,
} from "./testing/fakes.ts";

const FUTURE = Date.UTC(2090, 0, 1);
const sha = (n: number) => (n + 1).toString(16).padStart(40, "c");
const TRUNK = sha(1);

type Calls = { method: string; name?: string }[];

/** The pool's FakeArtifacts binding, recording each call RepoDO makes. */
const recording = (store: RepoStore, calls: Calls): RepoStore => ({
	create: (...args) => {
		calls.push({ method: "create" });
		return store.create(...args);
	},
	get: (name) => {
		calls.push({ method: "get", name });
		return store.get(name);
	},
	import: (...args) => {
		calls.push({ method: "import" });
		return store.import(...args);
	},
	list: (...args) => {
		calls.push({ method: "list" });
		return store.list(...args);
	},
	delete: (name) => {
		calls.push({ method: "delete", name });
		return store.delete(name);
	},
});

const makeHost = async (
	state: DurableObjectState,
	options: {
		laneMode?: LaneMode;
		createRepoBackend?: (deps: unknown) => RepoBackend;
		/** Start of the host clock (default: far in the future, see the header). */
		start?: number;
	} = {},
) => {
	let now = options.start ?? FUTURE;
	const clock = {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
	const ulid = createUlid({ now: () => clock.now() });
	const upstream = new Map<string, string>();
	const calls: Calls = [];
	const waits: Promise<unknown>[] = [];
	const roles = new Map<string, number>();
	let eventsRef: FakeEvents | null = null;
	let internalRef: RepoCoreInternal | null = null;
	let facadeRef: ReturnType<typeof host.facade<"core">> | null = null;
	const land = createFakeLand();
	const tree = {
		node: () => Promise.resolve(null),
		effectiveRole: (principals: string[]) =>
			Promise.resolve(Math.max(0, ...principals.map((p) => roles.get(p) ?? 0))),
		protectedRefs: () => Promise.resolve([]),
	} as unknown as TreeFacade;
	const ports: Partial<CorePorts> = {
		artifacts: recording(env.ARTIFACTS as unknown as RepoStore, calls),
		forgeTree: () => tree,
		lsRefs: (_remote: GitRemote, options) =>
			Promise.resolve(
				[...upstream.entries()]
					.filter(([ref]) =>
						(options?.refPrefixes ?? []).some((p) => ref.startsWith(p))
					)
					.map(([ref, value]) => ({ ref, sha: value })),
			),
		gitJobs: {
			refWrite: async (
				_repoId: string,
				intents: readonly KernelWriteIntent[],
			) => {
				const results = [];
				for (const intent of intents) {
					const row = await facadeRef!.registerKernelWrite(intent);
					if ((upstream.get(intent.ref) ?? ZERO_SHA) !== intent.expectOld) {
						results.push({ ref: intent.ref, ok: false, reason: "stale" });
						continue;
					}
					if (intent.newSha === ZERO_SHA) upstream.delete(intent.ref);
					else upstream.set(intent.ref, intent.newSha);
					await facadeRef!.markKernelWrite(row.id, "pushed");
					results.push({ ref: intent.ref, ok: true });
				}
				return results;
			},
		} as unknown as CorePorts["gitJobs"],
		probe: () => ({
			laneDiff: (_source, after): Promise<DiffResult> =>
				Promise.resolve({
					rangeBase: TRUNK,
					rangeTruncated: false,
					diffKey: `diffs/x/${TRUNK}..${after}.json`,
					commits: [],
					paths: ["a.ts"],
					truncated: false,
				}),
		}),
		// No installation exists on this test repo's node: no lane.open gates
		// (WP7b's real dispatcher asks WP3's tree, which does not know it).
		dispatch: {
			gates: () =>
				Promise.resolve({ calls: [], effective: [], blocked: false }),
		},
		laneMode: options.laneMode ?? "branch",
		waitUntil: (promise) => void waits.push(promise),
		log: () => {},
		sleep: () => Promise.resolve(),
	};
	const events: DoModule<object, RepoEventsInternal, Env, RepoInternals> = {
		name: "events",
		range: MIGRATION_RANGES.repo.events,
		migrations: [{ n: 249, name: "test events", sql: EVENTS_DDL }],
		create: ({ sql }) => {
			eventsRef = createFakeEvents(sql, clock, () => internalRef!);
			return { facade: {}, internal: eventsRef };
		},
	};
	const landModule: DoModule<object, typeof land, Env, RepoInternals> = {
		name: "land",
		range: MIGRATION_RANGES.repo.land,
		migrations: [],
		create: () => ({ facade: {}, internal: land }),
	};
	const host = createDoHost({
		kind: "repo-test",
		ctx: state,
		env,
		modules: {
			core: createRepoCoreModule({
				...(options.createRepoBackend
					? { createRepoBackend: options.createRepoBackend as never }
					: {}),
				ports: () => ports,
			}),
			events,
			probe: repoProbeModule,
			runs: repoRunsModule,
			land: landModule,
		},
		common: [COMMON_MIGRATIONS.base],
		clock,
		ids: { ulid },
		log: () => {},
	});
	await host.ready;
	facadeRef = host.facade("core");
	internalRef = host.internal("core");
	const repoId = ulid();
	upstream.set("refs/heads/main", TRUNK);
	await facadeRef.init({
		repoId,
		nodeId: repoId,
		path: "acme/shop",
		defaultBranch: "main",
		refs: { "refs/heads/main": TRUNK },
	});
	return {
		host,
		core: facadeRef,
		internal: internalRef,
		events: eventsRef! as FakeEvents,
		clock,
		ulid,
		upstream,
		calls,
		roles,
		repoId,
		settle: async () => {
			while (waits.length > 0) await Promise.allSettled(waits.splice(0));
		},
		sql: state.storage.sql,
	};
};

const freshRepo = () => env.REPO.getByName(`test-core:${crypto.randomUUID()}`);

describe("RepoDO core on Durable Object SQLite", () => {
	it("records pushes, merges the trigger, quarantines a foreign lane write, expires leases and GCs a closed lane", async () => {
		await runInDurableObject(freshRepo(), async (_instance, state) => {
			const t = await makeHost(state);
			const agent = `a_${t.ulid()}`;
			const lane = await t.core.openLane({
				owner: agent,
				actor: { kind: "agent", id: agent },
			});
			expect(lane.state).toBe("open");
			expect(t.calls).toEqual([]);

			// Phase 1: no binding call; the trigger merges into the row.
			t.upstream.set(lane.ref, sha(10));
			const pushed = await t.core.recordPush({
				target: lane.id,
				refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(10) }],
				principal: agent,
				via: "gateway",
				requestId: "req-1",
			});
			expect(t.calls).toEqual([]);
			expect(pushed.events.map((e) => e.type)).toEqual(["push.accepted"]);
			await t.core.observePush({
				eventId: "evt-1",
				repoName: repoArtifactsName(t.repoId).toUpperCase(),
				ref: lane.ref,
				before: ZERO_SHA,
				after: sha(10),
				at: t.clock.now(),
			});
			expect(
				t.sql.exec("SELECT COUNT(*) AS n FROM pushes").one().n,
			).toBe(1);

			// Phase 2 by the diff timer.
			t.clock.advance(31_000);
			await t.host.alarm();
			expect(t.events.ofType("push.diffed")).toHaveLength(1);

			// A foreign write to the lane: K2 after the grace window.
			await t.core.observePush({
				eventId: "evt-2",
				repoName: repoArtifactsName(t.repoId),
				ref: lane.ref,
				before: sha(10),
				after: sha(11),
				at: t.clock.now(),
			});
			t.clock.advance(OBSERVE_GRACE_MS + 1);
			await t.host.alarm();
			const quarantined = await t.core.getLane(lane.id);
			expect(quarantined?.quarantined).toBe(true);
			expect(t.internal.metaSync("landing_paused")).toBe("0");

			// K7: the lease expires, the lane is lost.
			t.clock.advance(LANE_LEASE_MS);
			await t.host.alarm();
			expect((await t.core.getLane(lane.id))?.state).toBe("lost");

			// Close (an Owner), then GC deletes the ref at the recorded head
			// (the canonical repo exists in the pool's FakeArtifacts).
			await env.ARTIFACTS.create(repoArtifactsName(t.repoId));
			const owner = `u_${t.ulid()}`;
			t.roles.set(owner, ROLE.owner);
			await t.core.closeLane(lane.id, "done", { kind: "user", id: owner });
			t.upstream.set(lane.ref, sha(11));
			const run = await t.core.gcLanes(t.clock.now() + 25 * 60 * 60 * 1000);
			expect(run.deleted).toEqual([lane.id]);
			expect(t.upstream.has(lane.ref)).toBe(false);
			expect((await t.core.getLane(lane.id))?.state).toBe("deleted");
			expect(t.events.ofType("lane.deleted")).toHaveLength(1);
		});
	});

	it("K16 denies another agent's close in the transaction and records lane.denied", async () => {
		await runInDurableObject(freshRepo(), async (_instance, state) => {
			const t = await makeHost(state);
			const a = `a_${t.ulid()}`;
			const b = `a_${t.ulid()}`;
			const lane = await t.core.openLane({
				owner: b,
				actor: { kind: "agent", id: b },
			});
			const error = await t.core.closeLane(lane.id, "x", {
				kind: "agent",
				id: a,
			})
				.catch((e: unknown) => e);
			expect(fromRpcError(error)).toMatchObject({
				code: "denied",
				reason: "lane-op",
			});
			expect(t.events.ofType("lane.denied")).toHaveLength(1);
			expect((await t.core.getLane(lane.id))?.state).toBe("open");
		});
	});

	it("[gate] a repo-mode open returns `opening` at once and awaitLane answers at its timeout", async () => {
		await runInDurableObject(freshRepo(), async (_instance, state) => {
			const started: string[] = [];
			const t = await makeHost(state, {
				laneMode: "import",
				createRepoBackend: (deps) => ({
					...createRepoBackend(deps as never),
					planOpening: (laneId, now) => ({
						mode: "repo",
						seed: "import",
						seedPhase: "cap",
						seedDeadline: now + 13_000,
						repoName: `l-${t0RepoId(deps)}-${laneId.slice(3)}`,
						capNonce: "0".repeat(32),
						base: TRUNK,
					}),
					startAttempt: (laneId) => void started.push(laneId),
					onSeedTimer: () => {},
				}),
			});
			const agent = `a_${t.ulid()}`;
			const lane = await t.core.openLane({
				owner: agent,
				actor: { kind: "agent", id: agent },
			});
			expect(lane.state).toBe("opening");
			expect(started).toEqual([lane.id]);
			const waited = await t.core.awaitLane(lane.id, 20);
			expect(waited.state).toBe("opening");
			expect(t.calls).toEqual([]);
		});
	});

	it("upstream mints one memory-only token per (repo, scope) through the Artifacts binding", async () => {
		await runInDurableObject(freshRepo(), async (_instance, state) => {
			// The binding's token expiry is wall time; this case schedules no timer.
			const t = await makeHost(state, { start: Date.now() });
			const name = repoArtifactsName(t.repoId);
			await env.ARTIFACTS.create(name);
			const first = await t.core.upstream({}, "read");
			expect(first.artifactsName).toBe(name);
			expect(first.remote).toContain(name);
			expect(first.kind).toBe("canonical");
			const again = await t.core.upstream({}, "read");
			expect(again.token).toBe(first.token);
			expect(t.calls.filter((c) => c.method === "get")).toHaveLength(1);
			const stored = JSON.stringify(
				t.sql.exec("SELECT * FROM meta").toArray(),
			);
			expect(stored.includes(first.token)).toBe(false);
		});
	});

	it("lane settings answer on the branch backend; an Owner's PUT round-trips through meta", async () => {
		await runInDurableObject(freshRepo(), async (_instance, state) => {
			const t = await makeHost(state);
			expect(await t.core.laneSettings()).toEqual({
				laneMode: "branch",
				effectiveMode: "branch",
				trunkPackBytes: null,
				maxActiveLanes: 2_000,
				atticRetentionDays: 7,
				retainedLaneRepos: 0,
				maxLaneReposForge: 1_000,
			});
			// A principal id needs a present-day ulid (the host clock is 2090).
			const ids = createUlid();
			const owner = `u_${ids()}`;
			const maintainer = `u_${ids()}`;
			t.roles.set(owner, ROLE.owner);
			t.roles.set(maintainer, ROLE.maintainer);
			const by = { kind: "user" as const, id: owner };
			const refused = await t.core.setLaneSettings({ maxActiveLanes: 9 }, {
				kind: "user",
				id: maintainer,
			}).catch((e: unknown) => e);
			expect(fromRpcError(refused).code).toBe("denied");
			const saved = await t.core.setLaneSettings({
				laneMode: "branch",
				maxActiveLanes: 9,
				atticRetentionDays: 30,
			}, by);
			expect(await t.core.laneSettings()).toEqual(saved);
			expect(saved).toMatchObject({
				laneMode: "branch",
				maxActiveLanes: 9,
				atticRetentionDays: 30,
			});
			const importMode = await t.core.setLaneSettings(
				{ laneMode: "import" },
				by,
			);
			expect(importMode.laneMode).toBe("import");
			expect(t.internal.metaSync("lane_mode")).toBe("import");
			// Only the swarm marks a repo simulated, and only with dev tools:
			// the pool runs without them.
			const sim = await t.core.markSimulated().catch((e: unknown) => e);
			expect(fromRpcError(sim).code).toBe("not_found");
			expect(t.internal.metaSync("sim")).toBeNull();
		});
	});

	it("a facade over RPC: the thin RepoDO's core() answers not_found before init (no stub left)", async () => {
		const repo = env.REPO.getByName(repoDoName(createUlid()()));
		const error = await repo.core().info().catch((e: unknown) => e);
		expect(fromRpcError(error).code).toBe("not_found");
	});
});

/** The repo id the module stored (`meta.repo_id`), for the fake backend. */
const t0RepoId = (deps: unknown): string =>
	(deps as { core: { internal: RepoCoreInternal } }).core.internal.metaSync(
		"repo_id",
	) as string;
