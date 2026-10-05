import { deepEqual, equal, ok } from "node:assert/strict";
import {
	createSelftest,
	gitAtLeast,
	parseSelftest,
	SELFTEST_INTERVAL_MS,
} from "./selftest.ts";
import { fakeDoState } from "./testing/fakes.ts";

const IMAGE = btoa(
	JSON.stringify({
		base: "docker.io/cloudflare/sandbox:0.12.1@sha256:abc",
		git: "1:2.55.0",
	}),
);
const GOOD = `git=2.55.0\npnpm=10.18.0\nusers=1\nmergetree=1\nimage=${IMAGE}\n`;

Deno.test("git ≥ 2.38 is required (merge-tree --write-tree)", () => {
	equal(gitAtLeast("2.34.1"), false);
	equal(gitAtLeast("2.38.0"), true);
	equal(gitAtLeast("2.55.0"), true);
	equal(gitAtLeast("3.0"), true);
	equal(gitAtLeast(null), false);
});

Deno.test("the selftest output is parsed into runner info", () => {
	const info = parseSelftest(GOOD, 5);
	deepEqual(info, {
		ok: true,
		gitVersion: "2.55.0",
		pnpmVersion: "10.18.0",
		mergeTree: true,
		users: true,
		image: {
			base: "docker.io/cloudflare/sandbox:0.12.1@sha256:abc",
			git: "1:2.55.0",
		},
		checkedAt: 5,
	});
	equal(
		parseSelftest("git=2.34.1\npnpm=\nusers=1\nmergetree=0\n", 1).ok,
		false,
	);
});

Deno.test("one start per 10 minutes; later calls get the last result or a retry hint", async () => {
	const state = fakeDoState();
	let now = 1_000_000;
	let execs = 0;
	let destroyed = 0;
	const selftest = createSelftest({
		sql: state.sql,
		exec: () => {
			execs += 1;
			if (execs === 1) {
				return Promise.reject(
					new Error("Default session initialization was invalidated"),
				);
			}
			return Promise.resolve({ exitCode: 0, stdout: GOOD, stderr: "" });
		},
		destroy: () => {
			destroyed += 1;
			return Promise.resolve();
		},
		now: () => now,
		sleep: () => Promise.resolve(),
	});
	const first = await selftest.run();
	ok(!("limited" in first) && first.ok, "retried past the first-start 500");
	equal(execs, 2);
	equal(destroyed, 1);
	now += 1000;
	deepEqual(await selftest.run(), first);
	equal(execs, 2, "no second container start");
	deepEqual(selftest.last(), first);
	now += SELFTEST_INTERVAL_MS;
	await selftest.run();
	equal(execs, 3);
});
