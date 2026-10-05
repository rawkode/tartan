// The smoke runner's arguments, and a full local run of both suites (the
// drivers against the smoke Workers' handlers with FakeArtifacts and stock
// git on loopback ports).

import { deepStrictEqual, equal } from "node:assert/strict";
import { parseArgs } from "./run.ts";

Deno.test("parseArgs: local implies small; stages and filters", () => {
	const local = parseArgs(["--local", "--only", "A1,U45"]);
	equal(local.local, true);
	equal(local.small, true);
	equal(local.stage, "local");
	deepStrictEqual([...local.only!], ["A1", "U45"]);
	deepStrictEqual(local.suites, ["git", "lanes"]);
	const live = parseArgs([
		"--stage",
		"dev-wp01",
		"--suite",
		"lanes",
		"--deploy",
	]);
	equal(live.stage, "dev-wp01");
	deepStrictEqual(live.suites, ["lanes"]);
	equal(live.deploy, true);
	equal(live.small, false);
});

Deno.test({
	name: "the smoke suites pass locally against FakeArtifacts",
	// Spawns stock git and loopback servers.
	sanitizeOps: false,
	sanitizeResources: false,
	fn: async () => {
		const out = await new Deno.Command(Deno.execPath(), {
			args: [
				"run",
				"-A",
				"--config",
				new URL("../../deno.json", import.meta.url).pathname,
				new URL("./run.ts", import.meta.url).pathname,
				"--local",
			],
			stdout: "piped",
			stderr: "piped",
		}).output();
		const text = new TextDecoder().decode(out.stdout);
		equal(out.code, 0, text + new TextDecoder().decode(out.stderr));
		equal(/^FAIL /m.test(text), false, text);
	},
});
