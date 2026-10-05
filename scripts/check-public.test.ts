// The public-content check (AGENTS.md rule 8). The
// real term list is private, so these tests use a stand-in policy.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	createScanner,
	historyPolicy,
	parseGitGrep,
	parsePolicy,
	revisionHits,
	TERMS_FILE,
	unpublishedEntry,
	unpublishedPaths,
} from "./check-public.ts";
import { createTempRepo } from "./testing/git-repo.ts";

const policy = parsePolicy({
	terms: ["plugh", "xyzzy", "frobozz"],
	scoped: { "web/": ["grue\\d"] },
	snapshot: [{
		pattern: "zork[0-9]",
		paths: ["src/", "lib.ts"],
		except: ["src/old/"],
	}],
	allowed: ["plughs?wood"],
	unpublished: {
		"notes/": "stand-in notes",
		"plan.md": "a stand-in plan",
		"docs/x.md": "a stand-in page",
	},
});
const scanner = createScanner(policy);
const labels = (file: string, text: string): string[] =>
	scanner.scanText(file, text).map((hit) => hit.term);

Deno.test("check-public: every term is found, case-insensitively, by its place in the list", () => {
	policy.terms.forEach((term, index) => {
		deepStrictEqual(labels("src/a.ts", `x ${term} y`), [`#${index + 1}`]);
		deepStrictEqual(labels("src/a.ts", `x ${term.toUpperCase()} y`), [
			`#${index + 1}`,
		]);
	});
});

Deno.test("check-public: hits carry their line number and never the term", () => {
	const hits = scanner.scanText("README.md", "ok\nsay xyzzy\nok");
	deepStrictEqual(hits, [{ file: "README.md", line: 2, term: "#2" }]);
	ok(!JSON.stringify(hits).includes("xyzzy"));
});

Deno.test("check-public: allowed words are removed before matching", () => {
	deepStrictEqual(labels("src/a.ts", "past plughwood"), []);
	deepStrictEqual(labels("src/a.ts", "a plugh here"), ["#1"]);
});

Deno.test("check-public: scoped patterns apply under their prefix only", () => {
	deepStrictEqual(labels("src/a.ts", "grue7"), []);
	deepStrictEqual(labels("web/src/a.ts", "grue7"), ["web/#1"]);
	deepStrictEqual(labels("web/src/a.ts", "grue"), []);
});

Deno.test("check-public: the policy shape is validated", () => {
	const base = { terms: ["a"], unpublished: {} };
	throws(() => parsePolicy(null), /expected an object/);
	throws(() => parsePolicy({ ...base, terms: [] }), /non-empty/);
	throws(() => parsePolicy({ ...base, terms: [""] }), /empty string/);
	throws(() => parsePolicy({ ...base, scoped: ["x"] }), /scoped/);
	throws(() => parsePolicy({ ...base, scoped: { "p/": "x" } }), /list/);
	throws(() => parsePolicy({ ...base, allowed: [1] }), /allowed/);
	throws(() => parsePolicy({ ...base, allowed: ["("] }));
	throws(() => parsePolicy({ ...base, snapshot: {} }), /snapshot/);
	throws(
		() => parsePolicy({ ...base, snapshot: [{ paths: ["p/"] }] }),
		/snapshot/,
	);
	throws(
		() => parsePolicy({ ...base, snapshot: [{ pattern: "x", paths: [] }] }),
		/snapshot/,
	);
	throws(() =>
		parsePolicy({ ...base, snapshot: [{ pattern: "(", paths: [""] }] })
	);
	deepStrictEqual(parsePolicy(base), {
		terms: ["a"],
		scoped: {},
		snapshot: [],
		allowed: [],
		unpublished: {},
	});
	deepStrictEqual(
		parsePolicy({ ...base, snapshot: [{ pattern: "x", paths: [""] }] })
			.snapshot,
		[{ pattern: "x", paths: [""], except: [] }],
	);
});

Deno.test("check-public: the unpublished paths are required, each with a reason", () => {
	// Without the list a snapshot would carry every path, so none is assumed.
	throws(() => parsePolicy({ terms: ["a"] }), /unpublished/);
	throws(() => parsePolicy({ terms: ["a"], unpublished: [] }), /unpublished/);
	throws(
		() => parsePolicy({ terms: ["a"], unpublished: { "x.md": "" } }),
		/unpublished/,
	);
	throws(
		() => parsePolicy({ terms: ["a"], unpublished: { "": "why" } }),
		/unpublished/,
	);
	throws(
		() => parsePolicy({ terms: ["a"], unpublished: { "/x.md": "why" } }),
		/unpublished/,
	);
	throws(
		() => parsePolicy({ terms: ["a"], unpublished: { "x.md": 1 } }),
		/unpublished/,
	);
	deepStrictEqual(unpublishedPaths(policy), ["docs/x.md", "notes/", "plan.md"]);
});

Deno.test("check-public: snapshot rules apply under their paths, except where excepted", () => {
	deepStrictEqual(labels("src/a.ts", "zork1"), ["snapshot#1"]);
	deepStrictEqual(labels("lib.ts", "ZORK2"), ["snapshot#1"]);
	deepStrictEqual(labels("src/old/a.ts", "zork1"), []);
	deepStrictEqual(labels("web/a.ts", "zork1"), []);
	deepStrictEqual(labels("src/a.ts", "zork"), []);
});

Deno.test("check-public: the policy for pushed commits has no snapshot rules", () => {
	const history = historyPolicy(policy);
	deepStrictEqual(history.snapshot, []);
	deepStrictEqual(history.terms, policy.terms);
	deepStrictEqual(history.scoped, policy.scoped);
	deepStrictEqual(history.unpublished, policy.unpublished);
	const rev = "b".repeat(40);
	const lines = parseGitGrep(`${rev}:src/a.ts\x003\x00zork1 and xyzzy\n`);
	deepStrictEqual(revisionHits(createScanner(history), lines), [
		{ rev, file: "src/a.ts", line: 3, term: "#2" },
	]);
	deepStrictEqual(revisionHits(scanner, lines).map((hit) => hit.term), [
		"#2",
		"snapshot#1",
	]);
});

Deno.test("check-public: the term list is private", () => {
	ok(TERMS_FILE.startsWith(".private/"));
});

Deno.test("check-public: a directory entry covers the files under it, and only those", () => {
	const entry = (file: string) => unpublishedEntry(policy, file);
	equal(entry("notes/a.md"), "notes/");
	equal(entry("notes/sub/x.md"), "notes/");
	equal(entry("plan.md"), "plan.md");
	equal(entry("docs/x.md"), "docs/x.md");
	equal(entry("notesx.md"), undefined);
	equal(entry("notes"), undefined);
	equal(entry("docs/x.md.bak"), undefined);
	equal(entry("docs/y.md"), undefined);
	equal(entry("sub/plan.md"), undefined);
	equal(entry("toString"), undefined);
});

Deno.test("check-public: parses git grep -z output; published revisions except no path", () => {
	const rev = "a".repeat(40);
	const output = [
		`${rev}:notes/plan.md\x0012\x00the frobozz here`,
		`${rev}:src/a.ts\x007\x00past plughwood`,
		`${rev}:src/b:c.ts\x001\x00x xyzzy`,
		`${rev}:web/src/x.ts\x002\x00grue1`,
		"",
	].join("\n");
	const lines = parseGitGrep(output);
	deepStrictEqual(lines.map((l) => [l.rev, l.file, l.line]), [
		[rev, "notes/plan.md", 12],
		[rev, "src/a.ts", 7],
		[rev, "src/b:c.ts", 1],
		[rev, "web/src/x.ts", 2],
	]);
	deepStrictEqual(revisionHits(scanner, lines), [
		{ rev, file: "notes/plan.md", line: 12, term: "#3" },
		{ rev, file: "src/b:c.ts", line: 1, term: "#2" },
		{ rev, file: "web/src/x.ts", line: 2, term: "web/#1" },
	]);
	equal(revisionHits(scanner, []).length, 0);
});

Deno.test("check-public: --history applies snapshot rules to every commit not pushed yet", async () => {
	const repo = await createTempRepo();
	const script = new URL("./check-public.ts", import.meta.url).pathname;
	const history = () => repo.script(script, ["--history", "--require"]);
	try {
		await repo.writePrivate(
			"public-terms.json",
			JSON.stringify({
				terms: ["plugh"],
				snapshot: [{ pattern: "zork[0-9]", paths: [""] }],
				unpublished: {},
			}),
		);
		// A pushed commit is checked without the snapshot rules.
		const pushed = await repo.commit(
			{ "README.md": "a\n", "src/old.ts": "zork1\n" },
			"Tartan: public snapshot",
		);
		await repo.git(["update-ref", "refs/remotes/origin/main", pushed]);
		await repo.git(["update-ref", "refs/heads/public", pushed]);
		const clean = await history();
		equal(clean.code, 0, clean.err);
		ok(clean.out.includes("1 pushed and 0 pending commit(s) clean"));

		// An unpushed commit is checked with them, even under a clean tip.
		const middle = await repo.commit(
			{ "src/old.ts": null, "src/new.ts": "zork2\n" },
			"Tartan: public snapshot",
		);
		const tip = await repo.commit(
			{ "src/new.ts": "clean\n" },
			"Tartan: public snapshot",
		);
		await repo.git(["update-ref", "refs/heads/public", tip]);
		const dirty = await history();
		equal(dirty.code, 1);
		ok(
			dirty.err.includes(
				`${middle.slice(0, 7)}:src/new.ts:1: private term snapshot#1`,
			),
			dirty.err,
		);
		ok(!dirty.err.includes(tip.slice(0, 7)), dirty.err);

		// One commit on the pushed one with the clean tree passes.
		const squashed = await repo.git([
			"commit-tree",
			`${tip}^{tree}`,
			"-p",
			pushed,
			"-m",
			"Tartan: public snapshot",
		]);
		await repo.git(["update-ref", "refs/heads/public", squashed]);
		const again = await history();
		equal(again.code, 0, again.err);
		ok(again.out.includes("1 pushed and 1 pending commit(s) clean"));
	} finally {
		await repo.remove();
	}
});
