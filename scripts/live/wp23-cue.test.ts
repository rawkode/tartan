// The WP23 live script's pure helpers: the net and info parsers, the
// percentile, the value digest and the leak scan.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	ANY_POSITION_RE,
	doublingTo,
	leaksIn,
	parseInfo,
	parseNet,
	parseVictim,
	percentile,
	valueDigest,
} from "./wp23-cue.ts";

Deno.test("wp23 parseNet: blocked only when all six checks failed", () => {
	const blocked = parseNet(
		[
			"root dns=2",
			"root tcp443=124",
			"root tcp53=1",
			"content dns=2",
			"content tcp443=1",
			"content tcp53=1",
			"---",
			"lo 127.0.0.1/8",
			"lo ::1/128",
		].join("\n"),
	);
	equal(blocked.blocked, true);
	deepStrictEqual(blocked.interfaces, ["lo"]);
	equal(blocked.checks["content tcp443"], 1);
	const open = parseNet(
		"root dns=0\nroot tcp443=1\nroot tcp53=1\ncontent dns=2\ncontent tcp443=1\ncontent tcp53=1\n---\neth0 10.0.0.2/24",
	);
	equal(open.blocked, false);
	deepStrictEqual(open.interfaces, ["eth0"]);
	equal(parseNet("root dns=2\n---\n").blocked, false, "a missing check fails");
});

Deno.test("wp23 parseInfo: architecture, CPUs, memory, the runner record and the limits", () => {
	const info = parseInfo(
		[
			"x86_64",
			"2",
			"MemTotal:        1000000 kB\nMemFree:          900000 kB",
			"memory.max=max",
			'{"cue":"v0.17.1"}',
			"core file size (blocks, -c) 0\nvirtual memory (kbytes, -v) unlimited\nstack size (kbytes, -s) 8192",
		].join("\n---\n"),
	);
	equal(info.arch, "x86_64");
	equal(info.cpus, 2);
	equal(info.memTotalKiB, 1000000);
	equal(info.cgroupMemoryMax, "memory.max=max");
	deepStrictEqual(info.runner, { cue: "v0.17.1" });
	deepStrictEqual(info.contentLimits, [
		"core file size (blocks, -c) 0",
		"virtual memory (kbytes, -v) unlimited",
	]);
	equal(parseInfo("aarch64").runner, null);
});

Deno.test("wp23 ANY_POSITION_RE: root files and the forge schema's files, nothing else", () => {
	for (
		const good of [
			"tartan.cue:4:11",
			"~tartan.cue:1:1",
			"cue.mod/pkg/tartan.dev/ext/ext.cue:24:12",
		]
	) ok(ANY_POSITION_RE.test(good), good);
	for (
		const bad of [
			"tartan.cue:4",
			"/tmp/x/tartan.cue:4:11",
			"sub/tartan.cue:4:11",
			"../x.cue:1:1",
			"tartan.cue:4:11 extra",
		]
	) ok(!ANY_POSITION_RE.test(bad), bad);
});

Deno.test("wp23 percentile: nearest rank", () => {
	const v = [5, 1, 4, 2, 3];
	equal(percentile(v, 50), 3);
	equal(percentile(v, 95), 5);
	equal(percentile([7], 95), 7);
	ok(Number.isNaN(percentile([], 50)));
	equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
});

Deno.test("wp23 valueDigest: sha256 of JSON.stringify, as the probe digests it", () => {
	const value = { b: 1, a: [true, "x"] };
	equal(
		valueDigest(value),
		createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	);
});

Deno.test("wp23 leaksIn: tokens, capability paths, bearer headers and the given secrets", () => {
	const secret = "s".repeat(43);
	deepStrictEqual(leaksIn('{"ok":true}', [secret]), []);
	equal(leaksIn("art_v1_abc", []).length, 1);
	deepStrictEqual(leaksIn("art_v1_<redacted>", []), []);
	equal(leaksIn("/-/cap/v1/x", []).length, 1);
	equal(leaksIn("Bearer abc", []).length, 1);
	deepStrictEqual(leaksIn(`x${secret}y`, [secret]), ["a secret value"]);
	deepStrictEqual(leaksIn("short", ["short"]), [], "short values are ignored");
});

Deno.test("wp23 parseVictim: the kernel's OOM victims and PID 1 before and after", () => {
	const v = parseVictim(
		[
			"pid1-start-before: 1234",
			"[ 5.1] Out of memory: Killed process 77 (cue) total-vm:1kB",
			"[ 9.2] oom-kill:constraint=CONSTRAINT_NONE,task=cue,pid=78,uid=1000",
			"---",
			"1234",
			"/sbin/init --flag",
		].join("\n"),
	);
	deepStrictEqual(v, {
		before: "1234",
		after: "1234",
		pid1: "/sbin/init --flag",
		killed: ["cue"],
	});
	const restarted = parseVictim(
		"pid1-start-before: 1234\n[1] Killed process 9 (other) x\n---\n99\nother",
	);
	deepStrictEqual(restarted.killed, ["other"]);
	equal(restarted.after, "99");
	equal(parseVictim("").before, "");
});

Deno.test("wp23 doublingTo: the corpus's string doubling to 2^n bytes", () => {
	const text = doublingTo(2);
	ok(text.startsWith("package tartan\n"));
	ok(text.includes('_s0: "x"\n_s1: _s0 + _s0\n_s2: _s1 + _s1\n'));
	ok(text.endsWith("settings: allow: [_s2]\n"));
});
