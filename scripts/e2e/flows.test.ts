// Unit tests for the e2e flow helpers (e2e/support/*): the cross-worker
// store the gateway, lanes and CUE suites share, the gateway checks (refusal
// lines, control characters, hand-built receive-pack bodies) and the notices
// of a tool result.

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import * as path from "node:path";
import {
	commandSection,
	controlsIn,
	echoEnabled,
	PARSER_PROBES,
	pktLine,
	receivePackAllowlist,
	refusedWith,
	refusedWithAny,
	tartanRemoteLines,
} from "../../e2e/support/gateway.ts";
import { noticesOf } from "../../e2e/support/mcp.ts";
import { createShared, keyOf, StepFailed } from "../../e2e/support/shared.ts";

const tempDir = () => Deno.makeTempDir({ prefix: "tartan-e2e-flows-" });

// ---------------------------------------------------------------------------
// The shared store
// ---------------------------------------------------------------------------

Deno.test("a shared step runs once across workers; every caller gets its value", async () => {
	const dir = await tempDir();
	try {
		// Two stores on one directory stand for two worker processes.
		const one = createShared(path.join(dir, "s"), { pollMs: 5 });
		const two = createShared(path.join(dir, "s"), { pollMs: 5 });
		let runs = 0;
		let release = () => {};
		const gate = new Promise<void>((r) => release = r);
		const work = async () => {
			runs++;
			await gate;
			return { lane: "ln_1", heads: ["a", "b"] };
		};
		const first = one.once("step", work);
		const second = two.once("step", work);
		const third = one.once("step", work);
		equal(await one.settled("step"), false);
		release();
		deepStrictEqual(await first, { lane: "ln_1", heads: ["a", "b"] });
		deepStrictEqual(await second, await first);
		deepStrictEqual(await third, await first);
		equal(runs, 1);
		equal(await two.settled("step"), true);
		// The directory and its files are private.
		equal((await Deno.stat(path.join(dir, "s"))).mode! & 0o777, 0o700);
		equal(
			(await Deno.stat(path.join(dir, "s", "step.json"))).mode! & 0o777,
			0o600,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("a failed shared step fails every waiter with the step's name", async () => {
	const dir = await tempDir();
	try {
		const one = createShared(dir, { pollMs: 5 });
		const two = createShared(dir, { pollMs: 5 });
		await rejects(
			one.once("ci", () => Promise.reject(new Error("CI failed for change A"))),
			(e: unknown) =>
				e instanceof StepFailed && e.step === "ci" &&
				/CI failed for change A/.test(e.message),
		);
		await rejects(
			two.once("ci", () => Promise.resolve(1)),
			/step "ci" failed: CI failed for change A/,
		);
		// A waiter gives up (bounded) when nobody ever writes the outcome.
		const stuck = createShared(path.join(dir, "stuck"), { pollMs: 5 });
		const never = stuck.once("x", () => new Promise<number>(() => {}));
		// The first store holds the step before the second asks for it.
		for (let i = 0; i < 200; i++) {
			const held = await Deno.stat(path.join(dir, "stuck", "x.lock")).then(
				() => true,
				() => false,
			);
			if (held) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await rejects(
			createShared(path.join(dir, "stuck"), { pollMs: 5 }).once(
				"x",
				() => Promise.resolve(1),
				{ waitMs: 50 },
			),
			/no outcome after/,
		);
		void never;
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("claim indexes count the callers of a key; marks are flags", async () => {
	const dir = await tempDir();
	try {
		const one = createShared(dir);
		const two = createShared(dir);
		deepStrictEqual(
			await Promise.all([
				one.claimIndex("t"),
				two.claimIndex("t"),
				one.claimIndex("t"),
			]).then((xs) => xs.sort()),
			[0, 1, 2],
		);
		equal(await one.claimIndex("other"), 0);
		equal(await two.has("m"), false);
		await one.mark("m");
		await one.mark("m");
		equal(await two.has("m"), true);
		await rejects(
			one.once("../escape", () => Promise.resolve(1)),
			/a bad shared key/,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("keys from test titles are stable and file-safe", () => {
	const key = keyOf("3. each agent pushes to its lane; radar predicts it");
	equal(key, keyOf("3. each agent pushes to its lane; radar predicts it"));
	match(key, /^[a-z0-9-]+-[0-9a-f]{8}$/);
	ok(keyOf("a") !== keyOf("b"));
	ok(keyOf("x".repeat(500)).length < 70);
});

// ---------------------------------------------------------------------------
// Gateway checks
// ---------------------------------------------------------------------------

Deno.test("git's refusal lines are read in the human and porcelain forms", () => {
	const human =
		"To https://tartan-dev-e2e.acme.workers.dev/e2e/classic/r-s3.git\n ! [remote rejected] HEAD -> main (woven-by-tartan)\nerror: failed to push some refs\n";
	ok(refusedWith(human, "refs/heads/main", "woven-by-tartan"));
	ok(!refusedWith(human, "refs/heads/main", "kernel-only"));
	const lane = " ! [remote rejected] HEAD -> lanes/ln_01abc (not-your-lane)\n";
	ok(refusedWith(lane, "refs/heads/lanes/ln_01abc", "not-your-lane"));
	const porcelain =
		"To https://x\n!\tHEAD:refs/heads/main\t[remote rejected] (woven-by-tartan)\nDone\n";
	ok(refusedWith(porcelain, "refs/heads/main", "woven-by-tartan"));
	const tag = " ! [remote rejected] HEAD -> refs/tags/v1 (tags-maintainer)\n";
	ok(refusedWith(tag, "refs/tags/v1", "tags-maintainer"));
	// What stock git 2.55 printed live: tags by their short name, and a
	// deletion without the `<src> ->` part.
	const shortTag =
		" ! [remote rejected] HEAD -> s2-agent-tag (tags-maintainer)\n";
	ok(refusedWith(shortTag, "refs/tags/s2-agent-tag", "tags-maintainer"));
	const deletion = " ! [remote rejected] lanes/ln_01abc (use-lanes-close)\n";
	ok(refusedWith(deletion, "refs/heads/lanes/ln_01abc", "use-lanes-close"));
	ok(!refusedWith(deletion, "refs/heads/lanes/ln_01abc", "not-your-lane"));
	ok(!refusedWith(deletion, "refs/heads/lanes/ln_01xyz", "use-lanes-close"));
	// Any reason, for the ref only.
	const other = " ! [remote rejected] HEAD -> lanes/ln_01abc (some reason)\n";
	ok(refusedWithAny(other, "refs/heads/lanes/ln_01abc"));
	ok(!refusedWithAny(other, "refs/heads/lanes/ln_01xyz"));
	ok(refusedWithAny(porcelain, "refs/heads/main"));
	ok(
		!refusedWithAny(
			" ! [rejected] HEAD -> main (fetch first)\n",
			"refs/heads/main",
		),
	);
	deepStrictEqual(
		tartanRemoteLines(
			"remote: tartan ▸ main is woven by Tartan\nremote: other\n",
		),
		["remote: tartan ▸ main is woven by Tartan"],
	);
});

Deno.test("control characters a terminal must not get are found; git's own are not", () => {
	deepStrictEqual(controlsIn("plain\ttext\r\nok"), []);
	deepStrictEqual(controlsIn("a\u001b]0;x\u0007b\u009b2J"), [
		"U+001B",
		"U+0007",
		"U+009B",
	]);
});

Deno.test("hand-built receive-pack bodies are well framed except where a probe breaks them", () => {
	equal(pktLine("abc\n"), "0008abc\n");
	equal(pktLine("é"), "0006é");
	const command = {
		old: "a".repeat(40),
		new: "b".repeat(40),
		ref: "refs/heads/lanes/ln_1",
	};
	const section = commandSection([command], ["report-status"]);
	ok(section.endsWith("0000"));
	ok(section.includes(`\0report-status\n`));
	const probes = PARSER_PROBES(command);
	deepStrictEqual(probes.map((p) => p.name).length, 6);
	ok(probes.some((p) => p.body.startsWith("0001")));
	ok(probes.some((p) => p.body.includes("push-cert")));
	ok(probes.some((p) => p.body.includes("push-options")));
	const allow = receivePackAllowlist();
	ok(allow.includes("report-status") && allow.includes("side-band-64k"));
	equal(allow.includes("push-cert"), false);
	equal(
		allow.includes("push-options"),
		false,
		"the probe's capability is refused",
	);
	equal(typeof echoEnabled(), "boolean");
});

Deno.test("a tool result's notices are read from its _tartan trailer", () => {
	deepStrictEqual(
		noticesOf({
			ok: true,
			_tartan: {
				notices: [
					{
						kind: "conflict",
						severity: "warn",
						text: "ln_2 edits src/rate/limits.ts",
						laneId: "ln_1",
						data: { conflictId: "c1" },
					},
					{ kind: 3 },
				],
			},
		}),
		[{
			kind: "conflict",
			severity: "warn",
			text: "ln_2 edits src/rate/limits.ts",
			laneId: "ln_1",
			data: { conflictId: "c1" },
		}],
	);
	deepStrictEqual(noticesOf({}), []);
	deepStrictEqual(noticesOf(null), []);
});
