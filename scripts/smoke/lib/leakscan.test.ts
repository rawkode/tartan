// The smoke leak scan catches live token shapes, capability paths, URL
// credentials and secret files, and passes redacted evidence.

import { deepStrictEqual, equal } from "node:assert/strict";
import { redactSecrets } from "@tartan/contract";
import { scanDirs, scanTextForLeaks } from "./leakscan.ts";

const fakeHex = "0123456789abcdef0123456789abcdef01234567";

Deno.test("leakscan flags tokens, capability paths and credentials", () => {
	const lines = [
		`token art_v2_x_${fakeHex}?expires=2000000000`,
		`old art_v1_${fakeHex}`,
		`cap /-/cap/v1/2000000000/ln_01k6aaaaaaaaaaaaaaaaaaaaaa/${"a".repeat(32)}/${
			"b".repeat(64)
		}/01k6rrrrrrrrrrrrrrrrrrrrrr.git`,
		"remote https://x:secret-password@host.example/git/r.git",
		`Authorization: Bearer ${fakeHex}`,
		`SMOKE_KEY=${fakeHex}`,
	].join("\n");
	deepStrictEqual(
		scanTextForLeaks("e.txt", lines).map((l) => l.rule),
		[
			"artifacts-token",
			"artifacts-token",
			"capability-path",
			"url-credentials",
			"authorization-header",
			"smoke-secret",
		],
	);
});

Deno.test("redacted evidence passes", () => {
	const redacted = redactSecrets(
		`art_v2_x_${fakeHex}?expires=1 /-/cap/v1/2000000000/ln_01k6aaaaaaaaaaaaaaaaaaaaaa/${
			"a".repeat(32)
		}/${"b".repeat(64)}/x.git`,
	);
	deepStrictEqual(scanTextForLeaks("e.txt", redacted), []);
	deepStrictEqual(
		scanTextForLeaks("e.txt", "SMOKE_KEY=<redacted>\nGIT_PASSWORD="),
		[],
	);
});

Deno.test("secret files inside evidence are leaks", async () => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-leakscan-" });
	try {
		await Deno.mkdir(`${dir}/work/.git`, { recursive: true });
		await Deno.writeTextFile(`${dir}/work/.git/config`, "[core]\n");
		await Deno.writeTextFile(`${dir}/.dev.vars`, "X=1\n");
		await Deno.writeTextFile(`${dir}/ok.json`, "{}\n");
		const leaks = await scanDirs([dir]);
		equal(leaks.length, 2);
		deepStrictEqual(
			new Set(leaks.map((l) => l.rule)),
			new Set(["forbidden-file"]),
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
