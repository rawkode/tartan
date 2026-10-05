// RepoDO `core` module (WP5a, migrations 100–179): the
// authoritative ref index, two-phase push log, `trunk_commits`, the
// `kernel_writes` ledger, parked observations (K1/K2), lanes of both
// backends behind the `LaneBackend` facade (`lanes/`), import mode and the
// Artifacts token cache with its control bucket. Timers `lease`, `outbox`,
// `observe`, `diff` and `seed` (the `repo` backend's seeder watchdog, one key
// `seed:<laneId>` per `opening` lane, routed to WP5b's `onSeedTimer`).
//
// The `repo` backend (`lanes/repo-backend/`) is WP5b's and owns 180–199 of
// this module's range. The module creates it once per RepoDO with
// `createRepoBackend(deps)` and delegates the WP5b facade methods to it
// (contract `RepoBackend`; the WP5a/WP5b split is written down in contract
// `services.ts`). `createRepoCoreModule` accepts an injected backend factory
// and injected ports so WP5a and WP5b can each test against fakes of the
// other and of every other WP. The lane settings are served here
// (`lanes/settings.ts`): they are `meta` and `lanes` reads and writes, so they
// answer on the `branch` backend too.

import {
	denied,
	FORGE_DO_NAME,
	invalid,
	isIdOf,
	isPrincipalId,
	isSha,
	isValidRefName,
	type LaneMode,
	notFound,
	RepoLaneSettingsRequestSchema,
	ROLE,
	trunkRef,
	unavailable,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type CreateRepoBackend,
	type DoModule,
	type LaneFetchSpec,
	type LaneOpActor,
	type Migration,
	MIGRATION_RANGES,
	type MigrationRange,
	type ModuleDeps,
	type PendingObservationRow,
	type RepoBackend,
	type RepoBackendCoreHost,
	type RepoBackendDeps,
	type RepoCoreFacade,
	type RepoCoreInternal,
	type RepoInternals,
	SEED_TIMER_PREFIX,
	type TimerHandler,
	type TreeFacade,
	type TriggerObservation,
	type Upstream,
	type UpstreamTarget,
} from "@tartan/contract/kernel.ts";
import { lsRefs } from "@tartan/gitproto";
import { laneModeOf, PUSH_LEASE_ENABLED } from "../../constants.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { createExtDispatch } from "../exthost/host/dispatch.ts";
import { createCapMac } from "../http/capmac.ts";
import { createKernelGitJobs } from "../land/gitjobs.ts";
import {
	actorOf,
	type Core,
	type CorePorts,
	emit,
	errorText,
	first,
	repoIdentity,
	rows,
	setMeta,
} from "./core.ts";
import { authorizationFor } from "./gitremote.ts";
import { createGitContexts } from "./gitctx.ts";
import { createCoreInternal } from "./internal.ts";
import { createBranchLaneBackend } from "./lanes/branch.ts";
import { createLaneBackends } from "./lanes/facade.ts";
import { createLanes } from "./lanes/ops.ts";
import { laneRow } from "./lanes/rows.ts";
import { createLaneSettings } from "./lanes/settings.ts";
import { createLaneWaiters } from "./lanes/waiters.ts";
import { markKernelWriteSync, registerKernelWriteSync } from "./ledger.ts";
import { createObserver, observePushSync } from "./observe.ts";
import { createProtection } from "./protection.ts";
import {
	createPushes,
	recordDiffSync,
	recordPushSync,
	recordRejectionSync,
} from "./pushes.ts";
import { createReconciler } from "./reconcile.ts";
import { allRefs, getRef, resolveRefSync, writeRef } from "./refs.ts";
import { createImportCompletion, initSync, repoInfo } from "./repo.ts";
import { createRoles } from "./roles.ts";
import { CORE_MIGRATIONS } from "./schema.ts";
import { trunkSeqsSync } from "./trunk.ts";
import { createArtifactsAccess } from "./upstream.ts";
import {
	createRepoBackend,
	repoBackendMigrations,
} from "./lanes/repo-backend/index.ts";
import { redactedLog } from "./lanes/repo-backend/context.ts";

/** WP5a's share of the `core` range; 180–199 is WP5b's. */
export const CORE_OWN_MIGRATION_RANGE = [
	100,
	179,
] as const satisfies MigrationRange;

/** WP5a's migrations, including the whole `lanes` DDL of both backends. */
export const coreOwnMigrations: readonly Migration[] = CORE_MIGRATIONS;

/** Facade methods the module delegates to WP5b's `RepoBackend` as they are. */
export const REPO_BACKEND_FACADE_METHODS = [
	"seedLane",
	"redriveSeeds",
	"capContext",
	"capUse",
	"capReport",
	"sweepLaneRepos",
	"reconcileLaneRepos",
] as const satisfies readonly (keyof RepoCoreFacade & keyof RepoBackend)[];

/** The ports the `repo` backend gets on top of the module's deps. */
export const repoBackendDeps = (
	deps: ModuleDeps<Env, RepoInternals>,
	core: RepoBackendCoreHost,
	ports: Pick<
		CorePorts,
		"artifacts" | "forgeTree" | "gitJobs" | "capMac" | "canonicalOrigin"
	> = defaultPorts(deps),
): RepoBackendDeps<Env> => ({
	...deps,
	core,
	artifacts: ports.artifacts,
	forgeTree: () => ports.forgeTree(),
	gitJobs: ports.gitJobs,
	capMac: ports.capMac,
	canonicalOrigin: () => ports.canonicalOrigin(),
});

/** Routes `seed:<laneId>` to WP5b's watchdog and every other key to WP5a's handler. */
export const coreTimerHandler = (
	repo: Pick<RepoBackend, "onSeedTimer">,
	own: TimerHandler,
): TimerHandler =>
(key) => key.startsWith(SEED_TIMER_PREFIX) ? repo.onSeedTimer(key) : own(key);

const defaultLog = redactedLog("core");

/** How long the forge's canonical origin is reused (ForgeDO setup state). */
const ORIGIN_CACHE_MS = 60_000;

/** The production ports, from `env` and the DO's `ctx`. */
export const defaultPorts = (
	deps: ModuleDeps<Env, RepoInternals>,
): CorePorts => {
	const forge = () => deps.env.FORGE.getByName(FORGE_DO_NAME);
	let origin: { value: string; at: number } | null = null;
	return {
		artifacts: deps.env.ARTIFACTS,
		forgeTree: (): TreeFacade => forge().tree(),
		canonicalOrigin: async () => {
			const now = deps.clock.now();
			if (origin !== null && now - origin.at < ORIGIN_CACHE_MS) {
				return origin.value;
			}
			const state = await forge().identity().setupState();
			if (state.canonicalOrigin === undefined) {
				throw unavailable("the forge has no canonical origin yet");
			}
			origin = { value: state.canonicalOrigin, at: now };
			return state.canonicalOrigin;
		},
		gitJobs: createKernelGitJobs(deps.env),
		capMac: createCapMac(deps.env),
		dispatch: createExtDispatch(deps.env),
		probe: () => loopback(deps.ctx).RepoProbe,
		lsRefs,
		laneMode: laneModeOf(deps.env),
		pushLeases: PUSH_LEASE_ENABLED,
		waitUntil: (promise) => deps.ctx.waitUntil(promise),
		log: defaultLog,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
};

export type RepoCoreModuleOptions = {
	/** WP5b's factory; tests inject a fake. */
	readonly createRepoBackend?: CreateRepoBackend<Env>;
	/** Overrides of the production ports (tests). */
	readonly ports?: (deps: ModuleDeps<Env, RepoInternals>) => Partial<CorePorts>;
	/** The lane modes an Owner may choose (default `OWNER_LANE_MODES`). */
	readonly laneModes?: readonly LaneMode[];
};

/** Rejects instead of throwing, so a facade method always returns a promise. */
const run = <T>(work: () => T | Promise<T>): Promise<T> => {
	try {
		return Promise.resolve(work());
	} catch (error) {
		return Promise.reject(error);
	}
};

const validateObservation = (obs: TriggerObservation): void => {
	if (typeof obs.eventId !== "string" || obs.eventId.length === 0) {
		throw invalid("eventId is required");
	}
	if (typeof obs.repoName !== "string" || obs.repoName.length > 512) {
		throw invalid("repoName is required");
	}
	if (!isValidRefName(obs.ref)) throw invalid(`invalid ref: ${obs.ref}`);
	if (!isSha(obs.before) || !isSha(obs.after)) {
		throw invalid("before and after must be shas");
	}
};

export const createRepoCoreModule = (
	options: RepoCoreModuleOptions = {},
): DoModule<RepoCoreFacade, RepoCoreInternal, Env, RepoInternals> => ({
	name: "core",
	range: MIGRATION_RANGES.repo.core,
	migrations: [...coreOwnMigrations, ...repoBackendMigrations],
	create: (deps) => {
		const ports: CorePorts = {
			...defaultPorts(deps),
			...(options.ports?.(deps) ?? {}),
		};
		const core: Core = {
			sql: deps.sql,
			tx: (closure) => deps.storage.transactionSync(closure),
			clock: deps.clock,
			ids: deps.ids,
			timers: deps.timers,
			modules: deps.modules,
			ports,
			env: deps.env,
		};
		const access = createArtifactsAccess({
			artifacts: ports.artifacts,
			clock: deps.clock,
			sleep: ports.sleep,
		});
		const protection = createProtection(core);
		const roles = createRoles(core);
		const waiters = createLaneWaiters();
		const internal = createCoreInternal(core, protection);

		// Forward reference: the backends are created below, `upstream` is
		// only called after `create` returns.
		let backendsRef: ReturnType<typeof createLaneBackends> | null = null;
		const upstream = async (
			target: UpstreamTarget,
			scope: "read" | "write",
		): Promise<Upstream> => {
			if (scope !== "read" && scope !== "write") {
				throw invalid(`invalid scope: ${scope}`);
			}
			const identity = repoIdentity(core.sql);
			if (target?.laneId === undefined) {
				const token = await access.token(identity.artifactsName, scope);
				return {
					artifactsName: identity.artifactsName,
					remote: token.remote,
					token: token.token,
					expiresAt: token.expiresAt,
					kind: "canonical",
					ref: trunkRef(identity.defaultBranch),
				};
			}
			if (!isIdOf("lane", target.laneId)) {
				throw invalid(`not a lane id: ${target.laneId}`);
			}
			const lane = laneRow(core.sql, target.laneId);
			if (lane === null) throw notFound(`unknown lane: ${target.laneId}`);
			if (backendsRef === null) throw unavailable("core is starting");
			return await backendsRef[lane.mode].remoteFor(lane, scope);
		};

		const host: RepoBackendCoreHost = {
			internal,
			upstream,
			control: access.bucket,
			releaseLaneWaiters: (laneId) => waiters.release(laneId),
		};
		const repo = (options.createRepoBackend ?? createRepoBackend)(
			repoBackendDeps(deps, host, ports),
		);
		const backends = createLaneBackends({
			branch: createBranchLaneBackend({ core, access }),
			repo,
		});
		backendsRef = backends;
		const pushes = createPushes(core);
		const observer = createObserver(core, protection);
		const reconciler = createReconciler({ core, access, protection, backends });
		const lanes = createLanes({
			core,
			backends,
			repo,
			roles,
			waiters,
			protection,
			onHeadMoved: (laneId) =>
				reconciler.reconcileLane(laneId).catch((error) =>
					ports.log("lane reconcile failed", {
						laneId,
						error: errorText(error),
					})
				),
		});
		const contexts = createGitContexts({ core, roles, protection });
		const laneSettings = createLaneSettings({
			core,
			...(options.laneModes ? { modes: options.laneModes } : {}),
		});
		const importComplete = createImportCompletion({
			core,
			access,
			roles,
			protection,
		});

		const detached = (what: string, work: Promise<unknown>): void =>
			ports.waitUntil(
				work.catch((error) => ports.log(what, { error: errorText(error) })),
			);

		const requireOwner = async (
			by: Pick<LaneOpActor, "id" | "onBehalfOf" | "bounds">,
			what: string,
		) => {
			if (!isPrincipalId(by.id)) throw invalid(`invalid principal: ${by.id}`);
			if (await roles.of(by) < ROLE.owner) {
				throw denied("role", `only an Owner may ${what}`);
			}
		};

		/**
		 * An Owner adopts the observed values of tampered refs (K1) and resumes
		 * landing (`ref.acknowledged`, K3). Only the observations read before
		 * the upstream read are acknowledged: one raised while it was in flight
		 * stays, and keeps landing paused, until the Owner sees it.
		 */
		const ackTampered = async (by: string): Promise<void> => {
			repoIdentity(core.sql);
			await requireOwner({ id: by }, "acknowledge a tampered ref");
			const tampered = rows<PendingObservationRow>(
				core.sql,
				`SELECT * FROM pending_observations WHERE lane_id IS NULL
				 AND tampered_at IS NOT NULL ORDER BY observed_at`,
			);
			const ids = JSON.stringify(tampered.map((obs) => obs.id));
			let upstreamTips: Map<string, string> | null = null;
			if (tampered.length > 0) {
				try {
					const identity = repoIdentity(core.sql);
					const token = await access.token(identity.artifactsName, "read");
					const refs = [...new Set(tampered.map((obs) => obs.ref))];
					const found = await ports.lsRefs(
						{ url: token.remote, authorization: authorizationFor(token.token) },
						{ refPrefixes: refs },
					);
					upstreamTips = new Map(
						found.filter((ref) => refs.includes(ref.ref)).map((ref) => [
							ref.ref,
							ref.sha,
						]),
					);
				} catch (error) {
					ports.log(
						"ackTampered: upstream unreadable, adopting observed values",
						{
							error: errorText(error),
						},
					);
				}
			}
			core.tx(() => {
				const seen = rows<PendingObservationRow>(
					core.sql,
					`SELECT * FROM pending_observations WHERE tampered_at IS NOT NULL
					 AND id IN (SELECT value FROM json_each(?)) ORDER BY observed_at`,
					ids,
				);
				const latest = new Map<string, string>();
				for (const obs of seen) latest.set(obs.ref, obs.after);
				for (const [ref, observed] of latest) {
					const value = upstreamTips === null
						? observed
						: upstreamTips.get(ref) ?? ZERO_SHA;
					const before = getRef(core.sql, ref)?.sha ?? null;
					writeRef(core, ref, value);
					emit(core, {
						type: "ref.reconciled",
						data: {
							ref,
							indexSha: before,
							remoteSha: value === ZERO_SHA ? null : value,
							matched: false,
						},
					});
				}
				core.sql.exec(
					"DELETE FROM pending_observations WHERE id IN (SELECT value FROM json_each(?))",
					ids,
				);
				const paused = first<{ id: string }>(
					core.sql,
					`SELECT id FROM pending_observations WHERE lane_id IS NULL
					 AND tampered_at IS NOT NULL LIMIT 1`,
				) !== null;
				setMeta(core.sql, "landing_paused", paused ? "1" : "0");
				setMeta(core.sql, "drifted", paused ? "1" : "0");
				emit(core, {
					type: "ref.acknowledged",
					actor: actorOf(by),
					data: { refs: [...latest.keys()], landingPaused: paused },
				});
			});
		};

		const laneFetchSpecs = async (
			laneIds: readonly string[],
		): Promise<LaneFetchSpec[]> => {
			if (laneIds.length > 64) throw invalid("at most 64 lanes per call");
			const lanesFound = laneIds
				.filter((id) => isIdOf("lane", id))
				.map((id) => laneRow(core.sql, id))
				.filter((lane) => lane !== null);
			if (lanesFound.some((lane) => lane.mode === "branch")) {
				await access.remote(repoIdentity(core.sql).artifactsName);
			}
			return lanesFound.map((lane) =>
				backends[lane.mode].fetchSpec(lane, lane.head_sha ?? lane.base_sha)
			);
		};

		const facade: RepoCoreFacade = {
			init: (input) => run(() => core.tx(() => initSync(core, input))),
			info: () => run(() => repoInfo(core)),
			refs: () => run(() => allRefs(core.sql)),
			resolveRef: (ref) => run(() => resolveRefSync(core.sql, ref)),
			recordPush: (report) =>
				run(() => {
					const outcome = core.tx(() => recordPushSync(core, report));
					if (outcome.missedRefs.length > 0) {
						detached(
							"reconcile after a CAS miss failed",
							reconciler.reconcile(outcome.missedRefs),
						);
					}
					for (const laneId of new Set(outcome.missedLanes)) {
						detached("lane reconcile failed", reconciler.reconcileLane(laneId));
					}
					lanes.scheduleLease();
					return {
						pushIds: outcome.pushIds,
						eventIds: outcome.eventIds,
						events: outcome.events,
						reconciled: outcome.reconciled,
					};
				}),
			recordDiff: (pushId, result) =>
				run(() => core.tx(() => recordDiffSync(core, pushId, result))),
			laneRange: (laneId) => run(() => pushes.laneRange(laneId)),
			recordRejection: (rejection) =>
				run(() => core.tx(() => recordRejectionSync(core, rejection))),
			observePush: async (observation) => {
				validateObservation(observation);
				repoIdentity(core.sql);
				await protection.refresh();
				const outcome = core.tx(() =>
					observePushSync(core, observation, protection.patterns())
				);
				// Phase 2 of a trigger-only push (the workflow cannot: observePush
				// returns nothing); the `diff` timer is the backstop.
				if (outcome.kind === "recorded" && outcome.pending) {
					detached("phase 2 failed", pushes.runPhase2(outcome.pushId));
				}
			},
			reconcile: (refs) => run(() => reconciler.reconcile(refs)),
			upstream,
			pushContext: (principal, tokenLaneId, target, lease) =>
				run(() => contexts.pushContext(principal, tokenLaneId, target, lease)),
			readContext: (principal) => run(() => contexts.readContext(principal)),
			importComplete: (by, input, source) =>
				run(() => importComplete(by, input, source)),
			authorizeLaneOp: (actor, laneId, op) =>
				run(() => lanes.authorizeLaneOp(actor, laneId, op)),
			openLane: (input) => run(() => lanes.openLane(input)),
			awaitLane: (laneId, timeoutMs) =>
				run(() => lanes.awaitLane(laneId, timeoutMs)),
			adoptLane: (input) => run(() => lanes.adoptLane(input)),
			getLane: (laneId) => run(() => lanes.getLane(laneId)),
			listLanes: (filter) => run(() => lanes.listLanes(filter ?? {})),
			closeLane: (laneId, reason, by) =>
				run(() => lanes.closeLane(laneId, reason, by)),
			archiveLane: (laneId, o, by) =>
				run(() => lanes.archiveLane(laneId, o ?? {}, by)),
			syncLane: (laneId, by) => run(() => lanes.syncLane(laneId, by)),
			restackLane: (laneId, onto, by) =>
				run(() => lanes.restackLane(laneId, onto, by)),
			delegateLane: (laneId, add, remove, by) =>
				run(() => lanes.delegateLane(laneId, add, remove, by)),
			purgeLane: (laneId, by) => run(() => lanes.purgeLane(laneId, by)),
			renewLease: (laneId, principal) =>
				run(() => lanes.renewLease(laneId, principal)),
			flushPresence: (entries) => run(() => lanes.flushPresence(entries)),
			ackTampered,
			ackQuarantine: (laneId, by) => run(() => lanes.ackQuarantine(laneId, by)),
			registerKernelWrite: (intent) =>
				run(() => core.tx(() => registerKernelWriteSync(core, intent))),
			markKernelWrite: (id, state) =>
				run(() => core.tx(() => markKernelWriteSync(core, id, state))),
			gcLanes: (now) => run(() => lanes.gcLanes(now)),
			markSimulated: () =>
				run(() => {
					// Dev tools only: elsewhere the method does not exist.
					const env = deps.env;
					if (
						!/^dev/.test(env.TARTAN_STAGE ?? "") ||
						env.TARTAN_DEV_TOOLS !== "1"
					) {
						throw notFound("not found");
					}
					repoIdentity(core.sql);
					core.tx(() => internal.markSimulatedSync());
				}),
			setLaneSettings: async (input, by) => {
				repoIdentity(core.sql);
				const parsed = RepoLaneSettingsRequestSchema.safeParse(input);
				if (!parsed.success) throw invalid("invalid lane settings");
				await requireOwner(by, "change lane settings");
				return laneSettings.set(parsed.data);
			},
			laneSettings: () =>
				run(() => {
					repoIdentity(core.sql);
					return laneSettings.get();
				}),
			laneFetchSpecs,
			trunkSeqs: (shas) => run(() => trunkSeqsSync(core.sql, shas)),
			// WP5b's methods, delegated as they are (no WP5a check in front).
			seedLane: (laneId) => repo.seedLane(laneId),
			redriveSeeds: (now) => repo.redriveSeeds(now),
			capContext: (laneId, nonce) => repo.capContext(laneId, nonce),
			capUse: (laneId, nonce, op) => repo.capUse(laneId, nonce, op),
			capReport: (laneId, nonce, report) =>
				repo.capReport(laneId, nonce, report),
			sweepLaneRepos: (names, now) => repo.sweepLaneRepos(names, now),
			reconcileLaneRepos: (now) => repo.reconcileLaneRepos(now),
		};

		const own: TimerHandler = async (key) => {
			switch (key) {
				case "lease":
					lanes.onLeaseTimer();
					return;
				case "observe":
					observer.onObserveTimer();
					return;
				case "diff":
					await pushes.onDiffTimer();
					return;
				case "outbox":
					// No core-owned outbox rows exist:
					// land and run instances are swept by their owners.
					return;
				default:
					ports.log("unknown core timer", { key });
			}
		};

		return {
			facade,
			internal,
			onTimer: coreTimerHandler(repo, own),
		};
	},
});

export const repoCoreModule = createRepoCoreModule();
