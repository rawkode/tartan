// Unit tests for the e2e flow helpers (e2e/support/*): the cross-worker
// store the M1 loop, the changes group and the gateway suites share, the
// loop's stages, the labels read from the extensions, the gateway checks
// (refusal lines, control characters, hand-built receive-pack bodies), the
// notices of a tool result, and the M1 loop fixture's design: its package
// tartan passes tartan.ci's and tartan.review's own validators, review
// routes its changes to a person, and the two agents' edits merge cleanly.

import {
	deepStrictEqual,
	equal,
	match,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import * as path from "node:path";
import type { Project } from "@tartan/contract";
import { validatePipeline } from "../../extensions/ci/src/pipeline/schema.ts";
import { validateOwners } from "../../extensions/review/src/owners.ts";
import {
	assessRisk,
	DEFAULT_THRESHOLD,
	routeOf,
} from "../../extensions/review/src/risk.ts";
import {
	buildHistory,
	CI_JOB,
	CI_MARKER,
	editedLimits,
	FIXTURE_COMMITS,
	LOOP_COMMITS,
	LOOP_CUE_FILES,
	LOOP_EDITS,
	LOOP_FILE,
	LOOP_LIMITS_LINES,
	LOOP_PROJECT,
	LOOP_SENSITIVITY,
} from "../../e2e/support/fixture-repo.ts";
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
import { gitEnv, gitOk } from "../../e2e/support/git.ts";
import {
	actionLabel,
	extensionDir,
	slotLabel,
} from "../../e2e/support/labels.ts";
import {
	checkKey,
	LOOP_STAGES,
	loopSuite,
	PRE_LAND_CHECKS,
	previousStage,
	stageKey,
} from "../../e2e/support/loop-stages.ts";
import { noticesOf } from "../../e2e/support/mcp.ts";
import { createShared, keyOf, StepFailed } from "../../e2e/support/shared.ts";
import { packSlots } from "../../e2e/support/tabs.ts";

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
// The loop's stages
// ---------------------------------------------------------------------------

Deno.test("the loop's stages run in the M1 order", () => {
	deepStrictEqual([...LOOP_STAGES], [
		"repo",
		"claimed",
		"pushed",
		"submitted",
		"ci-green",
		"review-human",
		"approved",
		"landed",
		"closed",
	]);
	equal(previousStage("repo"), null);
	equal(previousStage("approved"), "review-human");
	equal(loopSuite(0), "loop");
	equal(loopSuite(2), "loop-2");
	equal(stageKey(1, "landed"), "loop-1-stage-landed");
	equal(checkKey(0, 3, "started"), "loop-0-check-3-started");
	// The approval waits for the checks of the claims, pushes, radar,
	// submits and CI, never for itself (6) or a later one.
	deepStrictEqual([...PRE_LAND_CHECKS], [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// Labels from the extensions
// ---------------------------------------------------------------------------

Deno.test("labels come from the manifests and the extensions' UI source", () => {
	const manifest = (ext: string) =>
		JSON.parse(
			Deno.readTextFileSync(path.join(extensionDir(ext), "tartan.json")),
		) as {
			contributes: { slots: { slot: string; id: string; label?: string }[] };
		};
	for (
		const [ext, slot, id] of [
			["tartan.radar", "repo.tab", "radar"],
			["tartan.weave", "repo.tab", "weave"],
			["tartan.changes", "change.tab", "diff"],
		] as const
	) {
		equal(
			slotLabel(ext, slot, id),
			manifest(ext).contributes.slots.find((s) =>
				s.slot === slot && s.id === id
			)
				?.label,
		);
	}
	throws(
		() => slotLabel("tartan.radar", "repo.tab", "gone"),
		/no repo\.tab gone/,
	);
	throws(() => extensionDir("tartan.gone"), /no extension/);
	const approve = actionLabel("tartan.review", "approve");
	ok(approve.length > 0);
	const source = Deno.readTextFileSync(
		path.join(extensionDir("tartan.review"), "src", "ui.ts"),
	);
	ok(source.includes(`"${approve}"`));
	throws(() => actionLabel("tartan.review", "no-such-action"), /0 buttons/);
	// The Classic pack's repo sidebar is CI's project status.
	ok(packSlots("classic", "repo.sidebar").some((s) => s.ext === "tartan.ci"));
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

// ---------------------------------------------------------------------------
// The M1 loop fixture
// ---------------------------------------------------------------------------

/** What the loop fixture's package tartan exports (checked against `cue` below). */
const LOOP_EXPORT = {
	extensions: {
		"tartan.ci": {
			settings: {
				pipeline: {
					jobs: { [CI_JOB]: { run: `echo ${CI_MARKER}` } },
					on: { change: [CI_JOB], land: [CI_JOB] },
					lanes: { ci: "on-submit" },
				},
			},
		},
		"tartan.review": {
			settings: {
				owners: {
					rules: [{ paths: ["src/**"], sensitivity: LOOP_SENSITIVITY }],
				},
			},
		},
	},
	projects: { [LOOP_PROJECT]: { root: "src" } },
};

Deno.test("the loop fixture's policy passes tartan.ci's and tartan.review's validators", () => {
	const ext = LOOP_EXPORT.extensions;
	const pipeline = validatePipeline(ext["tartan.ci"].settings.pipeline);
	ok(pipeline.ok, JSON.stringify(pipeline));
	const owners = validateOwners(ext["tartan.review"].settings.owners);
	ok(owners.ok, JSON.stringify(owners));
	deepStrictEqual([...LOOP_CUE_FILES], [
		"ci.cue",
		"env.cue",
		"review.cue",
		"tartan.cue",
	]);
	// The basic fixture's ci.cue is the same pipeline.
	ok(FIXTURE_COMMITS[0].files["ci.cue"].includes(`"${CI_JOB}"`));
});

Deno.test("review routes a loop change to a person, with or without the radar conflict", () => {
	const owners = validateOwners(
		LOOP_EXPORT.extensions["tartan.review"].settings.owners,
	);
	if (!owners.ok) throw new Error("owners");
	const project: Project = {
		name: LOOP_PROJECT,
		root: "src",
		deps: [],
		dependents: [],
		owners: [],
		sensitive: false,
		source: "tartan-config",
	};
	for (const conflicts of [[], ["same_file"]]) {
		const risk = assessRisk({
			files: [{
				path: LOOP_FILE,
				change: "modified",
				additions: 1,
				deletions: 1,
			}],
			truncated: false,
			graph: { projects: [project], globalFiles: [] },
			rules: owners.rules,
			testScriptChanges: [],
			conflicts,
			track: { landed: 0, ejected: 0, vetoed: 0, reverted: 0 },
		});
		equal(risk.factors.sensitive, LOOP_SENSITIVITY / 3);
		ok(risk.risk >= DEFAULT_THRESHOLD, `risk ${risk.risk}`);
		equal(routeOf(risk, "by-exception", DEFAULT_THRESHOLD), "human");
	}
});

const run = async (cmd: string, args: string[], cwd: string) => {
	const out = await new Deno.Command(cmd, {
		args,
		cwd,
		stdout: "piped",
		stderr: "piped",
		env: { CUE_REGISTRY: "none" },
	}).output().catch(() => null);
	return out === null
		? null
		: { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};
const hasCue = (await run("cue", ["version"], ".")) !== null;
const hasGit = (await run("git", ["--version"], ".")) !== null;

Deno.test({
	name:
		"the loop fixture's package tartan exports what the suites expect (cue)",
	ignore: !hasCue,
	fn: async () => {
		const dir = await tempDir();
		try {
			for (const [file, text] of Object.entries(LOOP_COMMITS[0].files)) {
				await Deno.writeTextFile(path.join(dir, file), text);
			}
			const out = await run(
				"cue",
				["export", "--out", "json", ".:tartan"],
				dir,
			);
			equal(out?.code, 0);
			deepStrictEqual(JSON.parse(out!.stdout), LOOP_EXPORT);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});

Deno.test({
	name: "the two loop agents' edits merge cleanly with git merge-tree",
	ignore: !hasGit,
	fn: async () => {
		equal(
			Math.abs(LOOP_EDITS.A.line - LOOP_EDITS.B.line) >= 3,
			true,
			"unchanged lines between the two edits",
		);
		for (const name of ["A", "B"] as const) {
			equal(LOOP_LIMITS_LINES[LOOP_EDITS[name].line - 1], LOOP_EDITS[name].was);
		}
		const dir = await tempDir();
		const home = await tempDir();
		try {
			await buildHistory(dir, home, LOOP_COMMITS);
			const env = gitEnv({ home });
			const file = path.join(dir, ...LOOP_FILE.split("/"));
			const branch = async (name: "A" | "B", text: string) => {
				await gitOk(["switch", "-q", "-c", name, "main"], { cwd: dir, env });
				await Deno.writeTextFile(
					file,
					`${editedLimits(LOOP_LIMITS_LINES, name, text).join("\n")}\n`,
				);
				await gitOk(["commit", "-q", "-am", name], { cwd: dir, env });
			};
			await branch("A", "\tread: 120, // A");
			await branch("B", "\tadmin: 2, // B");
			const merged = await new Deno.Command("git", {
				args: ["merge-tree", "--write-tree", "A", "B"],
				cwd: dir,
				env,
				clearEnv: true,
				stdout: "piped",
				stderr: "piped",
			}).output();
			equal(merged.code, 0, new TextDecoder().decode(merged.stdout));
		} finally {
			await Deno.remove(dir, { recursive: true });
			await Deno.remove(home, { recursive: true });
		}
	},
});
