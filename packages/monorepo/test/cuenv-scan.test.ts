// The Tier 0 text rules (WP25 slice A′): the CUE tokenizer, the env.cue
// classifier, the package-clause reader and project identity (names unique
// by construction, slugs).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { isCuenvClause, packageClause } from "../src/cuenv/clause.ts";
import { assignIdentities, slugOf } from "../src/cuenv/identity.ts";
import { classifyEnvCue, scanCue } from "../src/cuenv/scan.ts";
import { PROJECT_SLUG_RE } from "@tartan/contract";

const env = (body: string) =>
	`package cuenv\n\nimport "github.com/cuenv/cuenv/schema"\n\n${body}`;

Deno.test('scan: comments go, strings become "", depth is counted outside both', () => {
	const lines = scanCue(
		[
			'a: "x { y" // } not counted',
			"b: {",
			'\tc: #"raw "quoted" { "#',
			"}",
			"d: '''",
			"\t{ inside a multi-line byte string",
			"\t'''",
			'e: "\\(f + "nested }")" & "g"',
		].join("\n"),
	);
	deepStrictEqual(lines.map((l) => [l.depth, l.continued, l.code]), [
		[0, false, 'a: "" '],
		[0, false, "b: {"],
		[1, false, '\tc: ""'],
		[1, false, "}"],
		[0, false, 'd: ""'],
		[0, true, ""],
		[0, true, ""],
		[0, false, 'e: "" & ""'],
	]);
	deepStrictEqual(lines[0].strings, [{ raw: "x { y", simple: true }]);
	deepStrictEqual(lines[2].strings, [{
		raw: 'raw "quoted" { ',
		simple: false,
	}]);
	equal(lines[7].strings.length, 2);
	equal(lines[7].strings[0].simple, false);
	deepStrictEqual(lines[7].strings[1], { raw: "g", simple: true });
});

Deno.test("scan: CRLF, a BOM and an unterminated string do not break line accounting", () => {
	const lines = scanCue('﻿a: 1\r\nb: "open\r\nc: 2\r\n');
	deepStrictEqual(lines.map((l) => l.code), ["a: 1", 'b: ""', "c: 2", ""]);
	equal(lines[1].strings[0].simple, false);
});

Deno.test("classify: both demo forms and the layer form", () => {
	deepStrictEqual(
		classifyEnvCue(env('schema.#Project\n\nname: "rawkode-academy-website"\n')),
		{
			kind: "project",
			kindLine: 5,
			name: "rawkode-academy-website",
			nameLine: 7,
		},
	);
	deepStrictEqual(
		classifyEnvCue(
			env(
				'schema.#Project & {\n\tname: "rawkode-cloud"\n\ttasks: {\n\t\tbuild: {name: "nope"}\n\t}\n}\n',
			),
		),
		{ kind: "project", kindLine: 5, name: "rawkode-cloud", nameLine: 6 },
	);
	deepStrictEqual(classifyEnvCue(env("schema.#Base\n\nenv: {}\n")), {
		kind: "base",
		kindLine: 5,
	});
	equal(classifyEnvCue(env("env: {}\n")).kind, "unknown");
});

Deno.test("classify (adversarial): #Project in a comment, a string, a multi-line string or a hidden field is no project", () => {
	for (
		const body of [
			'// schema.#Project\nname: "x"\n',
			'note: "schema.#Project"\n',
			'note: """\n\tschema.#Project\n\tname: "x"\n\t"""\n',
			"_x: schema.#Project\n",
			'_x: schema.#Project & {\n\tname: "x"\n}\n',
			"schema.#ProjectReference\n",
		]
	) {
		equal(classifyEnvCue(env(body)).kind, "unknown", body);
	}
	// A #Project embedding with #Base too is a project.
	equal(
		classifyEnvCue(env('schema.#Base\nschema.#Project\nname: "both"\n')).kind,
		"project",
	);
});

Deno.test("classify (adversarial): only a literal name at depth 0 or in the #Project block counts", () => {
	// Computed names.
	for (
		const body of [
			"schema.#Project\nname: _svc.name\n",
			'schema.#Project\nname: "a\\(b)"\n',
			'schema.#Project\nname: "with space"\n',
			'schema.#Project\nname: #"raw"#\n',
			// A nested name is a task's, not the project's.
			'schema.#Project\ntasks: {\n\tname: "task-name"\n}\n',
			'schema.#Project\nlist: [\n\tname: "x"\n]\n',
		]
	) {
		const facts = classifyEnvCue(env(body));
		equal(facts.kind, "project");
		equal(facts.name, undefined, body);
	}
	// The first literal wins; comments after it are fine.
	equal(
		classifyEnvCue(
			env('schema.#Project\nname: "first" // the name\nname: "second"\n'),
		).name,
		"first",
	);
	// Over 128 characters is still reported (the detector refuses it).
	equal(
		classifyEnvCue(env(`schema.#Project\nname: "${"n".repeat(129)}"\n`)).name
			?.length,
		129,
	);
});

Deno.test("clause: the first line that is not blank, a comment or an attribute", () => {
	deepStrictEqual(packageClause("package cuenv\n"), {
		name: "cuenv",
		attributeFirst: false,
		attributes: [],
	});
	equal(
		packageClause("// header\n\n\tpackage tartan // config\n").name,
		"tartan",
	);
	equal(packageClause("﻿// x\r\npackage codegen\r\n").name, "codegen");
	equal(packageClause('import "strings"\n').name, null);
	equal(packageClause("").name, null);
	deepStrictEqual(packageClause("@if(prod)\npackage cuenv\n"), {
		name: "cuenv",
		attributeFirst: true,
		attributes: ["if"],
	});
	ok(isCuenvClause(packageClause("// c\npackage cuenv\n")));
	ok(!isCuenvClause(packageClause("@if(prod)\npackage cuenv\n")));
	ok(!isCuenvClause(packageClause("package other\n")));
	// Only the head of the file is read.
	equal(packageClause(`${"\n".repeat(2000)}package late\n`).name, null);
});

Deno.test("slug: lowercase, [a-z0-9.-], trimmed, valid", () => {
	equal(slugOf("rawkode-academy-website"), "rawkode-academy-website");
	equal(slugOf("Rawkode Academy_Site"), "rawkode-academy-site");
	equal(slugOf("..a.b--"), "a.b");
	equal(slugOf("@@@"), "project");
	equal(slugOf("x".repeat(300)).length, 128);
	for (const s of ["a", "a.b", "web@projects-a"].map(slugOf)) {
		ok(PROJECT_SLUG_RE.test(s), s);
	}
});

Deno.test("identity: duplicate names are made unique by root order, cuenvName keeps the raw name", async () => {
	const ids = await assignIdentities([
		{ root: "services/b", name: "api" },
		{ root: "services/a", name: "api" },
		{ root: "web", name: "web" },
	]);
	deepStrictEqual(
		ids.map((i) => [i.root, i.name, i.cuenvName, i.slug]),
		[
			["services/a", "api", undefined, "api"],
			["services/b", "api@services-b", "api", "api-services-b"],
			["web", "web", undefined, "web"],
		],
	);
	deepStrictEqual(ids[0].issues.map((i) => i.code), ["duplicate-name"]);
	deepStrictEqual(ids[1].issues.map((i) => i.code), ["duplicate-name"]);
	deepStrictEqual(ids[2].issues, []);
});

Deno.test("identity: a slug shared by two names suffixes every colliding root, deterministically", async () => {
	const inputs = [
		{ root: "x/one", name: "a.b" },
		{ root: "x/two", name: "A.B" },
		{ root: "y", name: "c" },
	];
	const ids = await assignIdentities(inputs);
	const again = await assignIdentities([...inputs].reverse());
	deepStrictEqual(ids, again);
	ok(ids[0].slug.startsWith("a.b-") && ids[1].slug.startsWith("a.b-"));
	ok(ids[0].slug !== ids[1].slug);
	equal(ids[2].slug, "c");
	for (const i of ids) ok(PROJECT_SLUG_RE.test(i.slug), i.slug);
	deepStrictEqual(ids[0].issues.map((i) => i.code), ["slug-collision"]);
});
