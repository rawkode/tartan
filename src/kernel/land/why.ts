// Why notes from RepoDO state (K4, K15): `whyNote` builds the note LandWorkflow
// writes into `refs/notes/tartan` (`restack-n`) and the repair job re-writes;
// `why` answers for a landed commit (or the newest landing that touched a path)
// with the RepoDO copy of the note and the reason events (the RepoDO copy
// answers first for speed; git notes are the truth).

import {
	changeRef,
	type Envelope,
	invalid,
	isSha,
	notFound,
	type WhyNote,
	type WhyNoteKernel,
} from "@tartan/contract";
import type {
	LandingRow,
	LandVerdictRow,
	NoteSectionRow,
} from "@tartan/contract/kernel.ts";
import {
	first,
	type LandCtx,
	parseJson,
	requireAdvance,
	requireBatch,
	rows,
} from "./ctx.ts";
import { buildWhyNote } from "./notes.ts";
import type { LandChangeRow } from "./types.ts";

const ZERO_CHAIN = "0".repeat(64);

export const createWhy = (ctx: LandCtx) => {
	const whyNote = (advanceId: string, changeId: string): WhyNote => {
		const adv = requireAdvance(ctx, String(advanceId));
		const batch = requireBatch(ctx, adv.batch_id);
		const change = first<LandChangeRow>(
			ctx.sql,
			"SELECT * FROM land_changes WHERE batch_id = ? AND change_id = ?",
			batch.id,
			String(changeId),
		);
		if (change === null) {
			throw notFound(`change ${changeId} is not in batch ${batch.id}`);
		}
		const lane = ctx.core.laneSync(change.lane_id);
		if (lane === null) throw notFound(`lane ${change.lane_id} is gone`);
		const provenance = parseJson<{
			firstPushers?: { principal: string; commits: number }[];
			provenance?: "complete" | "partial";
		}>(change.provenance_json, {});
		const gates = parseJson<WhyNoteKernel["gates"]>(change.gates_json, []);
		const verdict = first<LandVerdictRow>(
			ctx.sql,
			"SELECT * FROM land_verdicts WHERE batch_id = ? AND attempt = ?",
			batch.id,
			adv.attempt,
		);
		const reason = parseJson<{ summary?: string; events?: string[] }>(
			batch.reason_json,
			{},
		);
		const kernel: WhyNoteKernel = {
			advance: adv.id,
			ref: adv.ref,
			batch: batch.id,
			landedBy: batch.requested_by,
			actor: lane.owner_principal,
			...(lane.on_behalf_of !== null ? { onBehalfOf: lane.on_behalf_of } : {}),
			change: change.change_id,
			lane: lane.id,
			laneHead: change.head,
			laneMode: lane.mode,
			laneHeadRef: changeRef(change.change_id),
			rangeBase: lane.base_sha,
			firstPushers: provenance.firstPushers ?? [],
			provenance: provenance.provenance ?? "partial",
			reason: {
				summary: reason.summary ?? "",
				events: [...new Set(reason.events ?? [])],
			},
			gates,
			checks: batch.test_policy === "none"
				? { state: "skipped", runs: [], evidenceReused: false }
				: {
					state: verdict?.state ?? "failure",
					runs: parseJson<string[]>(verdict?.run_ids_json ?? null, []),
					evidenceReused: adv.evidence_reused === 1,
				},
			chain: {
				seq: adv.chain_seq ?? 0,
				head: adv.chain_head ?? ZERO_CHAIN,
			},
		};
		const sections = rows<NoteSectionRow>(
			ctx.sql,
			"SELECT * FROM note_sections WHERE change_id = ? ORDER BY ext_id",
			change.change_id,
		).map((s) => ({ extId: s.ext_id, json: s.section_json }));
		return buildWhyNote(kernel, sections);
	};

	const why = (
		query: { sha?: string; path?: string; line?: number },
	): { commit: string; note: WhyNote | null; events: Envelope[] } | null => {
		const q = query ?? {};
		let landing: LandingRow | null = null;
		if (typeof q.sha === "string" && q.sha.length > 0) {
			const sha = q.sha.toLowerCase();
			if (!/^[0-9a-f]{7,40}$/.test(sha)) throw invalid("sha: 7–40 hex chars");
			landing = isSha(sha)
				? first<LandingRow>(
					ctx.sql,
					"SELECT * FROM landings WHERE commit_sha = ?",
					sha,
				)
				: first<LandingRow>(
					ctx.sql,
					`SELECT * FROM landings WHERE commit_sha >= ? AND commit_sha < ?
					 ORDER BY commit_sha LIMIT 1`,
					sha,
					`${sha}g`,
				);
		} else if (typeof q.path === "string" && q.path.length > 0) {
			if (q.path.length > 4096) throw invalid("path is too long");
			landing = first<LandingRow>(
				ctx.sql,
				`SELECT * FROM landings WHERE EXISTS (
				   SELECT 1 FROM json_each(landings.paths_json) WHERE value = ?)
				 ORDER BY trunk_seq DESC LIMIT 1`,
				q.path,
			);
		} else {
			throw invalid("why needs sha or path");
		}
		if (landing === null) return null;
		let note: WhyNote | null = null;
		try {
			note = whyNote(landing.advance_id, landing.change_id);
		} catch {
			note = null;
		}
		const events = note === null
			? []
			: ctx.events.getSync(note.kernel.reason.events.slice(0, 256));
		return { commit: landing.commit_sha, note, events };
	};

	return { whyNote, why };
};

export type Why = ReturnType<typeof createWhy>;
