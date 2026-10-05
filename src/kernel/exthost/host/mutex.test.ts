// The per-ExtensionDO FIFO mutex.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createMutex } from "./mutex.ts";

Deno.test("mutex: tasks run one at a time, in arrival order, and a failure never wedges it", async () => {
	const mutex = createMutex();
	const trace: string[] = [];
	const task = (name: string, ms: number, fail = false) =>
		mutex.run(async () => {
			trace.push(`start ${name}`);
			await new Promise((r) => setTimeout(r, ms));
			trace.push(`end ${name}`);
			if (fail) throw new Error(name);
			return name;
		});
	const results = await Promise.allSettled([
		task("a", 10),
		task("b", 1, true),
		task("c", 1),
	]);
	deepStrictEqual(trace, [
		"start a",
		"end a",
		"start b",
		"end b",
		"start c",
		"end c",
	]);
	deepStrictEqual(results.map((r) => r.status), [
		"fulfilled",
		"rejected",
		"fulfilled",
	]);
	strictEqual(mutex.locked, false);
	strictEqual(mutex.waiting, 0);
});
