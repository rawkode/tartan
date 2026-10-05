// Pure parts of the land module: the squash-message composer, K4, the git
// command builders and parsers, and why notes.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { Envelope } from "@tartan/contract";
import {
	fetchArgv,
	mergeTreeArgv,
	parseConflictRegions,
	parseMergeTree,
	parsePushPorcelain,
	pushArgv,
} from "./gitcmd.ts";
import { reasonChainIssues } from "./k4.ts";
import {
	buildWhyNote,
	decodeNote,
	encodeNote,
	notePaths,
	readNote,
} from "./notes.ts";
import {
	agentTrailer,
	coAuthorTrailer,
	composeSquashMessage,
	gerritChangeId,
} from "./trailers.ts";

const SHA = (n: number) => n.toString(16).padStart(40, "a");
const ZERO = "0".repeat(40);
const CHANGE = "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv";

Deno.test("squash message: title, summary, kernel trailers, provider trailers", async () => {
	const changeId = await gerritChangeId(CHANGE);
	ok(/^I[0-9a-f]{40}$/.test(changeId));
	equal(await gerritChangeId(CHANGE), changeId, "deterministic");
	const message = composeSquashMessage({
		title: "Per-tenant rate limiting",
		summary: "Abuse from one tenant\r\ndegrades all.\n\n\n\nMore.\0",
		kernel: {
			changeId,
			agent: "codex-2 (codex/gpt-5-codex)",
			onBehalfOf: "rawkode",
			advance: "adv_01k6xxxxxxxxxxxxxxxxxxxxxx_1",
			coAuthoredBy: [
				"claude <agent+a_1@agents.git.example.com>",
				"claude <agent+a_1@agents.git.example.com>",
			],
		},
		provider: [
			{ key: "Tartan-Review", value: "auto(0.18)" },
			{ key: "Tartan-Work", value: "acme/platform/router#42" },
			{ key: "Change-Id", value: "Iforged" },
			{ key: "tartan-advance", value: "adv_forged" },
			{ key: "Co-authored-by", value: "mallory <m@x>" },
			{ key: "Tartan-Change", value: CHANGE },
			{ key: "Refs", value: "#7" },
		],
	});
	equal(
		message,
		[
			"Per-tenant rate limiting",
			"",
			"Abuse from one tenant\ndegrades all.\n\nMore.",
			"",
			`Change-Id: ${changeId}`,
			`Tartan-Change: ${CHANGE}`,
			"Tartan-Work: acme/platform/router#42",
			"Tartan-Agent: codex-2 (codex/gpt-5-codex)",
			"Tartan-On-Behalf-Of: rawkode",
			"Tartan-Review: auto(0.18)",
			"Refs: #7",
			"Tartan-Advance: adv_01k6xxxxxxxxxxxxxxxxxxxxxx_1",
			"Co-authored-by: claude <agent+a_1@agents.git.example.com>",
			"",
		].join("\n"),
	);
	// No summary: no empty paragraph.
	const short = composeSquashMessage({
		title: "t",
		summary: "  ",
		kernel: { changeId, advance: "adv_x_1", coAuthoredBy: [] },
		provider: [],
	});
	equal(short, `t\n\nChange-Id: ${changeId}\nTartan-Advance: adv_x_1\n`);
	throws(() =>
		composeSquashMessage({
			title: "t",
			summary: "",
			kernel: { changeId: "I123", advance: "a", coAuthoredBy: [] },
			provider: [],
		})
	);
});

Deno.test("trailer principals", () => {
	equal(
		agentTrailer({
			id: "a_1",
			kind: "agent",
			handle: "codex-2",
			agentTool: "codex",
			agentModel: "gpt-5-codex",
		}),
		"codex-2 (codex/gpt-5-codex)",
	);
	equal(agentTrailer({ id: "a_1", kind: "agent", handle: "c" }), "c");
	equal(
		coAuthorTrailer(
			{ id: "a_1", kind: "agent", handle: "c<x>" },
			"git.example.com",
		),
		"cx <agent+a_1@agents.git.example.com>",
	);
	equal(
		coAuthorTrailer({ id: "u_1", kind: "user", handle: "rk" }, "h"),
		"rk <user+u_1@users.h>",
	);
});

const env = (
	id: string,
	type: string,
	data: unknown,
	source: Envelope["source"] = {
		kind: "installation",
		id: "i_01k6bbbbbbbbbbbbbbbbbbbbbb",
		ext: "tartan.review@1",
	},
	shadow = false,
): Envelope =>
	({
		id,
		seq: 1,
		stream: "repo:x",
		type,
		v: 1,
		source,
		actor: { kind: "system", id: "sys_kernel" },
		node: "x",
		depth: 0,
		shadow,
		at: 0,
		data,
	}) as unknown as Envelope;

Deno.test("K4: per change a submitted and an approval bound to the head", () => {
	const change = { changeId: CHANGE, laneId: "ln_1", head: SHA(1) };
	const submitted = env("e1", "changes.submitted", {
		changeId: CHANGE,
		laneId: "ln_1",
	});
	const approve = env("e2", "review.decided", {
		changeId: CHANGE,
		decision: "approve",
		head: SHA(1),
	});
	const base = {
		changes: [change],
		gateBatchHad: () => false,
	};
	deepStrictEqual(
		reasonChainIssues({
			...base,
			ids: ["e1", "e2"],
			found: [submitted, approve],
		}),
		[],
	);
	// Unknown (foreign or made-up) ids.
	deepStrictEqual(
		reasonChainIssues({
			...base,
			ids: ["e1", "e2", "e9"],
			found: [submitted, approve],
		}).map((i) => i.code),
		["unknown-event"],
	);
	// Queue events never suffice.
	const queued = env("q1", "queue.enqueued", { changeId: CHANGE });
	deepStrictEqual(
		reasonChainIssues({ ...base, ids: ["q1"], found: [queued] }).map((i) =>
			i.code
		),
		["no-submitted", "no-approval"],
	);
	// The approval names another head.
	const old = env("e3", "review.decided", {
		changeId: CHANGE,
		decision: "approve",
		head: SHA(2),
	});
	deepStrictEqual(
		reasonChainIssues({ ...base, ids: ["e1", "e3"], found: [submitted, old] })
			.map((i) => i.code),
		["approval-head"],
	);
	// Shadow, kernel-sourced, request_changes and wrong-provider decisions do not approve.
	const shadow = env(
		"e4",
		"review.decided",
		{
			changeId: CHANGE,
			decision: "approve",
			head: SHA(1),
		},
		undefined,
		true,
	);
	const rejecting = env("e5", "review.decided", {
		changeId: CHANGE,
		decision: "request_changes",
		head: SHA(1),
	});
	for (const e of [shadow, rejecting]) {
		deepStrictEqual(
			reasonChainIssues({ ...base, ids: ["e1", e.id], found: [submitted, e] })
				.map((i) => i.code),
			["no-approval"],
		);
	}
	deepStrictEqual(
		reasonChainIssues({
			...base,
			ids: ["e1", "e2"],
			found: [submitted, approve],
			reviewProvider: "i_01k6zzzzzzzzzzzzzzzzzzzzzz",
		}).map((i) => i.code),
		["no-approval"],
	);
	deepStrictEqual(
		reasonChainIssues({
			...base,
			ids: ["e1", "e2"],
			found: [submitted, approve],
			reviewProvider: null,
		}).map((i) => i.code),
		["no-approval"],
		"no review provider in force: no review approves",
	);
	// A passing enforce gate answer from an earlier batch at the same head.
	const gate = env("g1", "gate.decided", {
		point: "ref.advance",
		changeId: CHANGE,
		decision: "allow",
		mode: "enforce",
		basis: "answer",
		batchId: "lb_old",
	}, { kind: "kernel" });
	deepStrictEqual(
		reasonChainIssues({
			changes: [change],
			ids: ["e1", "g1"],
			found: [submitted, gate],
			gateBatchHad: (b, c, h) => b === "lb_old" && c === CHANGE && h === SHA(1),
		}),
		[],
	);
	deepStrictEqual(
		reasonChainIssues({
			changes: [change],
			ids: ["e1", "g1"],
			found: [submitted, gate],
			gateBatchHad: () => false,
		}).map((i) => i.code),
		["no-approval"],
	);
});

Deno.test("git argv: fetch by sha into work refs, leases, merge-tree", () => {
	deepStrictEqual(
		fetchArgv("/srv/m.git", "https://r", [{
			sha: SHA(1),
			ref: "refs/tartan-work/b/trunk",
		}]),
		[
			"git",
			"-C",
			"/srv/m.git",
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
			"--no-auto-gc",
			"--quiet",
			"https://r",
			`+${SHA(1)}:refs/tartan-work/b/trunk`,
		],
	);
	throws(() => fetchArgv("/m", "r", [{ sha: "HEAD", ref: "x" }]));
	deepStrictEqual(
		pushArgv("/m", "https://r", [
			{ src: SHA(2), dst: "refs/heads/main", expect: SHA(1) },
			{ src: SHA(3), dst: "refs/tartan/x", expect: ZERO },
		]).slice(3),
		[
			"push",
			"--porcelain",
			"--no-verify",
			`--force-with-lease=refs/heads/main:${SHA(1)}`,
			"--force-with-lease=refs/tartan/x:",
			"https://r",
			`${SHA(2)}:refs/heads/main`,
			`${SHA(3)}:refs/tartan/x`,
		],
	);
	ok(mergeTreeArgv("/m", SHA(1), SHA(2)).includes("merge.conflictStyle=diff3"));
});

Deno.test("parsers: merge-tree, push porcelain, conflict regions", () => {
	deepStrictEqual(parseMergeTree(0, `${SHA(5)}\n`), {
		clean: true,
		tree: SHA(5),
	});
	deepStrictEqual(parseMergeTree(1, `${SHA(5)}\nf.txt\nf.txt\ng.txt\n`), {
		clean: false,
		tree: SHA(5),
		paths: ["f.txt", "g.txt"],
	});
	throws(() => parseMergeTree(128, "fatal: refusing"));
	deepStrictEqual(
		parsePushPorcelain(
			[
				"To https://r",
				`*\t${SHA(1)}:refs/notes/tartan\t[new reference]`,
				`=\t${SHA(1)}:refs/tartan/x\t[up to date]`,
				`!\t${SHA(2)}:refs/heads/main\t[rejected] (stale info)`,
				`!\t${SHA(2)}:refs/heads/other\t[remote rejected] (busy)`,
				` \t${SHA(3)}:refs/heads/ff\t555946c..c27d038`,
				"Done",
			].join("\n"),
		).map((r) => [r.ref, r.kind]),
		[
			["refs/notes/tartan", "ok"],
			["refs/tartan/x", "uptodate"],
			["refs/heads/main", "stale"],
			["refs/heads/other", "rejected"],
			["refs/heads/ff", "ok"],
		],
	);
	const merged = [
		"l1",
		"<<<<<<< ours",
		"A",
		"A2",
		"||||||| base",
		"l2",
		"=======",
		"C",
		">>>>>>> theirs",
		"l3",
		"<<<<<<< ours",
		"x",
		"=======",
		">>>>>>> theirs",
		"",
	].join("\n");
	deepStrictEqual(parseConflictRegions(merged), [
		{
			baseStart: 2,
			baseLines: 1,
			oursStart: 2,
			oursLines: 2,
			theirsStart: 2,
			theirsLines: 1,
		},
		{
			baseStart: 4,
			baseLines: 0,
			oursStart: 5,
			oursLines: 1,
			theirsStart: 4,
			theirsLines: 0,
		},
	]);
});

Deno.test("why notes: schema-checked build, encode/decode, fan-out reads", async () => {
	const kernel = {
		advance: "adv_01k6xxxxxxxxxxxxxxxxxxxxxx_1",
		ref: "refs/heads/main",
		batch: "lb_01k6xxxxxxxxxxxxxxxxxxxxxx",
		landedBy: "i_weave",
		actor: "a_01k6eeeeeeeeeeeeeeeeeeeeee",
		change: CHANGE,
		lane: "ln_01k6eeeeeeeeeeeeeeeeeeeeee",
		laneHead: SHA(1),
		laneMode: "branch" as const,
		laneHeadRef: `refs/tartan/changes/${CHANGE}`,
		rangeBase: SHA(2),
		firstPushers: [],
		provenance: "complete" as const,
		reason: { summary: "s", events: ["01k6eeeeeeeeeeeeeeeeeeeeee"] },
		gates: [],
		checks: { state: "skipped" as const, runs: [], evidenceReused: false },
		chain: { seq: 3, head: "f".repeat(64) },
	};
	const note = buildWhyNote(kernel, [
		{ extId: "tartan.work", json: '{"item":"acme/shop#1"}' },
		{ extId: "broken", json: "{" },
	]);
	deepStrictEqual(Object.keys(note.ext), ["tartan.work"]);
	const text = encodeNote(note);
	ok(text.endsWith("}\n") && !text.slice(0, -1).includes("\n"));
	deepStrictEqual(decodeNote(text), note);
	equal(decodeNote("not json"), null);
	equal(decodeNote('{"v":2}'), null);
	throws(() =>
		buildWhyNote({ ...kernel, reason: { summary: "s", events: [] } }, [])
	);
	const commit = SHA(9);
	deepStrictEqual(notePaths(commit), [
		commit,
		`${commit.slice(0, 2)}/${commit.slice(2)}`,
		`${commit.slice(0, 2)}/${commit.slice(2, 4)}/${commit.slice(4)}`,
	]);
	const reads: string[] = [];
	const found = await readNote(
		{
			readFile: (tip, path) => {
				reads.push(`${tip}:${path}`);
				return Promise.resolve(path.includes("/") ? text : null);
			},
		},
		SHA(7),
		commit,
	);
	deepStrictEqual(found, note);
	deepStrictEqual(reads, [
		`${SHA(7)}:${commit}`,
		`${SHA(7)}:${notePaths(commit)[1]}`,
	]);
});
