// Event envelope and the kernel event union (K10).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	EnvelopeSchema,
	isKernelNamespace,
	KERNEL_EVENT_DATA,
	KERNEL_EVENT_TYPES,
	KernelEventSchema,
	type KernelEventType,
	matchesEventPattern,
	mayEmit,
	parseEvent,
	validateEventData,
} from "../src/events.ts";
import { createUlid } from "../src/ids.ts";
import { loadSchema } from "./helpers.ts";

const nextUlid = createUlid({ now: () => 1_790_000_000_000 });
const REPO = nextUlid();
const NODE = REPO;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const LANE = `ln_${nextUlid()}`;
const INST = `i_${nextUlid()}`;
const AGENT = `a_${nextUlid()}`;
const USER = `u_${nextUlid()}`;
const CHANGE = "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv";
const BATCH = `lb_${nextUlid()}`;

const envelope = (
	type: string,
	data: unknown,
	overrides: Record<string, unknown> = {},
) => ({
	id: nextUlid(),
	seq: 42,
	stream: `repo:${REPO}`,
	type,
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "agent", id: AGENT, onBehalfOf: USER },
	node: NODE,
	repo: REPO,
	causedBy: nextUlid(),
	correlation: "work:acme/platform/router#42",
	depth: 2,
	shadow: false,
	at: 1_790_000_000_000,
	hash: "9f".repeat(32),
	data,
	...overrides,
});

const nodeData = { nodeId: NODE, kind: "repo", path: "acme/platform/router" };
const extData = {
	inst: INST,
	ext: "tartan.weave",
	version: "0.1.0",
	node: NODE,
	mode: "enforce",
};
const laneData = {
	laneId: LANE,
	entity: { kind: "work", id: "acme/platform/router#42" },
	owner: AGENT,
	base: SHA_A,
	mode: "repo",
	footprint: { projects: ["api"], prefixes: ["services/api/src/middleware"] },
};
const runData = {
	runId: `run_${nextUlid()}`,
	jobId: "test-api",
	state: "success",
	project: "api",
	durationMs: 1200,
	cached: false,
};

/** One example payload per kernel event type (the test fails if a type has none). */
const EXAMPLES: Record<KernelEventType, unknown> = {
	"node.created": nodeData,
	"node.moved": { ...nodeData, oldPath: "acme/router" },
	"node.archived": nodeData,
	"principal.created": { principalId: USER, kind: "user", handle: "rawkode" },
	"principal.disabled": {
		principalId: AGENT,
		kind: "agent",
		handle: "codex-2",
	},
	"extension.installed": extData,
	"extension.upgraded": extData,
	"extension.mode.changed": { ...extData, mode: "shadow" },
	"extension.configured": {
		...extData,
		source: "repo-config",
		sha: SHA_B,
		inputKey: "a".repeat(64),
		trunkSeq: 7,
		repoNode: REPO,
		keys: ["batch"],
	},
	"extension.uninstalled": { ...extData, mode: "disabled" },
	"extension.error": {
		inst: INST,
		eventId: nextUlid(),
		error: "boom",
		attempts: 5,
		breaker: "open",
	},
	"repo.created": {
		repoId: REPO,
		path: "acme/platform/router",
		artifactsName: `r-${REPO}`,
	},
	"repo.imported": {
		repoId: REPO,
		path: "acme/platform/router",
		artifactsName: `r-${REPO}`,
		source: "import-mode",
	},
	"repo.config.evaluating": { sha: SHA_B, cause: "advance", trunkSeq: 3 },
	"repo.config.evaluated": {
		inputKey: "b".repeat(64),
		sha: SHA_B,
		origin: "trunk",
		status: "error",
		code: "BUILD_VALUE",
		evaluator: "cue@v0.17.1/cli+job@1+rules@1",
		cueVersion: "v0.17.1",
	},
	"repo.config.applied": {
		sha: SHA_B,
		inputKey: "b".repeat(64),
		trunkSeq: 3,
		epoch: 2,
		installed: 1,
		updated: 0,
		removed: 0,
		overlays: 1,
		principals: [USER],
	},
	"repo.config.failed": {
		sha: SHA_B,
		inputKey: "b".repeat(64),
		code: "unapproved",
		message: "tartan.fifo is not approved for /acme",
	},
	"repo.config.previewed": {
		laneId: LANE,
		head: SHA_B,
		inputKey: "c".repeat(64),
		status: "ok",
	},
	"repo.config.needs-apply": { sha: SHA_A, cause: "repo.imported" },
	"repo.config.resolved": { trunkSeq: 3, sha: SHA_A, status: "ok" },
	"repo.config.overridden": { action: "keep-last-good", sha: SHA_A },
	"repo.policy.approved": {
		laneId: LANE,
		head: SHA_B,
		policyDigest: "d".repeat(64),
	},
	"repo.policy.revoked": { laneId: LANE, head: SHA_B, approval: nextUlid() },
	"push.accepted": {
		pushId: `p_${nextUlid()}`,
		target: LANE,
		ref: "refs/heads/main",
		before: SHA_A,
		after: SHA_B,
		via: "gateway",
	},
	"push.diffed": {
		pushId: `p_${nextUlid()}`,
		target: LANE,
		ref: "refs/heads/main",
		after: SHA_B,
		rangeBase: SHA_A,
		rangeTruncated: false,
		commits: [{
			sha: SHA_B,
			subject: "token bucket",
			trailers: [{ key: "Tartan-Work", value: "acme/platform/router#42" }],
			firstPushedBy: AGENT,
		}, {
			sha: SHA_A,
			subject: "seen only by the trigger",
			trailers: [],
			firstPushedBy: null,
		}],
		paths: ["services/api/src/middleware/limit.ts"],
		truncated: false,
		diffKey: `diffs/${REPO}/${SHA_A}..${SHA_B}.json`,
	},
	"push.rejected": {
		target: "repo",
		refs: ["refs/heads/main"],
		reason: "woven-by-tartan",
	},
	"ref.tampered": {
		target: "repo",
		ref: "refs/heads/main",
		before: SHA_A,
		after: SHA_B,
		source: "trigger",
		parkedAt: 1_790_000_000_000,
	},
	"ref.acknowledged": { refs: ["refs/heads/main"], landingPaused: false },
	"ref.reconciled": {
		ref: "refs/heads/main",
		indexSha: SHA_A,
		remoteSha: SHA_B,
		matched: false,
	},
	"ref.advanced": {
		ref: "refs/heads/main",
		old: SHA_A,
		new: SHA_B,
		advanceId: `adv_${BATCH.slice(3)}_1`,
		changes: [{ changeId: CHANGE, laneId: LANE, commit: SHA_B }],
		reasonEvents: [nextUlid(), nextUlid()],
		evidenceReused: false,
	},
	"lane.opening": { ...laneData, seed: "import" },
	"lane.opened": { ...laneData, seed: "import", seedMs: 1000, head: SHA_A },
	"lane.seed_failed": {
		laneId: LANE,
		seed: "import",
		code: "import-timeout",
		attempt: 1,
		next: "import",
		platformFault: true,
	},
	"lane.mode_degraded": {
		from: "import",
		to: "branch",
		until: 1_790_003_600_000,
		strikes: [
			{ at: 1_790_000_000_000, laneId: LANE, code: "import-error" },
			{
				at: 1_790_000_100_000,
				laneId: `ln_${nextUlid()}`,
				code: "verify-failed",
			},
			{
				at: 1_790_000_200_000,
				laneId: `ln_${nextUlid()}`,
				code: "importer-unreachable",
			},
		],
	},
	"lane.closed": { ...laneData, reason: "landed" },
	"lane.lost": laneData,
	"lane.archived": {
		...laneData,
		atticHead: SHA_B,
		atticUntil: 1_790_604_800_000,
	},
	"lane.synced": { ...laneData, head: SHA_B },
	"lane.restacked": laneData,
	"lane.delegated": { ...laneData, delegates: [USER] },
	"lane.deleted": { ...laneData, head: SHA_B },
	"lane.denied": {
		laneId: LANE,
		op: "close",
		actor: `a_${nextUlid()}`,
		reason: "lane-op",
	},
	"land.submitted": {
		batchId: BATCH,
		attempt: 1,
		ref: "refs/heads/main",
		changes: [{ changeId: CHANGE, laneId: LANE, head: SHA_B }],
		reasonEvents: [nextUlid()],
		requestedBy: INST,
		testPolicy: "checks",
		partitionKey: "api",
	},
	"land.conflicted": {
		batchId: BATCH,
		attempt: 1,
		changeId: CHANGE,
		paths: ["a.ts"],
		regions: [{
			path: "a.ts",
			regions: [{
				baseStart: 1,
				baseLines: 2,
				oursStart: 1,
				oursLines: 3,
				theirsStart: 1,
				theirsLines: 1,
			}],
		}],
		conflictsWith: ["zyxwzyxwzyxwzyxwzyxwzyxwzyxwzyxw"],
	},
	"land.vetoed": {
		batchId: BATCH,
		attempt: 1,
		changeId: CHANGE,
		inst: INST,
		message: "AWS key",
	},
	"land.testing": {
		batchId: BATCH,
		attempt: 2,
		candidateSha: SHA_B,
		base: SHA_A,
		affected: ["api"],
	},
	"land.failed": { batchId: BATCH, attempt: 3, reason: "trunk-unexplained" },
	"land.completed": {
		batchId: BATCH,
		attempt: 1,
		landed: [{ changeId: CHANGE, commit: SHA_B }],
		conflicted: [],
		vetoed: [],
	},
	"advance.stale": {
		batchId: BATCH,
		attempt: 1,
		expectOld: SHA_A,
		actual: SHA_B,
	},
	"advance.released": {
		advanceId: "adv_x_1",
		batchId: BATCH,
		reason: "abandoned",
	},
	"run.started": runData,
	"run.dispatched": {
		runId: runData.runId,
		state: "queued",
		via: "k2",
		lagMs: 950,
	},
	"job.started": runData,
	"job.completed": runData,
	"run.completed": { ...runData, jobId: undefined },
	"gate.decided": {
		point: "ref.advance",
		inst: INST,
		ext: "acme.no-secrets@0.1.0",
		decision: "veto",
		mode: "enforce",
		message: "AWS key in limit.ts:12",
		batchId: BATCH,
		changeId: CHANGE,
	},
	"presence.changed": { principal: AGENT, laneId: LANE, status: "editing" },
};

const FORGE_ONLY = new Set(["node", "principal"]);
const streamFor = (type: string) =>
	FORGE_ONLY.has(type.split(".")[0]) || type.startsWith("extension.") &&
			type !== "extension.error"
		? { stream: "forge", repo: undefined, hash: undefined }
		: {};

Deno.test("events: every kernel event type has a valid example", () => {
	deepStrictEqual(
		KERNEL_EVENT_TYPES.filter((t) => !(t in EXAMPLES)),
		[],
	);
	for (const type of KERNEL_EVENT_TYPES) {
		const data = JSON.parse(JSON.stringify(EXAMPLES[type]));
		const parsed = parseEvent(envelope(type, data, streamFor(type)));
		ok(parsed.ok, `${type}: ${parsed.ok ? "" : parsed.errors.join("; ")}`);
		equal(parsed.ok && parsed.kind, "kernel");
		const direct = KernelEventSchema.safeParse(envelope(type, data));
		ok(direct.success, type);
		equal(direct.success && direct.data.type, type);
	}
});

Deno.test("events: the discriminated union narrows on type", () => {
	const r = KernelEventSchema.safeParse(
		envelope("land.testing", EXAMPLES["land.testing"]),
	);
	ok(r.success);
	if (r.data.type === "land.testing") {
		equal(r.data.data.candidateSha, SHA_B);
		equal(r.data.data.attempt, 2);
	} else {
		throw new Error("wrong variant");
	}
});

Deno.test("events: invalid kernel payloads are rejected", () => {
	const pushAccepted = EXAMPLES["push.accepted"] as object;
	const pushDiffed = EXAMPLES["push.diffed"] as object;
	const seedFailed = EXAMPLES["lane.seed_failed"] as object;
	const degraded = EXAMPLES["lane.mode_degraded"] as {
		strikes: { at: number; laneId: string; code: string }[];
	};
	const bad: [KernelEventType, unknown][] = [
		["push.accepted", { ...pushAccepted, after: "nope" }],
		["push.accepted", { ...pushAccepted, via: "ssh" }],
		["push.accepted", { ...pushAccepted, extra: 1 }],
		// Phase 1 is slim: paths, commits and diffKey belong to push.diffed.
		["push.accepted", { ...pushAccepted, paths: ["a.ts"] }],
		["push.accepted", { ...pushAccepted, diffKey: "diffs/x" }],
		["push.accepted", {
			target: LANE,
			ref: "refs/heads/main",
			before: SHA_A,
			after: SHA_B,
			via: "gateway",
		}],
		["push.diffed", {
			...pushDiffed,
			paths: Array.from({ length: 2001 }, (_, i) => `f${i}`),
		}],
		["push.diffed", { ...pushDiffed, before: SHA_A }],
		["push.diffed", { ...pushDiffed, rangeTruncated: undefined }],
		["push.diffed", {
			...pushDiffed,
			commits: [{ sha: SHA_B, subject: "x", trailers: [] }],
		}],
		["ref.tampered", {
			ref: "refs/heads/main",
			before: SHA_A,
			after: SHA_B,
			source: "trigger",
			parkedAt: 1,
		}],
		["lane.opened", { ...laneData, mode: undefined }],
		["lane.opened", { ...laneData, mode: "import" }],
		["lane.opened", { ...laneData, seed: "branch" }],
		["lane.closed", { ...laneData, seedCode: "whatever" }],
		["lane.seed_failed", { ...seedFailed, platformFault: false }],
		["lane.seed_failed", {
			...seedFailed,
			code: "trunk-moved",
			platformFault: true,
		}],
		["lane.seed_failed", {
			...seedFailed,
			code: "cancelled",
			platformFault: false,
		}],
		["lane.seed_failed", { ...seedFailed, attempt: 10 }],
		["lane.seed_failed", { ...seedFailed, next: "repo" }],
		["lane.mode_degraded", {
			...degraded,
			strikes: [{ ...degraded.strikes[0], code: "trunk-moved" }],
		}],
		["lane.mode_degraded", { ...degraded, strikes: [] }],
		["lane.denied", { op: "push", actor: AGENT, reason: "x" }],
		["land.testing", {
			batchId: BATCH,
			attempt: 0,
			candidateSha: SHA_B,
			base: SHA_A,
			affected: [],
		}],
		["land.testing", { batchId: BATCH, attempt: 1, base: SHA_A, affected: [] }],
		["gate.decided", {
			...(EXAMPLES["gate.decided"] as object),
			decision: "maybe",
		}],
		["lane.opened", { ...laneData, laneId: "lane-1" }],
		["land.failed", { batchId: BATCH, attempt: 1, reason: "unknown" }],
		["ref.advanced", {
			...(EXAMPLES["ref.advanced"] as object),
			reasonEvents: ["not-a-ulid"],
		}],
		["node.created", { ...nodeData, path: "/abs" }],
		["principal.created", { principalId: "root", kind: "user", handle: "x" }],
	];
	for (const [type, data] of bad) {
		const r = parseEvent(envelope(type, data));
		equal(r.ok, false, `${type} accepted ${JSON.stringify(data).slice(0, 80)}`);
		equal(validateEventData(type, data).ok, false);
	}
});

Deno.test("events: envelope rules (depth, ids, stream, closed shape)", () => {
	const data = EXAMPLES["presence.changed"];
	ok(parseEvent(envelope("presence.changed", data, { depth: 8 })).ok);
	equal(parseEvent(envelope("presence.changed", data, { depth: 9 })).ok, false);
	equal(
		parseEvent(
			envelope("presence.changed", data, { id: "01K6UPPERCASE0000000000000" }),
		).ok,
		false,
	);
	equal(
		parseEvent(envelope("presence.changed", data, { stream: "repo:nope" })).ok,
		false,
	);
	equal(
		parseEvent(envelope("presence.changed", data, { stream: "global" })).ok,
		false,
	);
	equal(
		parseEvent(envelope("presence.changed", data, { unknownField: 1 })).ok,
		false,
	);
	equal(
		parseEvent(
			envelope("presence.changed", data, {
				source: { kind: "installation", id: "x" },
			}),
		).ok,
		false,
	);
	ok(
		parseEvent(envelope("presence.changed", data, {
			source: { kind: "installation", id: INST, ext: "tartan.hud@0.1.0" },
			sim: true,
		})).ok,
	);
	equal(parseEvent(envelope("Presence.Changed", data)).ok, false);
});

Deno.test("events: interface and extension events", () => {
	const submitted = {
		changeId: CHANGE,
		laneId: LANE,
		revision: 1,
		head: SHA_B,
		base: SHA_A,
		affected: ["api"],
		futureField: "kept (interfaces are open for additive minors)",
	};
	const r = parseEvent(envelope("changes.submitted", submitted));
	ok(r.ok && r.kind === "interface" && r.iface === "changes@1");
	ok(
		r.ok &&
			(r.event.data as { futureField?: string }).futureField !== undefined,
	);
	equal(
		parseEvent(envelope("changes.submitted", { ...submitted, revision: 0 })).ok,
		false,
	);
	equal(
		parseEvent(envelope("review.decided", {
			changeId: CHANGE,
			revision: 1,
			decision: "approve",
			route: "auto",
		})).ok,
		false,
		"review.decided needs decidedBy",
	);
	const x = parseEvent(
		envelope("x.acme.no-secrets.finding", { anything: [1, 2] }),
	);
	ok(x.ok && x.kind === "extension");
	const unknown = parseEvent(envelope("merge.done", {}));
	equal(unknown.ok, false);
});

Deno.test("events (K10): who may emit what", () => {
	const kernel = { kind: "kernel" } as const;
	const weave = {
		kind: "installation",
		extId: "tartan.weave",
		provides: ["queue@1"],
	} as const;
	ok(mayEmit(kernel, "push.accepted"));
	equal(mayEmit(kernel, "queue.enqueued"), false);
	ok(mayEmit(weave, "queue.enqueued"));
	ok(mayEmit(weave, "x.tartan.weave.tick"));
	equal(mayEmit(weave, "x.tartan.radar.tick"), false);
	equal(mayEmit(weave, "changes.submitted"), false);
	equal(mayEmit(weave, "push.accepted"), false);
	equal(mayEmit(weave, "ref.advanced"), false);
	ok(isKernelNamespace("job.completed"));
	ok(isKernelNamespace("extension.mode.changed"));
	equal(isKernelNamespace("queue.batched"), false);
});

Deno.test("events: subscription patterns", () => {
	ok(matchesEventPattern("*", "push.accepted"));
	ok(matchesEventPattern("changes.*", "changes.submitted"));
	ok(matchesEventPattern("extension.*", "extension.mode.changed"));
	ok(matchesEventPattern("land.testing", "land.testing"));
	equal(matchesEventPattern("land.testing", "land.tested"), false);
	equal(matchesEventPattern("land.*", "landing.x"), false);
	equal(matchesEventPattern("changes.*", "changes"), false);
});

Deno.test("events: envelope-1.json accepts what EnvelopeSchema accepts", async () => {
	const check = await loadSchema("schema/envelope-1.json");
	const good = envelope("push.accepted", EXAMPLES["push.accepted"]);
	ok(EnvelopeSchema.safeParse(good).success);
	ok(check(good).valid, check(good).errors.join("; "));
	for (
		const bad of [
			envelope("push.accepted", {}, { depth: 9 }),
			envelope("push.accepted", {}, { extra: true }),
			envelope("push.accepted", {}, { stream: "x" }),
		]
	) {
		equal(EnvelopeSchema.safeParse(bad).success, false);
		equal(check(bad).valid, false);
	}
});

Deno.test("events: KERNEL_EVENT_DATA has no type outside the kernel namespaces", () => {
	for (const type of Object.keys(KERNEL_EVENT_DATA)) {
		ok(isKernelNamespace(type), type);
	}
});

Deno.test("events (v0.2): lane seeding events and their consistency rules", () => {
	const ok1 = (type: KernelEventType, data: unknown) =>
		validateEventData(type, data).ok;
	// Tartan-side and size codes never claim a platform fault.
	for (
		const code of [
			"lane-too-large",
			"trunk-moved",
			"interrupted",
			"rate-limited",
			"lane-repo-ceiling",
		]
	) {
		ok(
			ok1("lane.seed_failed", {
				laneId: LANE,
				seed: "import",
				code,
				attempt: 2,
				next: code === "lane-too-large" ? "branch" : "import",
				platformFault: false,
			}),
			code,
		);
	}
	ok(ok1("lane.seed_failed", {
		laneId: LANE,
		seed: "import",
		code: "import-error",
		attempt: 3,
		next: "branch",
		platformFault: true,
	}));
	// A lane closed while opening carries seedCode "cancelled" (one event, K3).
	ok(ok1("lane.closed", { ...laneData, seedCode: "cancelled" }));
	// The branch backend has no seed.
	ok(ok1("lane.opened", { ...laneData, mode: "branch" }));
});

Deno.test("events: underscore event names are kernel-only", () => {
	ok(isKernelNamespace("lane.seed_failed"));
	ok(mayEmit({ kind: "kernel" }, "lane.seed_failed"));
	ok(mayEmit({ kind: "kernel" }, "lane.mode_degraded"));
	ok(matchesEventPattern("lane.*", "lane.seed_failed"));
	const ext = {
		kind: "installation",
		extId: "acme.x",
		provides: [],
	} as const;
	equal(
		mayEmit(ext, "x.acme.x.seed_failed"),
		false,
		"extension names stay [a-z0-9-]",
	);
	ok(mayEmit(ext, "x.acme.x.seed-failed"));
	equal(parseEvent(envelope("_lane.opened", laneData)).ok, false);
});
