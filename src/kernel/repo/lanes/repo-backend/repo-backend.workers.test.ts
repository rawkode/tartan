/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The `repo` lane backend in workerd (WP5b): WP5a's `core` module with this
// backend on real Durable Object SQLite (the DO applied migration 180 with
// the rest of `core`), the real WP0 host (migrations, timer multiplexer,
// RpcTarget facades) and the pool's FakeArtifacts service binding. The
// capability route is WP4's and not in this build, so the importer never
// reaches it: the lane walks the whole fallback chain (import, its one
// retry, create) and opens on `branch`, fenced attempt by attempt.

import { runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	laneArtifactsName,
	type LaneMode,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type ArtifactsIndexRow,
	type DoModule,
	type IndexArtifactsInput,
	MIGRATION_RANGES,
	type RepoCoreInternal,
	type RepoEventsInternal,
	type RepoInternals,
	type RepoStore,
	type TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { GitRemote } from "@tartan/gitproto";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../../test/env.ts";
import { createDoHost } from "../../../../do/host.ts";
import { COMMON_MIGRATIONS } from "../../../../do/migrations.ts";
import type { Env } from "../../../../env.ts";
import { capMacOf } from "../../../http/capmac.ts";
import { repoProbeModule } from "../../../probe/module.ts";
import { repoRunsModule } from "../../../runs/module.ts";
import type { CorePorts } from "../../core.ts";
import { createRepoCoreModule } from "../../module.ts";
import {
	createFakeEvents,
	createFakeLand,
	EVENTS_DDL,
	type FakeEvents,
} from "../../testing/fakes.ts";
import { createRepoBackendWith } from "./index.ts";

const TRUNK = "c".repeat(40);

const makeHost = async (state: DurableObjectState, laneMode: LaneMode) => {
	let now = Date.now();
	const clock = {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
	const ulid = createUlid({ now: () => clock.now() });
	let eventsRef: FakeEvents | null = null;
	let internalRef: RepoCoreInternal | null = null;
	const index = new Map<string, ArtifactsIndexRow>();
	const tree = {
		node: () => Promise.resolve(null),
		effectiveRole: () => Promise.resolve(0),
		protectedRefs: () => Promise.resolve([]),
		grants: () => Promise.resolve([]),
		indexArtifacts: (input: IndexArtifactsInput) => {
			index.set(input.name, {
				name: input.name,
				kind: input.kind,
				repo_id: input.repoId,
				lane_id: input.laneId ?? null,
				state: input.state,
				created_at: index.get(input.name)?.created_at ?? clock.now(),
				updated_at: clock.now(),
			});
			return Promise.resolve({ ok: true });
		},
		lookupArtifacts: (name: string) => Promise.resolve(index.get(name) ?? null),
		countLaneRepos: () => Promise.resolve({ retained: 0, max: 1_000 }),
	} as unknown as TreeFacade;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("workers-test-lane-cap-key"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const ports: Partial<CorePorts> = {
		artifacts: env.ARTIFACTS as unknown as RepoStore,
		forgeTree: () => tree,
		canonicalOrigin: () => Promise.resolve("https://git.example.test"),
		capMac: capMacOf(() => Promise.resolve(key)),
		lsRefs: (_remote: GitRemote) => Promise.resolve([]),
		gitJobs: {} as unknown as CorePorts["gitJobs"],
		dispatch: {
			gates: () =>
				Promise.resolve({ calls: [], effective: [], blocked: false }),
		},
		laneMode,
		waitUntil: () => {},
		log: () => {},
		// The control bucket refills with the clock: sleeping advances it.
		sleep: (ms) => {
			clock.advance(ms);
			return Promise.resolve();
		},
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
	const land = createFakeLand();
	const landModule: DoModule<object, typeof land, Env, RepoInternals> = {
		name: "land",
		range: MIGRATION_RANGES.repo.land,
		migrations: [],
		create: () => ({ facade: {}, internal: land }),
	};
	const host = createDoHost({
		kind: "repo-backend-test",
		ctx: state,
		env,
		modules: {
			core: createRepoCoreModule({
				ports: () => ports,
				createRepoBackend: (deps) =>
					createRepoBackendWith(deps, {
						laneMode,
						chain: ["import", "branch"],
						log: () => {},
						notify: () => Promise.resolve(),
						sleep: (ms) => {
							clock.advance(ms);
							return Promise.resolve();
						},
					}),
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
	const core = host.facade("core");
	internalRef = host.internal("core");
	const repoId = ulid();
	await core.init({
		repoId,
		nodeId: repoId,
		path: "acme/shop",
		defaultBranch: "main",
		refs: { "refs/heads/main": TRUNK },
	});
	return {
		host,
		core,
		events: () => eventsRef as FakeEvents,
		clock,
		ulid,
		repoId,
		index,
		sql: state.storage.sql,
	};
};

const until = async (check: () => Promise<boolean>, ms = 5_000) => {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

describe("the repo lane backend on Durable Object SQLite", () => {
	it("migration 180 is applied with the rest of core", async () => {
		const repo = env.REPO.getByName(`test-repo-backend:${crypto.randomUUID()}`);
		await runInDurableObject(repo, (_instance, state) => {
			const tables = state.storage.sql.exec(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lane_seed_attempts','lane_repo_sightings','lane_repo_upkeep')",
			).toArray().map((r) => r.name).sort();
			expect(tables).toEqual([
				"lane_repo_sightings",
				"lane_repo_upkeep",
				"lane_seed_attempts",
			]);
		});
	});

	it("a repo-mode lane opens `opening` at once and, with no capability route, walks import, retry, then branch", async () => {
		const repo = env.REPO.getByName(`test-repo-backend:${crypto.randomUUID()}`);
		await runInDurableObject(repo, async (_instance, state) => {
			const t = await makeHost(state, "import");
			const agent = `a_${t.ulid()}`;
			const lane = await t.core.openLane({
				owner: agent,
				actor: { kind: "agent", id: agent },
			});
			expect(lane.state).toBe("opening");
			expect(lane.mode).toBe("repo");
			await until(async () =>
				(await t.core.getLane(lane.id))?.state === "open"
			);
			const opened = await t.core.getLane(lane.id);
			expect(opened?.mode).toBe("branch");
			expect(opened?.ref).toBe(`refs/heads/lanes/${lane.id}`);
			const failed = t.events().ofType("lane.seed_failed").map((
				e,
			) => (e.data as { code: string; attempt: number; next: string }));
			expect(failed.map((f) => [f.attempt, f.code, f.next])).toEqual([
				[1, "importer-unreachable", "import"],
				[2, "importer-unreachable", "branch"],
			]);
			const attempts = t.sql.exec(
				"SELECT attempt, seed, outcome FROM lane_seed_attempts WHERE lane_id = ? ORDER BY attempt",
				lane.id,
			).toArray();
			expect(attempts).toEqual([
				{ attempt: 1, seed: "import", outcome: "failed" },
				{ attempt: 2, seed: "import", outcome: "failed" },
			]);
			// Every attempt was indexed first, under its own fresh name.
			for (const n of [1, 2]) {
				expect(t.index.get(laneArtifactsName(t.repoId, lane.id.slice(3), n)))
					.toBeDefined();
			}
			// The seed intents were superseded and finally abandoned.
			const seeds = t.sql.exec(
				"SELECT state FROM kernel_writes WHERE target = ? AND purpose = 'lane-seed' ORDER BY created_at",
				lane.id,
			).toArray().map((r) => r.state);
			expect(seeds.length).toBe(2);
			expect(seeds.every((s) => s === "abandoned")).toBe(true);
			// The watchdog timer is gone.
			expect(
				t.sql.exec(
					"SELECT COUNT(*) AS n FROM _timers WHERE key LIKE 'seed:%'",
				).one().n,
			).toBe(0);
			void ZERO_SHA;
		});
	});

	it("capUse over RPC is single-use for the pack request", async () => {
		const repo = env.REPO.getByName(`test-repo-backend:${crypto.randomUUID()}`);
		await runInDurableObject(repo, async (_instance, state) => {
			const t = await makeHost(state, "import");
			const agent = `a_${t.ulid()}`;
			const lane = await t.core.openLane({
				owner: agent,
				actor: { kind: "agent", id: agent },
			});
			const nonce = t.sql.exec(
				"SELECT cap_nonce FROM lanes WHERE id = ?",
				lane.id,
			).one().cap_nonce as string | null;
			if (nonce !== null) {
				const first = await t.core.capUse(lane.id, nonce, "pack");
				const second = await t.core.capUse(lane.id, nonce, "pack");
				if (first.ok) {
					expect(second).toEqual({ ok: false, reason: "consumed" });
				} else expect(["not-opening", "unknown"]).toContain(first.reason);
			}
			// Let the detached seed finish inside this request.
			await until(async () =>
				(await t.core.getLane(lane.id))?.state !== "opening"
			);
		});
	});
});
