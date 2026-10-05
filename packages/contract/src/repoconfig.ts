// Repository config in CUE (docs/design/ADR-repo-config-cue.md).
//
// Tartan config is the CUE package `tartan` in the repository root: every
// root `*.cue` file whose package clause is `package tartan`, named and
// split as the team likes. The forge sends every root `*.cue` file (of any
// package) to the evaluator, which runs `cue export -E --out json
// .:tartan`; the CLI's loader, never a hand-written filter, decides which
// files are package `tartan`.
//
// - The evaluator contract `tartan.cue-eval/1`: an evaluator-agnostic
//   request (the module files, limits) and a response envelope
//   `{version, evaluator, cueVersion, ok | error{code, message, hint?},
//   issues[]}` with positioned issues. The kernel never trusts an evaluator:
//   `parseEvalResponse` checks size first, then shape.
// - The file rules, limits and names the kernel, the SPA and the CLI share.
// - Repo policy (the CI pipeline, the review owners, the projects and
//   global files): read at each change's base on trunk (K13), never applied.
// - The DTOs and request bodies of the repo-config HTTP API, MCP tools and
//   the policy sign-off (K13.3).
//
// CUE is never the security boundary: closedness gives authors positioned
// errors; the registry in ForgeDO decides what a resolved config may do.
// Portable (zod only), so the SPA can import it.

import { z } from "zod";
import {
	LaneIdSchema,
	PrincipalIdSchema,
	Sha256HexSchema,
	ShaSchema,
} from "./common.ts";
import { EXT_ID_RE, SEMVER_RE } from "./ids.ts";

// ---------------------------------------------------------------------------
// Versions and identity
// ---------------------------------------------------------------------------

export const CUE_EVAL_CONTRACT = "tartan.cue-eval/1" as const;
/** The pinned CUE release (runner image stage, CLI-backed tests). */
export const CUE_VERSION = "v0.17.1" as const;
/**
 * `containers/runner/cue-job.sh` reports this version; bump it with the
 * script. 2: the root layout (`.:tartan`) and a module path fresh per job.
 * 3: no core files, a process cap for `tartan-git`, cue's stdout
 * discarded, bundles in a root-owned directory, leftover processes killed
 * after the job. 4: an export that reaches the file cap is reported as the
 * cap (cue ignores SIGXFSZ and exits 1), and the job directory is stripped
 * from error text too.
 */
export const CUE_JOB_VERSION = 4 as const;
/**
 * The kernel's file rules (`rules.ts`); bump it with them. 2: every root
 * `*.cue` file of any package (ADR repo config).
 */
export const REPO_CONFIG_RULES_VERSION = 2 as const;
/**
 * Part of every input key: the CUE version, the job script and the file
 * rules, so changing any of them re-evaluates.
 */
export const CUE_EVALUATOR_ID =
	`cue@${CUE_VERSION}/cli+job@${CUE_JOB_VERSION}+rules@${REPO_CONFIG_RULES_VERSION}` as const;

/** The CUE package that is Tartan config (`cue export .:tartan`). */
export const REPO_CONFIG_PACKAGE = "tartan" as const;
/**
 * The forge's binding file beside the repository's root files. Its name is
 * one the file-name rule never admits (`~`), so no repository name is
 * reserved; it binds `extensions`, `projects` and `global` by field.
 */
export const FORGE_BINDING_FILE = "~tartan.cue" as const;
/**
 * The job's module path is `tartan.local/j<32 hex>@v0`, fresh for each job
 * (128 random bits), so no repository file can import the job's own
 * directory. Messages carry `<module>` in its place once normalized.
 */
export const FORGE_MODULE_PREFIX = "tartan.local/j" as const;
export const FORGE_MODULE_PATH_RE = /^tartan\.local\/j[0-9a-f]{32}@v0$/;
export const FORGE_MODULE_PLACEHOLDER = "<module>" as const;
/** Replaces every per-job module path in a message with `<module>`. */
export const stripForgeModule = (text: string): string =>
	text.replace(
		/tartan\.local\/j[0-9a-f]{32}(?:@v0)?/g,
		FORGE_MODULE_PLACEHOLDER,
	);
/** The forge-built schema module; package `tartan` may import only it and the standard library. */
export const FORGE_SCHEMA_IMPORT = "tartan.dev/ext" as const;
/**
 * The pre-decision-30 directory. The forge reads nothing under it; the
 * settings page shows a one-line migration hint while trunk still has it.
 */
export const LEGACY_CONFIG_DIR = ".tartan" as const;

/**
 * A root config file name: ASCII letters, digits, `_`, `.` and `-`, ending
 * in `.cue`. Every root `*.cue` entry must match it (a name that does not is
 * rejected, never dropped, because a local `cue export .:tartan` would load
 * it). No line terminator (U+2028/U+2029 included) can appear.
 */
export const REPO_CONFIG_FILE_RE = /^[A-Za-z0-9_.-]+\.cue$/;
/**
 * A normalized position the SPA may link to the blob view: a root
 * `<name>.cue` file. Forge positions (`cue.mod/…`, `~tartan.cue`) link to
 * the schema view instead.
 */
export const REPO_CONFIG_POSITION_RE = /^([A-Za-z0-9_.-]+\.cue):(\d+):(\d+)$/;

/** The exported top-level fields the kernel reads. */
export const REPO_CONFIG_TOP_LEVEL = [
	"extensions",
	"projects",
	"global",
] as const;
/** The hint on an unknown top-level field (CUE does not close a package's top level). */
export const REPO_CONFIG_TOP_LEVEL_HINT =
	'only extensions, projects and global are read; the pipeline goes under extensions: "tartan.ci": settings: pipeline' as const;
/** Configured projects per repository (the project graph's own cap). */
export const REPO_CONFIG_MAX_PROJECTS = 500;
/** Configured global globs per repository. */
export const REPO_CONFIG_MAX_GLOBAL = 200;

/** Kernel limits (starting values, tuned from the first live runs). */
export const REPO_CONFIG_LIMITS = {
	files: 32,
	fileBytes: 64 * 1024,
	totalBytes: 256 * 1024,
	/** The bundle the sandbox writes: repo files plus the forge overlay. */
	bundleBytes: 768 * 1024,
	/** Exported JSON the host parses. */
	jsonBytes: 256 * 1024,
	jsonDepth: 32,
	issues: 256,
	issueMessageBytes: 4096,
	issuePositions: 64,
	/** Stderr the host reads. */
	stderrBytes: 64 * 1024,
	/** A published package's `config.cue`. */
	configCueBytes: 64 * 1024,
	/** `timeout --foreground -s KILL`. */
	wallClockS: 10,
	/** `ulimit -v` (RLIMIT_AS), in KiB. */
	addressSpaceKiB: 2 * 1024 * 1024,
	/** `ulimit -f` (output and stderr files), in KiB. */
	outputFileKiB: 4096,
	/** The host deadline per attempt, from dispatch. */
	deadlineColdMs: 75_000,
	deadlineWarmMs: 30_000,
	/** Dispatches per watchdog round before background rounds back off. */
	dispatchesPerRound: 3,
	previewQueue: 50,
	previewsPerHour: 30,
	/** Cached evaluations per repository, plus the applied one. */
	cacheEntries: 50,
	/** `cue:preview:<k>` sandboxes (`k = fnv(principal) mod N`). */
	previewSandboxes: 1,
} as const;

/**
 * `<sid>`: the extension id with `.` and `-` replaced by `_`, the import
 * path segment of its settings package (`tartan.dev/ext/x/<sid>`).
 */
export const cueSid = (extId: string): string => extId.replace(/[.-]/g, "_");

// ---------------------------------------------------------------------------
// tartan.cue-eval/1
// ---------------------------------------------------------------------------

export const CUE_EVAL_ERROR_CODES = [
	/** The request was malformed, or a file broke a kernel file rule. */
	"INVALID_INPUT",
	/** Parse or import failure (syntax, unknown import, nesting depth). */
	"LOAD_INSTANCE",
	/** Unification or validation failure (conflict, bound, closedness). */
	"BUILD_VALUE",
	/** A memory, output or JSON cap. */
	"LIMIT_EXCEEDED",
	/** The wall clock: the evaluator process was killed. */
	"TIMEOUT",
	/** No evaluator could be reached or started; never cached. */
	"EVALUATOR_UNAVAILABLE",
	/** A protocol violation or version mismatch; never cached. */
	"INTERNAL",
] as const;
export type CueEvalErrorCode = typeof CUE_EVAL_ERROR_CODES[number];
export const CueEvalErrorCodeSchema = z.enum(CUE_EVAL_ERROR_CODES);

/** Codes a cache never keeps. */
export const UNCACHED_EVAL_CODES: readonly CueEvalErrorCode[] = [
	"INTERNAL",
	"EVALUATOR_UNAVAILABLE",
];
/** Preview results that never answer for trunk (trunk re-runs once). */
export const PREVIEW_ONLY_EVAL_CODES: readonly CueEvalErrorCode[] = [
	"TIMEOUT",
	"LIMIT_EXCEEDED",
];

/** `file:line:col` relative to the module root, without `./`. */
export const EVAL_POSITION_RE =
	// deno-lint-ignore no-control-regex
	/^[^\s\u0000-\u001f][^\u0000-\u001f]*:\d+:\d+$/;

/**
 * One error, in CUE's order: `path` is the CUE path
 * (`extensions."tartan.weave".settings.batch`, or `""` for a package-level
 * error), `msg` the message (text the repository controls: shown as text
 * only), `pos` its positions.
 */
export const EvalIssueSchema = z.strictObject({
	path: z.string().max(2048),
	msg: z.string().max(REPO_CONFIG_LIMITS.issueMessageBytes),
	pos: z.array(z.string().max(600).regex(EVAL_POSITION_RE)).max(
		REPO_CONFIG_LIMITS.issuePositions,
	),
});
export type EvalIssue = z.infer<typeof EvalIssueSchema>;

export type EvalLimits = {
	readonly wallClockS: number;
	readonly addressSpaceKiB: number;
	readonly outputFileKiB: number;
	readonly jsonBytes: number;
	readonly stderrBytes: number;
};

export const DEFAULT_EVAL_LIMITS: EvalLimits = {
	wallClockS: REPO_CONFIG_LIMITS.wallClockS,
	addressSpaceKiB: REPO_CONFIG_LIMITS.addressSpaceKiB,
	outputFileKiB: REPO_CONFIG_LIMITS.outputFileKiB,
	jsonBytes: REPO_CONFIG_LIMITS.jsonBytes,
	stderrBytes: REPO_CONFIG_LIMITS.stderrBytes,
};

/**
 * One evaluation. `files` maps module-root-relative paths to UTF-8 text:
 * the forge's `cue.mod/pkg/tartan.dev/ext/**` and `~tartan.cue`, plus every
 * validated root `<name>.cue` of the repository (any package). The
 * evaluator writes its own `cue.mod/module.cue` with a module path fresh
 * for the job and runs `cue export -E --out json .:tartan` in the module
 * root; the CLI selects package `tartan`.
 */
export type EvalRequest = {
	readonly version: typeof CUE_EVAL_CONTRACT;
	/** The evaluator id the caller expects (part of `inputKey`). */
	readonly evaluator: string;
	readonly inputKey: string;
	readonly files: Readonly<Record<string, string>>;
	readonly limits: EvalLimits;
};

const envelopeBase = {
	version: z.literal(CUE_EVAL_CONTRACT),
	evaluator: z.string().max(128),
	/** What `cue version` printed in the job (`null` when it did not run). */
	cueVersion: z.string().max(64).nullable(),
	/** Evaluator wall time, for display. */
	ms: z.number().int().nonnegative().max(3_600_000).optional(),
};

export const EvalOkSchema = z.strictObject({
	...envelopeBase,
	ok: z.unknown(),
	issues: z.array(EvalIssueSchema).max(0),
});
export const EvalErrorSchema = z.strictObject({
	...envelopeBase,
	error: z.strictObject({
		code: CueEvalErrorCodeSchema,
		message: z.string().max(REPO_CONFIG_LIMITS.issueMessageBytes),
		hint: z.string().max(1024).optional(),
	}),
	issues: z.array(EvalIssueSchema).max(REPO_CONFIG_LIMITS.issues),
});
export type EvalOk = z.infer<typeof EvalOkSchema>;
export type EvalError = z.infer<typeof EvalErrorSchema>;
export type EvalResponse = EvalOk | EvalError;

export const isEvalOk = (r: EvalResponse): r is EvalOk => "ok" in r;

/** An envelope the host itself produced (deadline, unreachable sandbox, rejected input). */
export const hostEvalError = (
	code: CueEvalErrorCode,
	message: string,
	options: {
		readonly evaluator?: string;
		readonly issues?: readonly EvalIssue[];
		readonly hint?: string;
	} = {},
): EvalError => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: options.evaluator ?? CUE_EVALUATOR_ID,
	cueVersion: null,
	error: {
		code,
		message: message.slice(0, REPO_CONFIG_LIMITS.issueMessageBytes),
		...(options.hint === undefined ? {} : { hint: options.hint }),
	},
	issues: [...(options.issues ?? [])].slice(0, REPO_CONFIG_LIMITS.issues),
});

const jsonDepth = (value: unknown, limit: number): number => {
	let max = 0;
	const stack: [unknown, number][] = [[value, 0]];
	while (stack.length > 0) {
		const [v, d] = stack.pop()!;
		if (d > max) max = d;
		if (max > limit) return max;
		if (typeof v === "object" && v !== null) {
			for (const child of Object.values(v)) stack.push([child, d + 1]);
		}
	}
	return max;
};

/**
 * Checks an evaluator's response: size before parsing (a runaway evaluator
 * cannot make the host allocate an unbounded object), then the envelope,
 * then the exported value's depth. Never throws.
 */
export const parseEvalResponse = (
	raw: string | unknown,
	limits: Pick<EvalLimits, "jsonBytes"> = DEFAULT_EVAL_LIMITS,
): EvalResponse => {
	let json: unknown = raw;
	if (typeof raw === "string") {
		// The envelope adds at most the issue list to the exported JSON.
		const cap = limits.jsonBytes + 512 * 1024;
		if (raw.length > cap) {
			return hostEvalError(
				"LIMIT_EXCEEDED",
				`evaluator output of ${raw.length} bytes exceeds ${cap} bytes`,
			);
		}
		try {
			json = JSON.parse(raw);
		} catch {
			return hostEvalError("INTERNAL", "evaluator output is not JSON");
		}
	}
	const isOk = typeof json === "object" && json !== null && "ok" in json;
	const parsed = isOk
		? EvalOkSchema.safeParse(json)
		: EvalErrorSchema.safeParse(json);
	if (!parsed.success) {
		return hostEvalError(
			"INTERNAL",
			`evaluator output violates ${CUE_EVAL_CONTRACT}: ${
				parsed.error.issues.slice(0, 3).map((i) =>
					`${i.path.join(".") || "(root)"} ${i.message}`
				).join("; ")
			}`,
		);
	}
	if (parsed.data !== null && "ok" in parsed.data) {
		if (parsed.data.ok === undefined) {
			return hostEvalError("INTERNAL", "evaluator returned ok without a value");
		}
		if (
			jsonDepth(parsed.data.ok, REPO_CONFIG_LIMITS.jsonDepth) >
				REPO_CONFIG_LIMITS.jsonDepth
		) {
			return hostEvalError(
				"LIMIT_EXCEEDED",
				`exported JSON is deeper than ${REPO_CONFIG_LIMITS.jsonDepth}`,
			);
		}
	}
	return parsed.data as EvalResponse;
};

// ---------------------------------------------------------------------------
// Sandbox jobs (`cue:trunk`, `cue:preview:<k>`)
// ---------------------------------------------------------------------------

/**
 * Work classes in strict priority on `cue:trunk` (lower first): trunk
 * evaluations and explicit applies, then trunk moves outside the Advance,
 * registry re-evaluations and approval self-checks. `preview` runs only on
 * `cue:preview:<k>`.
 */
export const CUE_JOB_CLASSES = [
	"trunk",
	"apply",
	"external",
	"registry",
	"selfcheck",
	"preview",
] as const;
export type CueJobClass = typeof CUE_JOB_CLASSES[number];
export const CUE_JOB_PRIORITY: Readonly<Record<CueJobClass, number>> = {
	trunk: 0,
	apply: 0,
	external: 1,
	registry: 2,
	selfcheck: 3,
	preview: 0,
};

/** Where a finished job's envelope goes. */
export type CueJobSink =
	| { readonly kind: "repo"; readonly repoId: string }
	| { readonly kind: "approval"; readonly requestId: string };

export type CueJobInput = {
	readonly class: CueJobClass;
	/** The requesting principal (previews: rate limits and the sandbox choice). */
	readonly principal?: string;
	readonly laneId?: string;
	readonly sink: CueJobSink;
	readonly request: EvalRequest;
};

export type CueSubmitResult =
	| {
		readonly accepted: true;
		readonly jobId: string;
		/** The container was running when the job was queued (deadline 30 s, else 75 s). */
		readonly warm: boolean;
		/** Jobs ahead of this one in the sandbox. */
		readonly ahead: number;
		/** An identical input was already queued or running: this call joined it. */
		readonly joined: boolean;
	}
	| {
		readonly accepted: false;
		readonly reason: "rate_limited" | "too_large" | "unavailable" | "invalid";
		readonly message: string;
	};

/** `fnv1a(principal) mod n`: which preview sandbox serves a principal. */
export const previewSandboxIndex = (
	principal: string,
	n: number = REPO_CONFIG_LIMITS.previewSandboxes,
): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < principal.length; i++) {
		h ^= principal.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h % Math.max(1, n);
};

// ---------------------------------------------------------------------------
// State, denials and plans
// ---------------------------------------------------------------------------

export const REPO_CONFIG_STATUSES = [
	/** Nothing applied and no config on trunk. */
	"unconfigured",
	/** The applied result is the trunk config's. */
	"current",
	/** A policy-touching Advance is unresolved (lands held, K13.1). */
	"pending",
	/** The trunk config has a CUE error, rejected input or a denial; last-good stays. */
	"failed",
	/** The registry epoch moved under the applied head; re-evaluating. */
	"stale",
	/** Trunk moved outside the Advance and its config differs; explicit apply. */
	"needs-apply",
] as const;
export type RepoConfigStatus = typeof REPO_CONFIG_STATUSES[number];

export const REPO_CONFIG_DENIAL_CODES = [
	"shape",
	"too_large",
	"unapproved",
	"inherited",
	"provider_floor",
	"pack",
	"policy_key",
	"overlay_key",
	"locked_gate",
	"locked_provider",
	"invalid",
	"conflict",
	"scope",
] as const;
export type RepoConfigDenialCode = typeof REPO_CONFIG_DENIAL_CODES[number];
/**
 * Denials about the configuration as a whole: they make its trunk config
 * row `error`, so repo policy falls back to last good. Every other denial
 * concerns installations only (repo policy stays exact).
 */
export const REPO_POLICY_DENIAL_CODES: readonly RepoConfigDenialCode[] = [
	"shape",
	"too_large",
	"policy_key",
];

/** A registry denial: the code, the JSON path it is about and a message. */
export type RepoConfigDenial = {
	readonly code: RepoConfigDenialCode;
	readonly path: string;
	readonly extId?: string;
	readonly message: string;
};

export type RepoConfigKeyChange = {
	readonly key: string;
	readonly from?: unknown;
	readonly to?: unknown;
};

/** One line of a plan against trunk's applied set and policy; `text` is stable for display. */
export type RepoConfigPlanLine =
	| {
		readonly op: "install";
		readonly extId: string;
		readonly version: string;
		readonly mode: "enforce" | "shadow";
		readonly enabled: boolean;
		readonly settings: unknown;
		readonly text: string;
	}
	| {
		readonly op: "configure";
		readonly extId: string;
		readonly version: string;
		readonly changes: readonly RepoConfigKeyChange[];
		readonly text: string;
	}
	| {
		readonly op: "remove";
		readonly extId: string;
		readonly version: string;
		readonly text: string;
	}
	| {
		readonly op: "overlay";
		readonly extId: string;
		readonly installationId: string;
		readonly nodePath: string;
		readonly changes: readonly RepoConfigKeyChange[];
		readonly text: string;
	}
	| {
		readonly op: "overlay-remove";
		readonly extId: string;
		readonly installationId: string;
		readonly nodePath: string;
		readonly text: string;
	}
	| {
		/** A repo-policy document of an extension (`pipeline`, `owners`). */
		readonly op: "policy";
		readonly extId: string;
		readonly key: string;
		readonly changes: readonly string[];
		readonly text: string;
	}
	| {
		/** The kernel's configured projects or global files. */
		readonly op: "projects" | "global";
		readonly changes: readonly string[];
		readonly text: string;
	};

/** The display form of a plan with nothing to do. */
export const NO_CHANGE_TEXT = "no change" as const;

/** How the schema offers an extension to this repository. */
export type RepoConfigSchemaEntry =
	| {
		/** An own install: approved here and installed nowhere above. */
		readonly kind: "install";
		readonly extId: string;
		readonly version: string;
		readonly sid: string;
		readonly approvalNode: string;
		readonly hasGates: boolean;
		readonly repoPolicy: readonly string[];
	}
	| {
		/**
		 * An installation in force (here or above): its repo-policy keys
		 * and, with the Owner's opt-in at a strict ancestor, its overridable
		 * keys (an overlay).
		 */
		readonly kind: "in-force";
		readonly extId: string;
		readonly version: string;
		readonly sid: string;
		readonly installationId: string;
		readonly nodePath: string;
		readonly repoPolicy: readonly string[];
		readonly overridable: readonly string[];
	};

/** `GET …/config/schema`, MCP `repo_config_schema`, `tartan config schema`. */
export type RepoConfigSchemaDto = {
	readonly repoId: string;
	readonly epoch: number;
	readonly schemaKey: string;
	/**
	 * Module-root-relative path → text: `cue.mod/pkg/tartan.dev/ext/**` and
	 * `~tartan.cue`. The evaluator adds its own `cue.mod/module.cue`; a local
	 * reproduction writes `LOCAL_MODULE_FILE` there.
	 */
	readonly files: Readonly<Record<string, string>>;
	readonly entries: readonly RepoConfigSchemaEntry[];
	/** What reproduces the forge's evaluation locally, after writing `files` beside the root `*.cue` files. */
	readonly exportCommand: string;
	/**
	 * The principal whose registry change moved the epoch to `epoch` (an
	 * Owner, or `sys_kernel`): a registry-driven re-apply names it in the
	 * audit.
	 */
	readonly epochBy?: string;
};

export const REPO_CONFIG_EXPORT_COMMAND =
	"CUE_REGISTRY=none cue export -E --out json .:tartan" as const;
/** CUE's language version for the forge module (the release's major.minor). */
export const CUE_LANGUAGE_VERSION = `${
	CUE_VERSION.split(".").slice(0, 2).join(".")
}.0`;
/** `cue.mod/module.cue` for a module path (the job's, or a local one). */
export const forgeModuleFile = (modulePath: string): string =>
	`module: ${JSON.stringify(modulePath)}\nlanguage: version: ${
		JSON.stringify(CUE_LANGUAGE_VERSION)
	}\n`;
/** The module file `tartan config schema --out <dir>` writes (fixed, local only). */
export const LOCAL_MODULE_FILE = forgeModuleFile(
	`${FORGE_MODULE_PREFIX}${"0".repeat(32)}@v0`,
);

/** A cached evaluation (`GET …/config/evals/:inputKey`). */
export type RepoConfigEvalDto = {
	readonly inputKey: string;
	readonly evaluator: string;
	readonly cueVersion: string | null;
	readonly origin: "trunk" | "preview";
	readonly status: "ok" | "error";
	readonly code?: CueEvalErrorCode;
	readonly message?: string;
	readonly issues: readonly EvalIssue[];
	/** Repository-controlled JSON: render as text only. */
	readonly resolved?: unknown;
	/** The root `*.cue` files sent (the CLI chose package `tartan` among them). */
	readonly files: readonly { readonly name: string; readonly oid: string }[];
	readonly firstSha: string;
	readonly firstLane?: string;
	readonly finishedAt: number;
};

/** Where an installation in force at the repo comes from, for the settings page. */
export type RepoConfigEffectiveRow = {
	readonly extId: string;
	readonly version: string;
	readonly mode: "enforce" | "shadow" | "disabled";
	readonly installationId: string;
	readonly nodePath: string;
	readonly source: "repo-config" | "overlay" | "inherited" | "manual";
	/** Keys a repository may overlay (`config.repoOverridable`), when the opt-in is on. */
	readonly overridable: readonly string[];
	/** Keys a repository authors as policy (`config.repoPolicy`), read at each change's base. */
	readonly repoPolicy: readonly string[];
	/** Repository-controlled settings: render as text only. */
	readonly settings: unknown;
	/** Settings forms are read-only: `MANAGED_BY_TEXT`. */
	readonly managed: boolean;
	readonly hasGates: boolean;
	readonly ownerDisabled?: boolean;
	readonly sourceSha?: string;
};

/** The settings forms' note on a managed row. */
export const MANAGED_BY_TEXT =
	"managed by package tartan in the repo root" as const;

export type ConfigApprovalDto = {
	readonly nodeId: string;
	readonly nodePath: string;
	readonly extId: string;
	readonly version: string;
	readonly packageSha256: string;
	readonly backgroundRole: 10 | 20 | 30 | 40;
	readonly approvedBy: string;
	readonly approvedAt: number;
	readonly needsReapproval: boolean;
};

export type ConfigApprovalRequestDto = {
	readonly id: string;
	readonly nodeId: string;
	readonly extId: string;
	readonly version: string;
	readonly state: "checking" | "approved" | "refused" | "superseded";
	readonly message?: string;
	readonly at: number;
};

// ---------------------------------------------------------------------------
// Repo policy (ADR repo config): read at each change's base on trunk (K13)
// ---------------------------------------------------------------------------

export const CONFIG_TRUNK_STATUSES = [
	"pending",
	"ok",
	"error",
	"none",
] as const;
export type ConfigTrunkStatus = typeof CONFIG_TRUNK_STATUSES[number];

/**
 * One trunk config history row: the trunk commit at which the root `*.cue`
 * files changed, and the evaluation that resolved it. Never rewritten by a
 * registry re-evaluation.
 */
export type RepoConfigTrunkRowDto = {
	readonly trunkSeq: number;
	readonly sha: string;
	/** sha256 of the sorted `[name, mode, oid]` of the root `*.cue` entries; null: none. */
	readonly policyDigest: string | null;
	readonly inputKey?: string;
	readonly status: ConfigTrunkStatus;
	readonly code?: string;
	readonly message?: string;
	readonly issues: readonly EvalIssue[];
	readonly at: number;
};

/** The repo policy in force at the trunk tip (settings page, MCP). */
export type RepoPolicyDto = {
	/** The newest trunk config row, or null when none was ever recorded. */
	readonly newest: RepoConfigTrunkRowDto | null;
	/** The row whose values are read (the newest, or the last good one). */
	readonly inForce: RepoConfigTrunkRowDto | null;
	/** False when the newest row failed (or is pending under keep-last-good). */
	readonly exact: boolean;
	readonly pending: boolean;
	/** Repository-controlled values: render as text only. */
	readonly pipeline?: unknown;
	readonly owners?: unknown;
	readonly projects?: unknown;
	readonly global?: unknown;
};

/**
 * `caps.repo.policy(repo, at)`: the calling extension's own `repoPolicy`
 * keys from the trunk config in force at `at` (a trunk commit). It never
 * runs CUE and never waits.
 */
export type RepoPolicyAnswer =
	| {
		readonly state: "ok";
		/** The trunk commit whose config is read. */
		readonly configSha: string;
		/** The evaluation read (absent when the last good config is "no config"). */
		readonly inputKey?: string;
		/** False: the newest config at `at` failed and these are the last good values. */
		readonly exact: boolean;
		/** Repository-controlled: the caller validates them (CUE is never the boundary). */
		readonly values: Readonly<Record<string, unknown>>;
		readonly failed?: {
			readonly sha: string;
			readonly message: string;
			readonly issues: readonly EvalIssue[];
		};
	}
	/** No Tartan config at `at` (or repository config is off on this forge). */
	| { readonly state: "none" }
	/** The config at `at` is still evaluating; retry on `repo.config.resolved`. */
	| { readonly state: "pending" }
	/** `at` is older than the kept history; the author syncs the lane. */
	| { readonly state: "expired" };

/** The kernel's configured projects and global files at a commit's trunk base. */
export type ProjectConfigAnswer =
	| {
		/** Part of the graph's cache key: the input key, `none`, `off`, or `provisional:<key>`. */
		readonly key: string;
		readonly projects: Readonly<Record<string, unknown>> | null;
		readonly global: readonly string[];
		/** The row at the base is pending: the last good config is used. */
		readonly provisional: boolean;
	}
	/** The commit is not on trunk and config exists: ask again with its trunk base. */
	| { readonly needsBase: true };

// ---------------------------------------------------------------------------
// Heads, state and previews
// ---------------------------------------------------------------------------

/** RepoDO's part of the state: its config head (no ForgeDO rows). */
export type RepoConfigHeadDto = {
	readonly repoId: string;
	readonly enabled: boolean;
	readonly status: RepoConfigStatus;
	readonly held: boolean;
	readonly holdReason?: "pending" | "gate-missing";
	readonly keptLastGoodBy?: string;
	readonly evaluator: string;
	readonly cueVersion?: string | null;
	readonly trunkSha?: string;
	readonly pendingSha?: string;
	readonly pendingKey?: string;
	readonly appliedSha?: string;
	readonly appliedKey?: string;
	readonly appliedEpoch?: number;
	readonly appliedSeq?: number;
	readonly appliedAt?: number;
	readonly appliedBy: readonly string[];
	readonly lastEvaluatedAt?: number;
	readonly failure?: RepoConfigFailure;
	readonly plan: readonly RepoConfigPlanLine[];
	readonly policy: RepoPolicyDto;
	/** The root `*.cue` files the newest trunk read found. */
	readonly rootFiles: readonly {
		readonly name: string;
		readonly oid: string;
	}[];
	/** Trunk still has a `.tartan/` directory (the migration hint). */
	readonly legacyDir: boolean;
	readonly updatedAt?: number;
};

export type RepoConfigFailure = {
	readonly code: string;
	readonly message: string;
	readonly issues: readonly EvalIssue[];
	readonly denials: readonly RepoConfigDenial[];
};

/** `GET /-/api/repos/:repo/config`, MCP `repo_config_get`. */
export type RepoConfigStateDto = RepoConfigHeadDto & {
	readonly effective: readonly RepoConfigEffectiveRow[];
	readonly approvals: readonly ConfigApprovalDto[];
	readonly epoch?: number;
};

/** The migration hint (ADR repo config) while trunk still has a `.tartan/` directory. */
export const LEGACY_DIR_HINT =
	'.tartan/ is no longer read; the pipeline goes in extensions: "tartan.ci": settings: pipeline and the owners in extensions: "tartan.review": settings: owners, in any root file with package tartan' as const;

export const REPO_CONFIG_PREVIEW_STATES = [
	"evaluating",
	"ok",
	"error",
	"denied",
	"rate_limited",
	"unavailable",
	"clean",
] as const;
export type RepoConfigPreviewState = typeof REPO_CONFIG_PREVIEW_STATES[number];

/** A lane's preview (`GET …/lanes/:laneId/config`, MCP `repo_config_preview`). */
export type RepoConfigPreviewDto = {
	readonly laneId: string;
	readonly head: string;
	readonly inputKey?: string;
	/** `clean`: the lane's range touches no policy path. */
	readonly status: RepoConfigPreviewState;
	readonly policyTouched: boolean;
	/** The root `*.cue` digest at the head (what a sign-off binds), once read. */
	readonly policyDigest?: string | null;
	readonly code?: string;
	readonly message?: string;
	readonly issues: readonly EvalIssue[];
	readonly denials: readonly RepoConfigDenial[];
	readonly plan: readonly RepoConfigPlanLine[];
	readonly evaluatedAt?: number;
	readonly signoff?: PolicySignoffDto;
};

/** A kernel-recorded policy sign-off (K13.3), bound to a lane head. */
export type PolicySignoffDto = {
	readonly laneId: string;
	readonly head: string;
	/** The root `*.cue` digest at `head`; null when the head has no root `*.cue` file. */
	readonly policyDigest: string | null;
	readonly signedBy: string;
	readonly eventId: string;
	readonly at: number;
	readonly revokedAt?: number;
};

// ---------------------------------------------------------------------------
// RepoDO ↔ ForgeDO registry (the facade's repo-config methods)
// ---------------------------------------------------------------------------

/** What ForgeDO has applied for one repo node (RepoDO stores exactly this). */
export type RepoConfigForgeState = {
	readonly appliedSeq: number;
	readonly appliedEpoch: number;
	readonly appliedKey: string;
	readonly appliedSha: string;
	/** `gate-missing` while a gate-bearing repo-config row lost its approval. */
	readonly holdReason: string | null;
	/**
	 * The hold's generation: it moves with every gate loss, so an Owner's
	 * keep-last-good covers only the losses it saw (absent from older
	 * registries: 1 while held).
	 */
	readonly holdId?: number;
	readonly principals: readonly string[];
	readonly updatedAt: number;
};

export type RepoConfigApplyInput = {
	/** RepoDO's monotonic trunk position (the fence's first half). */
	readonly trunkSeq: number;
	/** The `config_epoch` the evaluation used (the fence's second half). */
	readonly epoch: number;
	readonly sha: string;
	readonly inputKey: string;
	readonly schemaKey: string;
	/** The exported JSON (`{}` for a removal). */
	readonly resolved: unknown;
	/** Who the audit names; the first is `installed_by`. */
	readonly principals: readonly string[];
	readonly provenance: {
		readonly firstSha: string;
		readonly firstLane?: string;
		readonly evaluator: string;
		readonly cueVersion: string | null;
	};
	readonly explicit?: boolean;
	readonly removal?: boolean;
};

export type RepoConfigApplyAnswer =
	| {
		readonly kind: "applied" | "noop";
		readonly state: RepoConfigForgeState;
		readonly changes: {
			readonly installed: number;
			readonly updated: number;
			readonly removed: number;
			readonly overlays: number;
		};
	}
	| {
		readonly kind: "refused";
		readonly reason: "older" | "fence-conflict" | "schema-changed";
		readonly state: RepoConfigForgeState | null;
		readonly epoch: number;
	}
	| {
		readonly kind: "denied";
		readonly denials: readonly RepoConfigDenial[];
		readonly state: RepoConfigForgeState | null;
	};

export type RepoConfigCheckAnswer = {
	readonly denials: readonly RepoConfigDenial[];
	readonly plan: readonly RepoConfigPlanLine[];
	readonly epoch: number;
	readonly schemaKey: string;
};

/** What LandWorkflow reads before a land of the repo tests or advances (K13.1). */
export type RepoConfigLandContext = {
	readonly reviewProvider: string | null;
	/** ForgeDO's hold (`gate-missing`), or null. */
	readonly configHold: string | null;
	/** The hold's generation (`RepoConfigForgeState.holdId`). */
	readonly configHoldId?: number;
};

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** `POST /-/api/repos/:repo/lanes/:laneId/policy-signoff` (Maintainer+, session). */
export const PolicySignoffRequestSchema = z.strictObject({
	head: ShaSchema,
	/** The root `*.cue` digest at `head` the signer saw, `null` when none. */
	policyDigest: Sha256HexSchema.nullable(),
});
export type PolicySignoffRequest = z.infer<typeof PolicySignoffRequestSchema>;

/** `POST …/config/apply` (Maintainer+, session): the trunk sha the page showed. */
export const RepoConfigApplyRequestSchema = z.strictObject({ sha: ShaSchema });
/** `POST …/config/preview`. */
export const RepoConfigPreviewRequestSchema = z.strictObject({
	laneId: LaneIdSchema,
});
/** `POST …/config/override` (Owner, session). */
export const RepoConfigOverrideRequestSchema = z.strictObject({
	action: z.enum(["keep-last-good", "clear"]),
});
/** `PUT /-/api/nodes/:node/config-approvals/:extId` (Owner, session). */
export const ConfigApprovalRequestSchema = z.strictObject({
	version: z.string().regex(SEMVER_RE),
	backgroundRole: z.union([
		z.literal(10),
		z.literal(20),
		z.literal(30),
		z.literal(40),
	]).optional(),
});
export type ConfigApprovalRequest = z.infer<typeof ConfigApprovalRequestSchema>;
/** `PUT /-/api/installations/:id/repo-overrides` (Owner at the installation's node). */
export const RepoOverridesRequestSchema = z.strictObject({ on: z.boolean() });

export const ExtIdSchema = z.string().max(64).regex(EXT_ID_RE);
export const InputKeySchema = Sha256HexSchema;
export const SignerSchema = PrincipalIdSchema;
