// tartan.ci slots: `change.sidebar` checks, the `repo.tab` CI (its own route,
// beside the kernel Runs view) and the `repo.sidebar` project status. Renders
// are read-only: SELECTs on the extension's own tables and `repo.info` for
// link paths; every string is shown as text.

import type {
	ExtCtx,
	SlotContext,
	Tone,
	UiDoc,
	UiNode,
} from "@tartan/contract";
import { ui } from "@tartan/ext-api";
import type { Ci } from "./ci.ts";
import type { CheckState, PlanRow, PlanState } from "./store.ts";

const TONE: Readonly<Record<CheckState | PlanState, Tone>> = {
	pending: "muted",
	waiting: "muted",
	planned: "muted",
	running: "info",
	success: "success",
	cached: "success",
	failure: "danger",
	cancelled: "warning",
	superseded: "muted",
	skipped: "muted",
};

const badge = (state: CheckState | PlanState): UiNode =>
	ui.badge(state, TONE[state]);

const short = (sha: string): string => sha.slice(0, 7);

/** The repo's path for same-origin links (`/<path>/-/…`), or null. */
const repoPath = async (
	x: ExtCtx,
	ctx: SlotContext,
): Promise<string | null> => {
	if (!ctx.repo) return null;
	try {
		return (await x.caps.repo.info({ id: ctx.repo })).path;
	} catch {
		return null;
	}
};

const runLink = (path: string | null, runId: string | null): UiNode =>
	runId === null
		? ui.text("—", { tone: "muted" })
		: path === null
		? ui.text(runId, { mono: true })
		: ui.link(runId, `/${path}/-/runs/${runId}`);

const subjectCell = (path: string | null, p: PlanRow): UiNode => {
	if (p.subjectKind === "change") {
		const label = `change ${p.subjectId.slice(0, 8)}${
			p.revision ? ` r${p.revision}` : ""
		}`;
		return path === null
			? ui.text(label)
			: ui.link(label, `/${path}/-/changes/${p.subjectId}`);
	}
	if (p.subjectKind === "land") {
		return ui.text(`land ${p.subjectId} a${p.attempt ?? "?"}`);
	}
	return ui.text(`push ${p.detail.ref ?? p.subjectId}`);
};

const notes = (p: PlanRow): UiNode[] => [
	...(p.detail.note ? [ui.text(p.detail.note, { tone: "muted" })] : []),
	...(p.detail.errors ?? []).slice(0, 10).map((e) =>
		ui.text(e, { tone: "danger", mono: true })
	),
	ui.text(
		`policy: ${p.detail.policy ?? "?"} at ${
			p.base ? short(p.base) : "?"
		} (trunk)` +
			(p.detail.affected
				? ` · affected: ${
					p.detail.global
						? "all (global change)"
						: p.detail.affected.join(", ") ||
							"none"
				}`
				: ""),
		{ tone: "muted" },
	),
];

export const renderChecks = async (
	ci: Ci,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<UiDoc> => {
	const refresh = { refreshOn: ["checks.*", "run.*", "job.*"] };
	if (ctx.entity?.kind !== "change") {
		return ui.doc(ui.empty("Checks appear on a change"), refresh);
	}
	const { plan, checks } = ci.checksOf({ kind: "change", id: ctx.entity.id });
	if (plan === null) {
		return ui.doc(
			ui.empty("No checks yet", "CI runs when the change is submitted."),
			refresh,
		);
	}
	const path = await repoPath(x, ctx);
	const rows = checks.map((c) => [
		ui.text(c.context, { mono: true }),
		badge(c.state),
		c.cached
			? ui.text("cached", { tone: "muted" })
			: runLink(path, c.runId ?? null),
	]);
	return ui.doc(
		ui.stack([
			ui.row([ui.heading("Checks", 3), badge(plan.state)]),
			ui.text(
				`${short(plan.sha)}${
					plan.revision ? ` · revision ${plan.revision}` : ""
				}`,
				{
					mono: true,
					tone: "muted",
				},
			),
			...(rows.length > 0 ? [ui.table(["Check", "State", "Run"], rows)] : []),
			...notes(plan),
			ui.button(
				"Re-run",
				ui.action(
					"rerun",
					{ changeId: plan.subjectId },
					"Re-run every check without the cache?",
				),
			),
		], { gap: 2 }),
		refresh,
	);
};

export const renderRuns = async (
	ci: Ci,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<UiDoc> => {
	const plans = ci.store.recentPlans(50);
	const refresh = { refreshOn: ["checks.*", "run.*"] };
	if (plans.length === 0) {
		return ui.doc(
			ui.empty(
				"No CI runs yet",
				"Runs appear when changes are submitted or land.",
			),
			refresh,
		);
	}
	const path = await repoPath(x, ctx);
	return ui.doc(
		ui.stack([
			ui.heading("CI runs", 2),
			ui.table(
				["Subject", "Commit", "State", "Jobs", "Run"],
				plans.map((p) => {
					const ran = p.jobs.filter((j) => j.runs).length;
					const cached = p.jobs.length - ran;
					return [
						subjectCell(path, p),
						ui.text(short(p.sha), { mono: true }),
						badge(p.state),
						`${ran} run${cached > 0 ? ` · ${cached} cached` : ""}`,
						runLink(path, p.runId),
					];
				}),
			),
		], { gap: 2 }),
		refresh,
	);
};

export const renderProjects = (ci: Ci): UiDoc => {
	const rows = ci.store.projectStatus();
	const refresh = { refreshOn: ["checks.*"] };
	if (rows.length === 0) {
		return ui.doc(ui.empty("No project checks yet"), refresh);
	}
	return ui.doc(
		ui.section("Projects", [
			ui.table(
				["Project", "Check", "State"],
				rows.map((c) => [
					ui.text(c.project ?? "", { mono: true }),
					ui.text(c.context, { mono: true }),
					badge(c.state),
				]),
			),
		]),
		refresh,
	);
};
