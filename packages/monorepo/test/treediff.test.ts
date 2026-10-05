// Hash-pruned tree diff: change kinds, identical-content renames, pruning
// (an unchanged subtree is never read), two object sources, truncation.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { diffTrees, MissingObjectError, touchedPaths } from "../src/index.ts";
import { createMemGit } from "./memgit.ts";

Deno.test("memgit computes real git object ids", () => {
	const git = createMemGit();
	// `printf 'hello\n' | git hash-object --stdin`
	equal(git.blob("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
	// `git hash-object -t tree /dev/null` (the empty tree)
	equal(git.tree([]), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

Deno.test("diffTrees: added, modified, deleted, renamed, type change, mode change", async () => {
	const git = createMemGit();
	const before = git.writeTree({
		"README.md": "hello\n",
		"src/a.ts": "a\n",
		"src/b.ts": "b\n",
		"src/link": { content: "target", mode: "120000" },
		"bin/run": "echo\n",
		"old/name.txt": "moved content\n",
		"gone/x.txt": "x\n",
	});
	const after = git.writeTree({
		"README.md": "hello\n",
		"src/a.ts": "A\n",
		"src/b.ts": "b\n",
		"src/link": "now a file\n",
		"bin/run": { content: "echo\n", mode: "100755" },
		"new/name.txt": "moved content\n",
		"added.txt": "new\n",
	});
	const { changes, truncated } = await diffTrees(
		{ objects: git.objects, tree: before },
		{ objects: git.objects, tree: after },
	);
	equal(truncated, false);
	deepStrictEqual(changes.map((c) => [c.change, c.path, c.oldPath ?? null]), [
		["added", "added.txt", null],
		["modified", "bin/run", null],
		["deleted", "gone/x.txt", null],
		["renamed", "new/name.txt", "old/name.txt"],
		["modified", "src/a.ts", null],
		["type", "src/link", null],
	]);
	deepStrictEqual(touchedPaths(changes).includes("old/name.txt"), true);
});

Deno.test("diffTrees: reads only subtrees whose hash differs", async () => {
	const git = createMemGit();
	const files: Record<string, string> = {};
	for (let p = 0; p < 20; p++) {
		for (let f = 0; f < 10; f++) files[`pkg${p}/src/f${f}.ts`] = `${p}-${f}\n`;
	}
	const before = git.writeTree(files);
	const after = git.writeTree({ ...files, "pkg7/src/f3.ts": "changed\n" });
	git.reads.tree = 0;
	const { changes } = await diffTrees(
		{ objects: git.objects, tree: before },
		{ objects: git.objects, tree: after },
	);
	deepStrictEqual(changes.map((c) => c.path), ["pkg7/src/f3.ts"]);
	// root ×2, pkg7 ×2, pkg7/src ×2: nothing else is read.
	equal(git.reads.tree, 6);
	equal(git.reads.blob, 0);
});

Deno.test("diffTrees: each side reads its own object source; the empty tree side", async () => {
	const laneX = createMemGit();
	const laneY = createMemGit();
	const shared = { "lib/core.ts": "core\n" };
	const x = laneX.writeTree({ ...shared, "x.ts": "x\n" });
	const y = laneY.writeTree({ ...shared, "y.ts": "y\n" });
	const { changes } = await diffTrees(
		{ objects: laneX.objects, tree: x },
		{ objects: laneY.objects, tree: y },
	);
	deepStrictEqual(changes.map((c) => [c.change, c.path]), [
		["deleted", "x.ts"],
		["added", "y.ts"],
	]);
	const fromEmpty = await diffTrees(
		{ objects: laneX.objects, tree: null },
		{ objects: laneX.objects, tree: x },
	);
	equal(fromEmpty.changes.length, 2);
	await rejects(
		diffTrees(
			{ objects: laneX.objects, tree: x },
			{ objects: laneX.objects, tree: y },
		),
		MissingObjectError,
	);
});

Deno.test("diffTrees: stops at maxPaths with truncated", async () => {
	const git = createMemGit();
	const files: Record<string, string> = {};
	for (let i = 0; i < 50; i++) files[`f${i}.txt`] = `${i}\n`;
	const { changes, truncated } = await diffTrees(
		{ objects: git.objects, tree: null },
		{ objects: git.objects, tree: git.writeTree(files) },
		{ maxPaths: 10 },
	);
	ok(truncated);
	equal(changes.length, 10);
});
