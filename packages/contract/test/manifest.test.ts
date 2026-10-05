// Manifest validation: the zod mirror and the normative
// JSON Schema accept and reject the same documents; policy rules on top.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	extensionToolName,
	gateOnTruncated,
	type Manifest,
	manifestPolicyIssues,
	needsOwnerApproval,
	parseManifest,
} from "../src/manifest.ts";
import { clone, loadSchema } from "./helpers.ts";

const schema = await loadSchema("schema/manifest-1.json");

/** The Weave's manifest (`extensions/weave/tartan.json`), comments removed. */
const WEAVE = {
	schema: 1,
	id: "tartan.weave",
	name: "Weave",
	description:
		"Merge train: affected-project sub-trains, batching, ejection, resolver items",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: "tartan.weave" },
	storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
	provides: ["queue@1"],
	requires: ["changes@1", "checks@1", "review@1"],
	permissions: {
		repo: "read",
		land: ["refs/heads/main"],
		lanes: [],
		runs: [],
		notes: true,
		notify: true,
		"events.read": [
			"changes.*",
			"review.*",
			"checks.*",
			"land.*",
			"ref.*",
			"queue.*",
		],
		"interfaces.call": ["work@1", "changes@1"],
		"agents.dispatch": [],
		ai: false,
		net: [],
	},
	subscribe: [
		{ event: "review.decided", filter: { "data.decision": "approve" } },
		{ event: "land.*" },
		{ event: "ref.advanced" },
		{ event: "changes.revised" },
	],
	backfill: "none",
	onError: "skip",
	gates: [],
	echo: [],
	contributes: {
		slots: [
			{
				slot: "repo.tab",
				id: "weave",
				label: "Weave",
				icon: "git-merge",
				route: "weave",
				when: "node.kind == 'repo'",
			},
			{
				slot: "change.sidebar",
				id: "position",
				dynamic: true,
				refreshOn: ["queue.*", "land.*"],
			},
			{ slot: "hud.metric", id: "landed-per-hour", dynamic: true },
		],
		tools: [
			{
				name: "queue_status",
				description: "Show the Weave for a repo",
				input: "schemas/queue_status.json",
				role: 20,
			},
			{
				name: "queue_enqueue",
				description: "Enqueue an approved change",
				input: "schemas/queue_enqueue.json",
				role: 30,
			},
		],
		context: [{ id: "weave-health", maxBytes: 1024, priority: "hints" }],
		protocol: "protocol.md",
	},
	config: {
		schema: "schemas/config.json",
		default: {
			batch: 4,
			debounceMs: 2000,
			resolver: "resolve-item",
			reuseDisjointEvidence: true,
			bisect: true,
		},
	},
	limits: {
		event_cpu_ms: 1000,
		render_cpu_ms: 50,
		action_cpu_ms: 500,
		tool_cpu_ms: 2000,
		subrequests: 50,
		effects_per_second: 50,
	},
};

/** Third-party Rust → WASM gate. */
const NO_SECRETS = {
	schema: 1,
	id: "acme.no-secrets",
	name: "No secrets",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "wasm",
	entry: { js: "ext.js", wasm: ["ext.core.wasm", "ext.core2.wasm"] },
	storage: { scope: "repo", migrations: ["migrations/0001_findings.sql"] },
	permissions: {},
	inputs: ["added-lines"],
	gates: [{ point: "ref.advance", inputs: ["added-lines"] }],
	echo: [{ event: "push.accepted", inputs: ["added-lines"] }],
	contributes: {
		slots: [
			{ slot: "change.sidebar", id: "findings", dynamic: true },
			{ slot: "change.gate", id: "gate", dynamic: true },
			{ slot: "repo.tab", id: "secrets", label: "Secrets", route: "secrets" },
		],
		tools: [{
			name: "scan",
			description: "Scan text for secrets",
			input: { type: "object", properties: { text: { type: "string" } } },
		}],
		settings: {
			type: "object",
			properties: { allowlist: { type: "array", items: { type: "string" } } },
		},
	},
};

const SWARM_PACK = {
	schema: 1,
	kind: "pack",
	id: "tartan.pack.swarm",
	name: "Swarm",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: "tartan.pack.swarm" },
	storage: { scope: "node" },
	permissions: {},
	members: [
		{ id: "tartan.work", version: "0.1.0" },
		{
			id: "tartan.review",
			version: "0.1.0",
			config: { mode: "by-exception", autoThreshold: 0.35 },
		},
		{ id: "tartan.weave", version: "0.1.0", config: { batch: 4 } },
	],
};

const JS_MINIMAL = {
	schema: 1,
	id: "acme.hello",
	name: "Hello",
	version: "1.2.3-beta.1",
	api: "tartan:ext@0.1.0",
	runtime: "js",
	entry: { js: "main.js" },
	storage: { scope: "node", mode: "kv" },
	permissions: { repo: "read", "events.read": ["*"] },
};

const VALID: Record<string, unknown> = {
	weave: WEAVE,
	"no-secrets": NO_SECRETS,
	"swarm-pack": SWARM_PACK,
	"js-minimal": JS_MINIMAL,
};

const set = (
	base: Record<string, unknown>,
	path: string[],
	value: unknown,
): Record<string, unknown> => {
	const copy = clone(base);
	let cursor: Record<string, unknown> = copy;
	for (const key of path.slice(0, -1)) {
		cursor = cursor[key] as Record<string, unknown>;
	}
	const last = path[path.length - 1];
	if (value === undefined) delete cursor[last];
	else cursor[last] = value;
	return copy;
};

const INVALID: Record<string, unknown> = {
	"missing permissions": set(JS_MINIMAL, ["permissions"], undefined),
	"missing storage": set(JS_MINIMAL, ["storage"], undefined),
	"schema 2": set(JS_MINIMAL, ["schema"], 2),
	"uppercase id": set(JS_MINIMAL, ["id"], "Acme.Hello"),
	"id without a dot": set(JS_MINIMAL, ["id"], "hello"),
	"id too long": set(JS_MINIMAL, ["id"], `acme.${"x".repeat(64)}`),
	"two-part version": set(JS_MINIMAL, ["version"], "1.0"),
	"wrong api": set(JS_MINIMAL, ["api"], "tartan:ext@0.2.0"),
	"unknown runtime": set(JS_MINIMAL, ["runtime"], "python"),
	"wasm without js glue": set(NO_SECRETS, ["entry"], {
		wasm: ["ext.core.wasm"],
	}),
	"wasm without wasm modules": set(NO_SECRETS, ["entry"], { js: "ext.js" }),
	"builtin without builtin entry": set(WEAVE, ["entry"], { js: "main.js" }),
	"js without js entry": set(JS_MINIMAL, ["entry"], { builtin: "tartan.x" }),
	"empty entry": set(JS_MINIMAL, ["entry"], {}),
	"empty wasm list": set(NO_SECRETS, ["entry", "wasm"], []),
	"unknown top-level prop": set(JS_MINIMAL, ["hooks"], {}),
	"unknown permission": set(JS_MINIMAL, ["permissions", "fs"], true),
	"net not empty (v1)": set(JS_MINIMAL, ["permissions", "net"], [
		"example.com",
	]),
	"secrets not empty (v1)": set(JS_MINIMAL, ["permissions", "secrets"], ["K"]),
	"unknown provided interface": set(JS_MINIMAL, ["provides"], ["merge@1"]),
	"duplicate provides": set(WEAVE, ["provides"], ["queue@1", "queue@1"]),
	"bad requires": set(WEAVE, ["requires"], ["changes"]),
	"land not refs/heads": set(WEAVE, ["permissions", "land"], ["main"]),
	"bad lanes permission": set(WEAVE, ["permissions", "lanes"], ["push"]),
	"bad events.read pattern": set(WEAVE, ["permissions", "events.read"], [
		"Changes.*",
	]),
	"bad subscribe pattern": set(WEAVE, ["subscribe"], [{ event: "land.**" }]),
	"subscribe extra prop": set(WEAVE, ["subscribe"], [{
		event: "land.*",
		x: 1,
	}]),
	"subscribe filter object value": set(WEAVE, ["subscribe"], [{
		event: "land.*",
		filter: { a: { b: 1 } },
	}]),
	"bad tool name": set(WEAVE, ["contributes", "tools"], [{
		name: "Queue-Status",
		description: "x",
		input: "x.json",
	}]),
	"tool without input": set(WEAVE, ["contributes", "tools"], [{
		name: "queue_status",
		description: "x",
	}]),
	"tool role 25": set(WEAVE, ["contributes", "tools"], [{
		name: "queue_status",
		description: "x",
		input: "x.json",
		role: 25,
	}]),
	"slot id uppercase": set(WEAVE, ["contributes", "slots"], [{
		slot: "repo.tab",
		id: "Weave",
	}]),
	"slot carries a component path (forgepoint style)": set(
		WEAVE,
		["contributes", "slots"],
		[{ slot: "repo.tab", id: "weave", componentPath: "./Weave.vue" }],
	),
	"slot cache bogus": set(WEAVE, ["contributes", "slots"], [{
		slot: "repo.tab",
		id: "weave",
		cache: "global",
	}]),
	"slot order out of range": set(WEAVE, ["contributes", "slots"], [{
		slot: "repo.tab",
		id: "weave",
		order: 5000,
	}]),
	"gate timeout below 50": set(NO_SECRETS, ["gates"], [{
		point: "ref.advance",
		timeoutMs: 10,
	}]),
	"gate unknown point": set(NO_SECRETS, ["gates"], [{ point: "merge" }]),
	"echo on another event": set(NO_SECRETS, ["echo"], [{
		event: "push.rejected",
	}]),
	"echo budget above 1500": set(NO_SECRETS, ["echo"], [{
		event: "push.accepted",
		timeoutMs: 2000,
	}]),
	"context maxBytes above 4096": set(WEAVE, ["contributes", "context"], [{
		id: "x",
		maxBytes: 8192,
	}]),
	"protocol not markdown": set(WEAVE, ["contributes", "protocol"], "card.txt"),
	"settings not an object": set(NO_SECRETS, ["contributes", "settings"], "x"),
	"render_cpu_ms above 200": set(WEAVE, ["limits", "render_cpu_ms"], 500),
	"unknown limit": set(WEAVE, ["limits", "memory_mb"], 128),
	"storage scope global": set(WEAVE, ["storage", "scope"], "global"),
	"migration path": set(WEAVE, ["storage", "migrations"], ["init.sql"]),
	"quota above 1024": set(WEAVE, ["storage", "quotaMB"], 4096),
	"input with whitespace": set(NO_SECRETS, ["inputs"], ["file: secrets.txt"]),
	"backfill forever": set(WEAVE, ["backfill"], "forever"),
	"members without version": set(SWARM_PACK, ["members"], [{
		id: "tartan.work",
	}]),
	"name empty": set(JS_MINIMAL, ["name"], ""),
	"not an object": "tartan.weave",
};

/** v0.2 additions accepted by both the zod mirror and the JSON Schema. */
const VALID_V02: Record<string, unknown> = {
	"lanes delegate": set(WEAVE, ["permissions", "lanes"], [
		"open",
		"close",
		"delegate",
	]),
	"subscribe to lane.seed_failed": set(WEAVE, ["subscribe"], [
		{ event: "lane.seed_failed" },
		{ event: "lane.mode_degraded" },
	]),
	"events.read of lane.seed_failed": set(
		WEAVE,
		["permissions", "events.read"],
		[
			"lane.seed_failed",
			"lane.*",
		],
	),
};

Deno.test("manifest v0.2: delegate and underscore kernel event names are accepted", () => {
	for (const [name, manifest] of Object.entries(VALID_V02)) {
		const parsed = parseManifest(manifest);
		ok(
			parsed.ok,
			`${name} (zod): ${parsed.ok ? "" : parsed.errors.join("; ")}`,
		);
		const json = schema(manifest);
		ok(json.valid, `${name} (json schema): ${json.errors.join("; ")}`);
	}
	const bad = set(WEAVE, ["permissions", "lanes"], ["merge"]);
	equal(parseManifest(bad).ok, false);
	equal(schema(bad).valid, false);
});

Deno.test("manifest: valid fixtures pass zod and the JSON Schema", () => {
	for (const [name, manifest] of Object.entries(VALID)) {
		const parsed = parseManifest(manifest);
		ok(
			parsed.ok,
			`${name} (zod): ${parsed.ok ? "" : parsed.errors.join("; ")}`,
		);
		const json = schema(manifest);
		ok(json.valid, `${name} (json schema): ${json.errors.join("; ")}`);
	}
});

Deno.test("manifest: invalid fixtures fail zod and the JSON Schema", () => {
	for (const [name, manifest] of Object.entries(INVALID)) {
		const parsed = parseManifest(manifest);
		equal(parsed.ok, false, `${name}: zod accepted it`);
		equal(schema(manifest).valid, false, `${name}: JSON Schema accepted it`);
	}
});

Deno.test("manifest: zod applies the schema defaults", () => {
	const parsed = parseManifest(NO_SECRETS);
	ok(parsed.ok);
	const m = parsed.manifest;
	equal(m.kind, "extension");
	equal(m.backfill, "none");
	equal(m.onError, "skip");
	equal(m.permissions.repo, "none");
	equal(m.storage.mode, "sql");
	equal(m.storage.quotaMB, 256);
	equal(m.gates?.[0].timeoutMs, 1500);
	equal(m.gates?.[0].default, "allow");
	equal(m.echo?.[0].timeoutMs, 800);
	equal(m.contributes?.slots?.[0].cache, "viewer");
	equal(m.contributes?.slots?.[0].order, 0);
	equal(m.contributes?.tools?.[0].role, 30);
	equal(gateOnTruncated(m.gates![0]), "veto");
	equal(gateOnTruncated({ ...m.gates![0], point: "push" }), "allow");
});

const parsedOrThrow = (input: unknown): Manifest => {
	const r = parseManifest(input);
	if (!r.ok) throw new Error(r.errors.join("; "));
	return r.manifest;
};

Deno.test("manifest policy: builtin fixtures are clean when bundled", () => {
	deepStrictEqual(
		manifestPolicyIssues(parsedOrThrow(WEAVE), { bundled: true }),
		[],
	);
	deepStrictEqual(
		manifestPolicyIssues(parsedOrThrow(SWARM_PACK), { bundled: true }),
		[],
	);
	deepStrictEqual(
		manifestPolicyIssues(parsedOrThrow(NO_SECRETS), { bundled: false }),
		[],
	);
});

Deno.test("manifest policy: install-time rules beyond the schema", () => {
	const issues = (input: unknown, bundled = false) =>
		manifestPolicyIssues(parsedOrThrow(input), { bundled }).join("\n");
	ok(issues(WEAVE).includes("reserved for bundled builtins"));
	ok(issues(WEAVE).includes("runtime: builtin is only for bundled packages"));
	ok(
		issues(set(JS_MINIMAL, ["permissions", "land"], ["refs/heads/main"]))
			.includes("only queue@1 providers may hold land"),
	);
	ok(
		issues(set(JS_MINIMAL, ["permissions", "ai"], true)).includes(
			"builtin-only",
		),
	);
	ok(
		issues(set(JS_MINIMAL, ["permissions", "agents.dispatch"], ["worker"]))
			.includes("builtin-only"),
	);
	ok(
		issues(set(JS_MINIMAL, ["contributes"], {
			slots: [{ slot: "repo.tabs", id: "x" }],
		})).includes("unknown slot repo.tabs"),
	);
	ok(
		issues(set(SWARM_PACK, ["members"], []), true).includes(
			"a pack needs members",
		),
	);
	ok(
		issues(set(JS_MINIMAL, ["members"], [{ id: "a.b", version: "1.0.0" }]))
			.includes("only packs have members"),
	);
	ok(
		issues(set(JS_MINIMAL, ["contributes"], {
			tools: [
				{ name: "scan", description: "a", input: "a.json" },
				{ name: "scan", description: "b", input: "b.json" },
			],
		})).includes("duplicate tool name"),
	);
});

Deno.test("manifest: Owner approval and tool naming", () => {
	equal(needsOwnerApproval(parsedOrThrow(WEAVE)), true);
	equal(needsOwnerApproval(parsedOrThrow(NO_SECRETS)), false);
	equal(needsOwnerApproval(parsedOrThrow(NO_SECRETS), { locked: true }), true);
	equal(
		needsOwnerApproval(parsedOrThrow(NO_SECRETS), { backgroundRole: 30 }),
		true,
	);
	equal(extensionToolName("acme.no-secrets", "scan"), "no_secrets_scan");
});
