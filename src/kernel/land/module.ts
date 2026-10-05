// RepoDO `land` module (WP10, migrations 350–399): land batches, verdicts,
// advances, landings, why notes. Timers: `k5` (the lock sweeper), `outbox`
// (Workflow instances still to create) and `candidates` (candidate refs deleted
// 24 h after their batch ended).
//
// `createRepoLandModule` takes injected ports, so every part is tested on
// the `node:sqlite` fake with fakes of LAND, ForgeDO, Artifacts and the git
// jobs. `seedHistory` (dev tools only) writes labelled Advances for the
// gate replay (seed.ts); the replay itself rebuilds each Advance's input
// through RepoProbe in the installations API.

import {
	type AdvanceDto,
	type AdvancesResponse,
	FORGE_DO_NAME,
	fromRpcError,
	invalid,
	repoDoName,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type AdvanceRow,
	type DoModule,
	type GateReplayRow,
	KERNEL_LANE_ACTOR,
	MIGRATION_RANGES,
	type ModuleDeps,
	type RegistryFacade,
	type RepoInternals,
	type RepoLandInternal,
	type TimerHandler,
} from "@tartan/contract/kernel.ts";
import { withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import { createAdvances } from "./advance.ts";
import { createBatches } from "./batches.ts";
import {
	CANDIDATE_TTL_MS,
	errorText,
	first,
	type LandCtx,
	type LandPorts,
	parseJson,
	type PrincipalInfo,
	rows,
} from "./ctx.ts";
import { createKernelGitJobs } from "./gitjobs.ts";
import { LAND_MIGRATIONS } from "./schema.ts";
import type { LandFacade } from "./types.ts";
import { createCanonicalAccess } from "./upstream.ts";
import { createSeeder, SEED_INSTANCE_PREFIX } from "./seed.ts";
import { createWhy } from "./why.ts";

export { CANDIDATE_TTL_MS } from "./ctx.ts";
/** `refWrite` takes at most this many intents per call. */
const REF_WRITES_PER_CALL = 32;
/** The next sweep while due candidates remain (a full page swept). */
const CANDIDATE_SWEEP_NEXT_MS = 60 * 1000;
/** The next sweep after a refused deletion (the index catches up meanwhile). */
const CANDIDATE_SWEEP_RETRY_MS = 60 * 60 * 1000;

const defaultLog = (message: string, data: Record<string, unknown>): void =>
	console.error(`[tartan] land: ${message}`, JSON.stringify(data));

const isMissing = (error: unknown): boolean =>
	/not[ _.-]?found|does not exist|no such/i.test(errorText(error));
const isDuplicate = (error: unknown): boolean =>
	/already[ _.-]?exists|duplicate/i.test(errorText(error));

/** The production ports, from `env` (bindings) and the module deps. */
export const defaultLandPorts = (
	deps: ModuleDeps<Env, RepoInternals>,
): LandPorts => {
	const env = deps.env;
	const repoId = () => deps.modules.core.metaSync("repo_id") ?? "";
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	return {
		createInstance: async (id, params) => {
			try {
				await env.LAND.create({ id, params });
				return "created";
			} catch (error) {
				if (isDuplicate(error)) return "exists";
				throw error;
			}
		},
		instanceStatus: async (id) => {
			try {
				const instance = await env.LAND.get(id);
				return (await instance.status()).status;
			} catch (error) {
				if (isMissing(error)) return "missing";
				throw error;
			}
		},
		sendEvent: async (id, type, payload) => {
			const instance = await env.LAND.get(id);
			await instance.sendEvent({ type, payload });
		},
		remoteRef: (ref) =>
			createCanonicalAccess({ artifacts: env.ARTIFACTS, repoId: repoId() })
				.refValue(ref),
		principal: async (id): Promise<PrincipalInfo | null> => {
			const row = await forge().identity().principal(id);
			return row === null ? null : {
				id: row.id,
				kind: row.kind,
				handle: row.handle,
				display: row.display,
				email: row.email_verified === 1 ? row.email : null,
				agentTool: row.agent_tool,
				agentModel: row.agent_model,
			};
		},
		canonicalHost: async () => {
			const state = await forge().identity().setupState();
			return state.canonicalOrigin === undefined
				? "tartan.invalid"
				: new URL(state.canonicalOrigin).host;
		},
		reviewProvider: async (nodeId) => {
			try {
				// Typed through the contract facade (the RPC stub types are too
				// deep); the stub is disposed when the call settles.
				const found = await withRpc(
					() => forge().registry() as unknown as RegistryFacade,
					(registry) => registry.provider("review@1", nodeId),
				);
				return found === null ? null : found.installation.id;
			} catch (error) {
				// The registry's tree is an M0 stub until WP3 merges: K10's
				// `provides` rule is then what stands behind a review event.
				if (fromRpcError(error).code === "not_implemented") return undefined;
				throw error;
			}
		},
		gitJobs: () => createKernelGitJobs(env),
		closeLane: async (laneId, reason) => {
			await env.REPO.getByName(repoDoName(repoId())).core().closeLane(
				laneId,
				reason,
				KERNEL_LANE_ACTOR,
			);
		},
		roleOf: async (principal, nodeId) =>
			await withRpc(
				() => forge().tree(),
				(tree) => tree.effectiveRole([principal], nodeId),
			),
		laneRange: async (laneId) => {
			await env.REPO.getByName(repoDoName(repoId())).core().laneRange(laneId);
		},
		landContext: async (nodeId) =>
			// One per K13.1 hold check: the stub is disposed when it settles.
			await withRpc(
				() => forge().registry() as unknown as RegistryFacade,
				(registry) => registry.landContext(nodeId),
			),
		waitUntil: (promise) => deps.ctx.waitUntil(promise),
		log: defaultLog,
		artifacts: () => env.ARTIFACTS,
		devTools: () =>
			/^dev/.test(env.TARTAN_STAGE ?? "") && env.TARTAN_DEV_TOOLS === "1",
	};
};

export type RepoLandModuleOptions = {
	readonly ports?: (deps: ModuleDeps<Env, RepoInternals>) => Partial<LandPorts>;
};

const ADVANCES_PAGE_MAX = 100;

/** `GET /-/api/advances`: newest first, a page at a time (cursor = last id). */
export const listAdvances = (
	ctx: LandCtx,
	filter: { readonly cursor?: string; readonly limit?: number },
): AdvancesResponse => {
	const asked = Number(filter.limit ?? 50);
	const limit = Number.isFinite(asked)
		? Math.max(1, Math.min(ADVANCES_PAGE_MAX, Math.floor(asked)))
		: 50;
	if (filter.cursor !== undefined && !/^adv_[0-9a-z_]+$/.test(filter.cursor)) {
		throw invalid("invalid cursor");
	}
	const found = rows<AdvanceRow>(
		ctx.sql,
		`SELECT * FROM advances ${filter.cursor !== undefined ? "WHERE id < ?" : ""}
		 ORDER BY id DESC LIMIT ?`,
		...(filter.cursor !== undefined ? [filter.cursor] : []),
		limit + 1,
	);
	const page = found.slice(0, limit);
	return {
		advances: page.map((a): AdvanceDto => {
			const gates = parseJson<
				{ gates?: AdvanceDto["gateResults"] }[]
			>(a.gate_results_json, []).flatMap((c) => c.gates ?? []);
			return {
				id: a.id,
				...(a.owner_instance.startsWith(SEED_INSTANCE_PREFIX)
					? { seeded: true as const }
					: {}),
				batchId: a.batch_id,
				attempt: a.attempt,
				ref: a.ref,
				expectOld: a.expect_old,
				...(a.new_sha !== null ? { newSha: a.new_sha } : {}),
				ownerInstance: a.owner_instance,
				leaseUntil: a.lease_until,
				step: a.step,
				state: a.state,
				evidenceReused: a.evidence_reused === 1,
				createdAt: a.created_at,
				...(a.finished_at !== null ? { finishedAt: a.finished_at } : {}),
				...(gates.length > 0 ? { gateResults: gates } : {}),
				...(a.chain_seq !== null ? { chainSeq: a.chain_seq } : {}),
				...(a.chain_head !== null ? { chainHead: a.chain_head } : {}),
			};
		}),
		...(found.length > limit ? { cursor: page[page.length - 1].id } : {}),
	};
};

/** Rejects instead of throwing, so a facade method always returns a promise. */
const run = <T>(work: () => T | Promise<T>): Promise<T> => {
	try {
		return Promise.resolve(work());
	} catch (error) {
		return Promise.reject(error);
	}
};

export const createRepoLandModule = (
	options: RepoLandModuleOptions = {},
): DoModule<LandFacade, RepoLandInternal, Env, RepoInternals> => ({
	name: "land",
	range: MIGRATION_RANGES.repo.land,
	migrations: LAND_MIGRATIONS,
	create: (deps) => {
		const ports: LandPorts = {
			...defaultLandPorts(deps),
			...(options.ports?.(deps) ?? {}),
		};
		const ctx: LandCtx = {
			sql: deps.sql,
			tx: (closure) => deps.storage.transactionSync(closure),
			clock: deps.clock,
			ids: deps.ids,
			timers: deps.timers,
			get core() {
				return deps.modules.core;
			},
			get events() {
				return deps.modules.events;
			},
			get repoconfig() {
				return deps.modules.repoconfig ?? null;
			},
			ports,
			env: deps.env,
		};
		const batches = createBatches(ctx);
		const advances = createAdvances(ctx, batches);
		const why = createWhy(ctx);
		const seeder = createSeeder(ctx, () => ({
			artifacts: ports.artifacts(),
			devTools: ports.devTools(),
		}));

		/**
		 * Deletes candidate refs of batches that ended more than 24 h ago, in
		 * `refWrite` calls of at most 32 intents, and reschedules itself while
		 * unswept batches remain.
		 */
		const sweepCandidates = async (): Promise<void> => {
			const now = ctx.clock.now();
			const stale = batches.staleCandidates(now - CANDIDATE_TTL_MS);
			let refused = 0;
			if (stale.length > 0) {
				const repoId = ctx.core.metaSync("repo_id") ?? "";
				for (let i = 0; i < stale.length; i += REF_WRITES_PER_CALL) {
					const chunk = stale.slice(i, i + REF_WRITES_PER_CALL);
					const results = await ctx.ports.gitJobs().refWrite(
						repoId,
						chunk.map((c) => ({
							target: "repo",
							ref: c.ref,
							expectOld: c.sha,
							newSha: ZERO_SHA,
							purpose: "candidate" as const,
							ownerKind: "kernel" as const,
							ownerId: `candidates:${c.batchId}`,
						})),
					);
					const swept = chunk.filter((_, j) => results[j]?.ok === true);
					batches.markCandidatesSwept(swept.map((c) => c.batchId));
					refused += chunk.length - swept.length;
				}
			}
			const oldest = batches.oldestUnswept();
			if (oldest === null) return;
			const due = oldest + CANDIDATE_TTL_MS;
			ctx.timers.schedule(
				"candidates",
				due > now ? due : now +
					(refused > 0 ? CANDIDATE_SWEEP_RETRY_MS : CANDIDATE_SWEEP_NEXT_MS),
			);
		};

		const facade: LandFacade = {
			submit: (request, requestedBy) =>
				run(() => batches.submit(request, requestedBy)),
			status: (batchId) => run(() => batches.status(batchId)),
			batch: (batchId) => run(() => batches.detail(batchId)),
			report: (batchId, verdict, reportedBy) =>
				run(() => batches.report(batchId, verdict, reportedBy)),
			contributeNote: (changeId, extId, section) =>
				run(() => batches.contributeNote(changeId, extId, section)),
			composePlan: (batchId, attempt, ranges) =>
				run(() => batches.composePlan(batchId, attempt, ranges ?? [])),
			recordCompose: (batchId, attempt, candidateSha, perChange) =>
				run(() =>
					batches.recordCompose(batchId, attempt, candidateSha, perChange ?? [])
				),
			recordGates: (batchId, attempt, decisions) =>
				run(() => batches.recordGates(batchId, attempt, decisions ?? [])),
			// Every batch end arms the candidate sweep (`armCandidateSweep`).
			setBatchState: (batchId, state, result) =>
				run(() => batches.setBatchState(batchId, state, result)),
			nextAttempt: (batchId, reason) =>
				run(() => batches.nextAttempt(batchId, reason)),
			beginAdvance: (batchId, attempt, instanceId, o) =>
				run(() => advances.beginAdvance(batchId, attempt, instanceId, o ?? {})),
			markAdvanceStep: (advanceId, step, update) =>
				run(() => advances.markAdvanceStep(advanceId, step, update ?? {})),
			completeAdvance: (advanceId) =>
				run(() => advances.completeAdvance(advanceId)),
			// K13.1: RepoDO's pending hold and ForgeDO's gate-missing hold, the
			// latter read from ForgeDO in this call (never a stale copy).
			configHold: () =>
				run(async () => {
					const config = ctx.repoconfig;
					if (config === null || !config.enabledSync()) return { held: false };
					const nodeId = ctx.core.metaSync("node_id");
					const forge = ctx.ports.landContext === undefined ||
							nodeId === null
						? undefined
						: await ctx.ports.landContext(nodeId);
					return forge === undefined
						? config.holdSync()
						: config.holdSync(forge.configHold, forge.configHoldId);
				}),
			releaseAdvance: (advanceId, reason) =>
				run(() => advances.releaseAdvance(advanceId, reason)),
			verdict: (batchId, attempt, candidateSha) =>
				run(() => batches.verdict(batchId, attempt, candidateSha)),
			whyNote: (advanceId, changeId) =>
				run(() => why.whyNote(advanceId, changeId)),
			why: (query) => run(() => why.why(query)),
			recordReplay: (replay) =>
				run(() => {
					if (typeof replay?.id !== "string" || replay.id.length === 0) {
						throw invalid("replay id required");
					}
					ctx.sql.exec(
						`INSERT INTO gate_replays (id, installation_id, advances_json, results_json, state, created_at)
						 VALUES (?, ?, ?, ?, ?, ?)
						 ON CONFLICT (id) DO UPDATE SET results_json = excluded.results_json, state = excluded.state`,
						replay.id,
						String(replay.installationId),
						JSON.stringify(replay.results.map((r) => r.advanceId)),
						JSON.stringify(replay.results),
						replay.state,
						ctx.clock.now(),
					);
				}),
			replay: (replayId) =>
				run(() =>
					first<GateReplayRow>(
						ctx.sql,
						"SELECT * FROM gate_replays WHERE id = ?",
						String(replayId),
					)
				),
			seedHistory: (input) =>
				run(async () => {
					const seeded = await seeder.seedHistory(input);
					return {
						advances: seeded.advances,
						head: seeded.head,
						withFakeKeys: seeded.withFakeKeys,
					};
				}),
			advances: (filter) => run(() => listAdvances(ctx, filter ?? {})),
		};

		const onTimer: TimerHandler = async (key) => {
			switch (key) {
				case "k5":
					await advances.sweep();
					return;
				case "outbox":
					await batches.sweepOutbox();
					return;
				case "candidates":
					await sweepCandidates();
					return;
				default:
					// Unknown keys fail, so the multiplexer's backoff makes them visible.
					throw invalid(`unknown land timer: ${key}`);
			}
		};

		return { facade, internal: advances.internal, onTimer };
	},
});

export const repoLandModule = createRepoLandModule();
