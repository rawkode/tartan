// Mock HUD documents (WP19/WP20): what tartan.hud, radar, the Weave and
// review render for the `hud` and `home` views, shaped like the real
// extensions' renders (`extensions/hud/src/ui.ts` and the others'
// `hud.metric` / `home.section` slots). Keys are `<ext>/<slot>/<id>`, each a
// real manifest contribution (`test/mock-parity.spec.ts`).

import type { UiDoc, UiNode } from "@tartan/contract/ui.ts";

const spark = (base: number, wave: number): number[] =>
	Array.from(
		{ length: 60 },
		(_, i) => Math.max(0, Math.round(base + wave * Math.sin(i / 6))),
	);

const metric = (
	label: string,
	value: number,
	series: number[],
	note: string,
	extra: { delta?: number; unit?: string } = {},
): UiDoc => ({
	v: 1,
	refreshMs: 5000,
	root: {
		t: "stack",
		gap: 1,
		children: [
			{ t: "stat", label, value, ...extra },
			{ t: "sparkline", values: series },
			{ t: "text", text: note, tone: "muted" },
			{ t: "label", text: "every repository under acme", tone: "muted" },
		],
	},
});

/** The numbers of a running 300-agent swarm beside two real agents. */
export const HUD_NUMBERS = {
	activeLanes: 302,
	simulatedLanes: 300,
	predicted: 148,
	avoided: 61,
	landedPerHour: 38,
	human: 3,
	reviewed: 41,
} as const;

const n = HUD_NUMBERS;

const splitTable: UiNode = {
	t: "table",
	columns: ["Counter", "Real agents", "Simulated agents (swarm)"],
	rows: [
		["Active lanes", n.activeLanes - n.simulatedLanes, n.simulatedLanes],
		["Predicted conflicts", 9, n.predicted - 9],
		["Conflicts avoided", 4, n.avoided - 4],
		["Landed / hour", 2, n.landedPerHour - 2],
		["Needed a human", 3, 0],
	],
};

export const HUD_DOCS: Readonly<Record<string, UiDoc>> = {
	"tartan.hud/hud.metric/active-lanes": metric(
		"Active lanes",
		n.activeLanes,
		spark(280, 20),
		`${n.simulatedLanes} of them simulated agents (swarm)`,
		{ delta: 24 },
	),
	"tartan.hud/hud.metric/predicted-conflicts": metric(
		"Predicted conflicts",
		n.predicted,
		spark(3, 2),
		`52 in the last hour; ${n.predicted - 9} from simulated agents`,
	),
	"tartan.hud/hud.metric/conflicts-avoided": metric(
		"Conflicts avoided",
		n.avoided,
		spark(1, 1),
		"41% of predicted conflicts never reached trunk",
	),
	"tartan.hud/hud.metric/landed-per-hour": metric(
		"Landed / hour",
		n.landedPerHour,
		spark(1, 1),
		`412 landed in all; ${n.landedPerHour - 2} from simulated agents this hour`,
		{ unit: "changes" },
	),
	"tartan.hud/hud.metric/needed-a-human": metric(
		"Needed a human",
		n.human,
		spark(0, 1),
		`${n.human} of ${n.reviewed} reviewed changes (7%); the rest were reviewed by exception`,
	),
	"tartan.hud/home.section/swarm": {
		v: 1,
		refreshMs: 5000,
		root: {
			t: "section",
			title: "Real and simulated agents",
			gap: 2,
			children: [
				splitTable,
				{
					t: "text",
					tone: "muted",
					text:
						"Every repository under acme. Simulated agents run on their own sim repositories and are labelled everywhere; the other column is real agents only.",
				},
			],
		},
	},
	"tartan.radar/hud.metric/conflicts-avoided": {
		v: 1,
		refreshOn: ["conflicts.*"],
		root: { t: "stat", label: "Conflicts avoided", value: 7 },
	},
	"tartan.weave/hud.metric/landed-per-hour": {
		v: 1,
		refreshOn: ["queue.*", "ref.advanced"],
		root: { t: "stat", label: "Landed / hour", value: 4 },
	},
	"tartan.review/home.section/attention": {
		v: 1,
		refreshOn: ["review.*"],
		root: {
			t: "section",
			title: "Needs your review",
			children: [
				{
					t: "list",
					items: [
						{
							t: "link",
							text: "Split router into modules (risk 0.62)",
							href: "/acme/platform/router/-/changes",
						},
					],
				},
			],
		},
	},
};
