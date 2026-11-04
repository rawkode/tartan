// The textual read of a project's `.cue` files: the tokenizer, the package
// clause, literal name and deps, the `rawkode.issues` switch in every form, and
// project identity.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { PROJECT_SLUG_RE } from "@tartan/contract";
import { packageClause } from "../src/tartan/clause.ts";
import { assignIdentities, slugOf } from "../src/tartan/identity.ts";
import { isCueSourceName } from "../src/tartan/limits.ts";
import { mergeEnabled, readManifest } from "../src/tartan/manifest.ts";
import { MANIFEST_MAX_BYTES } from "../src/objects.ts";
import { scanCue } from "../src/tartan/scan.ts";

Deno.test('scan: comments go, strings become "", depth is counted outside both', () => {
	const lines = scanCue(`// top
a: "b // not a comment" // comment
x: {
	y: "}"
}
z: """
	{ not code
	"""
`);
	equal(lines[1].code.trim(), 'a: ""');
	deepStrictEqual(lines[1].strings, [
		{ raw: "b // not a comment", simple: true },
	]);
	equal(lines[2].depth, 0);
	equal(lines[3].depth, 1);
	equal(lines[4].depth, 1);
	equal(lines[5].depth, 0);
	ok(lines[6].continued);
	equal(lines[8].depth, 0);
});

Deno.test("scan: CRLF, a BOM and an unterminated string do not break line accounting", () => {
	const lines = scanCue('﻿name: "a"\r\nb: "oops\r\nc: 1\r\n');
	equal(lines[0].strings[0].raw, "a");
	equal(lines[2].code, "c: 1");
});

Deno.test("clause: the first line that is not blank, a comment or an attribute", () => {
	deepStrictEqual(packageClause("package tartan\n"), {
		name: "tartan",
		attributes: [],
	});
	equal(
		packageClause("// header\n\n\tpackage tartan // config\n").name,
		"tartan",
	);
	equal(packageClause("﻿// x\r\npackage codegen\r\n").name, "codegen");
	equal(packageClause('import "strings"\n').name, null);
	equal(packageClause("").name, null);
	deepStrictEqual(packageClause("@if(prod)\npackage tartan\n"), {
		name: "tartan",
		attributes: ["if"],
	});
});

Deno.test("clause: a long licence header above the clause does not hide it", () => {
	const header = "// licence line, long enough to matter\n".repeat(400);
	ok(header.length > 10_000);
	equal(packageClause(`${header}package tartan\n`).name, "tartan");
	equal(packageClause(`${"\n".repeat(5000)}package late\n`).name, "late");
});

Deno.test("files: the CUE loader's default set", () => {
	for (const name of ["forge.cue", "a.b.cue", "tool.cue", "test.cue"]) {
		ok(isCueSourceName(name), name);
	}
	for (
		const name of [
			"_x.cue",
			".x.cue",
			"x_tool.cue",
			"x_test.cue",
			"x.cue.bak",
			"cue",
		]
	) {
		ok(!isCueSourceName(name), name);
	}
});

Deno.test("name: a literal top-level name, in any spacing or with a comma", () => {
	equal(readManifest('package tartan\nname: "api"\n').name, "api");
	equal(readManifest('package tartan\n"name": "api"\n').name, "api");
	equal(readManifest('package tartan\nname:   "api" , x: 1\n').name, "api");
	equal(readManifest('package tartan\nname?: "api"\n').name, "api");
});

Deno.test("name: not a literal, or not at the top level, is no name", () => {
	const computed = [
		'name: "\\(x)"',
		"name: x",
		'name: strings.ToLower("A")',
		'name: "a" + "b"',
		'name: #"a"#',
		'name: """\n\ta\n\t"""',
	];
	for (const body of computed) {
		const facts = readManifest(`package tartan\n${body}\n`);
		equal(facts.name, undefined, body);
		ok(facts.computedName, body);
	}
	const elsewhere = [
		'x: { name: "a" }',
		'x: name: "a"',
		'// name: "a"',
		'y: """\nname: "a"\n"""',
	];
	for (const body of elsewhere) {
		const facts = readManifest(`package tartan\n${body}\n`);
		equal(facts.name, undefined, body);
		ok(!facts.computedName, body);
	}
});

Deno.test("deps: literal lists on one line or several", () => {
	deepStrictEqual(readManifest('deps: ["a", "b"]\n').deps, ["a", "b"]);
	deepStrictEqual(
		readManifest('deps: [\n\t"a", // first\n\t"b",\n]\nname: "x"\n'),
		{
			name: "x",
			computedName: false,
			invalidName: false,
			deps: ["a", "b"],
			computedDeps: false,
			issues: { state: "absent" },
		},
	);
	equal(readManifest("x: 1\n").computedDeps, false);
	deepStrictEqual(readManifest("deps: []\n").deps, []);
});

Deno.test("deps: what is not a literal string is reported and dropped", () => {
	const mixed = readManifest('deps: ["a", other, "\\(b)"]\n');
	deepStrictEqual(mixed.deps, ["a"]);
	ok(mixed.computedDeps);
	const computed = readManifest("deps: other\n");
	deepStrictEqual(computed.deps, []);
	ok(computed.computedDeps);
	ok(readManifest('deps: ["a"] + ["b"]\n').computedDeps);
});

const off = { state: "read", enabled: false };
const on = { state: "read", enabled: true };

Deno.test("extensions: the one-line and block forms", () => {
	const forms: readonly (readonly [string, unknown])[] = [
		['extensions: "rawkode.issues": enabled: false', off],
		['extensions: "rawkode.issues": enabled: true', on],
		['extensions: "rawkode.issues": { enabled: false }', off],
		['extensions: { "rawkode.issues": enabled: false }', off],
		['extensions: { "rawkode.issues": { enabled: false } }', off],
		[
			'extensions: {\n\t"rawkode.issues": {\n\t\tenabled: false\n\t}\n}',
			off,
		],
		['extensions: {\n\t"rawkode.issues": enabled: false\n}', off],
		['extensions: "rawkode.issues": {\n\tenabled: false\n}', off],
		['"extensions": {"rawkode.issues": {"enabled": false}}', off],
		[
			'extensions: {\n\t"other.ext": enabled: false\n\t"rawkode.issues": {\n\t\tx: 1\n\t\tenabled: false\n\t}\n}',
			off,
		],
		['extensions: "rawkode.issues": {x: 1, enabled: false, y: 2}', off],
	];
	for (const [body, want] of forms) {
		deepStrictEqual(
			readManifest(`package tartan\n\n${body}\nname: "n"\n`).issues,
			want,
			body,
		);
		equal(readManifest(`package tartan\n\n${body}\nname: "n"\n`).name, "n");
	}
});

Deno.test("extensions: nothing said means absent, so the extension stays on", () => {
	const absent = { state: "absent" };
	for (
		const body of [
			"",
			'name: "x"',
			"extensions: {}",
			'extensions: "other.ext": enabled: false',
			'extensions: "rawkode.other": enabled: false',
			'// extensions: "rawkode.issues": enabled: false',
		]
	) {
		deepStrictEqual(
			readManifest(`package tartan\n${body}\n`).issues,
			absent,
			body,
		);
	}
	deepStrictEqual(
		readManifest('extensions: "rawkode.issues": {}\n').issues,
		absent,
	);
});

Deno.test("extensions: a form it cannot read is unreadable, never a switch-off", () => {
	for (
		const body of [
			'extensions: "rawkode.issues": enabled: bool',
			'extensions: "rawkode.issues": enabled: *false | bool',
			'extensions: "rawkode.issues": enabled: !true',
			'extensions: "rawkode.issues": enabled: "false"',
			'extensions: "rawkode.issues": other',
			"extensions: other",
			"extensions: { other }",
			'extensions: "rawkode.issues": { other, x: 1 }',
			'x: { extensions: "rawkode.issues": enabled: false }',
			'if true { extensions: "rawkode.issues": enabled: false }',
			'#Base & { extensions: "rawkode.issues": enabled: false }',
			'let e = "rawkode.issues"',
		]
	) {
		equal(
			readManifest(`package tartan\n${body}\n`).issues.state,
			"unreadable",
			body,
		);
	}
});

Deno.test("extensions: declarations merge; a conflict is unreadable", () => {
	equal(
		readManifest(
			'extensions: "rawkode.issues": enabled: false\nextensions: "rawkode.issues": enabled: true\n',
		).issues.state,
		"unreadable",
	);
	deepStrictEqual(
		readManifest(
			'extensions: "rawkode.issues": enabled: false\nextensions: "rawkode.issues": enabled: false\n',
		).issues,
		off,
	);
	deepStrictEqual(mergeEnabled([]), { state: "absent" });
	deepStrictEqual(mergeEnabled([{ state: "absent" }, off as never]), off);
});

Deno.test("a malformed file reads without throwing", () => {
	for (
		const body of [
			"}}}",
			"[[[",
			"extensions:",
			'extensions: "rawkode.issues":',
			"name:",
			'"',
			':::\n,,,\n{"a"',
		]
	) {
		const facts = readManifest(`package tartan\n${body}`);
		equal(facts.name, undefined, body);
	}
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

Deno.test("identity: duplicate names are made unique by root order, declaredName keeps the raw name", async () => {
	const ids = await assignIdentities([
		{ root: "services/b", name: "api" },
		{ root: "services/a", name: "api" },
		{ root: "web", name: "web" },
	]);
	deepStrictEqual(
		ids.map((i) => [i.root, i.name, i.declaredName, i.slug]),
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

/** Pathological files of `MANIFEST_MAX_BYTES`: none may throw or take long. */
Deno.test("readManifest: a hostile file at the size limit neither throws nor stalls", () => {
	const fill = (unit: string) =>
		`package tartan\n${unit.repeat(MANIFEST_MAX_BYTES / unit.length)}`;
	const hostile = {
		"nested fields": fill("a: "),
		"nested fields, one per line": fill("a:\n"),
		"open braces": fill("{"),
		"open brackets": fill("["),
		"open parens": fill("("),
		"a field of braces": `package tartan\nx: ${"{".repeat(100_000)}`,
		"a field of lists": `package tartan\nx: ${"[".repeat(100_000)}`,
		"nested structs": fill("a: {"),
		"nested lists": fill("a: ["),
		"closers": fill("}"),
		"hashes": fill("#"),
		"a hashed string of quotes": `package tartan\nx: ${"#".repeat(16)}"${
			'"'.repeat(200_000)
		}`,
		"interpolations": fill('"\\('),
		"identifiers on one line": fill("a "),
		"unterminated strings": fill('"\n'),
		"quotes": fill('"'),
		"many fields": fill("a: 1\n"),
		"many names": fill('name: "x"\n'),
		"many deps": `package tartan\ndeps: [${'"a",'.repeat(60_000)}]`,
	};
	for (const [label, text] of Object.entries(hostile)) {
		const started = performance.now();
		const facts = readManifest(text);
		const ms = performance.now() - started;
		ok(ms < 2_000, `${label}: ${Math.round(ms)} ms`);
		ok(facts.issues.state !== "read", label);
	}
});

Deno.test("readManifest: past the nesting limit a value is opaque, and what is above it still reads", () => {
	const deep = "x: ".repeat(1_000) + "1";
	const facts = readManifest(
		`package tartan\nname: "kept"\ndeps: ["a"]\nother: ${deep}\n`,
	);
	equal(facts.name, "kept");
	deepStrictEqual(facts.deps, ["a"]);
	// A switch buried past the limit cannot be read: it stays on, with a warning.
	const buried = readManifest(
		`package tartan\nextensions: ${
			"{".repeat(100)
		}"rawkode.issues": enabled: false\n`,
	);
	equal(buried.issues.state, "unreadable");
});

Deno.test("readManifest: a literal name with characters a name cannot hold is invalid, not computed", () => {
	for (const name of ["a:b", "c/d", "has space", "<script>"]) {
		const facts = readManifest(`package tartan\nname: "${name}"\n`);
		equal(facts.name, undefined, name);
		ok(facts.invalidName, name);
		ok(!facts.computedName, name);
	}
	ok(readManifest("package tartan\nname: x\n").computedName);
	ok(!readManifest("package tartan\nname: x\n").invalidName);
	ok(!readManifest('package tartan\nname: "ok"\n').invalidName);
});
