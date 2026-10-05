// Slots: `lane.badge` (the lane's worst open conflict),
// `file.banner` ("N lanes are editing this file"), `change.sidebar` (the
// change's lane conflicts, with acknowledge actions), `repo.tab` (stats and
// open conflicts; the lanes × lanes matrix is M2) and `hud.metric`
// (conflicts avoided). Read-only renders; `onAction` acknowledges.

import type {
	ActionResult,
	Actor,
	ExtCtx,
	SlotContext,
	Tone,
	UiDoc,
	UiNode,
} from "@tartan/contract";
import { action, type Db, db, result, ui } from "@tartan/ext-api";
import { textEnv } from "./facts.ts";
import {
	ACTIVE_SQL,
	type ConflictRow,
	isCounted,
	type LaneRow,
	MAX_LIST,
	SEVERITY_RANK,
	TRUNK,
} from "./model.ts";
import {
	getLanes,
	getStats,
	laneByChange,
	lanesTouching,
	latestRoots,
	liveConflictsOf,
} from "./store.ts";
import {
	clean,
	laneLabel,
	ownerLabel,
	sideOf,
	suggestionText,
} from "./texts.ts";
import { ackConflict } from "./tools.ts";
import type { ConflictResolution, ConflictSeverity } from "./types.ts";
import { lanesDeclaring } from "./view.ts";

const REFRESH = ["conflicts.*"];

export const toneOf = (s: ConflictSeverity): Tone =>
	s === "textual" || s === "semantic"
		? "danger"
		: s === "same_file" || s === "adjacent" || s === "trunk_drift"
		? "warning"
		: "info";

const worst = (rows: readonly ConflictRow[]): ConflictRow | null =>
	rows.reduce<ConflictRow | null>(
		(w, r) =>
			w === null || SEVERITY_RANK[r.severity] > SEVERITY_RANK[w.severity]
				? r
				: w,
		null,
	);

const RESOLUTIONS: readonly ConflictResolution[] = [
	"coordinate",
	"rebase",
	"stack",
	"adapt",
	"yield",
	"ignore",
];

const conflictRow = (
	d: Db,
	x: ExtCtx,
	c: ConflictRow,
	from: string,
	lanes: Map<string, LaneRow>,
	withActions: boolean,
): UiNode => {
	const otherId = sideOf(c, from);
	const other = otherId === TRUNK ? null : lanes.get(otherId) ?? null;
	const children: UiNode[] = [
		ui.row([
			ui.badge(c.severity, toneOf(c.severity)),
			ui.text(c.path, { mono: true }),
		], { gap: 1 }),
		ui.text(`⟷ ${other ? laneLabel(other) : "trunk"}`, { tone: "muted" }),
		ui.text(
			`suggestion: ${suggestionText(c.suggestion, other, textEnv(x, d))}`,
		),
	];
	if (withActions && c.state === "open") {
		children.push(
			ui.menu(
				"Acknowledge",
				RESOLUTIONS.map((r) => ({
					text: r,
					action: action("ack", { conflictId: c.id, resolution: r }),
				})),
			),
		);
	} else if (c.state === "acked") {
		children.push(ui.badge("acked", "muted"));
	}
	return ui.card(children, { gap: 1 });
};

const laneBadge = (d: Db, laneId: string | undefined): UiDoc => {
	if (!laneId) return ui.doc(ui.stack([]));
	const live = liveConflictsOf(d, laneId).filter((c) => c.state === "open");
	const top = worst(live);
	if (top === null) {
		return ui.doc(ui.badge("radar: clear", "success"), { refreshOn: REFRESH });
	}
	const n = live.filter((c) => c.severity === top.severity).length;
	return ui.doc(
		ui.badge(
			`${top.severity.replace("_", " ")}${n > 1 ? ` ×${n}` : ""}`,
			toneOf(top.severity),
		),
		{ refreshOn: REFRESH },
	);
};

const fileBanner = (d: Db, path: string | undefined): UiDoc => {
	if (!path) return ui.doc(ui.stack([]));
	const editing = lanesTouching(d, path);
	const declared = lanesDeclaring(d, path, latestRoots(d)).filter((l) =>
		!editing.some((e) => e.lane_id === l.lane_id)
	);
	if (editing.length === 0 && declared.length === 0) {
		return ui.doc(ui.stack([]), { refreshOn: [...REFRESH, "push.diffed"] });
	}
	const items = [
		...editing.map((h) => ui.text(`${laneLabel(h)} edits this file`)),
		...declared.map((h) =>
			ui.text(`${laneLabel(h)} declared a footprint over it`, {
				tone: "muted",
			})
		),
	];
	const title = editing.length > 0
		? `${editing.length} lane${
			editing.length === 1 ? " is" : "s are"
		} editing this file`
		: `${declared.length} lane${
			declared.length === 1 ? "" : "s"
		} declared this area`;
	return ui.doc(
		ui.alert(editing.length > 1 ? "warning" : "info", title, ui.list(items)),
		{ refreshOn: [...REFRESH, "push.diffed"] },
	);
};

const changeSidebar = (
	d: Db,
	x: ExtCtx,
	changeId: string | undefined,
): UiDoc => {
	const lane = changeId ? laneByChange(d, changeId) : null;
	if (lane === null) {
		return ui.doc(ui.empty("No conflicts known for this change"));
	}
	const live = liveConflictsOf(d, lane.lane_id).sort((a, b) =>
		SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
	);
	if (live.length === 0) {
		return ui.doc(
			ui.section("Conflicts", [ui.badge("radar: clear", "success")]),
			{ refreshOn: REFRESH },
		);
	}
	const lanes = getLanes(
		d,
		live.map((c) => sideOf(c, lane.lane_id)).filter((s) => s !== TRUNK),
	);
	return ui.doc(
		ui.section(
			"Conflicts",
			live.slice(0, 20).map((c) =>
				conflictRow(d, x, c, lane.lane_id, lanes, true)
			),
		),
		{ refreshOn: REFRESH },
	);
};

const repoTab = (d: Db): UiDoc => {
	const stats = getStats(d);
	const live = d.all<ConflictRow>(
		`SELECT * FROM conflicts WHERE state <> 'cleared' ORDER BY last_seen DESC LIMIT ?`,
		MAX_LIST,
	).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
	const active = d.value<number>(
		`SELECT COUNT(*) FROM lanes WHERE state IN ${ACTIVE_SQL}`,
	) ?? 0;
	const lanes = getLanes(
		d,
		[...new Set(live.flatMap((c) => [c.a, c.b]).filter((s) => s !== TRUNK))],
	);
	const name = (id: string) => {
		const l = lanes.get(id);
		return id === TRUNK ? "trunk" : l ? `${id} (${ownerLabel(l)})` : id;
	};
	const header = ui.grid([
		ui.stat("Active lanes", active),
		ui.stat("Open conflicts", live.filter((c) => isCounted(c.severity)).length),
		ui.stat("Predicted", stats.predicted),
		ui.stat("Avoided", stats.avoided),
		ui.stat("Materialized", stats.materialized),
	], { cols: 5 });
	const body = live.length === 0
		? ui.empty(
			"No open conflicts",
			"Radar compares every active lane's touches and footprint.",
		)
		: ui.table(
			["Severity", "Path", "Lane", "Other", "Suggestion", "State"],
			live.map((c) => [
				ui.badge(c.severity, toneOf(c.severity)),
				clean(c.path, 200),
				name(c.a),
				name(c.b),
				c.suggestion,
				c.state,
			]),
		);
	return ui.doc(ui.stack([ui.heading("Conflict radar", 2), header, body]), {
		refreshOn: [...REFRESH, "push.diffed", "lane.*"],
	});
};

const hudMetric = (d: Db): UiDoc =>
	ui.doc(ui.stat("Conflicts avoided", getStats(d).avoided), {
		refreshOn: REFRESH,
	});

export const render = (
	slot: string,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<UiDoc> => {
	const d = db(x.sql);
	switch (slot) {
		case "severity":
			return Promise.resolve(
				laneBadge(d, ctx.entity?.kind === "lane" ? ctx.entity.id : undefined),
			);
		case "editing":
			return Promise.resolve(fileBanner(d, ctx.path));
		case "conflicts":
			return Promise.resolve(changeSidebar(
				d,
				x,
				ctx.entity?.kind === "change" ? ctx.entity.id : undefined,
			));
		case "radar":
			return Promise.resolve(repoTab(d));
		case "conflicts-avoided":
			return Promise.resolve(hudMetric(d));
		default:
			return Promise.resolve(
				ui.doc(ui.empty(`radar: no slot ${clean(slot, 40)}`)),
			);
	}
};

export const onAction = async (
	name: string,
	payload: unknown,
	ctx: SlotContext,
	x: ExtCtx,
): Promise<ActionResult> => {
	if (name !== "ack") {
		return result.toast("danger", `Unknown action ${clean(name, 40)}`);
	}
	const p = (payload ?? {}) as { conflictId?: unknown; resolution?: unknown };
	if (
		typeof p.conflictId !== "string" ||
		!RESOLUTIONS.includes(p.resolution as ConflictResolution)
	) {
		return result.toast("danger", "Choose a conflict and a resolution");
	}
	const actor: Actor = x.actor;
	await ackConflict(
		{
			conflictId: p.conflictId,
			resolution: p.resolution as ConflictResolution,
		},
		actor,
		ctx.repo,
		x,
	);
	return {
		v: 1,
		toast: { tone: "success", text: `Acknowledged: ${p.resolution}` },
		refresh: ["conflicts", "severity"],
	};
};
