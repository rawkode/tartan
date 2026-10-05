// Extension manifest `tartan.json` v1.
//
// Zod mirror of the normative `schema/manifest-1.json` (draft 2020-12); both
// accept and reject the same documents (`manifest.test.ts` cross-checks them).
// The zod mirror also applies the schema's defaults on output. Install-time
// rules that a JSON Schema cannot express live in `manifestPolicyIssues()`.

import { z } from "zod";
import { PROVIDABLE_INTERFACES, RoleSchema } from "./common.ts";
import { EVENT_PATTERN_RE } from "./events.ts";
import { GATE_POINT_VALUES } from "./gates.ts";
import { INTERFACE_TOOLS } from "./interfaces.ts";
import { KERNEL_TOOL_NAMES } from "./mcp.ts";
import { EXT_ID_RE, SEMVER_RE } from "./ids.ts";
import { EXT_API } from "./product.ts";
import { isKnownSlot, SLOT_ROUTE_RE } from "./slots.ts";

// Moved to ids.ts in 0.2.2 (repository config needs them without the
// manifest module); still exported here.
export { EXT_ID_RE, SEMVER_RE };
export const INTERFACE_REF_RE = /^[a-z]+@[0-9]+$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const SLOT_ITEM_ID_RE = /^[a-z0-9-]{1,32}$/;
// Zod-free since 0.2.1 (slots.ts), so the SPA bundle can use it; still exported here.
export { SLOT_ROUTE_RE };
export const MIGRATION_PATH_RE = /^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/;
export const INPUT_SPEC_RE = /^(diff|added-lines|changed-paths|file:[^\s]+)$/;
/** `config.cue`: a package-relative `.cue` path, no `..`, no leading `/`. */
export const CONFIG_CUE_PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+\.cue$/;
/** A settings key (`config.repoOverridable`). */
export const SETTING_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A dotted settings path (`config.targets`). */
export const SETTING_PATH_RE =
	/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const unique = <T>(items: readonly T[]): boolean =>
	new Set(items).size === items.length;

const RoleEnum = RoleSchema;

const EntrySchema = z.strictObject({
	builtin: z.string().regex(/^tartan\.[a-z0-9.-]+$/).optional(),
	js: z.string().regex(/^[A-Za-z0-9._/-]+\.js$/).optional(),
	wasm: z.array(z.string().regex(/^[A-Za-z0-9._/-]+\.wasm$/)).min(1).optional(),
}).refine(
	(e) => Object.keys(e).length >= 1,
	"entry needs at least one runtime",
);

const StorageSchema = z.strictObject({
	scope: z.enum(["node", "repo"]),
	mode: z.enum(["sql", "kv"]).default("sql"),
	migrations: z.array(z.string().regex(MIGRATION_PATH_RE)).optional(),
	quotaMB: z.number().int().min(1).max(1024).default(256),
});

export const LANE_PERMISSIONS = [
	"open",
	"close",
	"archive",
	"adopt",
	"sync",
	"restack",
	"delegate",
] as const;

const PermissionsSchema = z.strictObject({
	repo: z.enum(["none", "read"]).default("none"),
	lanes: z.array(z.enum(LANE_PERMISSIONS)).optional(),
	land: z.array(z.string().regex(/^refs\/heads\/[A-Za-z0-9._/*-]+$/))
		.optional(),
	"land.report": z.boolean().optional(),
	runs: z.array(z.enum(["start", "cancel"])).optional(),
	notes: z.boolean().optional(),
	notify: z.boolean().optional(),
	"events.read": z.array(z.string().regex(EVENT_PATTERN_RE)).optional(),
	"interfaces.call": z.array(z.string().regex(INTERFACE_REF_RE)).optional(),
	"agents.dispatch": z.array(
		z.enum(["resolver", "worker"]),
	).optional(),
	ai: z.boolean().optional(),
	/** Reserved for v2 (Outbound); must be empty in v1. */
	net: z.array(z.string()).max(0).optional(),
	secrets: z.array(z.string()).max(0).optional(),
});

const SubscribeSchema = z.strictObject({
	event: z.string().regex(EVENT_PATTERN_RE),
	filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
});

const GateSchema = z.strictObject({
	point: z.enum(GATE_POINT_VALUES),
	timeoutMs: z.number().int().min(50).max(5000).default(1500),
	default: z.enum(["allow", "veto"]).default("allow"),
	/** Default `veto` for `ref.advance`, `allow` elsewhere; see `gateOnTruncated`. */
	onTruncated: z.enum(["allow", "veto"]).optional(),
	inputs: z.array(z.string()).optional(),
});

const EchoSchema = z.strictObject({
	event: z.literal("push.accepted"),
	timeoutMs: z.number().int().max(1500).default(800),
	inputs: z.array(z.string()).optional(),
});

const SlotContributionSchema = z.strictObject({
	slot: z.string(),
	id: z.string().regex(SLOT_ITEM_ID_RE),
	label: z.string().max(40).optional(),
	title: z.string().max(80).optional(),
	icon: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
	route: z.string().regex(SLOT_ROUTE_RE).optional(),
	when: z.string().max(200).optional(),
	dynamic: z.boolean().default(false),
	refreshOn: z.array(z.string()).optional(),
	role: RoleEnum.optional(),
	cache: z.enum(["viewer", "role", "none"]).default("viewer"),
	/** Display order among contributions to the same slot (lower first; ties by label). */
	order: z.number().int().min(-1000).max(1000).default(0),
});

const ToolContributionSchema = z.strictObject({
	name: z.string().regex(TOOL_NAME_RE),
	description: z.string().max(1000),
	/** Path to a JSON Schema in the package, or an inline schema. */
	input: z.union([z.string(), z.record(z.string(), z.unknown())]),
	role: RoleEnum.default(30),
});

const ContextContributionSchema = z.strictObject({
	id: z.string(),
	maxBytes: z.number().int().max(4096).default(2048),
	priority: z.enum(["protocol", "negative", "conflicts", "ownership", "hints"])
		.default("hints"),
});

const ContributesSchema = z.strictObject({
	slots: z.array(SlotContributionSchema).optional(),
	tools: z.array(ToolContributionSchema).optional(),
	context: z.array(ContextContributionSchema).optional(),
	/** ≤ 2 KB card for MCP instructions. */
	protocol: z.string().regex(/^[A-Za-z0-9._/-]+\.md$/).optional(),
	/** JSON Schema rendered as a settings form; every string rendered as text. */
	settings: z.record(z.string(), z.unknown()).optional(),
});

const LimitsSchema = z.strictObject({
	event_cpu_ms: z.number().int().max(5000).optional(),
	render_cpu_ms: z.number().int().max(200).optional(),
	action_cpu_ms: z.number().int().max(2000).optional(),
	tool_cpu_ms: z.number().int().max(10000).optional(),
	subrequests: z.number().int().max(200).optional(),
	effects_per_second: z.number().int().max(500).optional(),
});

const MemberSchema = z.looseObject({
	id: z.string(),
	version: z.string(),
	config: z.record(z.string(), z.unknown()).optional(),
	mode: z.enum(["enforce", "shadow"]).optional(),
	/**
	 * The member installation's `background_role`; above
	 * Reporter it needs the Owner to approve the pack install. The
	 * Swarm pack gives `tartan.weave` Developer so its background resolver can
	 * call `work_create` (role 30).
	 */
	backgroundRole: z.union([
		z.literal(10),
		z.literal(20),
		z.literal(30),
		z.literal(40),
	]).optional(),
});

export const ManifestSchema = z.strictObject({
	schema: z.literal(1),
	kind: z.enum(["extension", "pack"]).default("extension"),
	id: z.string().max(64).regex(EXT_ID_RE),
	name: z.string().min(1).max(80),
	description: z.string().max(500).optional(),
	version: z.string().regex(SEMVER_RE),
	api: z.literal(EXT_API),
	runtime: z.enum(["builtin", "js", "wasm"]),
	entry: EntrySchema,
	storage: StorageSchema,
	provides: z.array(z.enum(PROVIDABLE_INTERFACES)).refine(unique, "unique")
		.optional(),
	requires: z.array(z.string().regex(INTERFACE_REF_RE)).refine(unique, "unique")
		.optional(),
	permissions: PermissionsSchema,
	inputs: z.array(z.string().regex(INPUT_SPEC_RE)).optional(),
	subscribe: z.array(SubscribeSchema).optional(),
	backfill: z.enum(["none", "30d", "all"]).default("none"),
	onError: z.enum(["skip", "block"]).default("skip"),
	gates: z.array(GateSchema).optional(),
	echo: z.array(EchoSchema).optional(),
	contributes: ContributesSchema.optional(),
	config: z.looseObject({
		schema: z.string().optional(),
		default: z.record(z.string(), z.unknown()).optional(),
		/**
		 * Package-relative CUE file (`package settings` with a closed
		 * `#Settings`): the schema repository config is checked against.
		 */
		cue: z.string().max(256).regex(CONFIG_CUE_PATH_RE).optional(),
		/**
		 * Settings (dotted paths) whose values name nodes: K12, enforced by
		 * the kernel when repository config sets them, never by CUE.
		 */
		targets: z.array(z.string().max(128).regex(SETTING_PATH_RE)).max(32)
			.refine(unique, "unique").optional(),
		/**
		 * Top-level settings keys a repository may overlay on an inherited
		 * installation whose Owner turned repo overrides on.
		 */
		repoOverridable: z.array(z.string().max(64).regex(SETTING_KEY_RE))
			.max(32).refine(unique, "unique").optional(),
		/**
		 * Top-level keys a repository authors as policy in its package
		 * `tartan` (`extensions: "<id>": settings: <key>`), read by the
		 * extension at each change's base through `caps.repo.policy` (K13):
		 * never installed, never merged into the installation's settings.
		 */
		repoPolicy: z.array(z.string().max(64).regex(SETTING_KEY_RE))
			.max(16).refine(unique, "unique").optional(),
	}).optional(),
	limits: LimitsSchema.optional(),
	members: z.array(MemberSchema).optional(),
}).superRefine((m, ctx) => {
	// The schema's allOf/if-then: each runtime needs its entry.
	const need = m.runtime === "wasm"
		? (["js", "wasm"] as const)
		: m.runtime === "js"
		? (["js"] as const)
		: (["builtin"] as const);
	for (const key of need) {
		if (m.entry[key] === undefined) {
			ctx.addIssue({
				code: "custom",
				message: `runtime ${m.runtime} requires entry.${key}`,
				path: ["entry", key],
			});
		}
	}
});

export type Manifest = z.output<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;
export type GateContribution = NonNullable<Manifest["gates"]>[number];
export type EchoContribution = NonNullable<Manifest["echo"]>[number];
export type SlotContribution = NonNullable<
	NonNullable<Manifest["contributes"]>["slots"]
>[number];
export type ToolContribution = NonNullable<
	NonNullable<Manifest["contributes"]>["tools"]
>[number];
export type ContextContribution = NonNullable<
	NonNullable<Manifest["contributes"]>["context"]
>[number];
export type ManifestPermissions = Manifest["permissions"];

export type ManifestResult =
	| { readonly ok: true; readonly manifest: Manifest }
	| { readonly ok: false; readonly errors: readonly string[] };

/** Schema validation only (publish step 1). Returns the parsed manifest with defaults applied. */
export const parseManifest = (input: unknown): ManifestResult => {
	const r = ManifestSchema.safeParse(input);
	return r.success ? { ok: true, manifest: r.data } : {
		ok: false,
		errors: r.error.issues.map((i) =>
			`${i.path.join(".") || "(root)"}: ${i.message}`
		),
	};
};

/** `onTruncated` default: `veto` for `ref.advance`, `allow` elsewhere. */
export const gateOnTruncated = (gate: GateContribution): "allow" | "veto" =>
	gate.onTruncated ?? (gate.point === "ref.advance" ? "veto" : "allow");

export type PolicyContext = {
	/** True when the package is registered from the Worker bundle (`published_by = sys_kernel`). */
	readonly bundled: boolean;
};

/** Every tool name an MCP client can see without an extension prefix. */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
	...KERNEL_TOOL_NAMES,
	...Object.keys(INTERFACE_TOOLS),
]);

/**
 * Install/publish-time rules beyond the JSON Schema: `land` only for `queue@1`
 * providers; `ai` and `agents.dispatch` only for bundled `tartan.*` builtins;
 * `tartan.*` ids, the `builtin` runtime and `entry.builtin` only for bundled
 * packages; packs have members and extensions do not; slot ids come from the
 * slot catalogue; one id per slot contribution, so `/-/api/slot/<inst>/<id>` is
 * unambiguous; unique tool and gate keys; exposed tool names
 * (`<extshort>_<tool>`) never shadow a kernel or interface tool.
 */
export const manifestPolicyIssues = (
	m: Manifest,
	context: PolicyContext,
): string[] => {
	const issues: string[] = [];
	const isTartan = m.id.startsWith("tartan.");
	if (isTartan && !context.bundled) {
		issues.push("id: 'tartan.*' is reserved for bundled builtins");
	}
	if (m.runtime === "builtin" && !context.bundled) {
		issues.push("runtime: builtin is only for bundled packages");
	}
	if (m.entry.builtin !== undefined && !context.bundled) {
		issues.push("entry.builtin: only for bundled packages");
	}
	if (
		(m.permissions.land?.length ?? 0) > 0 && !m.provides?.includes("queue@1")
	) {
		issues.push("permissions.land: only queue@1 providers may hold land");
	}
	if (m.permissions.ai && !(isTartan && context.bundled)) {
		issues.push("permissions.ai: builtin-only in v1");
	}
	if (
		(m.permissions["agents.dispatch"]?.length ?? 0) > 0 &&
		!(isTartan && context.bundled)
	) {
		issues.push("permissions.agents.dispatch: builtin-only in v1");
	}
	if (m.kind === "pack" && (m.members?.length ?? 0) === 0) {
		issues.push("members: a pack needs members");
	}
	if (m.kind === "extension" && m.members !== undefined) {
		issues.push("members: only packs have members");
	}
	for (const [i, slot] of (m.contributes?.slots ?? []).entries()) {
		if (!isKnownSlot(slot.slot)) {
			issues.push(`contributes.slots.${i}.slot: unknown slot ${slot.slot}`);
		}
	}
	const slotIds = (m.contributes?.slots ?? []).map((s) => s.id);
	if (!unique(slotIds)) {
		issues.push("contributes.slots: duplicate id (one id per contribution)");
	}
	const tools = (m.contributes?.tools ?? []).map((t) => t.name);
	if (!unique(tools)) issues.push("contributes.tools: duplicate tool name");
	for (const tool of tools) {
		const exposed = extensionToolName(m.id, tool);
		if (RESERVED_TOOL_NAMES.has(exposed)) {
			issues.push(
				`contributes.tools: ${tool} is exposed as ${exposed}, a kernel or interface tool`,
			);
		}
	}
	const gates = (m.gates ?? []).map((g) => g.point);
	if (!unique(gates)) issues.push("gates: duplicate gate point");
	if ((m.echo?.length ?? 0) > 1) issues.push("echo: at most one echo hook");
	issues.push(...repoConfigManifestIssues(m));
	return issues;
};

/**
 * Repository-config rules of a manifest (ADR repo config):
 * - `repoOverridable` keys are refused for packs, for packages that declare
 *   gates or provide `review@1` or `checks@1` (an overlay must never change
 *   what decides a land), without `config.cue`, for a key missing from
 *   `config.default` and for a key that is (or holds) a `targets` path;
 * - `repoPolicy` keys need `config.cue` (its `#Policy` declares them) and
 *   must not be in `config.default`, `targets` or `repoOverridable`. Any
 *   package may declare them, providers and gate-bearing ones included:
 *   repo policy changes nothing about installations, providers or gates.
 */
export const repoConfigManifestIssues = (m: Manifest): string[] => {
	const issues: string[] = [];
	const config = m.config;
	const overridable = config?.repoOverridable ?? [];
	const policy = config?.repoPolicy ?? [];
	if (config?.cue !== undefined && m.kind === "pack") {
		issues.push("config.cue: a pack has no settings of its own");
	}
	if (policy.length > 0) {
		if (m.kind === "pack") {
			issues.push("config.repoPolicy: a pack cannot declare repo policy");
		}
		if (config?.cue === undefined) {
			issues.push("config.repoPolicy: needs config.cue (its #Policy)");
		}
		const defaults = config?.default ?? {};
		const targets = config?.targets ?? [];
		for (const key of policy) {
			if (Object.hasOwn(defaults, key)) {
				issues.push(
					`config.repoPolicy: ${key} is a setting (config.default), not policy`,
				);
			}
			if (targets.some((t) => t === key || t.startsWith(`${key}.`))) {
				issues.push(`config.repoPolicy: ${key} is a target (K12)`);
			}
			if (overridable.includes(key)) {
				issues.push(`config.repoPolicy: ${key} is also repoOverridable`);
			}
		}
	}
	if (overridable.length === 0) return issues;
	if (m.kind === "pack") {
		issues.push(
			"config.repoOverridable: a pack cannot declare overridable keys",
		);
	}
	if ((m.gates?.length ?? 0) > 0) {
		issues.push(
			"config.repoOverridable: a package with gates cannot declare overridable keys",
		);
	}
	const deciding = (m.provides ?? []).filter((p) =>
		p === "review@1" || p === "checks@1"
	);
	if (deciding.length > 0) {
		issues.push(
			`config.repoOverridable: a ${
				deciding.join(" and ")
			} provider cannot declare overridable keys`,
		);
	}
	if (config?.cue === undefined) {
		issues.push("config.repoOverridable: needs config.cue");
	}
	const defaults = config?.default ?? {};
	const targets = config?.targets ?? [];
	for (const key of overridable) {
		if (!Object.hasOwn(defaults, key)) {
			issues.push(`config.repoOverridable: ${key} is not in config.default`);
		}
		if (targets.some((t) => t === key || t.startsWith(`${key}.`))) {
			issues.push(`config.repoOverridable: ${key} is a target (K12)`);
		}
	}
	return issues;
};

/** Owner approval needed to install; `backgroundRole`/`locked`/root are install-sheet inputs. */
export const needsOwnerApproval = (
	m: Manifest,
	install: {
		readonly backgroundRole?: number;
		readonly locked?: boolean;
		readonly atRoot?: boolean;
	} = {},
): boolean =>
	(m.permissions.land?.length ?? 0) > 0 ||
	m.permissions["land.report"] === true ||
	(m.provides ?? []).some((p) =>
		p === "checks@1" || p === "review@1" || p === "queue@1"
	) ||
	(install.backgroundRole ?? 20) > 20 ||
	install.locked === true ||
	install.atRoot === true;

/** Exposed MCP name of an extension-private tool: `<extshort>_<tool>`. */
export const extensionToolName = (extId: string, tool: string): string => {
	const short = (extId.split(".").pop() ?? extId).replace(/-/g, "_");
	return `${short}_${tool}`;
};
