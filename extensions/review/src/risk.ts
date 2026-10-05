// The by-exception risk model (K13): each
// factor is a number in [0, 1]; the risk is their weighted mean. A change is
// approved automatically when its risk is below the threshold and nothing
// forces a human; otherwise it is routed to a human.
//
// Factors (weights configurable, `DEFAULT_WEIGHTS`):
// - sensitive: the highest owner-rule sensitivity of a changed path (/3), or 1
//   for a path in a project marked `sensitive` (rules and graph at the base);
// - blastRadius: affected projects incl. dependents / all projects (1 when
//   global), on the graph at the base;
// - size: changed lines / 400 (1 when the diff was truncated);
// - weakenedTests: deleted test files, changed test scripts, net decrease of
//   test lines;
// - radar: the worst open conflict of the lane;
// - trackRecord: the author's ejects, vetoes and reverts against landings.
//
// Forced to a human whatever the score (K13): any policy-file change
// (a root `*.cue` file, i.e. Tartan config in package `tartan` or another
// tool's root CUE file, or a changed test script), weakened tests, owners
// rules that cannot be read (Tartan config on trunk does not evaluate), a
// trunk config still evaluating, a truncated diff.

import { type Affected, isPolicyPath } from "@tartan/contract";
import { createProjectIndex, type GraphLike } from "./lib/graph.ts";
import { createRuleIndex, type OwnerRule, SENSITIVITY_MAX } from "./owners.ts";

export const RISK_FACTORS = [
	"sensitive",
	"blastRadius",
	"size",
	"weakenedTests",
	"radar",
	"trackRecord",
] as const;
export type RiskFactor = typeof RISK_FACTORS[number];
export type RiskWeights = Readonly<Record<RiskFactor, number>>;

export const DEFAULT_WEIGHTS: RiskWeights = {
	sensitive: 3,
	blastRadius: 2,
	size: 1,
	weakenedTests: 3,
	radar: 2,
	trackRecord: 1,
};
export const DEFAULT_THRESHOLD = 0.35;
export const SIZE_LINES = 400;

export type ForcedReason =
	| "policy-file"
	| "weakened-tests"
	| "owners-invalid"
	| "config-pending"
	| "truncated-diff";

const TEST_PATH_RE =
	/(^|\/)(__tests__|tests?|specs?)\/|(^|\/)[^/]+[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rs)$/i;

/** True for a test file path (common conventions across ecosystems). */
export const isTestPath = (path: string): boolean => TEST_PATH_RE.test(path);

export type ChangedFile = {
	readonly path: string;
	readonly oldPath?: string;
	readonly change: "added" | "modified" | "deleted" | "renamed" | "type";
	readonly additions: number;
	readonly deletions: number;
};

const CONFLICT_SCORE: Readonly<Record<string, number>> = {
	textual: 1,
	semantic: 1,
	adjacent: 0.6,
	same_file: 0.4,
	trunk_drift: 0.3,
	same_project: 0.2,
	declared: 0.1,
};

export type RiskInput = {
	readonly files: readonly ChangedFile[];
	readonly truncated: boolean;
	/** The project graph at the base on trunk (K13). */
	readonly graph: GraphLike;
	/** Owner rules at trunk, or null when they cannot be read (K13: a human decides). */
	readonly rules: readonly OwnerRule[] | null;
	/** Trunk's Tartan config is still evaluating: the judgement waits for a person. */
	readonly configPending?: boolean;
	/** Manifests whose test scripts changed (or could not be compared). */
	readonly testScriptChanges: readonly string[];
	/** Severities of the lane's open conflicts. */
	readonly conflicts: readonly string[];
	readonly track: {
		readonly landed: number;
		readonly ejected: number;
		readonly vetoed: number;
		readonly reverted: number;
	};
};

export type RiskResult = {
	readonly risk: number;
	readonly factors: Readonly<Record<RiskFactor, number>>;
	readonly forced: readonly ForcedReason[];
	readonly policyFiles: readonly string[];
	readonly weakened: {
		readonly deletedTests: readonly string[];
		readonly netTestLines: number;
		readonly scripts: readonly string[];
	};
	readonly affected: Affected;
	readonly sensitivePaths: readonly string[];
	/** Owners named by the rules that matched (as written). */
	readonly owners: readonly string[];
	readonly lines: number;
};

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number): number => Math.max(0, Math.min(1, n));

export const assessRisk = (
	input: RiskInput,
	weights: RiskWeights = DEFAULT_WEIGHTS,
): RiskResult => {
	const index = createProjectIndex(input.graph);
	const rules = createRuleIndex(input.rules ?? []);
	const paths = input.files.flatMap((f) =>
		f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]
	);

	const policyFiles = [
		...new Set([
			...paths.filter(isPolicyPath),
			...input.testScriptChanges,
		]),
	].sort();

	let sensitive = 0;
	const sensitivePaths: string[] = [];
	const owners = new Set<string>();
	for (const path of paths) {
		let s = 0;
		for (const rule of rules.matching(path)) {
			s = Math.max(s, rule.sensitivity / SENSITIVITY_MAX);
			for (const o of rule.owners) owners.add(o);
		}
		const project = index.projectOf(path);
		const p = project === null ? null : index.project(project);
		if (p?.sensitive) s = 1;
		for (const o of p?.owners ?? []) owners.add(o);
		if (s > 0) sensitivePaths.push(path);
		sensitive = Math.max(sensitive, s);
	}

	const affected = input.truncated
		? { projects: [...index.allNames], global: true }
		: index.affected(paths);
	const blastRadius = affected.global
		? 1
		: affected.projects.length / Math.max(1, index.allNames.length);

	const lines = input.files.reduce((n, f) => n + f.additions + f.deletions, 0);
	const size = input.truncated ? 1 : clamp(lines / SIZE_LINES);

	const deletedTests = input.files.filter((f) =>
		(f.change === "deleted" && isTestPath(f.path)) ||
		(f.change === "renamed" && f.oldPath !== undefined &&
			isTestPath(f.oldPath) && !isTestPath(f.path))
	).map((f) => f.oldPath ?? f.path).sort();
	const netTestLines = input.files.filter((f) =>
		isTestPath(f.path) || (f.oldPath !== undefined && isTestPath(f.oldPath))
	).reduce((n, f) => n + f.additions - f.deletions, 0);
	const weakenedTests = deletedTests.length > 0 ||
			input.testScriptChanges.length > 0
		? 1
		: netTestLines < 0
		? clamp(0.5 + -netTestLines / 100)
		: 0;

	const radar = input.conflicts.reduce(
		(m, s) => Math.max(m, CONFLICT_SCORE[s] ?? 0),
		0,
	);
	const bad = input.track.ejected + input.track.vetoed + input.track.reverted;
	const trackRecord = bad / (input.track.landed + bad + 2);

	const factors: Record<RiskFactor, number> = {
		sensitive: round(sensitive),
		blastRadius: round(blastRadius),
		size: round(size),
		weakenedTests: round(weakenedTests),
		radar: round(radar),
		trackRecord: round(trackRecord),
	};
	const total = RISK_FACTORS.reduce((n, f) => n + Math.max(0, weights[f]), 0);
	const risk = total === 0 ? 0 : round(
		RISK_FACTORS.reduce((n, f) => n + Math.max(0, weights[f]) * factors[f], 0) /
			total,
	);

	const forced: ForcedReason[] = [];
	if (policyFiles.length > 0) forced.push("policy-file");
	if (weakenedTests > 0) forced.push("weakened-tests");
	if (input.rules === null) forced.push("owners-invalid");
	if (input.configPending === true) forced.push("config-pending");
	if (input.truncated) forced.push("truncated-diff");

	return {
		risk,
		factors,
		forced,
		policyFiles,
		weakened: { deletedTests, netTestLines, scripts: input.testScriptChanges },
		affected,
		sensitivePaths: sensitivePaths.sort(),
		owners: [...owners].sort(),
		lines,
	};
};

export type ReviewMode = "by-exception" | "human-required";

/** Auto only in by-exception mode, below the threshold, with nothing forced. */
export const routeOf = (
	r: RiskResult,
	mode: ReviewMode,
	threshold: number,
): "auto" | "human" =>
	mode === "by-exception" && r.forced.length === 0 && r.risk < threshold
		? "auto"
		: "human";

/** Test-related npm scripts (`test`, `pretest`, `test:unit`, …) of a package.json text. */
export const testScripts = (
	text: string | null,
): Readonly<Record<string, string>> | null => {
	if (text === null) return null;
	try {
		const pkg = JSON.parse(text) as { scripts?: unknown };
		const scripts = pkg?.scripts;
		if (scripts === null || typeof scripts !== "object") return {};
		return Object.fromEntries(
			Object.entries(scripts as Record<string, unknown>).filter((
				[k, v],
			) => /^(pre|post)?test/.test(k) && typeof v === "string"),
		) as Record<string, string>;
	} catch {
		return null;
	}
};

/**
 * True when the test scripts differ. `base` null = the file is absent at the
 * base (added); `head` null with `headDeleted` false = unreadable (a lane the
 * canonical repo cannot read), which counts as changed. Invalid JSON on either
 * side counts as changed.
 */
export const testScriptsChanged = (
	base: string | null,
	head: string | null,
	headDeleted: boolean,
): boolean => {
	const a = base === null ? {} : testScripts(base);
	const b = headDeleted ? {} : testScripts(head);
	if (a === null || b === null) return true;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].some((k) => a[k] !== b[k]);
};
