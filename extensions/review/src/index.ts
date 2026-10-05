// tartan.review: the `review@1` provider, review by exception. See `review.ts`
// for the behaviour: risk routing from policy at the change's base on trunk
// (K13), auto approvals bound to the reviewed head (K4), human decisions only
// from users, the `human-required` mode's `ref.advance` gate, and the track
// record. Tools `review_get`, `review_decide`, `review_queue`; slots
// `change.panel` evidence and `home.section` attention; `context@1` rules.

import {
	type ContextRequest,
	type ContextSection,
	type ExtCtx,
	invalid,
	REVIEW_TOOLS,
	type UiDoc,
} from "@tartan/contract";
import { defineExtension, result, ui } from "@tartan/ext-api";
import { createRuleIndex } from "./owners.ts";
import { createReviewer } from "./review.ts";
import { renderAttention, renderEvidence } from "./ui.ts";

export { migrations } from "./migrations.ts";
export { settingsCue } from "./settings-cue.ts";
/** Protocol card (`contributes.protocol`); none yet. */
export const protocol: string | undefined = undefined;

const reviewRulesContext = (
	req: ContextRequest,
	x: ExtCtx,
): ContextSection[] => {
	const reviewer = createReviewer(x);
	const { sha, rules } = reviewer.cachedRules();
	const index = createRuleIndex(rules);
	const paths = req.paths ?? [];
	const matched = paths.length === 0
		? rules.filter((r) => r.sensitivity > 0).slice(0, 12)
		: [...new Set(paths.flatMap((p) => index.matching(p)))].slice(0, 12);
	const mode = reviewer.config.mode;
	const lines = [
		mode === "human-required"
			? "Review: every change needs a human (Maintainer+) approval of its latest head."
			: `Review by exception: changes under risk ${reviewer.config.autoThreshold} are approved automatically once checks pass.`,
		"Always routed to a human: changes to root `*.cue` files (Tartan config) or to test scripts, deleted test files, fewer test lines.",
		...(matched.length > 0
			? [
				`Sensitive paths${
					sha ? ` (owners rules on trunk at ${sha.slice(0, 7)})` : ""
				}:`,
				...matched.map((r) =>
					`- \`${r.glob}\`: sensitivity ${r.sensitivity}/3${
						r.owners.length > 0 ? `, owners ${r.owners.join(", ")}` : ""
					}`
				),
			]
			: []),
	];
	let md = lines.join("\n");
	if (new TextEncoder().encode(md).length > req.maxBytes) {
		md = md.slice(0, Math.max(0, req.maxBytes - 2)) + " …";
	}
	return [{
		id: "review-rules",
		title: "Review rules",
		priority: "ownership",
		md,
	}];
};

export const extension = defineExtension({
	onEvent: async (ev, x) => {
		const reviewer = createReviewer(x);
		reviewer.useRepo(ev.repo);
		if (ev.type === "changes.submitted" || ev.type === "changes.revised") {
			return reviewer.onChange(ev);
		}
		if (ev.type === "checks.completed") {
			return await reviewer.onChecksCompleted(ev);
		}
		if (ev.type === "repo.config.resolved") {
			return await reviewer.onConfigResolved(ev);
		}
		if (ev.type.startsWith("conflicts.")) return reviewer.onConflict(ev);
		if (
			ev.type === "queue.ejected" || ev.type === "land.vetoed" ||
			ev.type === "ref.advanced"
		) {
			return reviewer.onTrack(ev);
		}
	},
	gate: (point, input, x) => {
		const reviewer = createReviewer(x);
		return Promise.resolve(
			point === "ref.advance"
				? reviewer.gate(input)
				: { decision: "allow", message: "not a review gate point" },
		);
	},
	render: (slot, ctx, _props, x): Promise<UiDoc> => {
		const reviewer = createReviewer(x);
		reviewer.useRepo(ctx.repo);
		switch (slot) {
			case "evidence":
				return Promise.resolve(renderEvidence(reviewer, ctx, x));
			case "attention":
				return Promise.resolve(renderAttention(reviewer, ctx, x));
			default:
				return Promise.resolve(ui.doc(ui.empty(`unknown slot ${slot}`)));
		}
	},
	onAction: async (action, payload, ctx, x) => {
		if (action !== "approve" && action !== "request_changes") {
			throw invalid(`unknown action ${action}`);
		}
		const p = (payload ?? {}) as { changeId?: unknown; revision?: unknown };
		if (typeof p.changeId !== "string") throw invalid("changeId required");
		const reviewer = createReviewer(x);
		reviewer.useRepo(ctx.repo);
		await reviewer.decide({
			changeId: p.changeId,
			decision: action,
			...(typeof p.revision === "number" ? { revision: p.revision } : {}),
		});
		return result.toast(
			"success",
			action === "approve" ? "Approved" : "Changes requested",
		);
	},
	callTool: async (name, args, ctx, x) => {
		const reviewer = createReviewer(x);
		reviewer.useRepo(ctx.repo);
		if (name === "review_get") {
			const p = REVIEW_TOOLS.review_get.input.safeParse(args);
			if (!p.success) throw invalid("review_get: invalid arguments");
			return reviewer.get((p.data as { changeId: string }).changeId);
		}
		if (name === "review_decide") {
			const p = REVIEW_TOOLS.review_decide.input.safeParse(args);
			if (!p.success) throw invalid("review_decide: invalid arguments");
			return await reviewer.decide(
				p.data as {
					changeId: string;
					decision: "approve" | "request_changes";
					revision?: number;
					note?: string;
				},
			);
		}
		if (name === "review_queue") {
			const p = REVIEW_TOOLS.review_queue.input.safeParse(args);
			if (!p.success) throw invalid("review_queue: invalid arguments");
			return {
				reviews: reviewer.queue((p.data as { mine?: boolean }).mine === true),
			};
		}
		throw invalid(`tartan.review has no tool ${name}`);
	},
	context: (req, x) => Promise.resolve(reviewRulesContext(req, x)),
});

export default extension;
