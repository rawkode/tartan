// The queue engine and its test support are shared by tartan.weave and
// tartan.fifo as byte-identical copies, because an extension may import only
// `@tartan/contract`, `@tartan/ext-api` and its own files.
// This fails when the copies drift: edit `extensions/weave/…` and copy.

import { equal } from "./assert.ts";

const COPIES = ["src/engine.ts", "test/kernel.ts", "test/assert.ts"];

Deno.test("fifo's engine and test support are copies of weave's", async () => {
	for (const path of COPIES) {
		const fifo = await Deno.readTextFile(
			new URL(`../${path}`, import.meta.url),
		);
		const weave = await Deno.readTextFile(
			new URL(`../../weave/${path}`, import.meta.url),
		);
		equal(
			fifo === weave,
			true,
			`${path} drifted from extensions/weave/${path}`,
		);
	}
});
