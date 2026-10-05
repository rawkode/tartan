// tartan.review slots: the `change.panel` evidence
// bundle (route, risk factors, forced reasons, CI, decision, approve /
// request-changes buttons) and the `home.section` attention inbox. Read-only
// renders over the extension's own tables; every string is text.
// The AI summary of the evidence bundle is M2.

import type {
	ExtCtx,
	SlotContext,
	Tone,
	UiDoc,
	UiNode,
} from "@tartan/contract";
import { ui } from "@tartan/ext-api";
import type { Reviewer } from "./review.ts";
import { RISK_FACTORS } from "./risk.ts";

const FACTOR_LABEL: Readonly<Record<string, string>> = {
	sensitive: "Path sensitivity",
	blastRadius: "Blast radius",
	size: "Size",
	weakenedTests: "Weakened tests",
	radar: "Conflicts",
	trackRecord: "Track record",
};

const REASON_LABEL: Readonly<Record<string, string>> = {
	"policy-file": "changes a policy file (a root .cue file or a test script)",
	"weakened-tests": "weakens tests",
	"owners-invalid": "tartan config on trunk does not evaluate (owners rules)",
	"config-pending": "tartan config on trunk is still evaluating",
	"truncated-diff": "the diff was too large to assess",
	"human-required": "human-required mode",
};

const routeTone = (route: string, decision: string | undefined): Tone =>
	decision === "approve"
		? "success"
		: decision === "request_changes"
		? "danger"
		: route === "human"
		? "warning"
		: "info";

export const renderEvidence = (
	reviewer: Reviewer,
	ctx: SlotContext,
	_x: ExtCtx,
): UiDoc => {
	const refresh = { refreshOn: ["review.*", "checks.*"] };
	if (ctx.entity?.kind !== "change") {
		return ui.doc(ui.empty("Review evidence appears on a change"), refresh);
	}
	let review;
	try {
		review = reviewer.get(ctx.entity.id);
	} catch {
		return ui.doc(
			ui.empty("Not under review yet", "Review starts when checks complete."),
			refresh,
		);
	}
	const ev = (review.evidence ?? {}) as {
		reasons?: string[];
		policyFiles?: string[];
		weakened?: {
			deletedTests?: string[];
			netTestLines?: number;
			scripts?: string[];
		};
		affected?: string[];
		global?: boolean;
		ci?: string;
		pending?: string;
		failing?: string[];
		note?: string;
	};
	const decided = review.decision
		? `${review.decision === "approve" ? "approved" : "changes requested"} by ${
			review.decidedBy?.kind === "user" ? review.decidedBy.id : "the reviewer"
		}`
		: review.route === "human"
		? "waiting for a human"
		: "pending";
	const factorRows = RISK_FACTORS.filter((f) => f in review.factors).map((
		f,
	) => [
		FACTOR_LABEL[f] ?? f,
		ui.progress(Math.round((review.factors[f] ?? 0) * 100), 100),
	]);
	const reasons: UiNode[] = (ev.reasons ?? []).map((r) =>
		ui.text(`• ${REASON_LABEL[r] ?? r}`, { tone: "warning" })
	);
	const details: UiNode[] = [
		...(ev.policyFiles?.length
			? [ui.kv([{ k: "Policy files", v: ev.policyFiles.join(", ") }])]
			: []),
		...(ev.weakened &&
				(ev.weakened.deletedTests?.length ||
					(ev.weakened.netTestLines ?? 0) < 0)
			? [
				ui.kv([
					{
						k: "Tests",
						v: `${ev.weakened.deletedTests?.length ?? 0} deleted, net ${
							ev.weakened.netTestLines ?? 0
						} lines`,
					},
				]),
			]
			: []),
		...(ev.affected
			? [
				ui.kv([{
					k: "Affected",
					v: ev.global
						? "all projects (global change)"
						: ev.affected.join(", ") || "none",
				}]),
			]
			: []),
		...(ev.ci ? [ui.kv([{ k: "Checks", v: ev.ci }])] : []),
		...(ev.failing?.length
			? [ui.kv([{ k: "Failing", v: ev.failing.join(", ") }])]
			: []),
		...(ev.note ? [ui.kv([{ k: "Note", v: ev.note }])] : []),
	];
	const canDecide = review.decidedBy?.kind !== "user";
	return ui.doc(
		ui.stack([
			ui.row([
				ui.heading(`Review r${review.revision}`, 3),
				ui.badge(
					`${review.route} · ${decided}`,
					routeTone(review.route, review.decision),
				),
				ui.stat("Risk", Math.round(review.risk * 100), { unit: "%" }),
			]),
			...(ev.pending ? [ui.text(ev.pending, { tone: "muted" })] : []),
			...reasons,
			...(factorRows.length > 0
				? [ui.table(["Factor", "Score"], factorRows)]
				: []),
			...details,
			...(canDecide
				? [
					ui.row([
						ui.button(
							"Approve",
							ui.action("approve", {
								changeId: review.changeId,
								revision: review.revision,
							}),
							"success",
						),
						ui.button(
							"Request changes",
							ui.action("request_changes", {
								changeId: review.changeId,
								revision: review.revision,
							}),
							"danger",
						),
					]),
				]
				: []),
		], { gap: 2 }),
		refresh,
	);
};

export const renderAttention = (
	reviewer: Reviewer,
	ctx: SlotContext,
	x: ExtCtx,
): UiDoc => {
	const refresh = { refreshOn: ["review.*"] };
	const viewer = ctx.viewer ?? x.actor;
	const waiting = reviewer.queue(false);
	const mine = new Set(reviewer.store.attentionFor(viewer.id));
	const rows = waiting.filter((r) =>
		mine.has(r.changeId) || r.attentionSet.length === 0
	);
	if (rows.length === 0) {
		return ui.doc(ui.empty("Nothing needs your review"), refresh);
	}
	return ui.doc(
		ui.section(`${rows.length} for you`, [
			ui.table(
				["Change", "Revision", "Risk"],
				rows.map((r) => [
					ui.text(r.changeId.slice(0, 12), { mono: true }),
					`r${r.revision}`,
					`${Math.round(r.risk * 100)}%`,
				]),
			),
		]),
		refresh,
	);
};
