// Plan lines: what applying a resolved repository config would change,
// against trunk's applied set (ADR repo config, "Change page card"). Pure;
// the registry computes the plan (it knows the applied rows), RepoDO and the
// SPA display it. The `text` of each line is stable, so the settings page,
// the change card, MCP and the CLI show the same words.

import {
	NO_CHANGE_TEXT,
	type RepoConfigKeyChange,
	type RepoConfigPlanLine,
} from "@tartan/contract";
import { escapeInvisible } from "./issues.ts";

/** A value as a plan shows it: scalars bare (strings quoted), structures as short JSON. */
export const formatValue = (value: unknown): string => {
	if (value === undefined) return "unset";
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	// JSON.stringify keeps bidi and zero-width characters raw.
	const json = escapeInvisible(JSON.stringify(value) ?? "null");
	return json.length > 80 ? `${json.slice(0, 79)}…` : json;
};

const sameValue = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

/** Keys whose values differ between two settings objects, sorted. */
export const keyChanges = (
	from: Readonly<Record<string, unknown>>,
	to: Readonly<Record<string, unknown>>,
	keys?: readonly string[],
): RepoConfigKeyChange[] => {
	const all = keys ?? [...new Set([...Object.keys(from), ...Object.keys(to)])];
	return [...all].sort().flatMap((key) => {
		const a = Object.hasOwn(from, key) ? from[key] : undefined;
		const b = Object.hasOwn(to, key) ? to[key] : undefined;
		if (sameValue(a, b)) return [];
		return [{
			key,
			...(a === undefined ? {} : { from: a }),
			...(b === undefined ? {} : { to: b }),
		}];
	});
};

export const changeText = (changes: readonly RepoConfigKeyChange[]): string =>
	changes.map((c) => `${c.key} ${formatValue(c.from)} → ${formatValue(c.to)}`)
		.join(", ");

export const installLine = (input: {
	readonly extId: string;
	readonly version: string;
	readonly mode: "enforce" | "shadow";
	readonly enabled: boolean;
	readonly settings: unknown;
}): RepoConfigPlanLine => ({
	op: "install",
	...input,
	text: `install ${input.extId} ${input.version} (${
		input.enabled ? input.mode : "disabled"
	})`,
});

export const configureLine = (input: {
	readonly extId: string;
	readonly version: string;
	readonly changes: readonly RepoConfigKeyChange[];
	readonly note?: string;
}): RepoConfigPlanLine => ({
	op: "configure",
	extId: input.extId,
	version: input.version,
	changes: input.changes,
	text: `configure ${input.extId}: ${input.note ?? changeText(input.changes)}`,
});

export const removeLine = (
	extId: string,
	version: string,
): RepoConfigPlanLine => ({
	op: "remove",
	extId,
	version,
	text: `remove ${extId}`,
});

export const overlayLine = (input: {
	readonly extId: string;
	readonly installationId: string;
	readonly nodePath: string;
	readonly changes: readonly RepoConfigKeyChange[];
}): RepoConfigPlanLine => ({
	op: "overlay",
	...input,
	text: `overlay ${input.extId} (inherited from /${input.nodePath}): ${
		changeText(input.changes)
	}`,
});

export const overlayRemoveLine = (input: {
	readonly extId: string;
	readonly installationId: string;
	readonly nodePath: string;
}): RepoConfigPlanLine => ({
	op: "overlay-remove",
	...input,
	text: `remove overlay ${input.extId} (inherited from /${input.nodePath})`,
});

/** The plan's display lines; one `no change` line when there is nothing to do. */
export const planText = (plan: readonly RepoConfigPlanLine[]): string[] =>
	plan.length === 0 ? [NO_CHANGE_TEXT] : plan.map((l) => l.text);

// ---------------------------------------------------------------------------
// Repo policy lines (ADR repo config): what a change does to the pipeline, the
// owners rules, the projects and the global files, against the trunk config
// in force. RepoDO computes them (it keeps the trunk config history); the
// registry never sees repo policy.
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const record = (v: unknown): Record<string, unknown> => isRecord(v) ? v : {};

const sortedKeys = (...objs: Record<string, unknown>[]): string[] =>
	[...new Set(objs.flatMap((o) => Object.keys(o)))].sort();

/** `+ job lint`, `- job old`, `~ job test` for a struct of named items. */
const namedDiff = (
	noun: string,
	from: Record<string, unknown>,
	to: Record<string, unknown>,
): string[] =>
	sortedKeys(from, to).flatMap((name) => {
		const a = from[name];
		const b = to[name];
		const shown = escapeInvisible(name);
		if (a === undefined) return [`+ ${noun} ${shown}`];
		if (b === undefined) return [`- ${noun} ${shown}`];
		return sameValue(a, b) ? [] : [`~ ${noun} ${shown}`];
	});

/** Owners rules keyed by their paths: added, removed, sensitivity and owners changes. */
const rulesDiff = (from: unknown, to: unknown): string[] => {
	const keyed = (v: unknown) =>
		new Map(
			(Array.isArray(v) ? v : []).filter(isRecord).map((r) => [
				Array.isArray(r.paths)
					? escapeInvisible(r.paths.map(String).join(", "))
					: "?",
				r,
			]),
		);
	const a = keyed(from);
	const b = keyed(to);
	return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((paths) => {
		const x = a.get(paths);
		const y = b.get(paths);
		if (x === undefined) return [`+ rule ${paths}`];
		if (y === undefined) return [`- rule ${paths}`];
		const out: string[] = [];
		if (!sameValue(x.sensitivity, y.sensitivity)) {
			out.push(
				`${paths} sensitivity ${formatValue(x.sensitivity)} → ${
					formatValue(y.sensitivity)
				}`,
			);
		}
		if (!sameValue(x.owners, y.owners)) out.push(`${paths} owners changed`);
		return out;
	});
};

/** What changed inside one repo-policy document, in a few stable words. */
export const policyChanges = (from: unknown, to: unknown): string[] => {
	if (sameValue(from, to)) return [];
	if (from === undefined) return ["set"];
	if (to === undefined) return ["removed"];
	if (!isRecord(from) || !isRecord(to)) {
		return [`${formatValue(from)} → ${formatValue(to)}`];
	}
	return sortedKeys(from, to).flatMap((key) => {
		const a = from[key];
		const b = to[key];
		if (sameValue(a, b)) return [];
		if (key === "jobs" && (isRecord(a) || isRecord(b))) {
			return namedDiff("job", record(a), record(b));
		}
		if (key === "rules" && (Array.isArray(a) || Array.isArray(b))) {
			return rulesDiff(a, b);
		}
		return [`${escapeInvisible(key)} ${formatValue(a)} → ${formatValue(b)}`];
	});
};

/**
 * The repo-policy plan lines of a candidate config against the trunk config
 * in force: one line per changed `repoPolicy` key of an extension, then
 * `projects` and `global`. `policyKeys` names each extension's repo-policy
 * keys (the schema's entries).
 */
export const policyPlan = (input: {
	readonly before: unknown;
	readonly after: unknown;
	readonly policyKeys: ReadonlyMap<string, readonly string[]>;
}): RepoConfigPlanLine[] => {
	const lines: RepoConfigPlanLine[] = [];
	const settingsOf = (resolved: unknown, extId: string) =>
		record(record(record(record(resolved).extensions)[extId]).settings);
	for (const extId of [...input.policyKeys.keys()].sort()) {
		for (const key of [...(input.policyKeys.get(extId) ?? [])].sort()) {
			const a = settingsOf(input.before, extId)[key];
			const b = settingsOf(input.after, extId)[key];
			const changes = policyChanges(a, b);
			if (changes.length === 0) continue;
			lines.push({
				op: "policy",
				extId,
				key,
				changes,
				text: `${key} (${extId}): ${changes.join(", ")}`,
			});
		}
	}
	const projects = namedDiff(
		"",
		record(record(input.before).projects),
		record(record(input.after).projects),
	).map((c) => c.replace(/^([+~-]) {2}/, "$1 "));
	if (projects.length > 0) {
		lines.push({
			op: "projects",
			changes: projects,
			text: `projects: ${projects.join(", ")}`,
		});
	}
	const globs = (v: unknown) =>
		new Set(Array.isArray(v) ? v.filter((g) => typeof g === "string") : []);
	const g0 = globs(record(input.before).global);
	const g1 = globs(record(input.after).global);
	const global = [
		...[...g1].filter((g) => !g0.has(g)).sort().map((g) =>
			`+ ${escapeInvisible(g)}`
		),
		...[...g0].filter((g) => !g1.has(g)).sort().map((g) =>
			`- ${escapeInvisible(g)}`
		),
	];
	if (global.length > 0) {
		lines.push({
			op: "global",
			changes: global,
			text: `global: ${global.join(", ")}`,
		});
	}
	return lines;
};
