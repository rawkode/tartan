// Capability state (WP5b): what the capability route
// asks RepoDO, always AFTER the isolate
// verified the path's syntax, TTL and MAC.
//
// - `capContext` reads (no side effect) what one nonce serves.
// - `capUse` is the atomic gate: the lane is `opening` on an `import`
//   attempt whose `cap_nonce` is this nonce; `info` (GET `info/refs` or a v2
//   `ls-refs`) counts against `CAP_INFO_USES_MAX`, `pack` (the request that
//   carries the want) consumes the nonce, so a second pack request and every
//   later `info` are refused.
// - `capReport` records the route's outcome on the nonce (the seeder
//   classifies a failed import from it) and, for a served pack, the
//   `trunk_pack_bytes` measurement; an unexplained upstream tip behind a
//   `trunk-moved` answer parks a K1 observation.

import { invalid, isIdOf, isSha } from "@tartan/contract";
import type {
	CapContext,
	CapOutcome,
	CapReport,
	CapUse,
	LaneRow,
} from "@tartan/contract/kernel.ts";
import {
	CAP_INFO_USES_MAX,
	LANE_CAP_PIN_BASE,
	LANE_IMPORT_MAX_BYTES,
} from "../../../../constants.ts";
import { setMeta } from "../../core.ts";
import { indexSha } from "../../refs.ts";
import {
	type Ctx,
	explainedTips,
	identity,
	lane as laneOf,
	trunkOf,
} from "./context.ts";

const NONCE_RE = /^[0-9a-f]{32}$/;
const OUTCOMES: readonly CapOutcome[] = [
	"served",
	"trunk-moved",
	"aborted",
	"upstream-error",
];

const validate = (laneId: string, nonce: string): void => {
	if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
	if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
		throw invalid("capability nonce must be 32 lowercase hex chars");
	}
};

/** The lane serves this nonce: `opening`, `repo`, an `import` attempt, the current nonce. */
const serving = (row: LaneRow | null, nonce: string): row is LaneRow =>
	row !== null && row.state === "opening" && row.mode === "repo" &&
	row.seed === "import" && row.cap_nonce === nonce;

const contextOf = (ctx: Ctx, row: LaneRow, nonce: string): CapContext => {
	const id = identity(ctx);
	return {
		repoId: id.repoId,
		laneId: row.id,
		nonce,
		attempt: row.seed_attempt,
		base: row.base_sha,
		defaultBranch: id.defaultBranch,
		pinBase: LANE_CAP_PIN_BASE,
		explainedTips: explainedTips(ctx),
	};
};

/** Records a measured trunk pack: a fitting measurement clears the size flag. */
export const recordPackMeasurement = (ctx: Ctx, bytes: number): void => {
	if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
	setMeta(ctx.sql, "trunk_pack_bytes", bytes);
	setMeta(ctx.sql, "trunk_pack_measured_at", ctx.now());
	if (bytes <= LANE_IMPORT_MAX_BYTES) {
		setMeta(ctx.sql, "import_too_large_until", null);
	}
};

export const createCapState = (ctx: Ctx) => {
	const capContext = async (
		laneId: string,
		nonce: string,
	): Promise<CapContext | null> => {
		validate(laneId, nonce);
		identity(ctx);
		const row = laneOf(ctx, laneId);
		return await Promise.resolve(
			serving(row, nonce) && row.cap_consumed_at === null
				? contextOf(ctx, row, nonce)
				: null,
		);
	};

	const capUse = async (
		laneId: string,
		nonce: string,
		op: "info" | "pack",
	): Promise<CapUse> => {
		validate(laneId, nonce);
		if (op !== "info" && op !== "pack") throw invalid(`unknown op: ${op}`);
		identity(ctx);
		const result = ctx.tx((): CapUse => {
			const row = laneOf(ctx, laneId);
			if (row === null) return { ok: false, reason: "unknown" };
			if (!serving(row, nonce)) {
				return {
					ok: false,
					reason: (row as LaneRow).state === "opening"
						? "unknown"
						: "not-opening",
				};
			}
			if (row.cap_consumed_at !== null) {
				return { ok: false, reason: "consumed" };
			}
			if (op === "info") {
				if (row.cap_uses >= CAP_INFO_USES_MAX) {
					return { ok: false, reason: "uses-exceeded" };
				}
				const updated = ctx.sql.exec(
					`UPDATE lanes SET cap_uses = cap_uses + 1 WHERE id = ? AND cap_nonce = ?
					 AND state = 'opening' AND cap_consumed_at IS NULL AND cap_uses < ?
					 RETURNING id`,
					laneId,
					nonce,
					CAP_INFO_USES_MAX,
				).toArray();
				if (updated.length === 0) return { ok: false, reason: "uses-exceeded" };
			} else {
				const updated = ctx.sql.exec(
					`UPDATE lanes SET cap_consumed_at = ? WHERE id = ? AND cap_nonce = ?
					 AND state = 'opening' AND cap_consumed_at IS NULL RETURNING id`,
					ctx.now(),
					laneId,
					nonce,
				).toArray();
				if (updated.length === 0) return { ok: false, reason: "consumed" };
			}
			return {
				ok: true,
				ctx: contextOf(ctx, laneOf(ctx, laneId) as LaneRow, nonce),
			};
		});
		if (!result.ok) {
			ctx.ports.log("capability refused", {
				laneId,
				op,
				reason: result.reason,
			});
		}
		return await Promise.resolve(result);
	};

	const capReport = async (
		laneId: string,
		nonce: string,
		report: CapReport,
	): Promise<void> => {
		validate(laneId, nonce);
		if (
			report === null || typeof report !== "object" ||
			(report.op !== "info" && report.op !== "pack") ||
			!OUTCOMES.includes(report.outcome)
		) {
			throw invalid("invalid capability report");
		}
		if (
			report.bytes !== undefined &&
			(!Number.isSafeInteger(report.bytes) || report.bytes < 0)
		) {
			throw invalid("bytes must be a non-negative integer");
		}
		if (report.upstreamTip !== undefined && !isSha(report.upstreamTip)) {
			throw invalid("upstreamTip must be a sha");
		}
		identity(ctx);
		ctx.tx(() => {
			const row = laneOf(ctx, laneId);
			if (
				report.op === "pack" && report.outcome === "served" &&
				report.bytes !== undefined
			) {
				// A served pack measures trunk, whichever attempt it was for.
				recordPackMeasurement(ctx, report.bytes);
			}
			if (row !== null && row.cap_nonce === nonce) {
				ctx.sql.exec(
					"UPDATE lanes SET cap_outcome = ? WHERE id = ? AND cap_nonce = ?",
					report.outcome,
					laneId,
					nonce,
				);
			}
			if (
				report.outcome === "trunk-moved" && report.upstreamTip !== undefined
			) {
				const ref = trunkOf(ctx);
				const indexed = indexSha(ctx.sql, ref);
				const internal = ctx.deps.core.internal;
				if (
					report.upstreamTip !== indexed &&
					!internal.explainsSync(ref, report.upstreamTip)
				) {
					// An unexplained upstream tip is a K1 observation.
					internal.observeSync({
						target: "repo",
						repoName: null,
						ref,
						before: indexed,
						after: report.upstreamTip,
					});
				}
			}
		});
		return await Promise.resolve();
	};

	return { capContext, capUse, capReport };
};
