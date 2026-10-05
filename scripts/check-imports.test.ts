// The extension import boundary.

import { equal, ok } from "node:assert/strict";
import { classify } from "./check-imports.ts";

const ROOT = "extensions/work";
const FILE = "extensions/work/src/index.ts";
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
			"../../changes/src/index.ts",
			"../../../src/router.ts",
			"https://example.com/x.ts",
		]
	) {
		ok(verdict(specifier) !== undefined, specifier);
	}
});

const TEST = "extensions/work/test/work.test.ts";
const WORKERS_TEST = "extensions/work/test/host.workers.test.ts";

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
			"../../changes/src/index.ts",
			"../../../src/kernel/exthost/host/do.ts",
			"@tartan/testkitx",
		]
	) {
		ok(classify(ROOT, WORKERS_TEST, specifier) !== undefined, specifier);
	}
	ok(
		classify(ROOT, "extensions/work/src/test.ts", "vitest") !== undefined,
		"a production file named test.ts",
	);
});
