// The review owners rules (ADR repo config): `tartan.review`'s repo policy,
// authored in the repository's package `tartan` and read at trunk through
// `caps.repo.policy` (K13):
//
//   extensions: "tartan.review": settings: owners: rules: [
//     {paths: ["services/api/**"], sensitivity: 2, owners: ["@platform"]},
//   ]
//
// `sensitivity` is 0 (none) … 3 (critical); `owners` are handles, group
// names or principal ids (only principal ids join the attention set). CUE
// gave the author positioned errors; this check is the boundary (CUE never
// is). An invalid value is not ignored: review routes every change to a
// human until trunk has a valid one (the policy cannot be read, so nothing
// is "low risk").

import { isPrincipalId } from "@tartan/contract";
import { globMatcher } from "./lib/glob.ts";

/** The repo-policy key `tartan.review` declares (`config.repoPolicy`). */
export const OWNERS_POLICY_KEY = "owners" as const;
/** Where the owners rules live in package `tartan` (for messages). */
export const OWNERS_LOCATION =
	'extensions: "tartan.review": settings: owners' as const;
export const SENSITIVITY_MAX = 3;
export const OWNER_RULES_MAX = 500;

export type OwnerRule = {
	readonly glob: string;
	readonly sensitivity: number;
	/** As written (handles, group names or principal ids). */
	readonly owners: readonly string[];
};

export type OwnersResult =
	| { readonly ok: true; readonly rules: readonly OwnerRule[] }
	| { readonly ok: false; readonly errors: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates an exported `owners` value: `{rules: [{paths, sensitivity?, owners?}]}`. */
export const validateOwners = (doc: unknown): OwnersResult => {
	const errors: string[] = [];
	if (!isObj(doc)) {
		return { ok: false, errors: ["(owners): expected a struct"] };
	}
	for (const key of Object.keys(doc)) {
		if (key !== "rules") errors.push(`${key}: unknown key`);
	}
	const rules: OwnerRule[] = [];
	if (!Array.isArray(doc.rules)) errors.push("rules: expected a list");
	else {
		if (doc.rules.length > OWNER_RULES_MAX) {
			errors.push(`rules: at most ${OWNER_RULES_MAX}`);
		}
		doc.rules.slice(0, OWNER_RULES_MAX).forEach((rule: unknown, i) => {
			const at = `rules.${i}`;
			if (!isObj(rule)) {
				errors.push(`${at}: expected a struct`);
				return;
			}
			for (const key of Object.keys(rule)) {
				if (!["paths", "sensitivity", "owners"].includes(key)) {
					errors.push(`${at}.${key}: unknown key`);
				}
			}
			const globs = Array.isArray(rule.paths) &&
					rule.paths.every((p) => typeof p === "string")
				? rule.paths as string[]
				: null;
			if (globs === null || globs.length === 0) {
				errors.push(`${at}.paths: at least one glob`);
				return;
			}
			const s = rule.sensitivity ?? 0;
			if (
				typeof s !== "number" || !Number.isInteger(s) || s < 0 ||
				s > SENSITIVITY_MAX
			) {
				errors.push(`${at}.sensitivity: an integer 0–${SENSITIVITY_MAX}`);
				return;
			}
			const owners = rule.owners ?? [];
			if (
				!Array.isArray(owners) || owners.some((o) => typeof o !== "string")
			) {
				errors.push(`${at}.owners: a list of strings`);
				return;
			}
			for (const glob of globs) {
				rules.push({ glob, sensitivity: s, owners: owners as string[] });
			}
		});
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
};

/** Rules matching each path, compiled once. */
export const createRuleIndex = (rules: readonly OwnerRule[]) => {
	const compiled = rules.map((r) => ({ rule: r, match: globMatcher(r.glob) }));
	return {
		matching: (path: string): OwnerRule[] =>
			compiled.filter((c) => c.match(path)).map((c) => c.rule),
	};
};

/** Owners that are principal ids (the attention set); handles are shown only. */
export const principalOwners = (owners: readonly string[]): string[] =>
	owners.filter((o) => isPrincipalId(o));
