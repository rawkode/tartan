// What the gateway (WP4) asks RepoDO before a receive-pack or upload-pack: one
// RPC each, from the RepoDO index, lane rows and push log only (no upstream
// call). The policies themselves are WP4's pure functions.

import {
	type EffectiveRole,
	invalid,
	isHiddenRef,
	isIdOf,
	isPrincipalId,
	LANE_REPO_HEAD_REF,
	notFound,
	ROLE,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type LaneRow,
	type PushContext,
	type PushLeaseRequest,
	type ReadContext,
} from "@tartan/contract/kernel.ts";
import { boundRole } from "@tartan/contract";
import { PUSH_LEASE_MS, RECENT_TIP_WINDOW_MS } from "../../constants.ts";
import {
	type Core,
	errorText,
	getMeta,
	isImporting,
	repoIdentity,
	rows,
} from "./core.ts";
import {
	delegatesOf,
	isResumable,
	laneRow,
	lanesOwnedOrDelegated,
	LIVE_SQL,
} from "./lanes/rows.ts";
import type { Protection } from "./protection.ts";
import type { Roles } from "./roles.ts";

const ACTIVE = "'open','submitted','landing','lost'";

/** The head ref of a lane among a push's refs (`refs/heads/main` of a lane repo). */
const leaseRef = (lane: LaneRow): string =>
	lane.mode === "repo" ? LANE_REPO_HEAD_REF : lane.ref;

export type GitContexts = {
	pushContext(
		principal: AuthContext,
		tokenLaneId: string | null,
		target?: { laneId: string },
		lease?: PushLeaseRequest,
	): Promise<PushContext>;
	readContext(principal: AuthContext | "anon"): Promise<ReadContext>;
};

export const createGitContexts = (deps: {
	readonly core: Core;
	readonly roles: Roles;
	readonly protection: Protection;
}): GitContexts => {
	const { core, roles, protection } = deps;
	const nodePaths = new Map<string, { path: string | null; at: number }>();

	/** Whether the repo lies in the token's node subtree (cached briefly). */
	const withinTokenNode = async (nodeId: string | null): Promise<boolean> => {
		if (nodeId === null) return true;
		const identity = repoIdentity(core.sql);
		if (nodeId === identity.nodeId) return true;
		const now = core.clock.now();
		let cached = nodePaths.get(nodeId);
		if (cached === undefined || now - cached.at > 60_000) {
			try {
				const node = await core.ports.forgeTree().node(nodeId);
				cached = { path: node?.path ?? null, at: now };
			} catch (error) {
				core.ports.log("token node lookup failed", { error: errorText(error) });
				cached = { path: null, at: now };
			}
			nodePaths.set(nodeId, cached);
		}
		return cached.path !== null &&
			(identity.path === cached.path ||
				identity.path.startsWith(`${cached.path}/`));
	};

	/** A write credential = the `lanes` or `repo:write` scope and a CURRENT role ≥ Developer. */
	const writeCredential = async (auth: AuthContext): Promise<boolean> => {
		const bounds = actorBoundsOf(auth);
		const scoped = bounds.scopes === null ||
			bounds.scopes.includes("lanes") || bounds.scopes.includes("repo:write");
		if (!scoped) return false;
		const granted = await roles.of({
			id: auth.principal,
			...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
		});
		const role: EffectiveRole = boundRole(granted, bounds, {
			withinTokenNode: await withinTokenNode(bounds.nodeId),
			laneId: bounds.laneId,
		});
		return role >= ROLE.developer;
	};

	/** The U48 fallback: per-ref leases on lane heads (only with `PUSH_LEASE_ENABLED`). */
	const takeLeases = (
		lanes: readonly LaneRow[],
		lease: PushLeaseRequest | undefined,
	): Set<string> => {
		const held = new Set<string>();
		if (!core.ports.pushLeases || lease === undefined) return held;
		const now = core.clock.now();
		core.tx(() => {
			for (const lane of lanes) {
				const ref = leaseRef(lane);
				if (!lease.refs.includes(ref)) continue;
				const current = rows<{ request_id: string; expires_at: number }>(
					core.sql,
					"SELECT request_id, expires_at FROM push_leases WHERE lane_id = ? AND ref = ?",
					lane.id,
					ref,
				)[0];
				if (
					current !== undefined && current.request_id !== lease.requestId &&
					current.expires_at > now
				) {
					held.add(lane.id);
					continue;
				}
				core.sql.exec(
					`INSERT INTO push_leases (lane_id, ref, request_id, expires_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT (lane_id, ref) DO UPDATE SET request_id = excluded.request_id,
					   expires_at = excluded.expires_at`,
					lane.id,
					ref,
					lease.requestId,
					now + PUSH_LEASE_MS,
				);
			}
		});
		return held;
	};

	const pushContext = async (
		principal: AuthContext,
		tokenLaneId: string | null,
		target?: { laneId: string },
		lease?: PushLeaseRequest,
	): Promise<PushContext> => {
		if (!isPrincipalId(principal.principal)) {
			throw invalid(`invalid principal: ${principal.principal}`);
		}
		if (tokenLaneId !== null && !isIdOf("lane", tokenLaneId)) {
			throw invalid(`invalid lane pin: ${tokenLaneId}`);
		}
		if (target !== undefined && !isIdOf("lane", target.laneId)) {
			throw invalid(`invalid lane: ${target.laneId}`);
		}
		const identity = repoIdentity(core.sql);
		await protection.refresh();
		const credential = await writeCredential(principal);
		const now = core.clock.now();
		const own = lanesOwnedOrDelegated(core.sql, principal.principal, ACTIVE)
			.filter((lane) => tokenLaneId === null || lane.id === tokenLaneId);
		const targetLane = target === undefined
			? null
			: laneRow(core.sql, target.laneId);
		if (target !== undefined && targetLane === null) {
			throw notFound(`unknown lane: ${target.laneId}`);
		}
		// Only the caller's own (or delegated, pin-matching) lanes are leased,
		// and on a lane remote only the target among them: a push to another
		// agent's lane never holds that lane's head before the policy refuses
		// it, and its own other repo lanes (same lease ref) stay free.
		const leased = takeLeases(
			targetLane === null
				? own
				: own.filter((lane) => lane.id === targetLane.id),
			lease,
		);
		const adopted = rows<LaneRow>(
			core.sql,
			`SELECT * FROM lanes WHERE kind = 'adopted' AND state IN (${ACTIVE}) ORDER BY id`,
		);
		const importing = isImporting(core.sql);
		const defaultBranch = identity.defaultBranch;
		const indexRefs = rows<{ ref: string }>(core.sql, "SELECT ref FROM refs")
			.map((row) => row.ref);
		const laneRefs = rows<{ ref: string }>(
			core.sql,
			`SELECT ref FROM lanes WHERE mode = 'branch' AND state IN (${LIVE_SQL})`,
		).map((row) => row.ref);
		return {
			caller: { kind: principal.kind, writeCredential: credential },
			ownLanes: own.map((lane) => ({
				laneId: lane.id,
				mode: lane.mode,
				ref: lane.ref,
				state: lane.state,
				headSha: lane.head_sha,
				resumable: isResumable(lane, now),
				leased: leased.has(lane.id),
			})),
			...(targetLane !== null
				? {
					target: {
						laneId: targetLane.id,
						mode: targetLane.mode,
						state: targetLane.state,
						owner: targetLane.owner_principal,
						delegates: delegatesOf(targetLane),
						headSha: targetLane.head_sha,
						quarantined: targetLane.quarantined === 1,
						resumable: isResumable(targetLane, now),
						leased: leased.has(targetLane.id),
					},
				}
				: {}),
			adopted: adopted.map((lane) => ({
				ref: lane.ref,
				owner: lane.owner_principal,
				delegates: delegatesOf(lane),
			})),
			protectedPatterns: importing
				? []
				: [...new Set([trunkRef(defaultBranch), ...protection.patterns()])],
			defaultBranch,
			caseFoldedRefs: [
				...new Set([...indexRefs, ...laneRefs].map((ref) => ref.toLowerCase())),
			],
			importState: importing ? "importing" : "none",
			landingPaused: getMeta(core.sql, "landing_paused") === "1",
		};
	};

	const readContext = (
		principal: AuthContext | "anon",
	): Promise<ReadContext> => {
		repoIdentity(core.sql);
		const visible = rows<{ ref: string; sha: string; peeled: string | null }>(
			core.sql,
			"SELECT ref, sha, peeled FROM refs ORDER BY ref",
		).filter((row) => !isHiddenRef(row.ref));
		const visibleTips = new Set<string>();
		for (const row of visible) {
			visibleTips.add(row.sha);
			if (row.peeled !== null) visibleTips.add(row.peeled);
		}
		const recentTips = new Set<string>();
		for (
			const row of rows<{ ref: string; before: string; after: string }>(
				core.sql,
				`SELECT ref, before, after FROM pushes WHERE repo_name IS NULL AND at >= ?`,
				core.clock.now() - RECENT_TIP_WINDOW_MS,
			)
		) {
			if (isHiddenRef(row.ref)) continue;
			for (const sha of [row.before, row.after]) {
				if (sha !== ZERO_SHA) recentTips.add(sha);
			}
		}
		const ownLanes = principal === "anon"
			? []
			: lanesOwnedOrDelegated(core.sql, principal.principal, ACTIVE)
				.filter((lane) => lane.mode === "branch")
				.filter((lane) =>
					principal.laneId === null || lane.id === principal.laneId
				)
				.map((lane) => ({
					laneId: lane.id,
					ref: lane.ref,
					headSha: lane.head_sha,
				}));
		return Promise.resolve({
			view: principal === "anon" ? "public" : "member",
			visibleTips: [...visibleTips],
			recentTips: [...recentTips],
			ownLanes,
		});
	};

	return { pushContext, readContext };
};
