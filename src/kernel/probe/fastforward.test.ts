// `walkFastForward`, RepoProbe's check of an Owner's direct push to trunk: a
// descendant of the tip is a fast-forward (a merge of an unrelated root too), a
// rewrite stops at older trunk, and the commits come back ancestors first.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { RepoStoreCommit, ResolvedSha } from "@tartan/contract/kernel.ts";
import { walkFastForward } from "./range.ts";

const sha = (name: string) => name.padEnd(40, "0") as ResolvedSha;

/** `graph[name]` = its parents' names; `trunk` = names on trunk. */
const depsOf = (
	graph: Readonly<Record<string, readonly string[]>>,
	trunk: readonly string[],
) => {
	const logged: string[] = [];
	const commit = (hash: string): RepoStoreCommit | null => {
		const name = hash.replace(/0+$/, "");
		const parents = graph[name];
		return parents === undefined ? null : ({
			hash,
			parents: parents.map(sha),
		} as unknown as RepoStoreCommit);
	};
	return {
		logged,
		log: (from: ResolvedSha, options: { readonly limit: number }) => {
			logged.push(from);
			const page: RepoStoreCommit[] = [];
			let at: string | undefined = from;
			while (at !== undefined && page.length < options.limit) {
				const c = commit(at);
				if (c === null) break;
				page.push(c);
				at = c.parents[0];
			}
			return Promise.resolve(page);
		},
		trunkSeqs: (shas: readonly string[]) =>
			Promise.resolve(
				Object.fromEntries(
					shas.flatMap((s) => {
						const seq = trunk.indexOf(s.replace(/0+$/, ""));
						return seq < 0 ? [] : [[s, seq]];
					}),
				),
			),
	};
};

const walk = (
	graph: Readonly<Record<string, readonly string[]>>,
	trunk: readonly string[],
	after: string,
	maxCommits = 100,
) =>
	walkFastForward(depsOf(graph, trunk), sha(trunk.at(-1)!), sha(after), {
		maxCommits,
	});

Deno.test("a straight descendant is a fast-forward, ancestors first", async () => {
	deepStrictEqual(
		await walk({ a: [], b: ["a"], c: ["b"], d: ["c"] }, ["a", "b"], "d"),
		{ fastForward: true, commits: [sha("c"), sha("d")] },
	);
});

Deno.test("a merge records both sides, parents before children", async () => {
	const result = await walk(
		{ a: [], b: ["a"], m1: ["b"], s1: ["b"], s2: ["s1"], m2: ["m1", "s2"] },
		["a", "b"],
		"m2",
	);
	ok(result.fastForward);
	if (!result.fastForward) return;
	const at = (name: string) => result.commits.indexOf(sha(name));
	equal(result.commits.length, 4);
	ok(at("s1") < at("s2"));
	ok(at("s2") < at("m2"));
	ok(at("m1") < at("m2"));
	equal(result.commits.at(-1), sha("m2"));
});

Deno.test("a diamond above the tip keeps every commit once, in order", async () => {
	const result = await walk(
		{ a: [], b: ["a"], c: ["b"], d: ["c"], e: ["c", "d"] },
		["a", "b"],
		"e",
	);
	deepStrictEqual(result, {
		fastForward: true,
		commits: [sha("c"), sha("d"), sha("e")],
	});
});

Deno.test("a merge of an unrelated root is still a fast-forward", async () => {
	const result = await walk(
		{ a: [], b: ["a"], root: [], r2: ["root"], m: ["b", "r2"] },
		["a", "b"],
		"m",
	);
	deepStrictEqual(result, {
		fastForward: true,
		commits: [sha("root"), sha("r2"), sha("m")],
	});
});

Deno.test("a rewrite is refused, and the walk stops at older trunk", async () => {
	const graph = {
		a: [],
		b: ["a"],
		c: ["b"],
		// Rewrites of c: branches off older trunk, whatever else lies below it.
		x: ["b"],
		y: ["x"],
	};
	const deps = depsOf(graph, ["a", "b", "c"]);
	deepStrictEqual(
		await walkFastForward(deps, sha("c"), sha("y"), { maxCommits: 100 }),
		{ fastForward: false, why: "diverged" },
	);
	equal(deps.logged.length, 1);
});

Deno.test("back to an ancestor, an unrelated history and the tip's sibling are refused", async () => {
	const graph = { a: [], b: ["a"], c: ["b"], u: [], u2: ["u"], s: ["b"] };
	const trunk = ["a", "b", "c"];
	for (const after of ["b", "a", "u2", "s"]) {
		deepStrictEqual(
			await walk(graph, trunk, after),
			{ fastForward: false, why: "diverged" },
			after,
		);
	}
});

Deno.test("a missing commit and too many commits are refused", async () => {
	deepStrictEqual(await walk({ a: [] }, ["a"], "nope"), {
		fastForward: false,
		why: "missing-commit",
	});
	deepStrictEqual(
		await walk({ a: [], b: ["a"], c: ["b"], d: ["c"] }, ["a"], "d", 2),
		{ fastForward: false, why: "too-many-commits" },
	);
});

Deno.test("paging: more commits than a log page, across pages", async () => {
	const graph: Record<string, string[]> = { base: [] };
	let parent = "base";
	const names: string[] = [];
	for (let i = 0; i < 350; i++) {
		const name = `c${i}x`;
		graph[name] = [parent];
		parent = name;
		names.push(name);
	}
	const deps = depsOf(graph, ["base"]);
	const result = await walkFastForward(deps, sha("base"), sha(parent), {
		maxCommits: 1000,
		firstPage: 100,
	});
	deepStrictEqual(result, { fastForward: true, commits: names.map(sha) });
	equal(deps.logged.length, 4);
});
