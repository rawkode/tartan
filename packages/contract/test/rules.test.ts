// Contract-level rules: one case per rule the contract enforces.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	IdpConfigRequestSchema,
	IdpRegisterRequestSchema,
	InstallRequestSchema,
} from "../src/api.ts";
import {
	CAPS_METHOD_POLICY,
	CAPS_METHODS,
	capsDenial,
	type KernelCaps,
} from "../src/caps.ts";
import {
	ACTOR_REQUIRED_TOOLS,
	boundRole,
	PERMISSION_MIN_ROLE,
	PERMISSION_TOKEN_SCOPES,
	scopesAllow,
	SESSION_BOUNDS,
} from "../src/common.ts";
import {
	DO_MODULE_HEADER,
	MIGRATION_RANGES,
	moduleRequest,
} from "../src/do/common.ts";
import { BREAKER, HOST_TABLES } from "../src/do/ext.ts";
import type { AuthContext } from "../src/do/forge.ts";
import { KERNEL_EVENT_DATA, mayEmit } from "../src/events.ts";
import { runPollStep, runSlotWaitStep } from "../src/ids.ts";
import { INTERFACE_TOOLS } from "../src/interfaces.ts";
import { laneStateAfter } from "../src/lanes.ts";
import {
	type Manifest,
	type ManifestPermissions,
	manifestPolicyIssues,
	parseManifest,
	RESERVED_TOOL_NAMES,
} from "../src/manifest.ts";
import { KERNEL_TOOLS } from "../src/mcp.ts";
import { CiJobGraphSchema, JobGraphSchema } from "../src/pipeline.ts";
import { actorBoundsOf } from "../src/security.ts";
import { readJson } from "./helpers.ts";

const ULID = "01k6aaaaaaaaaaaaaaaaaaaaaa";
const SHA = "a".repeat(40);
const LANE = `ln_${ULID}`;

const perms = (p: Partial<ManifestPermissions>): ManifestPermissions => ({
	repo: "none",
	...p,
});

// ---------------------------------------------------------------------------
// Credential bounds
// ---------------------------------------------------------------------------

Deno.test("token ceiling, node subtree and lane pin bound the granted role", () => {
	const token = {
		maxRole: 30,
		scopes: ["repo:read", "repo:write", "lanes"],
		nodeId: "n_docs",
		laneId: null,
	} as const;
	equal(boundRole(50, token, { withinTokenNode: true }), 30);
	equal(boundRole(50, token, { withinTokenNode: false }), 0, "outside node");
	equal(boundRole(20, token, { withinTokenNode: true }), 20);
	equal(boundRole(40, null, { withinTokenNode: false }), 40, "no bounds");
	equal(boundRole(50, SESSION_BOUNDS, { withinTokenNode: false }), 50);
	const pinned = { ...token, nodeId: null, laneId: LANE };
	equal(boundRole(40, pinned, { withinTokenNode: true, laneId: LANE }), 30);
	equal(boundRole(40, pinned, { withinTokenNode: true }), 20, "off-lane");
	equal(
		boundRole(40, pinned, {
			withinTokenNode: true,
			laneId: `ln_${"b".repeat(26)}`,
		}),
		20,
	);
});

Deno.test("scopes per permission; sessions are unrestricted", () => {
	for (const perm of Object.keys(PERMISSION_MIN_ROLE)) {
		ok(perm in PERMISSION_TOKEN_SCOPES, perm);
	}
	ok(scopesAllow(null, "delete"));
	ok(scopesAllow([], "read-metadata"));
	ok(scopesAllow(["repo:read"], "read"));
	equal(scopesAllow(["repo:read"], "push"), false);
	ok(scopesAllow(["repo:write"], "push"));
	equal(scopesAllow(["repo:write", "mcp"], "claim"), false);
	ok(scopesAllow(["lanes"], "submit"));
	equal(scopesAllow(["repo:write", "lanes", "mcp", "api"], "grant"), false);
});

Deno.test("actorBoundsOf derives bounds from an AuthContext", () => {
	const agent: AuthContext = {
		principal: "a_x",
		kind: "agent",
		via: "agent-token",
		scopes: ["mcp", "lanes"],
		nodeId: "n_docs",
		laneId: LANE,
		maxRole: 30,
		isAdmin: false,
	};
	deepStrictEqual(actorBoundsOf(agent), {
		maxRole: 30,
		scopes: ["mcp", "lanes"],
		nodeId: "n_docs",
		laneId: LANE,
	});
	deepStrictEqual(
		actorBoundsOf({ ...agent, kind: "user", via: "session" }),
		SESSION_BOUNDS,
	);
});

// ---------------------------------------------------------------------------
// Per-method caps policy
// ---------------------------------------------------------------------------

Deno.test("CAPS_METHOD_POLICY lists every KernelCaps method", () => {
	// Compile-time: Record<CapsMethod, …> is exhaustive. Runtime: the names match.
	const sample: Record<keyof KernelCaps, true> = {
		repo: true,
		lanes: true,
		land: true,
		runs: true,
		notes: true,
		events: true,
		notify: true,
		authz: true,
		principals: true,
		interfaces: true,
		timers: true,
		agents: true,
		ai: true,
		clock: true,
		ids: true,
	};
	deepStrictEqual(
		[...new Set(CAPS_METHODS.map((m) => m.split(".")[0]))].sort(),
		Object.keys(sample).sort(),
	);
	// 45: `repo.policy` (repository config); 46: `interfaces.provider`
	// (0.4.1).
	equal(CAPS_METHODS.length, 46);
});

Deno.test("grants, read-only and shadow are decided per method", () => {
	const call = (
		method: Parameters<typeof capsDenial>[0],
		grants: ManifestPermissions,
		over: {
			mode?: "enforce" | "shadow";
			readOnly?: boolean;
			mutatingTool?: boolean;
		} = {},
	) =>
		capsDenial(method, {
			grants,
			mode: over.mode ?? "enforce",
			readOnly: over.readOnly ?? false,
			mutatingTool: over.mutatingTool,
		});
	const changes = perms({ repo: "read", lanes: ["adopt"], notes: true });
	// A read-only render may read lanes and runs (the namespace is not an effect).
	equal(call("lanes.get", changes, { readOnly: true }), null);
	equal(call("lanes.open", changes), "grant");
	equal(call("lanes.adopt", changes), null);
	equal(call("lanes.adopt", changes, { readOnly: true }), "read-only");
	equal(call("lanes.adopt", changes, { mode: "shadow" }), "shadow");
	// tartan.changes holds only lanes:["adopt"] and still reads lanes.
	equal(call("lanes.get", perms({ lanes: ["adopt"] })), null);
	equal(call("lanes.get", perms({})), "grant");
	const ci = perms({
		repo: "read",
		runs: ["start", "cancel"],
		"land.report": true,
	});
	equal(call("runs.get", ci, { readOnly: true }), null);
	equal(call("runs.logs", ci, { readOnly: true }), null);
	equal(call("runs.start", ci, { readOnly: true }), "read-only");
	equal(call("land.status", ci), null);
	equal(call("land.report", ci), null);
	equal(call("land.submit", ci), "grant");
	const weave = perms({ repo: "read", land: ["refs/heads/main"] });
	equal(call("land.status", weave, { readOnly: true }), null);
	equal(call("land.submit", weave, { mode: "shadow" }), "shadow");
	equal(call("authz.check", perms({})), null);
	equal(call("principals.get", perms({})), null);
	equal(call("events.emit", perms({}), { readOnly: true }), "read-only");
	equal(call("events.emit", perms({}), { mode: "shadow" }), null);
	equal(call("notes.contribute", changes, { mode: "shadow" }), null);
	const board = perms({ "interfaces.call": ["work@1"] });
	equal(
		call("interfaces.call", board, { readOnly: true, mutatingTool: false }),
		null,
	);
	equal(
		call("interfaces.call", board, { readOnly: true, mutatingTool: true }),
		"read-only",
	);
	equal(call("interfaces.call", board, { readOnly: true }), "read-only");
	equal(call("interfaces.call", perms({})), "grant");
	equal(CAPS_METHOD_POLICY["timers.set"].effect, true);
});

Deno.test("v0.2 K16, K17: lanes.delegate needs the delegate grant; repo.laneRange is a read", () => {
	const call = (
		method: Parameters<typeof capsDenial>[0],
		grants: ManifestPermissions,
		over: { mode?: "enforce" | "shadow"; readOnly?: boolean } = {},
	) =>
		capsDenial(method, {
			grants,
			mode: over.mode ?? "enforce",
			readOnly: over.readOnly ?? false,
		});
	const work = perms({ repo: "read", lanes: ["open", "close", "delegate"] });
	equal(call("lanes.delegate", work), null);
	equal(call("lanes.delegate", perms({ lanes: ["open", "close"] })), "grant");
	equal(call("lanes.delegate", work, { readOnly: true }), "read-only");
	equal(call("lanes.delegate", work, { mode: "shadow" }), "shadow");
	equal(
		call("repo.laneRange", perms({ repo: "read" }), { readOnly: true }),
		null,
	);
	equal(
		call("repo.laneRange", perms({ repo: "read" }), { mode: "shadow" }),
		null,
	);
	equal(call("repo.laneRange", perms({ lanes: ["open"] })), "grant");
	equal(CAPS_METHOD_POLICY["repo.laneRange"].effect, false);
	equal(CAPS_METHOD_POLICY["lanes.archive"].effect, true);
});

// ---------------------------------------------------------------------------
// Extensions start CI only
// ---------------------------------------------------------------------------

Deno.test("caps.runs.start accepts CI graphs only", () => {
	const ci = {
		repo: { path: "acme/platform/router" },
		kind: "ci",
		subject: { kind: "change", id: "zkqv" },
		source: { repoId: ULID, laneId: LANE },
		sha: SHA,
		jobs: [{ id: "test", run: "pnpm test" }],
	};
	ok(CiJobGraphSchema.safeParse(ci).success);
	const push = {
		...ci,
		kind: "git",
		subject: { kind: "kernel", id: "repair" },
		jobs: [{
			id: "push",
			argv: ["git", "push", "origin", "x:refs/heads/main"],
		}],
	};
	ok(JobGraphSchema.safeParse(push).success, "the kernel graph allows git");
	equal(CiJobGraphSchema.safeParse(push).success, false);
	equal(CiJobGraphSchema.safeParse({ ...ci, kind: "git" }).success, false);
	equal(
		CiJobGraphSchema.safeParse({
			...ci,
			jobs: [{ id: "push", argv: ["git", "push"] }],
		}).success,
		false,
	);
	equal(
		CiJobGraphSchema.safeParse({
			...ci,
			jobs: [{ id: "x", run: "true", argv: ["git"] }],
		}).success,
		false,
	);
	equal(
		CiJobGraphSchema.safeParse({ ...ci, subject: { kind: "kernel", id: "x" } })
			.success,
		false,
	);
	equal(
		CiJobGraphSchema.safeParse({
			...ci,
			jobs: [{ id: "a", needs: ["a"], run: "x" }],
		}).success,
		false,
		"cycles are still rejected",
	);
	equal(
		CiJobGraphSchema.safeParse({
			...ci,
			jobs: [{ id: "a", run: "x", env: { ARTIFACTS_TOKEN: "x" } }],
		}).success,
		false,
		"reserved env is still rejected",
	);
});

// ---------------------------------------------------------------------------
// Id-keyed tools take a repo
// ---------------------------------------------------------------------------

Deno.test("every id-keyed tool accepts an optional repo", () => {
	const shapeOf = (input: unknown): Record<string, unknown> =>
		(input as { shape?: Record<string, unknown> }).shape ?? {};
	const inputs: Record<string, unknown> = {
		...Object.fromEntries(
			Object.entries(KERNEL_TOOLS).map(([n, t]) => [n, t.input]),
		),
		...Object.fromEntries(
			Object.entries(INTERFACE_TOOLS).map(([n, t]) => [n, t.def.input]),
		),
	};
	// Every tool whose input names a lane, change, conflict or run by id
	// (and nothing that already carries the repo, like a work ref) has `repo`.
	const idKeyed = Object.entries(inputs).filter(([, input]) => {
		const keys = Object.keys(shapeOf(input));
		return ["laneId", "changeId", "conflictId", "runId"].some((k) =>
			keys.includes(k)
		);
	});
	ok(idKeyed.length >= 14);
	for (const [name, input] of idKeyed) {
		ok(Object.keys(shapeOf(input)).includes("repo"), `${name} has repo`);
	}
	const parsed = INTERFACE_TOOLS.queue_enqueue.def.input.safeParse({
		repo: "acme/platform/router",
		changeId: "z".repeat(32),
	});
	ok(parsed.success);
	deepStrictEqual(parsed.data, {
		repo: "acme/platform/router",
		changeId: "z".repeat(32),
	});
	ok(KERNEL_TOOLS.runs_status.input.safeParse({ runId: "r_x" }).success);
});

// ---------------------------------------------------------------------------
// Lane state from changes@1 events
// ---------------------------------------------------------------------------

Deno.test("changes@1 events move the lane; replays are harmless", () => {
	equal(laneStateAfter("open", "changes.submitted"), "submitted");
	equal(laneStateAfter("submitted", "changes.submitted"), null);
	equal(laneStateAfter("landing", "changes.submitted"), null);
	equal(laneStateAfter("submitted", "changes.abandoned"), "open");
	equal(laneStateAfter("submitted", "changes.superseded"), "open");
	equal(laneStateAfter("open", "changes.abandoned"), null);
	equal(laneStateAfter("open", "changes.revised"), null);
	equal(laneStateAfter("open", "push.accepted"), null);
});

// ---------------------------------------------------------------------------
// Manifest policy
// ---------------------------------------------------------------------------

const BASE = {
	schema: 1,
	id: "acme.thing",
	name: "Thing",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "js",
	entry: { js: "ext.js" },
	storage: { scope: "repo" },
	permissions: {},
};

const manifest = (over: Record<string, unknown>): Manifest => {
	const r = parseManifest({ ...BASE, ...over });
	if (!r.ok) throw new Error(r.errors.join("; "));
	return r.manifest;
};

Deno.test("one id per slot contribution in a manifest", () => {
	const dup = manifest({
		contributes: {
			slots: [
				{ slot: "repo.tab", id: "work", route: "work" },
				{ slot: "work.panel", id: "work" },
			],
		},
	});
	ok(
		manifestPolicyIssues(dup, { bundled: false }).some((i) =>
			i.includes("duplicate id")
		),
	);
	const fine = manifest({
		contributes: {
			slots: [
				{ slot: "repo.tab", id: "work", route: "work" },
				{ slot: "work.panel", id: "item" },
			],
		},
	});
	deepStrictEqual(manifestPolicyIssues(fine, { bundled: false }), []);
});

Deno.test("exposed tool names never shadow kernel or interface tools", () => {
	ok(
		RESERVED_TOOL_NAMES.has("whoami") && RESERVED_TOOL_NAMES.has("work_claim"),
	);
	for (
		const [id, tool] of [
			["acme.review", "decide"],
			["acme.inbox", "send"],
			["acme.repo", "read"],
			["acme.work", "claim"],
		]
	) {
		const issues = manifestPolicyIssues(
			manifest({
				id,
				contributes: {
					tools: [{ name: tool, description: "x", input: "x.json" }],
				},
			}),
			{ bundled: false },
		);
		ok(
			issues.some((i) => i.includes("kernel or interface tool")),
			`${id}/${tool}`,
		);
	}
	const scan = manifest({
		id: "acme.no-secrets",
		contributes: {
			tools: [{ name: "scan", description: "x", input: "x.json" }],
		},
	});
	deepStrictEqual(manifestPolicyIssues(scan, { bundled: false }), []);
});

Deno.test("entry.builtin is for bundled packages only", () => {
	const sneaky = manifest({ entry: { js: "ext.js", builtin: "tartan.weave" } });
	ok(
		manifestPolicyIssues(sneaky, { bundled: false }).includes(
			"entry.builtin: only for bundled packages",
		),
	);
});

Deno.test("pack members may carry an Owner-approved backgroundRole", async () => {
	const swarm = await readJson("../../extensions/packs/swarm/tartan.json");
	const parsed = parseManifest(swarm);
	ok(parsed.ok);
	const roles = Object.fromEntries(
		(parsed.ok ? parsed.manifest.members ?? [] : []).map((
			m,
		) => [m.id, m.backgroundRole]),
	);
	equal(roles["tartan.weave"], 30);
	equal(roles["tartan.work"], undefined);
	equal(
		parseManifest({
			...swarm as object,
			members: [{ id: "a.b", version: "1.0.0", backgroundRole: 50 }],
		}).ok,
		false,
	);
	ok(ACTOR_REQUIRED_TOOLS.includes("queue_enqueue"));
});

Deno.test("tartan.review's ref.advance gate fails closed", async () => {
	const review = parseManifest(
		await readJson("../../extensions/review/tartan.json"),
	);
	ok(review.ok);
	equal(review.ok && review.manifest.gates?.[0].default, "veto");
	ok(
		KERNEL_EVENT_DATA["gate.decided"].safeParse({
			point: "ref.advance",
			inst: `i_${ULID}`,
			ext: "tartan.review",
			decision: "allow",
			mode: "enforce",
			message: "timed out",
			basis: "default",
		}).success,
	);
});

// ---------------------------------------------------------------------------
// Extension event names are one segment
// ---------------------------------------------------------------------------

Deno.test("an extension cannot emit into a longer id's namespace", () => {
	const a = { kind: "installation", extId: "acme.a", provides: [] } as const;
	ok(mayEmit(a, "x.acme.a.evt"));
	equal(mayEmit(a, "x.acme.a.b.evt"), false);
	const ab = { kind: "installation", extId: "acme.a.b", provides: [] } as const;
	ok(mayEmit(ab, "x.acme.a.b.evt"));
});

// ---------------------------------------------------------------------------
// RunWorkflow loop steps carry job and attempt
// ---------------------------------------------------------------------------

Deno.test("poll and slot-wait step names are job- and attempt-bound", () => {
	equal(runPollStep("test", 1, 3), "poll-test-a1-3");
	equal(runPollStep("test", 2, 3), "poll-test-a2-3");
	equal(runSlotWaitStep("test-api", 1, 0), "slot-wait-test-api-a1-0");
	ok(runPollStep("x".repeat(500), 99, 9999).length <= 100);
	throws(() => runPollStep("test", 0, 1));
	throws(() => runSlotWaitStep("test", 1, -1));
});

// ---------------------------------------------------------------------------
// Inbox body bytes; ExtensionDO ledgers
// ---------------------------------------------------------------------------

Deno.test("inbox_send bodies over 2 KB are rejected, not truncated", () => {
	const input = (body: string) =>
		KERNEL_TOOLS.inbox_send.input.safeParse({
			to: "codex-2",
			body,
			repo: "acme/x",
		})
			.success;
	ok(input("a".repeat(2048)));
	equal(input("a".repeat(2049)), false);
	equal(input("é".repeat(1025)), false, "2050 bytes of UTF-8");
	ok(input("é".repeat(1024)));
});

Deno.test("ExtensionDO host and extension migration ledgers", () => {
	deepStrictEqual(MIGRATION_RANGES.ext, { host: [1, 99], extension: [1, 999] });
	ok(
		HOST_TABLES.includes("_migrations") &&
			HOST_TABLES.includes("_ext_migrations"),
	);
});

Deno.test("v0.2: breaker tables replace the stateless runtime's kv", () => {
	ok(HOST_TABLES.includes("_strikes") && HOST_TABLES.includes("_inflight"));
	equal((HOST_TABLES as readonly string[]).includes("_kv"), false);
	deepStrictEqual(BREAKER, {
		strikes: 3,
		windowMs: 600_000,
		cooldownMs: 900_000,
		maxCooldownMs: 14_400_000,
	});
	equal(
		InstallRequestSchema.safeParse({
			extId: "acme.x",
			version: "0.1.0",
			node: "acme",
			mode: "enforce",
			runtimeOverride: "stateless",
		}).success,
		false,
	);
	ok(
		InstallRequestSchema.safeParse({
			extId: "acme.x",
			version: "0.1.0",
			node: "acme",
			mode: "enforce",
			runtimeOverride: "wasm",
		}).success,
	);
});

// ---------------------------------------------------------------------------
// Module fetch addressing
// ---------------------------------------------------------------------------

Deno.test("moduleRequest always sets the routing header itself", () => {
	const req = new Request("https://forge.test/-/live?repo=x", {
		headers: { [DO_MODULE_HEADER]: "core", upgrade: "websocket" },
	});
	const routed = moduleRequest("events", req);
	equal(routed.headers.get(DO_MODULE_HEADER), "events");
	equal(routed.headers.get("upgrade"), "websocket");
	equal(routed.url, req.url);
	equal(req.headers.get(DO_MODULE_HEADER), "core", "the original is untouched");
});

// ---------------------------------------------------------------------------
// The demo IdP is a public PKCE client; DCR registration
// ---------------------------------------------------------------------------

Deno.test("IdP public client (none) by default; DCR request", () => {
	const manual = IdpConfigRequestSchema.safeParse({
		issuer: "https://id.rawkode.academy",
		clientId: "tartan",
	});
	ok(manual.success);
	equal(manual.success && manual.data.clientAuth, "none");
	equal(
		IdpConfigRequestSchema.safeParse({
			issuer: "https://id.rawkode.academy",
			clientId: "tartan",
			clientAuth: "none",
			clientSecret: "s3cret",
		}).success,
		false,
	);
	ok(
		IdpConfigRequestSchema.safeParse({
			issuer: "https://idp.example",
			clientId: "tartan",
			clientAuth: "client_secret_basic",
			clientSecret: "s3cret",
		}).success,
	);
	ok(
		IdpRegisterRequestSchema.safeParse({ issuer: "https://id.rawkode.academy" })
			.success,
	);
	equal(
		IdpRegisterRequestSchema.safeParse({ issuer: "http://id.rawkode.academy" })
			.success,
		false,
	);
	// U44: an initial access token for IdPs that require one.
	ok(
		IdpRegisterRequestSchema.safeParse({
			issuer: "https://id.rawkode.academy",
			initialAccessToken: "iat-123",
		}).success,
	);
	equal(
		IdpRegisterRequestSchema.safeParse({
			issuer: "https://id.rawkode.academy",
			initialAccessToken: "",
		}).success,
		false,
	);
});

// ---------------------------------------------------------------------------
// The WIT world carries the fields the TS contract has
// ---------------------------------------------------------------------------

Deno.test("WIT gate-decision, notify options, event and slot context", async () => {
	const wit = await Deno.readTextFile(
		new URL("../wit/tartan.wit", import.meta.url),
	);
	for (
		const needle of [
			"full-scan: bool",
			"record notify-options",
			"dedupe-key: option<string>",
			"shadow: bool",
			"node: string,\n    repo: option<string>",
			"slot: option<string>",
			"notify: func(principal: string, options: notify-options",
		]
	) {
		ok(wit.includes(needle), needle);
	}
});
