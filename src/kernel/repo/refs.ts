// The authoritative ref index of the canonical repo (K15): the binding resolves
// no full refname, so `refs` (and `lanes.head_sha` for lane heads) is where
// every SHA comes from. `branch`-backend lane refs are canonical refs, so their
// heads are mirrored here too; refs of lane repos never are.

import {
	isKernelRef,
	LANE_BRANCH_PREFIX,
	laneIdFromBranchRef,
	parseId,
	SHA1_RE,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type { LaneRow, PushRow, RefRow } from "@tartan/contract/kernel.ts";
import { type Core, first, getMeta, rows, setMeta } from "./core.ts";

export const getRef = (sql: SqlStorage, ref: string): RefRow | null =>
	first<RefRow>(sql, "SELECT * FROM refs WHERE ref = ?", ref);

export const allRefs = (sql: SqlStorage): RefRow[] =>
	rows<RefRow>(sql, "SELECT * FROM refs ORDER BY ref");

/** The index value of `ref`, zeros when absent. */
export const indexSha = (sql: SqlStorage, ref: string): string =>
	getRef(sql, ref)?.sha ?? ZERO_SHA;

/**
 * Sets (or, for zeros, deletes) one index entry; keeps `meta.trunk_sha` in
 * step with the default branch.
 */
export const writeRef = (
	core: Core,
	ref: string,
	sha: string,
	options: {
		readonly pushId?: string | null;
		readonly peeled?: string | null;
	} = {},
): void => {
	const now = core.clock.now();
	if (sha === ZERO_SHA) {
		core.sql.exec("DELETE FROM refs WHERE ref = ?", ref);
	} else {
		core.sql.exec(
			`INSERT INTO refs (ref, sha, updated_at, push_id, peeled, reconciled_at)
			 VALUES (?, ?, ?, ?, ?, NULL)
			 ON CONFLICT (ref) DO UPDATE SET sha = excluded.sha, updated_at = excluded.updated_at,
			   push_id = excluded.push_id, peeled = excluded.peeled`,
			ref,
			sha,
			now,
			options.pushId ?? null,
			options.peeled ?? null,
		);
	}
	const defaultBranch = getMeta(core.sql, "default_branch");
	if (defaultBranch !== null && ref === trunkRef(defaultBranch)) {
		setMeta(core.sql, "trunk_sha", sha === ZERO_SHA ? null : sha);
	}
};

/** Push channels that carry a pusher, and the kernel's own writes. */
const ATTRIBUTED_VIA = "via IN ('gateway','swarm','kernel')";

/**
 * The last row of a chain of recorded transitions leading from `from` to
 * `to` (bounded walk, the latest row at each step), or null. With
 * `attributedOnly`, only rows of the attributing channels and the kernel
 * count (never a trigger- or reconcile-recorded row).
 */
export const pushChainTo = (
	core: Core,
	where: TransitionSide,
	ref: string,
	from: string,
	to: string,
	options: { readonly attributedOnly?: boolean } = {},
): PushRow | null => {
	let at = from;
	const seen = new Set<string>([at]);
	for (let hop = 0; hop < 16; hop++) {
		const next = first<PushRow>(
			core.sql,
			`SELECT * FROM pushes WHERE ref = ? AND before = ? AND ${where.clause}${
				options.attributedOnly ? ` AND ${ATTRIBUTED_VIA}` : ""
			} ORDER BY at DESC, id DESC LIMIT 1`,
			ref,
			at,
			...where.bindings,
		);
		if (next === null) return null;
		if (next.after === to) return next;
		if (seen.has(next.after)) return null;
		seen.add(next.after);
		at = next.after;
	}
	return null;
};

/**
 * True when a report `before → after` is older than the index value: the push
 * log already holds transitions leading from its `after` to the current
 * value (bounded walk). Applying it would regress the index.
 */
export const isOlderTransition = (
	core: Core,
	where: TransitionSide,
	ref: string,
	after: string,
	current: string,
): boolean => pushChainTo(core, where, ref, after, current) !== null;

/** Where a transition happened: the canonical repo, or one lane repo. */
export type TransitionSide = {
	readonly repoName: string | null;
	readonly clause: string;
	readonly bindings: readonly SqlStorageValue[];
};

export const CANONICAL: TransitionSide = {
	repoName: null,
	clause: "repo_name IS NULL",
	bindings: [],
};

export const laneRepoSide = (repoName: string): TransitionSide => ({
	repoName,
	clause: "repo_name = ?",
	bindings: [repoName],
});

export type CasOutcome = "applied" | "noop" | "older" | "missed";

/**
 * The index CAS of a canonical ref: `before` = the index ⇒
 * applied; already `after` ⇒ no-op; an older report ⇒ left alone; anything
 * else is a CAS miss: `after` is what upstream just accepted, so it is
 * written and the ref is reconciled afterwards.
 */
export const casRef = (
	core: Core,
	ref: string,
	before: string,
	after: string,
	pushId: string | null,
): CasOutcome => {
	const current = indexSha(core.sql, ref);
	if (current === after) return "noop";
	if (current === before) {
		writeRef(core, ref, after, { pushId });
		return "applied";
	}
	if (isOlderTransition(core, CANONICAL, ref, after, current)) return "older";
	writeRef(core, ref, after, { pushId });
	return "missed";
};

// ---------------------------------------------------------------------------
// Protection and classification
// ---------------------------------------------------------------------------

const GLOB_SPECIAL = /[.+?^${}()|[\]\\]/g;

const globToRegExp = (pattern: string): RegExp => {
	const full = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
	const source = full
		.split("**")
		.map((part) => part.replace(GLOB_SPECIAL, "\\$&").replace(/\*/g, "[^/]*"))
		.join(".*");
	return new RegExp(`^${source}$`);
};

/**
 * A protected ref: the default branch always, plus the
 * inherited patterns (globs; `*` within a segment, `**` across). Patterns
 * never match `refs/heads/lanes/**`.
 */
export const isProtectedRef = (
	ref: string,
	defaultBranch: string,
	patterns: readonly string[],
): boolean => {
	if (ref === trunkRef(defaultBranch)) return true;
	if (ref.startsWith(LANE_BRANCH_PREFIX)) return false;
	return patterns.some((pattern) => globToRegExp(pattern).test(ref));
};

/** The literal prefix of a protected pattern, for `ls-refs ref-prefix`. */
export const patternPrefix = (pattern: string): string => {
	const full = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
	const glob = full.indexOf("*");
	return glob === -1 ? full : full.slice(0, glob);
};

/**
 * The repo a canonical ref belongs to for K1/K2: a `branch`-lane ref or the
 * ref of an active adopted lane is that lane's; anything else is `"repo"`.
 */
export const canonicalTarget = (sql: SqlStorage, ref: string): string => {
	const laneId = laneIdFromBranchRef(ref);
	if (laneId !== null) {
		const lane = first<{ id: string }>(
			sql,
			"SELECT id FROM lanes WHERE id = ? AND mode = 'branch'",
			laneId,
		);
		if (lane !== null) return lane.id;
	}
	const adopted = first<{ id: string }>(
		sql,
		`SELECT id FROM lanes WHERE kind = 'adopted' AND ref = ?
		 AND state NOT IN ('closed','archived','deleted') LIMIT 1`,
		ref,
	);
	return adopted?.id ?? "repo";
};

/** Kernel-guarded canonical refs (K1): kernel namespaces and stray lane refs. */
export const isKernelGuardedRef = (ref: string, target: string): boolean =>
	isKernelRef(ref) ||
	(ref.startsWith(LANE_BRANCH_PREFIX) && target === "repo");

/** Diff state of a new push row. */
export const diffStateFor = (
	ref: string,
	after: string,
	options: { readonly laneHead: boolean; readonly importing: boolean },
): "pending" | "skipped" => {
	if (after === ZERO_SHA || options.importing) return "skipped";
	if (options.laneHead) return "pending";
	if (isKernelRef(ref) || !ref.startsWith("refs/heads/")) return "skipped";
	return "pending";
};

// ---------------------------------------------------------------------------
// resolveRef (K15)
// ---------------------------------------------------------------------------

const laneTip = (lane: LaneRow): string | null =>
	lane.head_sha ?? (lane.state === "opening" ? null : lane.base_sha);

/**
 * A ref name, a lane id or a SHA → SHA, from the index and lane rows only.
 * Short branch and tag names and `HEAD` are accepted; annotated tags resolve
 * to their peeled target.
 */
export const resolveRefSync = (
	sql: SqlStorage,
	input: string,
): string | null => {
	const value = input.trim();
	if (SHA1_RE.test(value)) return value;
	if (parseId("lane", value) !== null) {
		const lane = first<LaneRow>(sql, "SELECT * FROM lanes WHERE id = ?", value);
		return lane === null ? null : laneTip(lane);
	}
	const defaultBranch = getMeta(sql, "default_branch") ?? "main";
	const candidates = value === "HEAD"
		? [trunkRef(defaultBranch)]
		: value.startsWith("refs/")
		? [value]
		: [`refs/heads/${value}`, `refs/tags/${value}`];
	for (const ref of candidates) {
		const laneId = laneIdFromBranchRef(ref);
		if (laneId !== null) {
			const lane = first<LaneRow>(
				sql,
				"SELECT * FROM lanes WHERE id = ? AND mode = 'branch'",
				laneId,
			);
			if (lane !== null) return laneTip(lane);
		}
		const row = getRef(sql, ref);
		if (row !== null) return row.peeled ?? row.sha;
	}
	return null;
};
