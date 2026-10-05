// The public-content check (AGENTS.md rule 8). The
// real term list is private, so these tests use a stand-in policy.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	ALLOWED_PATHS,
	allowedEntry,
	createScanner,
	parseGitGrep,
	parsePolicy,
	revisionHits,
	TERMS_FILE,
	UNPUBLISHED_PATHS,
} from "./check-public.ts";

const policy = parsePolicy({
	terms: ["plugh", "xyzzy", "frobozz"],
	scoped: { "web/": ["grue\\d"] },
	allowed: ["plughs?wood"],
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
	throws(() => parsePolicy(null), /expected an object/);
	throws(() => parsePolicy({ terms: [] }), /non-empty/);
	throws(() => parsePolicy({ terms: [""] }), /empty string/);
	throws(() => parsePolicy({ terms: ["a"], scoped: ["x"] }), /scoped/);
	throws(() => parsePolicy({ terms: ["a"], scoped: { "p/": "x" } }), /list/);
	throws(() => parsePolicy({ terms: ["a"], allowed: [1] }), /allowed/);
	throws(() => parsePolicy({ terms: ["a"], allowed: ["("] }));
	deepStrictEqual(parsePolicy({ terms: ["a"] }), {
		terms: ["a"],
		scoped: {},
		allowed: [],
	});
});

Deno.test("check-public: the term list is private", () => {
	ok(TERMS_FILE.startsWith(".private/"));
});

Deno.test("check-public: every excepted path is reviewed and never published", () => {
	const excepted = [
		"docs/GOALS.md",
		"docs/STATUS.md",
		"docs/design/ARCHITECTURE.md",
		"docs/design/PLAN.md",
		"docs/status/",
		"packages/contract/CHANGELOG.md",
	];
	deepStrictEqual(Object.keys(ALLOWED_PATHS).sort(), excepted);
	deepStrictEqual(UNPUBLISHED_PATHS, excepted);
	ok(Object.values(ALLOWED_PATHS).every((entry) => entry.reason.length > 0));
});

Deno.test("check-public: a directory entry covers the files under it, and only those", () => {
	ok(allowedEntry("docs/status/wp00.md"));
	ok(allowedEntry("docs/status/sub/x.md"));
	ok(allowedEntry("docs/STATUS.md"));
	equal(allowedEntry("docs/statusx.md"), undefined);
	equal(allowedEntry("docs/status"), undefined);
	equal(allowedEntry("docs/design/README.md"), undefined);
	equal(allowedEntry("README.md"), undefined);
});

Deno.test("check-public: parses git grep -z output; published revisions except no path", () => {
	const rev = "a".repeat(40);
	const output = [
		`${rev}:docs/design/PLAN.md\x0012\x00the frobozz here`,
		`${rev}:src/a.ts\x007\x00past plughwood`,
		`${rev}:src/b:c.ts\x001\x00x xyzzy`,
		`${rev}:web/src/x.ts\x002\x00grue1`,
		"",
	].join("\n");
	const lines = parseGitGrep(output);
	deepStrictEqual(lines.map((l) => [l.rev, l.file, l.line]), [
		[rev, "docs/design/PLAN.md", 12],
		[rev, "src/a.ts", 7],
		[rev, "src/b:c.ts", 1],
		[rev, "web/src/x.ts", 2],
	]);
	deepStrictEqual(revisionHits(scanner, lines), [
		{ rev, file: "docs/design/PLAN.md", line: 12, term: "#3" },
		{ rev, file: "src/b:c.ts", line: 1, term: "#2" },
		{ rev, file: "web/src/x.ts", line: 2, term: "web/#1" },
	]);
	equal(revisionHits(scanner, []).length, 0);
});
