// Errors, text hygiene and redaction, notices, gates, pipeline, lanes, MCP,
// notes, ports and the DO module contract.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	denied,
	fromRpcError,
	fromWire,
	fromWitError,
	httpStatus,
	isTartanError,
	notImplemented,
	protocolMismatch,
	setupRequired,
	TartanError,
	toWire,
	toWitError,
} from "../src/errors.ts";
import {
	aggregateGates,
	effectiveGateDecision,
	type GateCall,
	GateDecisionSchema,
	sanitizeEchoLines,
} from "../src/gates.ts";
import {
	KERNEL_WRITE_PURPOSES,
	LandRequestSchema,
	LandVerdictSchema,
} from "../src/land.ts";
import {
	ArchiveResultSchema,
	isLanePlatformFault,
	LANE_FALLBACK_ORDER,
	LANE_MODES,
	LANE_PLATFORM_FAULT_CODES,
	LANE_REPO_HEAD_REF,
	LANE_SEED_FAIL_CODES,
	LANE_SEEDS,
	laneRemotePath,
	LaneSchema,
} from "../src/lanes.ts";
import { KERNEL_TOOLS, TartanTrailerSchema } from "../src/mcp.ts";
import { isProviderTrailerKey, WhyNoteSchema } from "../src/notes.ts";
import {
	type Notice,
	renderNoticesBlock,
	sanitizeInboxBody,
	selectNotices,
} from "../src/notices.ts";
import { JobGraphSchema, topoOrder } from "../src/pipeline.ts";
import { isKnownSlot, SLOT_IDS } from "../src/slots.ts";
import {
	byteLength,
	defuseFences,
	redactSecrets,
	stripControl,
	truncateBytes,
} from "../src/text.ts";
import { diffKey } from "../src/git.ts";
import { DENIED_REASONS } from "../src/errors.ts";
import {
	MIGRATION_RANGES,
	migrationIssues,
	timerBackoffMs,
} from "../src/do/common.ts";
import type { RepoReader, RepoStore } from "../src/ports.ts";
import {
	isRepoStoreError,
	isResolvedSha,
	toResolvedSha,
} from "../src/ports.ts";

const ULID = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const SHA = "a".repeat(40);

Deno.test("errors: wire, RPC and WIT round trips", () => {
	const e = denied("scope", "repo outside the installation subtree");
	equal(e.message, "denied(scope): repo outside the installation subtree");
	equal(httpStatus(e.code), 403);
	deepStrictEqual(toWire(e), {
		error: "denied",
		message: "repo outside the installation subtree",
		reason: "scope",
	});
	const viaRpc = fromRpcError(new Error(e.message));
	equal(viaRpc.code, "denied");
	equal(viaRpc.reason, "scope");
	ok(isTartanError(viaRpc));
	deepStrictEqual(toWitError(e), { tag: "denied", val: "scope" });
	equal(fromWitError({ tag: "denied", val: "read-only" }).reason, "read-only");
	equal(fromWitError({ tag: "not-found", val: "x" }).code, "not_found");
	equal(fromWire(toWire(setupRequired())).code, "setup_required");
	equal(httpStatus("setup_required"), 503);
	equal(
		toWire(protocolMismatch("https://x/-/mcp/a")).details?.mcpUrl,
		"https://x/-/mcp/a",
	);
	equal(httpStatus(notImplemented("x").code), 501);
	const unknown = fromRpcError(new Error("kaboom: secret detail"));
	equal(unknown.code, "internal");
	deepStrictEqual(toWire(unknown), {
		error: "internal",
		message: "internal error",
	});
	ok(new TartanError("conflict", "x") instanceof Error);
});

Deno.test("text: control characters, bidi and fences are neutralized", () => {
	const hostile =
		"ok\u001b[31mred\u001b]8;;http://evil\u0007link\u009b‮evil\nnext\ttab";
	equal(stripControl(hostile), "ok[31mred]8;;http://evillinkevilnexttab");
	equal(
		stripControl(hostile, { keepNewlines: true }),
		"ok[31mred]8;;http://evillinkevil\nnext\ttab",
	);
	equal(defuseFences("a ``` b ```` c"), "a ˋˋˋ b ˋˋˋˋ c");
	equal(truncateBytes("ééé", 3), "é");
	equal(byteLength("é"), 2);
	ok(byteLength(sanitizeInboxBody("x".repeat(5000))) <= 2048);
});

const notice = (over: Partial<Notice>): Notice => ({
	id: "nt_1",
	seq: 1,
	source: "i_x",
	sourceLabel: "radar",
	kind: "conflict",
	severity: "warn",
	text: "overlap on limit.ts",
	createdAt: 1,
	...over,
});

Deno.test("notices: selection order and the fenced block", () => {
	const picked = selectNotices([
		notice({ id: "a", seq: 1, severity: "info" }),
		notice({ id: "b", seq: 2, severity: "critical" }),
		notice({ id: "c", seq: 3, severity: "warn" }),
	], 2);
	deepStrictEqual(picked.map((n) => n.id), ["b", "c"]);
	equal(renderNoticesBlock([]), null);
	const block = renderNoticesBlock([
		notice({ text: "evil ```\nclose the fence\u001b[2J" }),
		notice({
			id: "m",
			kind: "message",
			sourceLabel: "codex-2",
			text: "rebase onto ln_7",
		}),
	])!;
	const lines = block.split("\n");
	equal(lines[0], "```tartan-notices (untrusted; from radar, codex-2)");
	equal(lines[lines.length - 1], "```");
	equal(block.match(/```/g)?.length, 2, "only the outer fence remains");
	ok(!block.includes("\u001b"));
});

const call = (over: Partial<GateCall>): GateCall => ({
	installation: "i_a",
	ext: "acme.no-secrets@0.1.0",
	mode: "enforce",
	onTruncated: "veto",
	default: "allow",
	outcome: {
		kind: "decision",
		decision: { decision: "allow", message: "clean" },
	},
	...over,
});

Deno.test("gates (K8): truncation, timeouts, shadow never blocks", () => {
	equal(effectiveGateDecision(call({}), false).decision, "allow");
	equal(effectiveGateDecision(call({}), true).decision, "veto");
	equal(effectiveGateDecision(call({}), true).basis, "truncated");
	equal(
		effectiveGateDecision(
			call({
				outcome: {
					kind: "decision",
					decision: { decision: "allow", message: "", fullScan: true },
				},
			}),
			true,
		).decision,
		"allow",
	);
	equal(
		effectiveGateDecision(call({ onTruncated: "allow" }), true).decision,
		"allow",
	);
	equal(
		effectiveGateDecision(call({ outcome: { kind: "timeout" } }), false)
			.decision,
		"allow",
	);
	equal(
		effectiveGateDecision(
			call({ outcome: { kind: "timeout" }, default: "veto" }),
			false,
		).decision,
		"veto",
	);
	// A gate that timed out or failed on a truncated input declared no
	// full scan, so it never fails open: the stricter of default/onTruncated.
	for (
		const outcome of [{ kind: "timeout" }, {
			kind: "error",
			message: "trap",
		}] as const
	) {
		const d = effectiveGateDecision(call({ outcome }), true);
		equal(d.decision, "veto", `${outcome.kind} + truncated`);
		equal(d.basis, "truncated");
		equal(
			effectiveGateDecision(call({ outcome, onTruncated: "allow" }), true)
				.decision,
			"allow",
		);
		equal(
			effectiveGateDecision(
				call({ outcome, onTruncated: "allow", default: "veto" }),
				true,
			).decision,
			"veto",
		);
		equal(effectiveGateDecision(call({ outcome }), false).basis, "default");
	}
	const veto = {
		kind: "decision",
		decision: { decision: "veto", message: "AWS key" },
	} as const;
	const shadowVeto = effectiveGateDecision(
		call({ mode: "shadow", outcome: veto }),
		false,
	);
	const enforceVeto = effectiveGateDecision(call({ outcome: veto }), false);
	equal(aggregateGates([shadowVeto]).blocked, false);
	equal(aggregateGates([shadowVeto, enforceVeto]).blocked, true);
	equal(
		GateDecisionSchema.safeParse({
			decision: "veto",
			message: "x",
			html: "<b>",
		}).success,
		false,
	);
});

Deno.test("echo: lines sanitized, capped and prefixed", () => {
	const lines = sanitizeEchoLines("radar", [
		"\u001b]0;pwned\u0007textual limit.ts L40-58",
		"",
		"x".repeat(500),
		...Array.from({ length: 20 }, (_, i) => `line ${i}`),
	]);
	equal(lines.length, 9, "≤ 10 input lines, empty ones dropped");
	equal(lines[0], "[radar] ]0;pwnedtextual limit.ts L40-58");
	ok(lines.every((l) => l.startsWith("[radar] ")));
	ok(lines[1].length <= "[radar] ".length + 200);
	deepStrictEqual(sanitizeEchoLines("radar", "not an array"), []);
	deepStrictEqual(sanitizeEchoLines("radar", [1, 2]), []);
});

Deno.test("pipeline: JobGraph validation (DAG, run xor argv, reserved env)", () => {
	const base = {
		repo: { path: "acme/platform/router" },
		kind: "ci",
		source: { repoId: ULID, laneId: `ln_${ULID}` },
		sha: SHA,
		jobs: [
			{ id: "install", run: "pnpm install --frozen-lockfile" },
			{ id: "test-api", needs: ["install"], project: "api", run: "pnpm test" },
		],
	};
	const ok1 = JobGraphSchema.safeParse(base);
	ok(ok1.success);
	deepStrictEqual(ok1.success && ok1.data.jobs[0].needs, []);
	const bad = (jobs: unknown) =>
		JobGraphSchema.safeParse({ ...base, jobs }).success;
	equal(
		bad([{ id: "a", needs: ["b"], run: "x" }, {
			id: "b",
			needs: ["a"],
			run: "x",
		}]),
		false,
	);
	equal(bad([{ id: "a", needs: ["missing"], run: "x" }]), false);
	equal(bad([{ id: "a", run: "x" }, { id: "a", run: "y" }]), false);
	equal(bad([{ id: "a" }]), false);
	equal(bad([{ id: "a", run: "x", argv: ["git"] }]), false);
	equal(
		bad([{ id: "a", argv: ["git", "push"], env: { GIT_CONFIG_COUNT: "1" } }]),
		false,
	);
	equal(bad([{ id: "A", run: "x" }]), false);
	equal(
		JobGraphSchema.safeParse({ ...base, kind: "agent" }).success,
		false,
		"agent jobs are out of v1",
	);
	equal(
		JobGraphSchema.safeParse({
			...base,
			source: { repoId: ULID, artifactsName: "r-x" },
		}).success,
		false,
	);
	deepStrictEqual(topoOrder([{ id: "b", needs: ["a"] }, { id: "a" }]), [
		"a",
		"b",
	]);
	equal(topoOrder([{ id: "a", needs: ["a"] }]), null);
});

Deno.test("land: requests and verdicts (K4 shape, K14)", () => {
	const req = {
		batchId: `lb_${ULID}`,
		repo: { id: ULID },
		ref: "refs/heads/main",
		batch: [{
			changeId: "zkqv".repeat(8),
			laneId: `ln_${ULID}`,
			head: SHA,
			title: "Per-tenant rate limiting",
			message: "why",
			trailers: [{ key: "Tartan-Work", value: "acme/platform/router#42" }],
		}],
		reason: { events: [ULID], summary: "weave partition [api] batch 7" },
		testPolicy: "checks",
	};
	ok(LandRequestSchema.safeParse(req).success);
	equal(
		LandRequestSchema.safeParse({
			...req,
			reason: { events: [], summary: "x" },
		}).success,
		false,
		"K4: non-empty",
	);
	equal(
		LandRequestSchema.safeParse({ ...req, batchId: "batch-1" }).success,
		false,
	);
	equal(
		LandRequestSchema.safeParse({ ...req, ref: "refs/tags/v1" }).success,
		false,
	);
	equal(
		LandRequestSchema.safeParse({
			...req,
			batch: [{
				...req.batch[0],
				trailers: [{ key: "Tartan-Work", value: "a\nInjected: 1" }],
			}],
		}).success,
		false,
		"trailer values are single-line",
	);
	equal(
		LandVerdictSchema.safeParse({
			attempt: 1,
			state: "success",
			runIds: [],
			evidence: null,
		}).success,
		false,
		"K14: candidateSha required",
	);
	ok(
		LandVerdictSchema.safeParse({
			attempt: 1,
			candidateSha: SHA,
			state: "success",
			runIds: [],
			evidence: null,
		}).success,
	);
});

Deno.test("mcp: the kernel tools and the _tartan trailer", () => {
	deepStrictEqual(Object.keys(KERNEL_TOOLS).sort(), [
		"context_get",
		"events_tail",
		"inbox_ack",
		"inbox_read",
		"inbox_send",
		"inbox_wait",
		"lanes_close",
		"lanes_delegate",
		"lanes_get",
		"lanes_list",
		"lanes_open",
		"lanes_sync",
		"protocol_get",
		"repo_affected",
		"repo_config_get",
		"repo_config_preview",
		"repo_config_result",
		"repo_config_schema",
		"repo_list",
		"repo_projects",
		"repo_read",
		"repo_tree",
		"runs_logs",
		"runs_status",
		"whoami",
		"why",
	]);
	ok(KERNEL_TOOLS.inbox_wait.input.safeParse({ timeoutMs: 25_000 }).success);
	equal(
		KERNEL_TOOLS.inbox_wait.input.safeParse({ timeoutMs: 25_001 }).success,
		false,
	);
	ok(
		KERNEL_TOOLS.why.input.safeParse({ repo: "acme/x", path: "a.ts", line: 3 })
			.success,
	);
	equal(KERNEL_TOOLS.why.input.safeParse({ repo: "acme/x" }).success, false);
	equal(
		KERNEL_TOOLS.repo_read.input.safeParse({
			repo: "acme/x",
			path: "../etc/passwd",
		}).success,
		false,
	);
	ok(
		TartanTrailerSchema.safeParse({ notices: [], protocol: "0a1b2c3d" })
			.success,
	);
	ok(
		TartanTrailerSchema.safeParse({
			notices: [],
			protocol: "0a1b2c3d",
			lane: {
				id: `ln_${ULID}`,
				mode: "repo",
				state: "opening",
				leaseExpiresAt: 1,
			},
		}).success,
	);
	equal(
		TartanTrailerSchema.safeParse({
			notices: [],
			protocol: "0a1b2c3d",
			lane: { id: `ln_${ULID}`, state: "open", leaseExpiresAt: 1 },
		}).success,
		false,
		"the trailer's lane carries its mode",
	);
	const delegate = KERNEL_TOOLS.lanes_delegate;
	equal(delegate.role, 30);
	equal(delegate.milestone, "M1");
	ok(
		delegate.input.safeParse({
			laneId: `ln_${ULID}`,
			add: ["codex-2"],
			remove: ["claude-1"],
		}).success,
	);
	equal(
		delegate.input.safeParse({ laneId: "lane-1", add: ["x"] }).success,
		false,
	);
	equal(
		TartanTrailerSchema.safeParse({ notices: [], protocol: "x" }).success,
		false,
	);
});

Deno.test("notes: an example why note parses; kernel trailers are reserved", () => {
	const note = {
		v: 1,
		kernel: {
			advance: `adv_${ULID}_1`,
			ref: "refs/heads/main",
			batch: `lb_${ULID}`,
			landedBy: "i_weave",
			actor: `a_${ULID}`,
			onBehalfOf: `u_${ULID}`,
			change: "zkqv".repeat(8),
			lane: `ln_${ULID}`,
			laneHead: SHA,
			reason: {
				summary: "weave partition [api] batch 7",
				events: [ULID, ULID],
			},
			gates: [{
				ext: "acme.no-secrets@0.1.0",
				decision: "allow",
				mode: "enforce",
			}],
			checks: {
				state: "success",
				runs: [`run_${ULID}`],
				evidenceReused: false,
			},
			chain: { seq: 41822, head: "9f".repeat(32) },
			laneMode: "repo",
			laneHeadRef: `refs/tartan/changes/${"zkqv".repeat(8)}`,
			rangeBase: "b".repeat(40),
			firstPushers: [{ principal: `a_${ULID}`, commits: 3 }],
			provenance: "complete",
		},
		ext: {
			"tartan.work": { item: "acme/platform/router#42", kind: "intent" },
			"tartan.review": { route: "auto", risk: 0.18 },
		},
	};
	ok(WhyNoteSchema.safeParse(note).success);
	equal(
		WhyNoteSchema.safeParse({
			...note,
			kernel: { ...note.kernel, reason: { summary: "x", events: [] } },
		}).success,
		false,
	);
	for (
		const key of [
			"laneMode",
			"laneHeadRef",
			"rangeBase",
			"firstPushers",
			"provenance",
		]
	) {
		const kernel: Record<string, unknown> = { ...note.kernel };
		delete kernel[key];
		equal(
			WhyNoteSchema.safeParse({ ...note, kernel }).success,
			false,
			`kernel.${key} is required (v0.2)`,
		);
	}
	equal(
		WhyNoteSchema.safeParse({
			...note,
			kernel: { ...note.kernel, laneHeadRef: "refs/heads/lanes/x" },
		}).success,
		false,
		"the landed head is kept under refs/tartan/changes/",
	);
	equal(
		WhyNoteSchema.safeParse({
			...note,
			kernel: { ...note.kernel, provenance: "maybe" },
		}).success,
		false,
	);
	ok(isProviderTrailerKey("Tartan-Work"));
	equal(isProviderTrailerKey("Tartan-Agent"), false);
	equal(isProviderTrailerKey("change-id"), false);
	equal(isProviderTrailerKey("Bad Key"), false);
});

Deno.test("slots: the slot catalogue", () => {
	equal(SLOT_IDS.length, 20);
	ok(
		isKnownSlot("repo.tab") && isKnownSlot("change.gate") &&
			isKnownSlot("agent.context"),
	);
	equal(isKnownSlot("repo-tabs"), false);
});

Deno.test("do/common: migration ranges and timer backoff", () => {
	deepStrictEqual(MIGRATION_RANGES.repo.land, [350, 399]);
	deepStrictEqual(
		migrationIssues("land", MIGRATION_RANGES.repo.land, [
			{ n: 350, name: "init", sql: "" },
			{ n: 351, name: "verdicts", sql: "" },
		]),
		[],
	);
	equal(
		migrationIssues("land", MIGRATION_RANGES.repo.land, [{
			n: 200,
			name: "x",
			sql: "",
		}]).length,
		1,
	);
	equal(
		migrationIssues("land", MIGRATION_RANGES.repo.land, [
			{ n: 352, name: "b", sql: "" },
			{ n: 351, name: "a", sql: "" },
		]).length,
		1,
	);
	equal(timerBackoffMs(1), 1000);
	equal(timerBackoffMs(2), 2000);
	equal(timerBackoffMs(50), 600000);
});

// Compile-time check: the real Artifacts binding satisfies the RepoStore port.
const _bindingIsAStore = (binding: Artifacts): RepoStore => binding;
// And a minimal fake shape type-checks against it: exactly the methods
// Tartan uses (token revocation and listing included).
const _fakeRepo = (): Awaited<ReturnType<RepoStore["get"]>> => ({
	info: () => Promise.reject(new Error("fake")),
	createToken: () => Promise.reject(new Error("fake")),
	revokeToken: () => Promise.resolve(true),
	listTokens: () => Promise.resolve({ tokens: [], total: 0 }),
	readBlob: () => Promise.resolve(null),
	readTree: () => Promise.resolve(null),
	readCommit: () => Promise.resolve(null),
	readFile: () => Promise.resolve(null),
	log: () => Promise.resolve([]),
	[Symbol.dispose]: () => {},
});
// A RepoReader takes branded SHAs only (K15).
const _fakeReader = (): RepoReader => ({
	source: { repoId: ULID },
	readCommit: () => Promise.resolve(null),
	readTree: () => Promise.resolve(null),
	readBlob: () => Promise.resolve(null),
	readFile: () => Promise.resolve(null),
	log: () => Promise.resolve([]),
});
const _readByRefName = (reader: RepoReader) =>
	// @ts-expect-error: a refname (or any unbranded string) is not a ResolvedSha
	reader.readCommit("refs/heads/main");

Deno.test("ports: Artifacts errors are recognized by name and code", () => {
	const err = Object.assign(new Error("exists"), {
		name: "ArtifactsError",
		code: "ALREADY_EXISTS",
	});
	ok(isRepoStoreError(err));
	ok(isRepoStoreError(err, "ALREADY_EXISTS", "NOT_FOUND"));
	equal(isRepoStoreError(err, "NOT_FOUND"), false);
	equal(isRepoStoreError(new Error("x")), false);
	ok(typeof _bindingIsAStore === "function" && typeof _fakeRepo === "function");
	ok(typeof _fakeReader === "function" && typeof _readByRefName === "function");
	equal(toResolvedSha(SHA), SHA);
	ok(isResolvedSha(SHA));
	equal(isResolvedSha("refs/heads/main"), false);
	throws(() => toResolvedSha("A".repeat(40)), /not a sha/);
	throws(() => {
		throw denied("read-only");
	}, /denied\(read-only\)/);
});

Deno.test("text: redactSecrets covers live tokens and capability paths (K11)", () => {
	const token = `art_v2_x_${
		"0123456789abcdef".repeat(2)
	}01234567?expires=1790000600`;
	const v1 = `/-/cap/v1/1790000120/ln_${ULID}/${"0f".repeat(16)}/${
		"ab".repeat(32)
	}/${ULID}.git/info/refs`;
	const legacy = `/-/cap/1790000120/${"0f".repeat(16)}/${
		"ab".repeat(32)
	}/x.git`;
	const line =
		`push to https://forge.test${v1} with Bearer ${token}; old ${legacy}`;
	const out = redactSecrets(line);
	equal(
		out,
		`push to https://forge.test/-/cap/<redacted>/${ULID}.git/info/refs with Bearer art_v2_<redacted>; old /-/cap/<redacted>/x.git`,
	);
	ok(!out.includes("ab".repeat(32)) && !out.includes("0f".repeat(16)));
	ok(!out.includes("expires="));
	// Every occurrence, and a path cut off before its last slash.
	const cut = `/-/cap/v1/1790000120/ln_${ULID}/${"0f".repeat(16)}/${
		"ab".repeat(32)
	}`;
	equal(
		redactSecrets(`${cut} ${cut}`),
		"/-/cap/<redacted>/ /-/cap/<redacted>/",
	);
	equal(
		redactSecrets("art_v1_abc art_v12_x_y"),
		"art_v1_<redacted> art_v12_<redacted>",
	);
	equal(
		redactSecrets("nothing secret: /-/cap/ and art_x"),
		"nothing secret: /-/cap/ and art_x",
	);
	equal(redactSecrets(redactSecrets(line)), out, "idempotent");
});

const laneOf = (over: Record<string, unknown>) => ({
	id: `ln_${ULID}`,
	repoId: ULID,
	kind: "lane",
	mode: "repo",
	seed: "import",
	ref: LANE_REPO_HEAD_REF,
	branch: `lanes/ln_${ULID}`,
	owner: `a_${ULID}`,
	delegates: [],
	footprint: { projects: [], prefixes: [] },
	base: SHA,
	head: SHA,
	state: "open",
	quarantined: false,
	leaseExpiresAt: 1,
	pushes: 0,
	createdAt: 1,
	remote: `/acme/x/-/lanes/ln_${ULID}.git`,
	...over,
});

Deno.test("lanes: both backends, their invariants and the seed vocabularies", () => {
	ok(LaneSchema.safeParse(laneOf({ seedMs: 1000 })).success, "repo lane");
	ok(
		LaneSchema.safeParse(laneOf({ state: "opening", head: undefined })).success,
		"opening repo lane",
	);
	const branchLane = laneOf({
		mode: "branch",
		seed: undefined,
		ref: `refs/heads/lanes/ln_${ULID}`,
		head: undefined,
		remote: "/acme/x.git",
	});
	ok(LaneSchema.safeParse(branchLane).success, "branch lane");
	ok(
		LaneSchema.safeParse({
			...branchLane,
			kind: "adopted",
			ref: "refs/heads/feat-x",
		}).success,
		"adopted lane",
	);
	for (
		const [why, bad] of [
			["adopted lanes are branch lanes", laneOf({ kind: "adopted" })],
			["branch lanes have no seed", { ...branchLane, seed: "import" }],
			["repo lanes use refs/heads/main", laneOf({ ref: "refs/heads/x" })],
			["only repo lanes open slowly", { ...branchLane, state: "opening" }],
			["unknown kind", laneOf({ kind: "copy" })],
			["unknown seed", laneOf({ seed: "copy" })],
			["quarantined is required", laneOf({ quarantined: undefined })],
			["mode is required", laneOf({ mode: undefined })],
		] as const
	) {
		equal(LaneSchema.safeParse(bad).success, false, why);
	}
	equal(
		laneRemotePath({ id: `ln_${ULID}`, mode: "repo" }, "acme/x"),
		`/acme/x/-/lanes/ln_${ULID}.git`,
	);
	equal(
		laneRemotePath({ id: `ln_${ULID}`, mode: "branch" }, "acme/x"),
		"/acme/x.git",
	);
	deepStrictEqual([...LANE_SEEDS], ["import"]);
	deepStrictEqual([...LANE_MODES], ["import", "branch"]);
	deepStrictEqual([...LANE_FALLBACK_ORDER], ["import", "branch"]);
	ok(
		LANE_PLATFORM_FAULT_CODES.every((c) =>
			(LANE_SEED_FAIL_CODES as readonly string[]).includes(c)
		),
		"platform-fault codes ⊂ seed failure codes",
	);
	equal(LANE_PLATFORM_FAULT_CODES.length, 4);
	equal(
		LANE_SEED_FAIL_CODES.filter((c) => isLanePlatformFault(c)).length,
		LANE_PLATFORM_FAULT_CODES.length,
	);
	equal(isLanePlatformFault("trunk-moved"), false);
	equal(isLanePlatformFault("cancelled"), false);
	for (const p of ["lane-seed", "lane-gc", "lane-delete", "purge"]) {
		ok((KERNEL_WRITE_PURPOSES as readonly string[]).includes(p), p);
	}
	ok(DENIED_REASONS.includes("lane-op") && DENIED_REASONS.includes("lane-cap"));
	equal(
		diffKey(ULID, "a".repeat(40), SHA),
		`diffs/${ULID}/${"a".repeat(40)}..${SHA}.json`,
	);
});

Deno.test("lanes: ArchiveResult per backend", () => {
	ok(
		ArchiveResultSchema.safeParse({
			kind: "lane",
			laneId: `ln_${ULID}`,
			head: SHA,
			until: 1_790_604_800_000,
		}).success,
	);
	ok(
		ArchiveResultSchema.safeParse({
			kind: "ref",
			ref: "refs/tartan/attic/ln_x",
			head: SHA,
		}).success,
	);
	ok(ArchiveResultSchema.safeParse({ kind: "summary" }).success);
	equal(
		ArchiveResultSchema.safeParse({
			kind: "lane",
			laneId: `ln_${ULID}`,
			head: SHA,
		})
			.success,
		false,
		"a kept lane repo has an end of retention",
	);
	equal(
		ArchiveResultSchema.safeParse({ kind: "summary", head: SHA }).success,
		false,
	);
});
