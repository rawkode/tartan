// Scripted conflict scenarios on the fixture monorepo: two lanes (`a`, `b`)
// branch from the same trunk commit and change files; each scenario states
// what radar, merge3 and the planner must conclude. The expectations are
// checked against stock `git merge-file` in this package's tests.

import type { FileChanges, FileMap } from "../git/store.ts";
import {
	affectedProjects,
	CART_TS,
	LEGACY_TS,
	MONEY_TS,
	MONOREPO_FILES,
	ORDERS_TS,
} from "./monorepo.ts";

export type LaneScript = {
	readonly message: string;
	readonly changes: FileChanges;
};

export type ScenarioExpectation = {
	/** Paths both lanes touch. */
	readonly sharedPaths: readonly string[];
	/** Paths whose three-way merge conflicts (text, modify/delete, add/add). */
	readonly conflictPaths: readonly string[];
	/** Projects affected by each lane (owners plus dependents). */
	readonly affected: {
		readonly a: readonly string[];
		readonly b: readonly string[];
	};
};

export type ConflictScenario = {
	readonly id: string;
	readonly title: string;
	/** Applied to the fixture before the lanes branch (trunk at the lanes' base). */
	readonly base?: LaneScript;
	readonly lanes: { readonly a: LaneScript; readonly b: LaneScript };
	readonly expect: ScenarioExpectation;
};

const edit = (
	source: string,
	from: string,
	to: string,
): string => {
	if (!source.includes(from)) throw new Error(`fixture edit missing: ${from}`);
	return source.replace(from, to);
};

const MONEY = "packages/shared/src/money.ts";
const ORDERS = "services/api/src/routes/orders.ts";
const CART = "apps/web/src/cart.ts";
const LEGACY = "apps/web/src/legacy.ts";
const ALL = ["@acme/shared", "@acme/api", "@acme/web"];

export const CONFLICT_SCENARIOS: readonly ConflictScenario[] = [
	{
		id: "disjoint-projects",
		title: "lanes change different projects",
		lanes: {
			a: {
				message: "api: 410 for archived orders",
				changes: {
					[ORDERS]: edit(
						ORDERS_TS,
						'if (!order) return { status: 404, body: "not found" };',
						'if (!order) return { status: 404, body: "not found" };\n\tif (order.lines.length === 0) return { status: 410, body: "archived" };',
					),
				},
			},
			b: {
				message: "web: show the item count first",
				changes: {
					[CART]: edit(CART_TS, "item(s): ", "item(s) — "),
				},
			},
		},
		expect: {
			sharedPaths: [],
			conflictPaths: [],
			affected: { a: ["@acme/api"], b: ["@acme/web"] },
		},
	},
	{
		id: "same-file-disjoint-hunks",
		title: "lanes change different functions of one shared file",
		lanes: {
			a: {
				message: "shared: add JPY",
				changes: {
					[MONEY]: edit(
						edit(
							MONEY_TS,
							'export type Currency = "EUR" | "GBP" | "USD";',
							'export type Currency = "EUR" | "GBP" | "JPY" | "USD";',
						),
						'\tGBP: "£",',
						'\tGBP: "£",\n\tJPY: "¥",',
					),
				},
			},
			b: {
				message: "shared: clamp discounts",
				changes: {
					[MONEY]: edit(
						MONEY_TS,
						"money(Math.round(m.amount * (1 - percent / 100)), m.currency);",
						"money(\n\t\tMath.round(m.amount * (1 - Math.min(Math.max(percent, 0), 100) / 100)),\n\t\tm.currency,\n\t);",
					),
				},
			},
		},
		expect: {
			sharedPaths: [MONEY],
			conflictPaths: [],
			affected: { a: ALL, b: ALL },
		},
	},
	{
		id: "same-hunk-conflict",
		title: "lanes change the same line differently",
		lanes: {
			a: {
				message: "shared: format with a space",
				changes: {
					[MONEY]: edit(
						MONEY_TS,
						"`${SYMBOLS[m.currency]}${(m.amount / 100).toFixed(2)}`",
						"`${SYMBOLS[m.currency]} ${(m.amount / 100).toFixed(2)}`",
					),
				},
			},
			b: {
				message: "shared: format with the currency code",
				changes: {
					[MONEY]: edit(
						MONEY_TS,
						"`${SYMBOLS[m.currency]}${(m.amount / 100).toFixed(2)}`",
						"`${(m.amount / 100).toFixed(2)} ${m.currency}`",
					),
				},
			},
		},
		expect: {
			sharedPaths: [MONEY],
			conflictPaths: [MONEY],
			affected: { a: ALL, b: ALL },
		},
	},
	{
		id: "shared-ripple",
		title:
			"a shared rename and a new caller of the old name (no text conflict)",
		lanes: {
			a: {
				message: "shared: rename sumMoney to totalOf",
				changes: {
					[MONEY]: edit(
						MONEY_TS,
						"export const sumMoney = (",
						"export const totalOf = (",
					),
					[ORDERS]: edit(
						edit(
							ORDERS_TS,
							"import { formatMoney, money, sumMoney }",
							"import { formatMoney, money, totalOf }",
						),
						"\tsumMoney(order.lines",
						"\ttotalOf(order.lines",
					),
					[CART]: edit(
						edit(
							CART_TS,
							"import { applyDiscount, formatMoney, money, sumMoney }",
							"import { applyDiscount, formatMoney, money, totalOf }",
						),
						"\tsumMoney(items.map",
						"\ttotalOf(items.map",
					),
				},
			},
			b: {
				message: "api: order subtotal endpoint",
				changes: {
					"services/api/src/routes/subtotal.ts":
						'import { money, sumMoney } from "@acme/shared";\n\nexport const subtotal = (cents: readonly number[]) =>\n\tsumMoney(cents.map((c) => money(c, "EUR")), "EUR");\n',
				},
			},
		},
		expect: {
			sharedPaths: [],
			conflictPaths: [],
			affected: { a: ALL, b: ["@acme/api"] },
		},
	},
	{
		id: "delete-vs-edit",
		title: "one lane deletes a file the other edits",
		lanes: {
			a: {
				message: "web: drop the legacy banner",
				changes: { [LEGACY]: null },
			},
			b: {
				message: "web: reword the legacy banner",
				changes: {
					[LEGACY]: edit(
						LEGACY_TS,
						"The old checkout is still available.",
						"The old checkout closes on 31 October.",
					),
				},
			},
		},
		expect: {
			sharedPaths: [LEGACY],
			conflictPaths: [LEGACY],
			affected: { a: ["@acme/web"], b: ["@acme/web"] },
		},
	},
	{
		id: "add-add",
		title: "both lanes add the same new path with different content",
		lanes: {
			a: {
				message: "shared: tax helper (flat)",
				changes: {
					"packages/shared/src/tax.ts":
						"export const vat = (cents: number): number => Math.round(cents * 0.2);\n",
				},
			},
			b: {
				message: "shared: tax helper (by rate)",
				changes: {
					"packages/shared/src/tax.ts":
						"export const vat = (cents: number, rate = 0.2): number =>\n\tMath.round(cents * rate);\n",
				},
			},
		},
		expect: {
			sharedPaths: ["packages/shared/src/tax.ts"],
			conflictPaths: ["packages/shared/src/tax.ts"],
			affected: { a: ALL, b: ALL },
		},
	},
];

export const scenario = (id: string): ConflictScenario => {
	const found = CONFLICT_SCENARIOS.find((s) => s.id === id);
	if (!found) throw new Error(`unknown scenario ${id}`);
	return found;
};

const apply = (files: FileMap, changes: FileChanges): FileMap => {
	const next: Record<string, FileMap[string]> = { ...files };
	for (const [path, spec] of Object.entries(changes)) {
		if (spec === null) delete next[path];
		else next[path] = spec;
	}
	return next;
};

/** The three snapshots of a scenario as file maps (no git needed). */
export const scenarioSnapshots = (
	s: ConflictScenario,
): { base: FileMap; a: FileMap; b: FileMap } => {
	const base = s.base ? apply(MONOREPO_FILES, s.base.changes) : MONOREPO_FILES;
	return {
		base,
		a: apply(base, s.lanes.a.changes),
		b: apply(base, s.lanes.b.changes),
	};
};

/** The scenario's lane paths and affected projects, derived from its scripts. */
export const derivedExpectation = (
	s: ConflictScenario,
): Omit<ScenarioExpectation, "conflictPaths"> => {
	const a = Object.keys(s.lanes.a.changes);
	const b = Object.keys(s.lanes.b.changes);
	return {
		sharedPaths: a.filter((p) => b.includes(p)).sort(),
		affected: { a: affectedProjects(a), b: affectedProjects(b) },
	};
};
