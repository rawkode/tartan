// tartan.hud renders: one `hud.metric` document per counter (a stat, the last
// hour as a sparkline, a note that names what was simulated) and the
// `home.section` "swarm": the same five counters split into real and simulated
// agents. Every number covers the installation's subtree: each repository under
// the node it is installed on. Renders refresh every 5 s (`refreshMs`): a
// node's HUD has no single repo live feed to follow.

import type { ExtCtx, SlotContext, UiDoc, UiNode } from "@tartan/contract";
import { ui } from "@tartan/ext-api";
import { METRIC } from "./fold.ts";
import { createStore, type HudStore, minuteOf } from "./store.ts";

export const REFRESH_MS = 5000;
/** Sparkline window: the last hour, one point per minute. */
export const WINDOW = 60;

export const METRIC_SLOTS = [
	"active-lanes",
	"predicted-conflicts",
	"conflicts-avoided",
	"landed-per-hour",
	"needed-a-human",
] as const;
export type MetricSlot = typeof METRIC_SLOTS[number];

export type MetricView = {
	readonly id: MetricSlot;
	readonly label: string;
	readonly value: number;
	readonly unit?: string;
	readonly delta?: number;
	readonly series: readonly number[];
	readonly note: string;
};

const sum = (values: readonly number[]): number =>
	values.reduce((a, b) => a + b, 0);

const percent = (part: number, whole: number): string =>
	whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;

const simulated = (n: number): string =>
	n === 0 ? "no simulated agents" : `${n} from simulated agents`;

/** The five counters at minute `now` (pure over the store). */
export const metricViews = (
	store: HudStore,
	now: number,
): readonly MetricView[] => {
	const lanes = store.activeLanes();
	const lanesSeries = store.series(METRIC.lanesActive, now, WINDOW, {
		gauge: true,
	});
	const predictedSeries = store.series(METRIC.predicted, now, WINDOW);
	const avoidedSeries = store.series(METRIC.avoided, now, WINDOW);
	const landedSeries = store.series(METRIC.landed, now, WINDOW);
	const landedSim = sum(
		store.series(METRIC.landed, now, WINDOW, { sim: true }),
	);
	const humanSeries = store.series(METRIC.human, now, WINDOW);
	const predicted = store.total(METRIC.predicted);
	const avoided = store.total(METRIC.avoided);
	const reviewed = store.total(METRIC.reviewed);
	const human = store.total(METRIC.human);
	return [
		{
			id: "active-lanes",
			label: "Active lanes",
			value: lanes.total,
			delta: lanes.total - (lanesSeries[0] ?? 0),
			series: lanesSeries,
			note: lanes.sim === 0
				? "every lane is a real agent's"
				: `${lanes.sim} of them simulated agents (swarm)`,
		},
		{
			id: "predicted-conflicts",
			label: "Predicted conflicts",
			value: predicted,
			series: predictedSeries,
			note: `${sum(predictedSeries)} in the last hour; ${
				simulated(store.total(METRIC.predicted, true))
			}`,
		},
		{
			id: "conflicts-avoided",
			label: "Conflicts avoided",
			value: avoided,
			series: avoidedSeries,
			note: `${
				percent(avoided, predicted)
			} of predicted conflicts never reached trunk`,
		},
		{
			id: "landed-per-hour",
			label: "Landed / hour",
			value: sum(landedSeries),
			unit: "changes",
			series: landedSeries,
			note: `${store.total(METRIC.landed)} landed in all; ${
				simulated(landedSim)
			} this hour`,
		},
		{
			id: "needed-a-human",
			label: "Needed a human",
			value: human,
			series: humanSeries,
			note: `${human} of ${reviewed} reviewed changes (${
				percent(human, reviewed)
			}); the rest were reviewed by exception`,
		},
	];
};

/** One counter; `scope` names the subtree it covers (it may sit beside a repo's own metrics). */
const metricNode = (m: MetricView, scope?: string): UiNode =>
	ui.stack([
		ui.stat(m.label, m.value, {
			...(m.delta !== undefined ? { delta: m.delta } : {}),
			...(m.unit !== undefined ? { unit: m.unit } : {}),
		}),
		ui.sparkline(m.series),
		ui.text(m.note, { tone: "muted" }),
		...(scope !== undefined
			? [ui.label(`every repository under ${scope}`, { tone: "muted" })]
			: []),
	], { gap: 1, id: m.id });

export type Split = {
	readonly label: string;
	readonly real: number;
	readonly sim: number;
};

/** Each counter split into real and simulated agents (the swarm). */
export const splitViews = (
	store: HudStore,
	now: number,
): readonly Split[] => {
	const lanes = store.activeLanes();
	const hour = (sim: boolean) =>
		sum(store.series(METRIC.landed, now, WINDOW, { sim }));
	const split = (label: string, all: number, sim: number): Split => ({
		label,
		real: all - sim,
		sim,
	});
	return [
		split("Active lanes", lanes.total, lanes.sim),
		split(
			"Predicted conflicts",
			store.total(METRIC.predicted),
			store.total(METRIC.predicted, true),
		),
		split(
			"Conflicts avoided",
			store.total(METRIC.avoided),
			store.total(METRIC.avoided, true),
		),
		split("Landed / hour", hour(false), hour(true)),
		split(
			"Needed a human",
			store.total(METRIC.human),
			store.total(METRIC.human, true),
		),
	];
};

const isMetricSlot = (slot: string): slot is MetricSlot =>
	(METRIC_SLOTS as readonly string[]).includes(slot);

/**
 * The home section: the same counters split into real and simulated agents,
 * so a swarm never passes for real work (the metrics themselves are the
 * `hud.metric` slots beside it).
 */
const swarmSection = (store: HudStore, path: string, now: number): UiNode => {
	const splits = splitViews(store, now);
	const quiet = splits.every((s) => s.real === 0 && s.sim === 0) &&
		metricViews(store, now).every((m) => m.series.every((v) => v === 0));
	const simulated = splits.some((s) => s.sim > 0);
	return ui.section("Real and simulated agents", [
		ui.table(
			["Counter", "Real agents", "Simulated agents (swarm)"],
			splits.map((s) => [s.label, s.real, s.sim]),
		),
		ui.text(
			quiet
				? `No lanes, conflicts or landings under ${path} yet. Counters start when agents claim work.`
				: simulated
				? `Every repository under ${path}. Simulated agents run on their own sim repositories and are labelled everywhere; the other column is real agents only.`
				: `Every repository under ${path}. No simulated agents are running: every number is from real agents.`,
			{ tone: "muted" },
		),
	], { gap: 2 });
};

export const renderWith = (
	store: HudStore,
	slot: string,
	path: string,
	now: number,
): UiDoc => {
	if (isMetricSlot(slot)) {
		const view = metricViews(store, now).find((m) => m.id === slot)!;
		return ui.doc(metricNode(view, path), { refreshMs: REFRESH_MS });
	}
	if (slot === "swarm") {
		return ui.doc(swarmSection(store, path, now), { refreshMs: REFRESH_MS });
	}
	return ui.doc(ui.empty(`tartan.hud has no slot ${slot}`));
};

export const render = (
	slot: string,
	_ctx: SlotContext,
	_props: unknown,
	x: ExtCtx,
): Promise<UiDoc> =>
	Promise.resolve(
		renderWith(
			createStore(x.sql),
			slot,
			x.install.node.path,
			minuteOf(Date.now()),
		),
	);
