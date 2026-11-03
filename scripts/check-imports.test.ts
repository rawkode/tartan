// The extension import boundary, on specifiers and on temporary extension
// trees (none of the repository's own extensions is read).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import * as path from "node:path";
import { checkRoot, classify } from "./check-imports.ts";

const ROOT = "extensions/issues";
const FILE = "extensions/issues/src/index.ts";
const verdict = (specifier: string) => classify(ROOT, FILE, specifier);

Deno.test("check-imports: the portable contract, ext-api and local files are allowed", () => {
	for (
		const specifier of [
			"@tartan/contract",
			"@tartan/contract/ui.ts",
			"@tartan/contract/interfaces.ts",
			"@tartan/ext-api",
			"@tartan/ext-api/ui.ts",
			"./migrations.ts",
			"../tartan.json",
		]
	) {
		equal(verdict(specifier), undefined, specifier);
	}
});

Deno.test("check-imports: kernel-only contract entry points are rejected", () => {
	for (
		const specifier of [
			"@tartan/contract/kernel",
			"@tartan/contract/kernel.ts",
			"@tartan/contract/ports.ts",
			"@tartan/contract/security.ts",
			"@tartan/contract/services.ts",
			"@tartan/contract/do/repo.ts",
			"@tartan/contract/do",
		]
	) {
		ok(verdict(specifier)?.includes("kernel-only"), specifier);
	}
});

Deno.test("check-imports: other packages, kernel paths and sibling extensions are rejected", () => {
	for (
		const specifier of [
			"zod",
			"node:crypto",
			"cloudflare:workers",
			"../../other/src/index.ts",
			"../../../src/router.ts",
			"https://example.com/x.ts",
		]
	) {
		ok(verdict(specifier) !== undefined, specifier);
	}
});

const TEST = "extensions/issues/test/issues.test.ts";
const WORKERS_TEST = "extensions/issues/test/host.workers.test.ts";

Deno.test("check-imports: test files may also import the test tooling", () => {
	for (const file of [TEST, WORKERS_TEST]) {
		for (
			const specifier of [
				"node:assert/strict",
				"@tartan/testkit",
				"@tartan/testkit/fakes.ts",
				"vitest",
				"cloudflare:test",
				"cloudflare:workers",
				"@cloudflare/vitest-pool-workers/types",
			]
		) {
			equal(classify(ROOT, file, specifier), undefined, `${file} ${specifier}`);
		}
	}
});

Deno.test("check-imports: production files may not, and test files keep every other rule", () => {
	for (
		const specifier of [
			"node:assert/strict",
			"@tartan/testkit",
			"vitest",
			"cloudflare:test",
		]
	) {
		ok(verdict(specifier) !== undefined, specifier);
	}
	for (
		const specifier of [
			"node:crypto",
			"node:assert",
			"zod",
			"@tartan/contract/kernel.ts",
			"../../other/src/index.ts",
			"../../../src/kernel/exthost/host/do.ts",
			"@tartan/testkitx",
		]
	) {
		ok(classify(ROOT, WORKERS_TEST, specifier) !== undefined, specifier);
	}
	ok(
		classify(ROOT, "extensions/issues/src/test.ts", "vitest") !== undefined,
		"a production file named test.ts",
	);
});

Deno.test("check-imports: a missing root or an empty one has nothing to check", async () => {
	const root = await Deno.makeTempDir({ prefix: "tartan-check-imports-" });
	try {
		equal(await checkRoot(path.join(root, "extensions")), null);
		await Deno.mkdir(path.join(root, "extensions"));
		deepStrictEqual(await checkRoot(path.join(root, "extensions")), {
			extensions: 0,
			violations: [],
		});
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("check-imports: a fixture tree reports each forbidden import by file", async () => {
	const root = await Deno.makeTempDir({ prefix: "tartan-check-imports-" });
	const ext = path.join(root, "extensions");
	const write = async (file: string, text: string) => {
		await Deno.mkdir(path.dirname(path.join(ext, file)), { recursive: true });
		await Deno.writeTextFile(path.join(ext, file), text);
	};
	try {
		await write(
			"good/src/index.ts",
			[
				'import { parseManifest } from "@tartan/contract";',
				'import type { Ui } from "@tartan/ext-api";',
				'import manifest from "../tartan.json" with { type: "json" };',
				'// import "zod" in a comment never counts',
				"const s = \"import 'node:fs'\";",
				"",
			].join("\n"),
		);
		await write(
			"good/test/good.test.ts",
			'import { equal } from "node:assert/strict";\n',
		);
		await write(
			"bad/src/index.ts",
			[
				'import { z } from "zod";',
				'export * from "../../good/src/index.ts";',
				'const k = await import("@tartan/contract/kernel.ts");',
				"",
			].join("\n"),
		);
		await write("bad/dist/main.js", 'import "zod";\n');
		const result = await checkRoot(ext);
		equal(result?.extensions, 2);
		deepStrictEqual(
			result?.violations.map((v) => [path.relative(ext, v.file), v.specifier]),
			[
				["bad/src/index.ts", "zod"],
				["bad/src/index.ts", "../../good/src/index.ts"],
				["bad/src/index.ts", "@tartan/contract/kernel.ts"],
			],
		);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
