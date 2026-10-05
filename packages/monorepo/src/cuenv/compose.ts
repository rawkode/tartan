// The detector chain's edge mode (WP25 slice A′): when
// cuenv is the primary detector, the workspace detectors (pnpm, npm/Bun,
// deno, Cargo, go.work) no longer name projects; each member they find is
// mapped package name → member root → the cuenv project whose root contains
// it (longest root), and each local dependency becomes an edge between the
// two containing cuenv projects. A member outside every cuenv root is a
// warning, never a project, and edges to or from it are dropped (safe only
// because paths outside every root are global).

import { isUnder } from "../glob.ts";
import type { ProjectIssue } from "./types.ts";

/** A workspace member as a detector found it (deps are member names). */
export type MemberDraft = {
	readonly name: string;
	readonly root: string;
	readonly deps: readonly string[];
};

export type LiftedEdges = {
	/** Dependencies of each cuenv project (by graph name), sorted. */
	readonly deps: ReadonlyMap<string, readonly string[]>;
	readonly warnings: readonly ProjectIssue[];
};

/** Lifts workspace edges onto the cuenv projects that contain their members. */
export const liftEdges = (
	projects: readonly { readonly name: string; readonly root: string }[],
	members: readonly MemberDraft[],
): LiftedEdges => {
	const byLength = [...projects].sort((a, b) => b.root.length - a.root.length);
	const containing = (root: string) =>
		byLength.find((p) => isUnder(root, p.root)) ?? null;
	const byName = new Map<string, MemberDraft>();
	for (const m of [...members].sort((a, b) => a.root < b.root ? -1 : 1)) {
		if (!byName.has(m.name)) byName.set(m.name, m);
	}
	const deps = new Map<string, Set<string>>(
		projects.map((p) => [p.name, new Set<string>()]),
	);
	const warnings: ProjectIssue[] = [];
	const seen = new Set<string>();
	for (const m of members) {
		const key = `${m.root}\0${m.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const from = containing(m.root);
		if (from === null) {
			warnings.push({
				code: "workspace-member-without-project",
				path: m.root,
				message:
					`workspace member ${m.name} is outside every cuenv project; its paths are global`,
			});
			continue;
		}
		for (const dep of m.deps) {
			const target = byName.get(dep);
			if (target === undefined) continue;
			const to = containing(target.root);
			if (to === null) {
				warnings.push({
					code: "edge-dropped",
					path: m.root,
					message:
						`${m.name} depends on ${dep} at ${target.root}, outside every cuenv project`,
				});
				continue;
			}
			if (to.name !== from.name) deps.get(from.name)!.add(to.name);
		}
	}
	return {
		deps: new Map(
			[...deps.entries()].map(([name, set]) => [name, [...set].sort()]),
		),
		warnings: warnings.sort((a, b) =>
			(a.path ?? "") < (b.path ?? "")
				? -1
				: (a.path ?? "") > (b.path ?? "")
				? 1
				: 0
		),
	};
};
