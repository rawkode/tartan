// Lane operations of RepoDO core (WP5a; K2, K7, K16).
//
// Every mutating operation runs K16 on its `LaneOpActor` inside the same
// transaction as its state change; a denial rolls that transaction back,
// appends `lane.denied` in its own transaction and throws
// `denied("lane-op")` (`details.code` = the reason). State rules (a
// `landing` lane is frozen, a quarantined lane cannot be archived) answer
// `conflict` with a code. Opening returns at once on either backend: a
// `branch` lane is `open` with no Artifacts call; a `repo` lane is
// `opening` and WP5b's seeder runs detached (`startAttempt`).

import {
	type ArchiveResult,
	ATTIC_PREFIX,
	conflict,
	denied,
	type EntityRef,
	EntityRefSchema,
	type Footprint,
	FootprintSchema,
	invalid,
	isIdOf,
	isPrincipalId,
	isReservedParent,
	isReservedRef,
	isValidRefName,
	type Lane,
	LANE_DELETE_AFTER_CLOSE_MS,
	LANE_LEASE_MS,
	LANE_REPO_HEAD_REF,
	laneBranchRef,
	laneId as laneIdOf,
	type LaneOp,
	type LaneState,
	notFound,
	scopesAllow,
	type SyncResult,
	truncateChars,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type AdoptLaneInput,
	KERNEL_LANE_ACTOR,
	type LaneGcRun,
	type LaneOpActor,
	type LaneOpDecision,
	type LaneRow,
	type OpenLaneInput,
	type RepoBackend,
	seedTimerKey,
} from "@tartan/contract/kernel.ts";
import {
	LANES_OPEN_PER_MIN,
	MAX_ACTIVE_LANES,
	MAX_ACTIVE_LANES_REPO_BACKEND,
	MAX_LANES_PER_PRINCIPAL,
} from "../../../constants.ts";
import {
	actorOf,
	type Core,
	emit,
	errorText,
	first,
	getMetaNumber,
	landingOf,
	repoIdentity,
	requireNotImporting,
	rows,
	scalar,
	trunkRefOf,
} from "../core.ts";
import { openSeedIntents, registerKernelWriteSync } from "../ledger.ts";
import type { Protection } from "../protection.ts";
import { getRef, indexSha, isProtectedRef } from "../refs.ts";
import type { Roles } from "../roles.ts";
import { configuredLaneMode, type LaneBackends } from "./facade.ts";
import { recordLaneOpenGates, runLaneOpenGates } from "./gates.ts";
import { decideLaneOp, isKernelActor, laneStateIssue } from "./k16.ts";
import {
	delegatesOf,
	isResumable,
	laneEventData,
	laneRow,
	LIVE_SQL,
	mayWriteLane,
	toLane,
} from "./rows.ts";
import type { LaneWaiters } from "./waiters.ts";

/** At most this many delegates per lane. */
export const MAX_DELEGATES = 32;
/** Rows one `gcLanes` run handles. */
const GC_BATCH = 50;
/** The `lanes_open` rate window. */
const RATE_WINDOW_MS = 60_000;

/** Thrown inside an operation's transaction to roll it back and record `lane.denied`. */
class LaneDenial extends Error {
	constructor(
		readonly reason: "lane-op" | "lane-cap",
		readonly code: string,
		readonly laneId: string | null,
		readonly op: LaneOp,
		/** Recorded with `lane.denied` (e.g. the `gate.decided` of a veto). */
		readonly record?: () => void,
	) {
		super(`${reason}: ${code}`);
	}
}

export type LanesDeps = {
	readonly core: Core;
	readonly backends: LaneBackends;
	readonly repo: RepoBackend;
	readonly roles: Roles;
	readonly waiters: LaneWaiters;
	readonly protection: Protection;
	/** Lane GC found a head that moved: reconcile that lane (K2). */
	readonly onHeadMoved?: (laneId: string) => Promise<void>;
};

export type Lanes = {
	authorizeLaneOp(
		actor: LaneOpActor,
		laneId: string | null,
		op: LaneOp,
	): Promise<LaneOpDecision>;
	openLane(input: OpenLaneInput): Promise<Lane>;
	awaitLane(laneId: string, timeoutMs: number): Promise<Lane>;
	adoptLane(input: AdoptLaneInput): Promise<Lane>;
	getLane(laneId: string): Promise<Lane | null>;
	listLanes(filter: {
		state?: LaneState[];
		owner?: string;
		entity?: EntityRef;
		cursor?: string;
		limit?: number;
	}): Promise<{ lanes: Lane[]; cursor?: string }>;
	closeLane(laneId: string, reason: string, by: LaneOpActor): Promise<void>;
	archiveLane(
		laneId: string,
		o: { atticRef?: string },
		by: LaneOpActor,
	): Promise<ArchiveResult>;
	delegateLane(
		laneId: string,
		add: readonly string[],
		remove: readonly string[],
		by: LaneOpActor,
	): Promise<void>;
	syncLane(laneId: string, by: LaneOpActor): Promise<SyncResult>;
	restackLane(
		laneId: string,
		onto: string,
		by: LaneOpActor,
	): Promise<SyncResult>;
	purgeLane(laneId: string, by: LaneOpActor): Promise<void>;
	ackQuarantine(laneId: string, by: LaneOpActor): Promise<void>;
	renewLease(
		laneId: string,
		principal: string,
	): Promise<{ leaseExpiresAt: number }>;
	flushPresence(
		entries: {
			principal: string;
			laneId?: string;
			status: string;
			at: number;
		}[],
	): Promise<void>;
	gcLanes(now: number): Promise<LaneGcRun>;
	/** The `lease` timer (K7). */
	onLeaseTimer(): void;
	/** Re-arms the `lease` timer at the next expiry. */
	scheduleLease(): void;
};

const validateActor = (actor: LaneOpActor): void => {
	if (
		actor === null || typeof actor !== "object" ||
		!["user", "agent", "ext", "system"].includes(actor.kind) ||
		!isPrincipalId(actor.id)
	) {
		throw invalid("invalid lane actor");
	}
	if (actor.onBehalfOf !== undefined && !isPrincipalId(actor.onBehalfOf)) {
		throw invalid("invalid onBehalfOf");
	}
	if (
		actor.installation !== undefined &&
		!isIdOf("installation", actor.installation)
	) {
		throw invalid("invalid installation");
	}
	const bounds = actor.bounds;
	if (
		bounds !== undefined &&
		(bounds === null || typeof bounds !== "object" ||
			!Number.isInteger(bounds.maxRole) || bounds.maxRole < 0 ||
			bounds.maxRole > 50 ||
			!(bounds.scopes === null ||
				(Array.isArray(bounds.scopes) &&
					bounds.scopes.every((s) => typeof s === "string"))) ||
			!(bounds.nodeId === null || typeof bounds.nodeId === "string") ||
			!(bounds.laneId === null || typeof bounds.laneId === "string"))
	) {
		throw invalid("invalid actor bounds");
	}
};

const requireLaneId = (laneId: string): void => {
	if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
};

export const createLanes = (deps: LanesDeps): Lanes => {
	const { core, backends, repo, roles, waiters } = deps;
	const now = () => core.clock.now();

	const repoInfo = () => {
		const id = repoIdentity(core.sql);
		return { repoId: id.repoId, path: id.path };
	};

	const dto = (row: LaneRow): Lane => toLane(row, repoInfo());

	const requireLane = (laneId: string): LaneRow => {
		const lane = laneRow(core.sql, laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		return lane;
	};

	/** Runs `body` in a transaction; a K16/cap denial appends `lane.denied` in its own. */
	const guarded = <T>(
		actor: LaneOpActor,
		body: () => T,
	): T => {
		try {
			return core.tx(body);
		} catch (error) {
			if (!(error instanceof LaneDenial)) throw error;
			core.tx(() => {
				error.record?.();
				emit(core, {
					type: "lane.denied",
					actor: actorOf(actor.id, actor.onBehalfOf),
					...(error.laneId !== null
						? { subject: { kind: "lane", id: error.laneId } }
						: {}),
					data: {
						...(error.laneId !== null ? { laneId: error.laneId } : {}),
						op: error.op,
						actor: actor.id,
						reason: truncateChars(`${error.reason}: ${error.code}`, 500),
					},
				});
			});
			throw denied(
				error.reason,
				`lane ${error.op} denied: ${error.code}`,
				{ code: error.code },
			);
		}
	};

	const k16 = (
		actor: LaneOpActor,
		op: LaneOp,
		lane: LaneRow | null,
		role: number,
		extra: { owner?: string; lastPusher?: string | null } = {},
	): void => {
		const decision = decideLaneOp({ actor, op, lane, role, ...extra });
		if (!decision.ok) {
			throw new LaneDenial("lane-op", decision.code, lane?.id ?? null, op);
		}
	};

	const stateCheck = (
		op: Exclude<LaneOp, "open" | "adopt">,
		lane: LaneRow,
		onto?: LaneRow | null,
	): void => {
		const issue = laneStateIssue(op, lane, onto);
		if (issue !== null) {
			throw conflict(`lane ${lane.id} cannot ${op}: ${issue}`, {
				code: issue,
				laneId: lane.id,
			});
		}
	};

	/**
	 * The role only when K16 could need it (Maintainer+/Owner alternatives),
	 * bounded by the actor's credential (ceiling, node subtree, lane pin at
	 * the target lane); a credential without the `lanes` scope brings no role
	 * to a lane operation.
	 */
	const roleFor = async (
		actor: LaneOpActor,
		op: LaneOp,
		laneId: string | null,
	): Promise<number> => {
		if (isKernelActor(actor)) return 50;
		const lane = laneId === null ? null : laneRow(core.sql, laneId);
		const bounded = async () =>
			actor.bounds !== undefined && !scopesAllow(actor.bounds.scopes, "claim")
				? 0
				: await roles.of(actor, { laneId });
		if (op === "purge") return await bounded();
		if (op === "adopt" || lane === null) return await bounded();
		const withoutRole = decideLaneOp({ actor, op, lane, role: 0 });
		return withoutRole.ok ? 0 : await bounded();
	};

	const scheduleLease = (): void => {
		const next = first<{ at: number | null }>(
			core.sql,
			`SELECT MIN(at) AS at FROM (
			   SELECT lease_expires_at AS at FROM lanes WHERE state = 'open'
			   UNION ALL
			   SELECT lease_expires_at + ? AS at FROM lanes WHERE state = 'lost')`,
			24 * 60 * 60 * 1000,
		)?.at ?? null;
		if (next === null) core.timers.cancel("lease");
		else core.timers.schedule("lease", Math.max(next, now() + 1));
	};

	// -------------------------------------------------------------------------
	// Read-only
	// -------------------------------------------------------------------------

	const authorizeLaneOp = async (
		actor: LaneOpActor,
		laneId: string | null,
		op: LaneOp,
	): Promise<LaneOpDecision> => {
		validateActor(actor);
		if (laneId !== null) requireLaneId(laneId);
		const lane = laneId === null ? null : laneRow(core.sql, laneId);
		if (laneId !== null && lane === null) {
			throw notFound(`unknown lane: ${laneId}`);
		}
		const role = await roleFor(actor, op, laneId);
		const decision = decideLaneOp({
			actor,
			op,
			lane,
			role,
			owner: actor.onBehalfOf ?? actor.id,
		});
		return decision.ok ? { ok: true } : { ok: false, reason: "lane-op" };
	};

	const getLane = (laneId: string): Promise<Lane | null> => {
		const lane = laneRow(core.sql, laneId);
		return Promise.resolve(lane === null ? null : dto(lane));
	};

	const listLanes: Lanes["listLanes"] = (filter) => {
		const asked = Number(filter.limit ?? 50);
		const limit = Number.isFinite(asked)
			? Math.min(Math.max(Math.floor(asked), 1), 200)
			: 50;
		const where: string[] = [];
		const bindings: SqlStorageValue[] = [];
		if (filter.state !== undefined && filter.state.length > 0) {
			where.push("state IN (SELECT value FROM json_each(?))");
			bindings.push(JSON.stringify(filter.state));
		}
		if (filter.owner !== undefined) {
			where.push("owner_principal = ?");
			bindings.push(filter.owner);
		}
		if (filter.entity !== undefined) {
			where.push("entity_kind = ? AND entity_id = ?");
			bindings.push(filter.entity.kind, filter.entity.id);
		}
		if (filter.cursor !== undefined) {
			where.push("id > ?");
			bindings.push(filter.cursor);
		}
		const found = rows<LaneRow>(
			core.sql,
			`SELECT * FROM lanes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY id LIMIT ?`,
			...bindings,
			limit + 1,
		);
		const page = found.slice(0, limit);
		return Promise.resolve({
			lanes: page.map(dto),
			...(found.length > limit ? { cursor: page[page.length - 1].id } : {}),
		});
	};

	// -------------------------------------------------------------------------
	// Open, adopt, await
	// -------------------------------------------------------------------------

	const activeCount = (owner?: string): number =>
		owner === undefined
			? scalar(
				core.sql,
				`SELECT COUNT(*) AS n FROM lanes WHERE state IN (${LIVE_SQL})`,
			)
			: scalar(
				core.sql,
				`SELECT COUNT(*) AS n FROM lanes WHERE state IN (${LIVE_SQL}) AND owner_principal = ?`,
				owner,
			);

	/** Per-principal and per-repo caps (an `opening` lane counts) and the open rate. */
	const checkCaps = (owner: string, op: "open" | "adopt"): void => {
		const perPrincipal = getMetaNumber(core.sql, "max_lanes_per_principal") ??
			MAX_LANES_PER_PRINCIPAL;
		const mode = configuredLaneMode(core);
		const perRepo = getMetaNumber(core.sql, "max_active_lanes") ??
			(mode === "branch" ? MAX_ACTIVE_LANES : MAX_ACTIVE_LANES_REPO_BACKEND);
		if (activeCount(owner) >= perPrincipal) {
			throw new LaneDenial("lane-cap", "per-principal", null, op);
		}
		if (activeCount() >= perRepo) {
			throw new LaneDenial("lane-cap", "per-repo", null, op);
		}
		if (op === "open") {
			const recent = scalar(
				core.sql,
				`SELECT COUNT(*) AS n FROM lanes WHERE kind = 'lane' AND owner_principal = ?
				 AND created_at > ?`,
				owner,
				now() - RATE_WINDOW_MS,
			);
			if (recent >= LANES_OPEN_PER_MIN) {
				throw new LaneDenial("lane-cap", "open-rate", null, op);
			}
		}
	};

	const trunkTip = (): string => {
		const sha = indexSha(core.sql, trunkRefOf(core.sql));
		if (sha === ZERO_SHA) throw conflict("the repo has no trunk yet");
		return sha;
	};

	const validateOpen = (input: OpenLaneInput): {
		footprint: Footprint;
		entity?: EntityRef;
	} => {
		validateActor(input.actor);
		if (!isPrincipalId(input.owner)) {
			throw invalid(`invalid owner: ${input.owner}`);
		}
		if (input.onBehalfOf !== undefined && !isPrincipalId(input.onBehalfOf)) {
			throw invalid(`invalid onBehalfOf: ${input.onBehalfOf}`);
		}
		const footprint = FootprintSchema.safeParse(
			input.footprint ?? { projects: [], prefixes: [] },
		);
		if (!footprint.success) throw invalid("invalid footprint");
		if (input.entity !== undefined) {
			if (!EntityRefSchema.safeParse(input.entity).success) {
				throw invalid("invalid entity");
			}
		}
		return {
			footprint: footprint.data,
			...(input.entity ? { entity: input.entity } : {}),
		};
	};

	const insertLane = (row: {
		id: string;
		kind: "lane" | "adopted";
		mode: "repo" | "branch";
		repoName: string | null;
		seed: string | null;
		seedAttempt: number;
		seedPhase: string | null;
		seedDeadline: number | null;
		capNonce: string | null;
		ref: string;
		owner: string;
		onBehalfOf: string | null;
		installation: string | null;
		entity?: EntityRef;
		footprint: Footprint;
		base: string;
		head: string | null;
		state: LaneState;
	}): LaneRow => {
		const at = now();
		core.sql.exec(
			`INSERT INTO lanes (id, kind, mode, repo_name, seed, seed_attempt, seed_phase,
			   seed_deadline, cap_nonce, ref, owner_principal, on_behalf_of, delegates_json,
			   opened_by_installation, entity_kind, entity_id, footprint_json, base_sha, head_sha,
			   state, quarantined, lease_expires_at, pushes, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
			row.id,
			row.kind,
			row.mode,
			row.repoName,
			row.seed,
			row.seedAttempt,
			row.seedPhase,
			row.seedDeadline,
			row.capNonce,
			row.ref,
			row.owner,
			row.onBehalfOf,
			row.installation,
			row.entity?.kind ?? null,
			row.entity?.id ?? null,
			JSON.stringify(row.footprint),
			row.base,
			row.head,
			row.state,
			at + LANE_LEASE_MS,
			at,
		);
		return laneRow(core.sql, row.id) as LaneRow;
	};

	const openLane = async (input: OpenLaneInput): Promise<Lane> => {
		const { footprint, entity } = validateOpen(input);
		const identity = repoIdentity(core.sql);
		requireNotImporting(core.sql, "openLane");
		const id = laneIdOf(core.ids.ulid());
		// Who may open, without I/O; denials never reach the gates.
		const early = decideLaneOp({
			actor: input.actor,
			op: "open",
			lane: null,
			role: 0,
			owner: input.owner,
		});
		const mode = configuredLaneMode(core);
		const gates = early.ok
			? await runLaneOpenGates(core, {
				point: "lane.open",
				repo: identity.repoId,
				mode: mode === "branch" ? "branch" : "repo",
				owner: input.owner,
				...(entity ? { entity } : {}),
				footprint,
				openLanesByOwner: activeCount(input.owner),
				truncated: false,
			}, { nodeId: identity.nodeId, repoId: identity.repoId })
			: { effective: [], blocked: false };
		let started = false;
		const row = guarded(input.actor, () => {
			k16(input.actor, "open", null, 0, { owner: input.owner });
			checkCaps(input.owner, "open");
			if (gates.blocked) {
				throw new LaneDenial(
					"lane-op",
					"gate-veto",
					null,
					"open",
					() => recordLaneOpenGates(core, gates, id),
				);
			}
			const common = {
				id,
				kind: "lane" as const,
				owner: input.owner,
				onBehalfOf: input.onBehalfOf ?? null,
				installation: input.actor.installation ?? null,
				...(entity ? { entity } : {}),
				footprint,
			};
			const plan = mode === "branch"
				? ({ mode: "branch" } as const)
				: repo.planOpening(id, now());
			recordLaneOpenGates(core, gates, id);
			if (plan.mode === "branch") {
				const lane = insertLane({
					...common,
					mode: "branch",
					repoName: null,
					seed: null,
					seedAttempt: 0,
					seedPhase: null,
					seedDeadline: null,
					capNonce: null,
					ref: laneBranchRef(id),
					base: trunkTip(),
					head: null,
					state: "open",
				});
				emit(core, {
					type: "lane.opened",
					actor: actorOf(input.actor.id, input.actor.onBehalfOf),
					subject: { kind: "lane", id },
					data: laneEventData(lane, plan.reason ? { reason: plan.reason } : {}),
				});
				return lane;
			}
			const lane = insertLane({
				...common,
				mode: "repo",
				repoName: plan.repoName,
				seed: plan.seed,
				seedAttempt: 1,
				seedPhase: plan.seedPhase,
				seedDeadline: plan.seedDeadline,
				capNonce: plan.capNonce,
				ref: LANE_REPO_HEAD_REF,
				base: plan.base,
				head: null,
				state: "opening",
			});
			registerKernelWriteSync(core, {
				target: id,
				ref: LANE_REPO_HEAD_REF,
				expectOld: ZERO_SHA,
				newSha: plan.base,
				purpose: "lane-seed",
				ownerKind: "kernel",
				ownerId: id,
			});
			core.timers.schedule(seedTimerKey(id), plan.seedDeadline);
			emit(core, {
				type: "lane.opening",
				actor: actorOf(input.actor.id, input.actor.onBehalfOf),
				subject: { kind: "lane", id },
				data: laneEventData(lane),
			});
			started = true;
			return lane;
		});
		scheduleLease();
		if (started) {
			try {
				repo.startAttempt(id);
			} catch (error) {
				// Never thrown by contract; the watchdog re-drives the attempt.
				core.ports.log("startAttempt threw", {
					laneId: id,
					error: errorText(error),
				});
			}
		}
		return dto(row);
	};

	const awaitLane = async (
		laneId: string,
		timeoutMs: number,
	): Promise<Lane> => {
		requireLaneId(laneId);
		const lane = requireLane(laneId);
		if (lane.state === "opening") {
			await waiters.wait(laneId, Math.min(Math.max(0, timeoutMs), 120_000));
		}
		return dto(requireLane(laneId));
	};

	const lastGatewayPusher = (ref: string): string | null =>
		first<{ principal_id: string | null }>(
			core.sql,
			`SELECT principal_id FROM pushes WHERE repo_name IS NULL AND ref = ?
			 AND via IN ('gateway','swarm') AND principal_id IS NOT NULL
			 ORDER BY at DESC, id DESC LIMIT 1`,
			ref,
		)?.principal_id ?? null;

	const adoptLane = async (input: AdoptLaneInput): Promise<Lane> => {
		validateActor(input.actor);
		if (!isPrincipalId(input.owner)) {
			throw invalid(`invalid owner: ${input.owner}`);
		}
		if (
			input.entity !== undefined &&
			!EntityRefSchema.safeParse(input.entity).success
		) {
			throw invalid("invalid entity");
		}
		const ref = input.ref;
		if (
			!isValidRefName(ref) || !ref.startsWith("refs/heads/") ||
			isReservedRef(ref) || isReservedParent(ref)
		) {
			throw invalid(`not an adoptable branch: ${ref}`);
		}
		repoIdentity(core.sql);
		requireNotImporting(core.sql, "adoptLane");
		await deps.protection.refresh();
		const role = await roleFor(input.actor, "adopt", null);
		const id = laneIdOf(core.ids.ulid());
		const row = guarded(input.actor, () => {
			k16(input.actor, "adopt", null, role, {
				owner: input.owner,
				lastPusher: lastGatewayPusher(ref),
			});
			const defaultBranch = repoIdentity(core.sql).defaultBranch;
			if (isProtectedRef(ref, defaultBranch, deps.protection.patterns())) {
				throw invalid(`a protected ref cannot be adopted: ${ref}`);
			}
			const head = getRef(core.sql, ref);
			if (head === null) throw notFound(`unknown branch: ${ref}`);
			const taken = first<{ id: string }>(
				core.sql,
				`SELECT id FROM lanes WHERE mode = 'branch' AND ref = ? AND state IN (${LIVE_SQL})`,
				ref,
			);
			if (taken !== null) throw conflict(`branch already has lane ${taken.id}`);
			checkCaps(input.owner, "adopt");
			const lane = insertLane({
				id,
				kind: "adopted",
				mode: "branch",
				repoName: null,
				seed: null,
				seedAttempt: 0,
				seedPhase: null,
				seedDeadline: null,
				capNonce: null,
				ref,
				owner: input.owner,
				onBehalfOf: null,
				installation: input.actor.installation ?? null,
				...(input.entity ? { entity: input.entity } : {}),
				footprint: { projects: [], prefixes: [] },
				base: trunkTip(),
				head: head.sha,
				state: "open",
			});
			emit(core, {
				type: "lane.opened",
				actor: actorOf(input.actor.id, input.actor.onBehalfOf),
				subject: { kind: "lane", id },
				data: laneEventData(lane, { reason: "adopted" }),
			});
			return lane;
		});
		scheduleLease();
		return dto(row);
	};

	// -------------------------------------------------------------------------
	// Close, archive, delegate, sync, restack, purge, quarantine
	// -------------------------------------------------------------------------

	const closeLane = async (
		laneId: string,
		reason: string,
		by: LaneOpActor,
	): Promise<void> => {
		requireLaneId(laneId);
		validateActor(by);
		requireLane(laneId);
		const role = await roleFor(by, "close", laneId);
		let releasedOpening = false;
		guarded(by, () => {
			const lane = requireLane(laneId);
			k16(by, "close", lane, role);
			if (["closed", "archived", "deleted"].includes(lane.state)) return;
			stateCheck("close", lane);
			const at = now();
			const deleteAfter = lane.kind === "lane"
				? at + LANE_DELETE_AFTER_CLOSE_MS
				: null;
			const text = truncateChars(reason, 500);
			if (lane.state === "opening") {
				// A CAS on `opening` (any attempt) fences the seed.
				const fenced = rows<{ id: string }>(
					core.sql,
					`UPDATE lanes SET state = 'closed', cap_nonce = NULL, seed_phase = NULL,
					   seed_deadline = NULL, closed_at = ?, delete_after = ?
					 WHERE id = ? AND state = 'opening' RETURNING id`,
					at,
					deleteAfter,
					laneId,
				);
				if (fenced.length === 0) throw conflict("lane changed state; retry");
				for (const intent of openSeedIntents(core, lane)) {
					core.sql.exec(
						"UPDATE kernel_writes SET state = 'abandoned', updated_at = ? WHERE id = ?",
						at,
						intent.id,
					);
				}
				core.timers.cancel(seedTimerKey(laneId));
				const closed = requireLane(laneId);
				emit(core, {
					type: "lane.closed",
					actor: actorOf(by.id, by.onBehalfOf),
					subject: { kind: "lane", id: laneId },
					data: laneEventData(closed, {
						seedCode: "cancelled",
						...(text ? { reason: text } : {}),
					}),
				});
				releasedOpening = true;
				return;
			}
			const updated = rows<{ id: string }>(
				core.sql,
				`UPDATE lanes SET state = 'closed', closed_at = ?, delete_after = ?
				 WHERE id = ? AND state = ? RETURNING id`,
				at,
				deleteAfter,
				laneId,
				lane.state,
			);
			if (updated.length === 0) throw conflict("lane changed state; retry");
			emit(core, {
				type: "lane.closed",
				actor: actorOf(by.id, by.onBehalfOf),
				subject: { kind: "lane", id: laneId },
				data: laneEventData(requireLane(laneId), text ? { reason: text } : {}),
			});
		});
		if (releasedOpening) waiters.release(laneId);
		scheduleLease();
	};

	const archiveLane = async (
		laneId: string,
		o: { atticRef?: string },
		by: LaneOpActor,
	): Promise<ArchiveResult> => {
		requireLaneId(laneId);
		validateActor(by);
		if (
			o.atticRef !== undefined &&
			(!isValidRefName(o.atticRef) || !o.atticRef.startsWith(ATTIC_PREFIX))
		) {
			throw invalid(`not an attic ref: ${o.atticRef}`);
		}
		const { repoId } = repoIdentity(core.sql);
		requireLane(laneId);
		const role = await roleFor(by, "archive", laneId);
		const before = guarded(by, () => {
			const lane = requireLane(laneId);
			k16(by, "archive", lane, role);
			stateCheck("archive", lane);
			return lane;
		});
		const git = await core.ports.gitJobs.archive(repoId, laneId, {
			...(o.atticRef !== undefined ? { atticRef: o.atticRef } : {}),
			gateFirst: true,
		});
		const result: ArchiveResult = before.mode === "repo"
			? await repo.archive(laneId, { vetoed: git.vetoed })
			: git.vetoed
			? { kind: "summary" }
			: git.kind === "ref"
			? { kind: "ref", ref: git.ref, head: git.head }
			: git.kind === "lane"
			? { kind: "lane", laneId: git.laneId, head: git.head, until: git.until }
			: { kind: "summary" };
		core.tx(() => {
			const lane = requireLane(laneId);
			stateCheck("archive", lane);
			const at = now();
			core.sql.exec(
				`UPDATE lanes SET state = 'archived', closed_at = COALESCE(closed_at, ?),
				   delete_after = CASE WHEN mode = 'branch' AND kind = 'lane' THEN ? ELSE delete_after END
				 WHERE id = ?`,
				at,
				at,
				laneId,
			);
			const archived = requireLane(laneId);
			emit(core, {
				type: "lane.archived",
				actor: actorOf(by.id, by.onBehalfOf),
				subject: { kind: "lane", id: laneId },
				data: laneEventData(archived, {
					...(result.kind === "ref" ? { atticRef: result.ref } : {}),
					...(result.kind === "lane"
						? { atticHead: result.head, atticUntil: result.until }
						: {}),
					...(result.kind === "summary" ? { reason: "summary" } : {}),
				}),
			});
		});
		scheduleLease();
		return result;
	};

	const delegateLane = (
		laneId: string,
		add: readonly string[],
		remove: readonly string[],
		by: LaneOpActor,
	): Promise<void> => {
		requireLaneId(laneId);
		validateActor(by);
		for (const principal of [...add, ...remove]) {
			if (!isPrincipalId(principal)) {
				throw invalid(`invalid principal: ${principal}`);
			}
		}
		requireLane(laneId);
		guarded(by, () => {
			const lane = requireLane(laneId);
			k16(by, "delegate", lane, 0);
			stateCheck("delegate", lane);
			const next = [
				...new Set([...delegatesOf(lane), ...add]),
			].filter((p) => !remove.includes(p) && p !== lane.owner_principal);
			if (next.length > MAX_DELEGATES) {
				throw invalid(`at most ${MAX_DELEGATES} delegates`);
			}
			core.sql.exec(
				"UPDATE lanes SET delegates_json = ? WHERE id = ?",
				JSON.stringify(next),
				laneId,
			);
			emit(core, {
				type: "lane.delegated",
				actor: actorOf(by.id, by.onBehalfOf),
				subject: { kind: "lane", id: laneId },
				data: laneEventData(requireLane(laneId), { delegates: next }),
			});
		});
		return Promise.resolve();
	};

	const gitWork = async (
		op: "sync" | "restack",
		laneId: string,
		by: LaneOpActor,
		onto?: string,
	): Promise<SyncResult> => {
		requireLaneId(laneId);
		validateActor(by);
		if (onto !== undefined) requireLaneId(onto);
		const { repoId } = repoIdentity(core.sql);
		requireLane(laneId);
		guarded(by, () => {
			const lane = requireLane(laneId);
			k16(by, op, lane, 0);
			stateCheck(
				op,
				lane,
				onto === undefined ? undefined : laneRow(core.sql, onto),
			);
		});
		const result = op === "sync"
			? await core.ports.gitJobs.sync(repoId, laneId)
			: await core.ports.gitJobs.restack(repoId, laneId, onto as string);
		if (result.ok) {
			core.tx(() => {
				if (onto !== undefined) {
					core.sql.exec(
						"UPDATE lanes SET depends_on_lane = ? WHERE id = ?",
						onto,
						laneId,
					);
				}
				emit(core, {
					type: op === "sync" ? "lane.synced" : "lane.restacked",
					actor: actorOf(by.id, by.onBehalfOf),
					subject: { kind: "lane", id: laneId },
					data: laneEventData(requireLane(laneId), { head: result.head }),
				});
			});
		}
		return result;
	};

	const purgeLane = async (laneId: string, by: LaneOpActor): Promise<void> => {
		requireLaneId(laneId);
		validateActor(by);
		const { repoId } = repoIdentity(core.sql);
		requireLane(laneId);
		const role = await roleFor(by, "purge", laneId);
		const lane = guarded(by, () => {
			const current = requireLane(laneId);
			k16(by, "purge", current, role);
			return current;
		});
		if (lane.state === "deleted") return;
		stateCheck("purge", lane);
		if (lane.mode === "repo") {
			await repo.purge(laneId);
		} else {
			const refs = [
				...(lane.kind === "lane" && getRef(core.sql, lane.ref) !== null
					? [{ ref: lane.ref, sha: indexSha(core.sql, lane.ref) }]
					: []),
				...rows<{ ref: string; new_sha: string }>(
					core.sql,
					`SELECT DISTINCT ref, new_sha FROM kernel_writes WHERE target = ? AND purpose = 'attic'
					 AND state IN ('pushed','observed')`,
					laneId,
				)
					.filter((w) => getRef(core.sql, w.ref)?.sha === w.new_sha)
					.map((w) => ({ ref: w.ref, sha: w.new_sha })),
			];
			if (refs.length > 0) {
				const results = await core.ports.gitJobs.refWrite(
					repoId,
					refs.map((r) => ({
						target: laneId,
						ref: r.ref,
						expectOld: r.sha,
						newSha: ZERO_SHA,
						purpose: "purge" as const,
						ownerKind: "kernel" as const,
						ownerId: `purge:${laneId}`,
					})),
				);
				const failed = results.filter((r) => !r.ok);
				if (failed.length > 0) {
					throw conflict(
						`purge incomplete: ${failed.map((r) => r.ref).join(", ")}`,
					);
				}
			}
		}
		core.tx(() => {
			const current = requireLane(laneId);
			if (current.state === "deleted") return;
			core.sql.exec(
				"UPDATE lanes SET state = 'deleted', delete_after = NULL WHERE id = ?",
				laneId,
			);
			emit(core, {
				type: "lane.deleted",
				actor: actorOf(by.id, by.onBehalfOf),
				subject: { kind: "lane", id: laneId },
				data: laneEventData(requireLane(laneId), { reason: "purge" }),
			});
		});
	};

	const ackQuarantine = async (
		laneId: string,
		by: LaneOpActor,
	): Promise<void> => {
		requireLaneId(laneId);
		validateActor(by);
		requireLane(laneId);
		const role = isKernelActor(by) ? 50 : await roles.of(by, { laneId });
		if (role < 50) {
			throw denied("role", "only an Owner may acknowledge a quarantine");
		}
		core.tx(() => {
			const lane = requireLane(laneId);
			const tampered = scalar(
				core.sql,
				"SELECT COUNT(*) AS n FROM pending_observations WHERE lane_id = ? AND tampered_at IS NOT NULL",
				laneId,
			);
			if (lane.quarantined !== 1 && tampered === 0) return;
			core.sql.exec("UPDATE lanes SET quarantined = 0 WHERE id = ?", laneId);
			core.sql.exec(
				"DELETE FROM pending_observations WHERE lane_id = ? AND tampered_at IS NOT NULL",
				laneId,
			);
			// K3: the cleared alarm is an event.
			emit(core, {
				type: "ref.acknowledged",
				actor: actorOf(by.id, by.onBehalfOf),
				subject: { kind: "lane", id: laneId },
				data: { laneId },
			});
		});
	};

	// -------------------------------------------------------------------------
	// Leases and presence (K7)
	// -------------------------------------------------------------------------

	const renewLease = (
		laneId: string,
		principal: string,
	): Promise<{ leaseExpiresAt: number }> => {
		requireLaneId(laneId);
		if (!isPrincipalId(principal)) {
			throw invalid(`invalid principal: ${principal}`);
		}
		const result = core.tx(() => {
			const lane = requireLane(laneId);
			if (!mayWriteLane(lane, principal)) {
				throw denied("lane-op", "only the owner or a delegate renews a lane", {
					code: "not-owner-or-delegate",
				});
			}
			if (lane.state === "opening") {
				return { leaseExpiresAt: lane.lease_expires_at };
			}
			const at = now();
			if (lane.state === "lost") {
				if (!isResumable(lane, at)) {
					throw conflict("the lane's resume window has passed", {
						code: "lane-lost",
					});
				}
				core.sql.exec(
					"UPDATE lanes SET state = 'open', lease_expires_at = ? WHERE id = ?",
					at + LANE_LEASE_MS,
					laneId,
				);
				emit(core, {
					type: "lane.opened",
					actor: actorOf(principal),
					subject: { kind: "lane", id: laneId },
					data: laneEventData(requireLane(laneId), { reason: "resumed" }),
				});
				return { leaseExpiresAt: at + LANE_LEASE_MS };
			}
			if (!["open", "submitted", "landing"].includes(lane.state)) {
				throw conflict(`lane is ${lane.state}`, { code: `lane-${lane.state}` });
			}
			core.sql.exec(
				"UPDATE lanes SET lease_expires_at = ? WHERE id = ?",
				at + LANE_LEASE_MS,
				laneId,
			);
			return { leaseExpiresAt: at + LANE_LEASE_MS };
		});
		scheduleLease();
		return Promise.resolve(result);
	};

	const flushPresence: Lanes["flushPresence"] = (entries) => {
		core.tx(() => {
			for (const entry of entries.slice(0, 1000)) {
				if (!isPrincipalId(entry.principal)) continue;
				const status = truncateChars(String(entry.status ?? ""), 64);
				if (entry.laneId !== undefined && isIdOf("lane", entry.laneId)) {
					const lane = laneRow(core.sql, entry.laneId);
					if (
						lane !== null && mayWriteLane(lane, entry.principal) &&
						["open", "submitted", "landing"].includes(lane.state)
					) {
						const until = Math.max(
							lane.lease_expires_at,
							Math.min(entry.at, now()) + LANE_LEASE_MS,
						);
						core.sql.exec(
							"UPDATE lanes SET lease_expires_at = ? WHERE id = ?",
							until,
							lane.id,
						);
					}
				}
				emit(core, {
					type: "presence.changed",
					actor: actorOf(entry.principal),
					data: {
						principal: entry.principal,
						...(entry.laneId !== undefined && isIdOf("lane", entry.laneId)
							? { laneId: entry.laneId }
							: {}),
						status,
					},
				});
			}
		});
		scheduleLease();
		return Promise.resolve();
	};

	const onLeaseTimer = (): void => {
		core.tx(() => {
			const at = now();
			const expired = rows<LaneRow>(
				core.sql,
				`SELECT * FROM lanes WHERE state = 'open' AND lease_expires_at <= ?
				 ORDER BY lease_expires_at LIMIT 200`,
				at,
			);
			for (const lane of expired) {
				core.sql.exec("UPDATE lanes SET state = 'lost' WHERE id = ?", lane.id);
				emit(core, {
					type: "lane.lost",
					subject: { kind: "lane", id: lane.id },
					data: laneEventData(requireLane(lane.id)),
				});
			}
			const abandoned = rows<LaneRow>(
				core.sql,
				`SELECT * FROM lanes WHERE state = 'lost' AND lease_expires_at + ? <= ?
				 ORDER BY lease_expires_at LIMIT 200`,
				24 * 60 * 60 * 1000,
				at,
			);
			for (const lane of abandoned) {
				core.sql.exec(
					`UPDATE lanes SET state = 'closed', closed_at = ?,
					   delete_after = CASE WHEN kind = 'lane' THEN ? ELSE NULL END
					 WHERE id = ?`,
					at,
					at + LANE_DELETE_AFTER_CLOSE_MS,
					lane.id,
				);
				emit(core, {
					type: "lane.closed",
					subject: { kind: "lane", id: lane.id },
					data: laneEventData(requireLane(lane.id), {
						reason: "lease-expired",
					}),
				});
			}
		});
		scheduleLease();
	};

	// -------------------------------------------------------------------------
	// Lane GC (cron)
	// -------------------------------------------------------------------------

	const gcInFlight = new Set<string>();

	const gcLanes = async (at: number): Promise<LaneGcRun> => {
		const due = rows<LaneRow>(
			core.sql,
			`SELECT * FROM lanes WHERE kind = 'lane' AND state IN ('closed','archived')
			 AND delete_after IS NOT NULL AND delete_after <= ?
			 ORDER BY delete_after, id LIMIT ?`,
			at,
			GC_BATCH,
		);
		const deleted: string[] = [];
		const deferred: string[] = [];
		const skipped: string[] = [];
		for (const lane of due) {
			if (gcInFlight.has(lane.id)) {
				skipped.push(lane.id);
				continue;
			}
			gcInFlight.add(lane.id);
			try {
				const landing = landingOf(core, lane.id);
				const expect = landing?.lane_head ?? lane.head_sha ?? ZERO_SHA;
				const outcome = await backends[lane.mode].gc(lane, expect);
				if (outcome.deleted || outcome.reason === "missing") {
					core.tx(() => {
						const current = requireLane(lane.id);
						if (!["closed", "archived"].includes(current.state)) return;
						core.sql.exec(
							"UPDATE lanes SET state = 'deleted', delete_after = NULL WHERE id = ?",
							lane.id,
						);
						emit(core, {
							type: "lane.deleted",
							actor: actorOf(KERNEL_LANE_ACTOR.id),
							subject: { kind: "lane", id: lane.id },
							data: laneEventData(requireLane(lane.id), {
								reason: outcome.deleted ? "gc" : "missing",
							}),
						});
					});
					deleted.push(lane.id);
				} else if (outcome.reason === "change-ref-missing") {
					deferred.push(lane.id);
				} else {
					skipped.push(lane.id);
					await deps.onHeadMoved?.(lane.id);
				}
			} catch (error) {
				core.ports.log("lane gc failed", {
					laneId: lane.id,
					error: errorText(error),
				});
				skipped.push(lane.id);
			} finally {
				gcInFlight.delete(lane.id);
			}
		}
		return { deleted, deferred, skipped };
	};

	return {
		authorizeLaneOp,
		openLane,
		awaitLane,
		adoptLane,
		getLane,
		listLanes,
		closeLane,
		archiveLane,
		delegateLane,
		syncLane: (laneId, by) => gitWork("sync", laneId, by),
		restackLane: (laneId, onto, by) => gitWork("restack", laneId, by, onto),
		purgeLane,
		ackQuarantine,
		renewLease,
		flushPresence,
		gcLanes,
		onLeaseTimer,
		scheduleLease,
	};
};
