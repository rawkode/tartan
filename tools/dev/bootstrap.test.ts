import assert from "node:assert/strict";
import { parseBootstrapArgs, setupCodeIn, storeCookies } from "./bootstrap.ts";

Deno.test("setupCodeIn: the last code in the launcher's output", () => {
	assert.equal(setupCodeIn("[tartan-dev] forge: https://localhost"), null);
	assert.equal(
		setupCodeIn("[tartan] setup code: first\nx\n[tartan] setup code: second\n"),
		"second",
	);
});

Deno.test("storeCookies: keeps name=value only, and the newest value", () => {
	const jar = new Map([["a", "old"]]);
	storeCookies(jar, ["a=new; Path=/; Secure", "b=c=d; HttpOnly", "bad"]);
	assert.deepEqual([...jar], [["a", "new"], ["b", "c=d"]]);
});

Deno.test("parseBootstrapArgs: both flags are required", () => {
	assert.deepEqual(
		parseBootstrapArgs(["--origin", "https://localhost:8801/", "--log", "l"]),
		{ origin: "https://localhost:8801", log: "l" },
	);
	assert.throws(() => parseBootstrapArgs(["--log", "l"]), /--origin/);
});
