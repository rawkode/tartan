// Identifiers, names and kernel ref constants.
//
// IDs are lowercase ULIDs: 26 chars of Crockford base32 lowercased, valid under
// every Artifacts, DO and Workflow regex. The ULID implementation is our own,
// with an injectable clock and random source, and is monotonic within one
// generator (strictly increasing even within a millisecond or if the clock
// steps backwards).

import { internal, invalid } from "./errors.ts";

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

export const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz" as const;
export const ULID_LENGTH = 26;
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
/** 2^48 - 1: the largest timestamp a ULID can carry. */
export const ULID_TIME_MAX = 281474976710655;

/** Lowercase ULID; the first char is ≤ '7' because time is 48 bits. */
export const ULID_RE = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export type Ulid = string;

export const isUlid = (value: unknown): value is Ulid =>
	typeof value === "string" && ULID_RE.test(value);

export type UlidDeps = {
	/** Epoch milliseconds. Default `Date.now`. */
	readonly now?: () => number;
	/** Returns `n` random bytes. Default `crypto.getRandomValues`. */
	readonly random?: (n: number) => Uint8Array;
};

const defaultRandom = (n: number): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(n));

const encodeTime = (time: number): string => {
	let out = "";
	let t = time;
	for (let i = 0; i < TIME_LENGTH; i++) {
		const mod = t % 32;
		out = ULID_ALPHABET[mod] + out;
		t = (t - mod) / 32;
	}
	return out;
};

const randomDigits = (random: (n: number) => Uint8Array): number[] => {
	const bytes = random(RANDOM_LENGTH);
	if (bytes.length < RANDOM_LENGTH) {
		throw internal("ulid random source returned too few bytes");
	}
	// 256 is a multiple of 32, so masking keeps the digits uniform.
	return Array.from(bytes.subarray(0, RANDOM_LENGTH), (b) => b & 31);
};

const increment = (digits: readonly number[]): number[] => {
	const next = [...digits];
	for (let i = next.length - 1; i >= 0; i--) {
		if (next[i] < 31) {
			next[i] += 1;
			return next;
		}
		next[i] = 0;
	}
	throw internal("ulid random component overflowed within one millisecond");
};

/**
 * Creates a monotonic ULID generator. Within one generator every id is
 * strictly greater than the previous one: a repeated or earlier timestamp
 * reuses the last time and increments the random part.
 */
export const createUlid = (deps: UlidDeps = {}): () => Ulid => {
	const now = deps.now ?? Date.now;
	const random = deps.random ?? defaultRandom;
	let lastTime = -1;
	let lastDigits: number[] = [];
	return () => {
		const time = now();
		if (!Number.isInteger(time) || time < 0 || time > ULID_TIME_MAX) {
			throw invalid(`ulid time out of range: ${time}`);
		}
		if (time > lastTime) {
			lastTime = time;
			lastDigits = randomDigits(random);
		} else {
			lastDigits = increment(lastDigits);
		}
		return encodeTime(lastTime) +
			lastDigits.map((d) => ULID_ALPHABET[d]).join("");
	};
};

/** Process-wide default generator (monotonic per isolate). */
export const ulid: () => Ulid = createUlid();

/** Epoch milliseconds encoded in a ULID. */
export const ulidTime = (id: Ulid): number => {
	if (!isUlid(id)) throw invalid(`not a ulid: ${id}`);
	let time = 0;
	for (const ch of id.slice(0, TIME_LENGTH)) {
		time = time * 32 + ULID_ALPHABET.indexOf(ch);
	}
	return time;
};

const requireUlid = (id: string, what: string): Ulid => {
	if (!isUlid(id)) throw invalid(`${what} must be a lowercase ulid: ${id}`);
	return id;
};

// ---------------------------------------------------------------------------
// Prefixed ids
// ---------------------------------------------------------------------------

export const ID_PREFIX = {
	user: "u_",
	agent: "a_",
	/** Extension service principal: `x_<installationId>` = `x_i_<ulid>`. */
	ext: "x_",
	installation: "i_",
	lane: "ln_",
	batch: "lb_",
	kernelWrite: "kw_",
	run: "run_",
	token: "tok_",
	invite: "inv_",
	delegation: "dlg_",
	notice: "nt_",
	conflict: "cf_",
} as const;
export type IdKind = keyof typeof ID_PREFIX;

export const SYS_KERNEL = "sys_kernel" as const;

export const prefixedId = (kind: IdKind, id: Ulid): string =>
	kind === "ext"
		? `${ID_PREFIX.ext}${installationId(id)}`
		: `${ID_PREFIX[kind]}${requireUlid(id, kind)}`;

/** Returns the ULID inside a prefixed id, or null if `id` is not of that kind. */
export const parseId = (kind: IdKind, id: string): Ulid | null => {
	const prefix = kind === "ext"
		? `${ID_PREFIX.ext}${ID_PREFIX.installation}`
		: ID_PREFIX[kind];
	if (!id.startsWith(prefix)) return null;
	const rest = id.slice(prefix.length);
	return isUlid(rest) ? rest : null;
};

export const isIdOf = (kind: IdKind, id: unknown): id is string =>
	typeof id === "string" && parseId(kind, id) !== null;

export const userId = (id: Ulid): string => prefixedId("user", id);
export const agentId = (id: Ulid): string => prefixedId("agent", id);
export const installationId = (id: Ulid): string =>
	`${ID_PREFIX.installation}${requireUlid(id, "installation")}`;
export const extPrincipalId = (installation: string): string => {
	if (!isIdOf("installation", installation)) {
		throw invalid(`not an installation id: ${installation}`);
	}
	return `${ID_PREFIX.ext}${installation}`;
};
export const laneId = (id: Ulid): string => prefixedId("lane", id);
export const batchId = (id: Ulid): string => prefixedId("batch", id);
export const kernelWriteId = (id: Ulid): string =>
	prefixedId("kernelWrite", id);
export const runId = (id: Ulid): string => prefixedId("run", id);

/** Principal ids: `u_<ulid>`, `a_<ulid>`, `x_i_<ulid>` or `sys_kernel`. */
export const PRINCIPAL_ID_RE =
	/^(?:u_[0-7][0-9a-hjkmnp-tv-z]{25}|a_[0-7][0-9a-hjkmnp-tv-z]{25}|x_i_[0-7][0-9a-hjkmnp-tv-z]{25}|sys_kernel)$/;
export const isPrincipalId = (value: unknown): value is string =>
	typeof value === "string" && PRINCIPAL_ID_RE.test(value);

export type PrincipalKind = "user" | "agent" | "ext" | "system";
export const principalKind = (id: string): PrincipalKind | null =>
	id === SYS_KERNEL
		? "system"
		: isIdOf("user", id)
		? "user"
		: isIdOf("agent", id)
		? "agent"
		: isIdOf("ext", id)
		? "ext"
		: null;

/** Advance ids are deterministic: `adv_<batchUlid>_<attempt>`. */
export const advanceId = (batch: string, attempt: number): string => {
	if (!Number.isInteger(attempt) || attempt < 0) {
		throw invalid(`attempt must be a non-negative integer: ${attempt}`);
	}
	return `adv_${batchUlidOf(batch)}_${attempt}`;
};
export const ADVANCE_ID_RE = /^adv_([0-7][0-9a-hjkmnp-tv-z]{25})_(\d+)$/;
export const parseAdvanceId = (
	id: string,
): { batchUlid: Ulid; attempt: number } | null => {
	const m = ADVANCE_ID_RE.exec(id);
	return m ? { batchUlid: m[1], attempt: Number(m[2]) } : null;
};

/** Accepts `lb_<ulid>` or a bare ULID and returns the ULID. */
export const batchUlidOf = (batch: string): Ulid => {
	const inner = parseId("batch", batch);
	if (inner) return inner;
	return requireUlid(batch, "batch");
};

/** jj-style change id: 32 chars of "reverse hex" (`z`=0 … `k`=f), e.g. `zkqv…`. */
export const CHANGE_ID_RE = /^[k-z]{32}$/;
export const isChangeId = (value: unknown): value is string =>
	typeof value === "string" && CHANGE_ID_RE.test(value);
const REVERSE_HEX = "zyxwvutsrqponmlk";
/** Encodes 16 bytes as a reverse-hex change id. */
export const changeIdFromBytes = (bytes: Uint8Array): string => {
	if (bytes.length < 16) throw invalid("change id needs 16 bytes");
	return Array.from(
		bytes.subarray(0, 16),
		(b) => REVERSE_HEX[b >> 4] + REVERSE_HEX[b & 15],
	).join("");
};
/** Gerrit-style `Change-Id: I<40hex>` trailer value. */
export const GERRIT_CHANGE_ID_RE = /^I[0-9a-f]{40}$/;

/** Extension id: `tartan.weave`, `acme.no-secrets`. */
export const EXT_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
export const SHA1_RE = /^[0-9a-f]{40}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const ZERO_SHA = "0000000000000000000000000000000000000000" as const;
export const isSha = (value: unknown): value is string =>
	typeof value === "string" && SHA1_RE.test(value);

// ---------------------------------------------------------------------------
// Artifacts names
// ---------------------------------------------------------------------------

const ULID_SRC = "[0-7][0-9a-hjkmnp-tv-z]{25}";

/**
 * Artifacts repo names Tartan creates, all lowercase (names fold case
 * [E A2]): the canonical `r-<repoUlid>` (28 chars) or a lane repo
 * `l-<repoUlid>-<laneUlid>` (seed attempt 1, 55 chars) /
 * `l-<repoUlid>-<laneUlid>-<n>` (attempt n = 2–9, 57 chars). Every seed
 * attempt uses a fresh name, and the name carries the repo family, so
 * IngestWorkflow and the orphan sweep resolve the RepoDO from the name alone.
 */
export const ARTIFACTS_NAME_RE = new RegExp(
	`^(?:r-${ULID_SRC}|l-${ULID_SRC}-${ULID_SRC}(?:-[2-9])?)$`,
);
/** Artifacts namespace rule: lowercase `[a-z0-9-]`, 2–63, no trailing `-`. */
export const ARTIFACTS_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

/** Seed attempts per lane: the lane-repo name suffix stops at 9. */
export const LANE_SEED_MAX_ATTEMPTS = 9;

export const repoArtifactsName = (repoUlid: Ulid): string =>
	`r-${requireUlid(repoUlid, "repo id")}`;

/** The lane repo of one seed attempt: `l-<repoUlid>-<laneUlid>` (1) or `…-<attempt>` (2–9). */
export const laneArtifactsName = (
	repoUlid: Ulid,
	laneUlid: Ulid,
	attempt = 1,
): string => {
	if (
		!Number.isInteger(attempt) || attempt < 1 ||
		attempt > LANE_SEED_MAX_ATTEMPTS
	) {
		throw invalid(
			`seed attempt must be 1–${LANE_SEED_MAX_ATTEMPTS}: ${attempt}`,
		);
	}
	const base = `l-${requireUlid(repoUlid, "repo id")}-${
		requireUlid(laneUlid, "lane id")
	}`;
	return attempt === 1 ? base : `${base}-${attempt}`;
};

export type ParsedArtifactsName =
	| { readonly kind: "repo"; readonly repoUlid: Ulid }
	| {
		readonly kind: "lane";
		readonly repoUlid: Ulid;
		readonly laneUlid: Ulid;
		readonly attempt: number;
	};

/**
 * Parses a repo name as Artifacts reports it (events, `list()`), lowercasing
 * it first. Null for any name Tartan does not create.
 */
export const parseArtifactsName = (
	name: string,
): ParsedArtifactsName | null => {
	const lower = name.toLowerCase();
	if (!ARTIFACTS_NAME_RE.test(lower)) return null;
	if (lower.startsWith("r-")) return { kind: "repo", repoUlid: lower.slice(2) };
	const [, repoUlid, laneUlid, attempt] = lower.split("-");
	return {
		kind: "lane",
		repoUlid,
		laneUlid,
		attempt: attempt === undefined ? 1 : Number(attempt),
	};
};

const STAGE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** `tartan` (button default) or `tartan-<stage>`; used for the Worker and the Artifacts namespace. */
export const stageName = (stage?: string): string => {
	if (stage === undefined || stage === "" || stage === "default") {
		return "tartan";
	}
	if (!STAGE_RE.test(stage)) throw invalid(`invalid stage name: ${stage}`);
	const name = `tartan-${stage}`;
	if (!ARTIFACTS_NAMESPACE_RE.test(name)) {
		throw invalid(`stage name too long: ${stage}`);
	}
	return name;
};
export const artifactsNamespace = stageName;
export const workerName = stageName;

// ---------------------------------------------------------------------------
// Durable Object names (≤ 1,024 bytes)
// ---------------------------------------------------------------------------

export const DO_NAME_MAX_BYTES = 1024;

const checkDoName = (name: string): string => {
	if (new TextEncoder().encode(name).length > DO_NAME_MAX_BYTES) {
		throw invalid(`durable object name exceeds ${DO_NAME_MAX_BYTES} bytes`);
	}
	return name;
};

export const FORGE_DO_NAME = "forge" as const;
export const repoDoName = (repoUlid: Ulid): string =>
	checkDoName(`repo:${requireUlid(repoUlid, "repo id")}`);
export const inboxDoName = (principal: string): string => {
	if (!isPrincipalId(principal)) {
		throw invalid(`not a principal id: ${principal}`);
	}
	return checkDoName(`inbox:${principal}`);
};

export type ExtScope =
	| { readonly kind: "node" }
	| { readonly kind: "repo"; readonly repoId: Ulid };

/** `ext:<instId>:node` or `ext:<instId>:repo:<repoUlid>`. */
export const extDoName = (installation: string, scope: ExtScope): string => {
	if (!isIdOf("installation", installation)) {
		throw invalid(`not an installation id: ${installation}`);
	}
	return checkDoName(
		scope.kind === "node"
			? `ext:${installation}:node`
			: `ext:${installation}:repo:${requireUlid(scope.repoId, "repo id")}`,
	);
};
export const extScopeKey = (scope: ExtScope): string =>
	scope.kind === "node" ? "node" : `repo:${scope.repoId}`;

export const jobSandboxName = (runUlid: Ulid): string =>
	checkDoName(`job:${requireUlid(runUlid, "run id")}`);
export const gitSandboxName = (repoUlid: Ulid): string =>
	checkDoName(`git:${requireUlid(repoUlid, "repo id")}`);
/** v2 only. */
export const agentSandboxName = (runUlid: Ulid): string =>
	checkDoName(`agent:${requireUlid(runUlid, "run id")}`);
/**
 * The repository-config evaluator for kernel-originated work (trunk
 * evaluations, explicit applies, registry re-evaluations, approval
 * self-checks); lane previews never run here (ADR repo config).
 */
export const CUE_TRUNK_SANDBOX = "cue:trunk" as const;
/** Lane previews, chosen by a hash of the requesting principal (`cue:preview:<k>`). */
export const cuePreviewSandboxName = (k: number): string => {
	if (!Number.isInteger(k) || k < 0 || k > 63) {
		throw invalid(`preview sandbox index out of range: ${k}`);
	}
	return checkDoName(`cue:preview:${k}`);
};

/** Dynamic Worker loader id: `x:<extId>@<version>#<sha16>:<instId>`. */
export const dynamicWorkerId = (
	extId: string,
	version: string,
	sha256Hex: string,
	installation: string,
): string => {
	if (!SHA256_HEX_RE.test(sha256Hex) && !/^[0-9a-f]{16}$/.test(sha256Hex)) {
		throw invalid("sha256 must be 64 (or 16) lowercase hex chars");
	}
	if (!isIdOf("installation", installation)) {
		throw invalid(`not an installation id: ${installation}`);
	}
	return `x:${extId}@${version}#${sha256Hex.slice(0, 16)}:${installation}`;
};

/** Synthetic facet id for js/wasm runtimes. */
export const facetId = (installation: string): string => `ext:${installation}`;

// ---------------------------------------------------------------------------
// Workflow instance ids, waitForEvent types and step names (U39)
// ---------------------------------------------------------------------------

export const WORKFLOW_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
export const WORKFLOW_ID_MAX = 100;
export const WORKFLOW_EVENT_TYPE_MAX = 100;
export const STEP_NAME_MAX = 100;

export const isWorkflowId = (value: string): boolean =>
	value.length <= WORKFLOW_ID_MAX && WORKFLOW_ID_RE.test(value);

const checkWorkflowId = (id: string): string => {
	if (!isWorkflowId(id)) throw invalid(`invalid workflow instance id: ${id}`);
	return id;
};

/** `run-<repoUlid>-<runUlid>` (57 chars). */
export const runInstanceId = (repoUlid: Ulid, runUlid: Ulid): string =>
	checkWorkflowId(
		`run-${requireUlid(repoUlid, "repo id")}-${requireUlid(runUlid, "run id")}`,
	);
/** `land-<repoUlid>-<batchUlid>` (58 chars). Accepts `lb_<ulid>` or a bare ULID. */
export const landInstanceId = (repoUlid: Ulid, batch: string): string =>
	checkWorkflowId(
		`land-${requireUlid(repoUlid, "repo id")}-${batchUlidOf(batch)}`,
	);
export const swarmInstanceId = (swarmUlid: Ulid): string =>
	checkWorkflowId(`swarm-${requireUlid(swarmUlid, "swarm id")}`);
/** `swarm-<ulid>-c<nn>` cohort children. */
export const swarmCohortInstanceId = (
	swarmUlid: Ulid,
	cohort: number,
): string => {
	if (!Number.isInteger(cohort) || cohort < 0) {
		throw invalid(`cohort must be a non-negative integer: ${cohort}`);
	}
	return checkWorkflowId(
		`swarm-${requireUlid(swarmUlid, "swarm id")}-c${
			String(cohort).padStart(2, "0")
		}`,
	);
};

/** Job ids inside a JobGraph: `[a-z0-9][a-z0-9-]{0,59}` (sanitized form is the identity). */
export const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Maps any string onto the job-id charset, ≤ 60 chars. */
export const sanitizeJobId = (raw: string): string => {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return cleaned === "" ? "job" : cleaned;
};

const checkAttempt = (attempt: number): number => {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw invalid(`attempt must be a positive integer: ${attempt}`);
	}
	return attempt;
};

const checkEventType = (type: string): string => {
	if (type.length > WORKFLOW_EVENT_TYPE_MAX || !WORKFLOW_ID_RE.test(type)) {
		throw invalid(`invalid workflow event type: ${type}`);
	}
	return type;
};

/** `job-<jobId>-a<attempt>` (RunWorkflow). */
export const jobEventType = (jobId: string, attempt: number): string =>
	checkEventType(`job-${sanitizeJobId(jobId)}-a${checkAttempt(attempt)}`);
/** `verdict-<attempt>` (LandWorkflow `test-n`, K14). */
export const verdictEventType = (attempt: number): string =>
	checkEventType(`verdict-${checkAttempt(attempt)}`);
/** `k5-free-<n>` (LandWorkflow K5 wait). */
export const k5FreeEventType = (n: number): string =>
	checkEventType(`k5-free-${checkAttempt(n)}`);

/** LandWorkflow steps, in order, for attempt `n`. */
export const LAND_STEPS = [
	"compose",
	"gate",
	"test",
	"lock",
	"restack",
	"push-trunk",
	"push-notes",
	"push-refs",
	"complete",
] as const;
export type LandStep = typeof LAND_STEPS[number];
/** Steps that repeat inside an attempt carry an iteration `i`. */
export const LAND_LOOP_STEPS = [
	"k5-wait",
	"poll",
	/** K13.1: the repository-config hold check and its sleep (never a land attempt). */
	"config-hold",
	"config-wait",
] as const;
export type LandLoopStep = typeof LAND_LOOP_STEPS[number];

/** `compose-1`, `push-trunk-2`, `k5-wait-1-3`, `poll-2-7`. */
export const landStepName = (
	step: LandStep | LandLoopStep,
	attempt: number,
	iteration?: number,
): string => {
	const loop = (LAND_LOOP_STEPS as readonly string[]).includes(step);
	if (loop && iteration === undefined) {
		throw invalid(`${step} needs an iteration`);
	}
	const name = `${step}-${checkAttempt(attempt)}${
		iteration === undefined ? "" : `-${iteration}`
	}`;
	if (name.length > STEP_NAME_MAX) throw invalid("step name too long");
	return name;
};

const checkIteration = (iteration: number): number => {
	if (!Number.isInteger(iteration) || iteration < 0) {
		throw invalid(`iteration must be a non-negative integer: ${iteration}`);
	}
	return iteration;
};

const runLoopStep = (
	step: "slot-wait" | "poll",
	jobId: string,
	attempt: number,
	iteration: number,
): string => {
	const name = `${step}-${sanitizeJobId(jobId)}-a${checkAttempt(attempt)}-${
		checkIteration(iteration)
	}`;
	if (name.length > STEP_NAME_MAX) throw invalid("step name too long");
	return name;
};

/**
 * RunWorkflow loop steps carry the job, its attempt and the iteration,
 * so a retried job never reads attempt 1's cached step result:
 * `slot-wait-<jobId>-a<attempt>-<i>`, `poll-<jobId>-a<attempt>-<i>`.
 */
export const runSlotWaitStep = (
	jobId: string,
	attempt: number,
	iteration: number,
): string => runLoopStep("slot-wait", jobId, attempt, iteration);
export const runPollStep = (
	jobId: string,
	attempt: number,
	iteration: number,
): string => runLoopStep("poll", jobId, attempt, iteration);

// ---------------------------------------------------------------------------
// Refs (K1)
// ---------------------------------------------------------------------------

export const DEFAULT_BRANCH = "main" as const;
export const HEADS_PREFIX = "refs/heads/" as const;
export const TAGS_PREFIX = "refs/tags/" as const;
export const NOTES_REF = "refs/notes/tartan" as const;
export const TARTAN_REF_PREFIX = "refs/tartan/" as const;
export const CANDIDATES_PREFIX = "refs/tartan/candidates/" as const;
export const CHANGES_PREFIX = "refs/tartan/changes/" as const;
export const ATTIC_PREFIX = "refs/tartan/attic/" as const;
/** Sandbox-mirror-only work refs; never pushed. */
export const WORK_REF_PREFIX = "refs/tartan-work/" as const;
/** The `branch` backend's lane namespace in the canonical repo. */
export const LANE_BRANCH_PREFIX = "refs/heads/lanes/" as const;
/** Agent notes of `branch`-backend lanes (stretch): `refs/notes/lanes/<laneId>/{agent-trace,ai}`. */
export const LANE_NOTES_PREFIX = "refs/notes/lanes/" as const;
/**
 * Reserved, kernel-only: nobody pushes below it. Artifacts
 * accepts `refs/tartan/*` [E S8, A4], so it is no longer a fallback namespace.
 */
export const RESERVED_TARTAN_HEADS_PREFIX = "refs/heads/tartan/" as const;
/** Agent-pushed notes copied onto landed commits (stretch). */
export const AGENT_NOTES_REFS = [
	"refs/notes/agent-trace",
	"refs/notes/ai",
] as const;

/**
 * Hidden namespaces of the canonical repo: never in a default
 * advertisement; listed only for an explicit protocol-v2 prefix inside them
 * (member view), plus the caller's own lane refs.
 */
export const HIDDEN_REF_PREFIXES = [
	LANE_BRANCH_PREFIX,
	LANE_NOTES_PREFIX,
	TARTAN_REF_PREFIX,
] as const;

/**
 * Reserved prefixes: the hidden namespaces plus
 * `refs/heads/tartan/`, `refs/tartan-work/` and everything below
 * `refs/notes/tartan` (the notes ref itself is matched by `isReservedRef`).
 */
export const RESERVED_REF_PREFIXES = [
	...HIDDEN_REF_PREFIXES,
	RESERVED_TARTAN_HEADS_PREFIX,
	WORK_REF_PREFIX,
	`${NOTES_REF}/`,
] as const;

/**
 * Exact refs nobody may create: each would block the namespace below it by
 * git's directory/file rule.
 */
export const RESERVED_REF_PARENTS = [
	"refs/heads/lanes",
	"refs/heads/tartan",
	"refs/notes/lanes",
	"refs/tartan",
	"refs/tartan-work",
] as const;

export const isHiddenRef = (ref: string): boolean =>
	HIDDEN_REF_PREFIXES.some((p) => ref.startsWith(p));
/** `refs/notes/tartan` or anything under a reserved prefix. */
export const isReservedRef = (ref: string): boolean =>
	ref === NOTES_REF || RESERVED_REF_PREFIXES.some((p) => ref.startsWith(p));
export const isReservedParent = (ref: string): boolean =>
	(RESERVED_REF_PARENTS as readonly string[]).includes(ref);

export const branchRef = (branch: string): string =>
	branch.startsWith(HEADS_PREFIX) ? branch : `${HEADS_PREFIX}${branch}`;
export const trunkRef = (defaultBranch: string = DEFAULT_BRANCH): string =>
	branchRef(defaultBranch);

/** `refs/tartan/candidates/<batchUlid>` (accepts `lb_<ulid>` or a bare ULID). */
export const candidateRef = (batch: string): string =>
	`${CANDIDATES_PREFIX}${batchUlidOf(batch)}`;
export const changeRef = (changeId: string): string => {
	if (!isChangeId(changeId)) throw invalid(`not a change id: ${changeId}`);
	return `${CHANGES_PREFIX}${changeId}`;
};
/** The `branch` backend's lane ref: `refs/heads/lanes/<laneId>`. */
export const laneBranchRef = (lane: string): string => {
	if (!isIdOf("lane", lane)) throw invalid(`not a lane id: ${lane}`);
	return `${LANE_BRANCH_PREFIX}${lane}`;
};
/** The local branch name agents use for a lane on either backend: `lanes/<laneId>`. */
export const laneLocalBranch = (lane: string): string => {
	if (!isIdOf("lane", lane)) throw invalid(`not a lane id: ${lane}`);
	return `lanes/${lane}`;
};
/**
 * The lane id of a `branch`-backend lane ref, or null. Only the exact
 * lowercase spelling `refs/heads/lanes/ln_<ulid>` counts:
 * deeper paths and case variants are not lane refs.
 */
export const laneIdFromBranchRef = (ref: string): string | null => {
	if (!ref.startsWith(LANE_BRANCH_PREFIX)) return null;
	const rest = ref.slice(LANE_BRANCH_PREFIX.length);
	return isIdOf("lane", rest) ? rest : null;
};
export const workRefs = (batch: string) => {
	const base = `${WORK_REF_PREFIX}${batchUlidOf(batch)}`;
	return {
		trunk: `${base}/trunk`,
		tip: `${base}/tip`,
		lane: (n: number): string => `${base}/lane-${n}`,
	} as const;
};

/**
 * Refs only kernel git jobs may write (K1), excluding protected
 * branches: `refs/tartan/**`, `refs/heads/tartan/**`, `refs/tartan-work/**`,
 * `refs/notes/tartan` and everything below it.
 */
export const isKernelRef = (ref: string): boolean =>
	ref === NOTES_REF || ref.startsWith(`${NOTES_REF}/`) ||
	ref.startsWith(TARTAN_REF_PREFIX) ||
	ref.startsWith(RESERVED_TARTAN_HEADS_PREFIX) ||
	ref.startsWith(WORK_REF_PREFIX);

/**
 * A conservative subset of `git check-ref-format` for full ref names: starts
 * with `refs/`, no control chars, space, `~^:?*[\`, `..`, `@{`, `//`, no
 * component starting with `.` or ending with `.lock`, not ending with `/` or `.`.
 */
export const isValidRefName = (ref: string): boolean => {
	if (!ref.startsWith("refs/") || ref.length > 1024) return false;
	// deno-lint-ignore no-control-regex
	if (/[\u0000- \u007f~^:?*[\\]/.test(ref)) return false;
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) {
		return false;
	}
	if (ref.endsWith("/") || ref.endsWith(".")) return false;
	return ref.split("/").every((part) =>
		part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")
	);
};

// ---------------------------------------------------------------------------
// Capability URLs
// ---------------------------------------------------------------------------

/**
 * The capability route Artifacts' importer pulls a lane repo's seed from:
 * `/-/cap/v1/<exp>/<laneId>/<nonce>/<mac>/<repoId>.git/<op>`.
 */
export const CAP_PATH_PREFIX = "/-/cap/v1/" as const;
/**
 * Syntax check, step 1 of the route's verification (before any DO call):
 * `exp` 10 digits (epoch seconds), a lowercase `ln_<ulid>`, a 128-bit hex
 * nonce, a 256-bit hex MAC, a lowercase repo ULID and the upload-pack op.
 */
export const CAP_PATH_RE = new RegExp(
	`^/-/cap/v1/(\\d{10})/(ln_${ULID_SRC})/([0-9a-f]{32})/([0-9a-f]{64})/(${ULID_SRC})\\.git/(info/refs|git-upload-pack)$`,
);
export const CAP_PATH_OPS = ["info/refs", "git-upload-pack"] as const;
export type CapPathOp = typeof CAP_PATH_OPS[number];

/** The fields the MAC covers. */
export type CapFields = {
	/** Expiry, epoch seconds (10 digits). */
	readonly exp: number;
	readonly laneId: string;
	/** 128 random bits, lowercase hex: `lanes.cap_nonce` of one seed attempt. */
	readonly nonce: string;
	readonly repoId: Ulid;
};
export type CapPathParts = CapFields & {
	/** HMAC-SHA256, lowercase hex. */
	readonly mac: string;
	readonly op: CapPathOp;
};

const CAP_NONCE_RE = /^[0-9a-f]{32}$/;

const checkCapFields = (c: CapFields): void => {
	if (!Number.isInteger(c.exp) || !/^\d{10}$/.test(String(c.exp))) {
		throw invalid(`capability exp must be 10-digit epoch seconds: ${c.exp}`);
	}
	if (!isIdOf("lane", c.laneId)) throw invalid(`not a lane id: ${c.laneId}`);
	if (!CAP_NONCE_RE.test(c.nonce)) {
		throw invalid("capability nonce must be 32 lowercase hex chars");
	}
	requireUlid(c.repoId, "repo id");
};

/**
 * The exact string the capability MAC covers, every path segment included:
 * `v1|<exp>|<laneId>|<nonce>|<repoId>`. The HMAC itself is computed
 * and verified kernel-side with a non-extractable WebCrypto key.
 */
export const capMacInput = (c: CapFields): string => {
	checkCapFields(c);
	return `v1|${c.exp}|${c.laneId}|${c.nonce}|${c.repoId}`;
};

/**
 * The repository path handed to `import()` (prefixed with the canonical
 * origin): `/-/cap/v1/<exp>/<laneId>/<nonce>/<mac>/<repoId>.git`. Git appends
 * `/info/refs` and `/git-upload-pack`.
 */
export const capPath = (c: CapFields & { readonly mac: string }): string => {
	checkCapFields(c);
	if (!SHA256_HEX_RE.test(c.mac)) {
		throw invalid("capability mac must be 64 lowercase hex chars");
	}
	return `${CAP_PATH_PREFIX}${c.exp}/${c.laneId}/${c.nonce}/${c.mac}/${c.repoId}.git`;
};

/** Parses a request path on the capability route, or null (the route answers a plain 404). */
export const parseCapPath = (path: string): CapPathParts | null => {
	const m = CAP_PATH_RE.exec(path);
	return m
		? {
			exp: Number(m[1]),
			laneId: m[2],
			nonce: m[3],
			mac: m[4],
			repoId: m[5],
			op: m[6] as CapPathOp,
		}
		: null;
};

// ---------------------------------------------------------------------------
// Hierarchy, tokens, cookies
// ---------------------------------------------------------------------------

/** Node slug: 1–64 of `[a-z0-9-]`, starting with `[a-z0-9]` (DDL CHECK on `nodes.slug`). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESERVED_ROOT_SLUGS = [
	"-",
	"api",
	"mcp",
	"assets",
	"static",
	"setup",
	"login",
	"logout",
	"admin",
	"settings",
	"explore",
	"help",
	"well-known",
	"oauth",
	"favicon.ico",
	"robots.txt",
] as const;
export const isValidSlug = (slug: string): boolean => SLUG_RE.test(slug);
export const isReservedRootSlug = (slug: string): boolean =>
	(RESERVED_ROOT_SLUGS as readonly string[]).includes(slug);

/** Ancestor-or-self path prefixes of a node path, root first. */
export const pathPrefixes = (path: string): string[] => {
	const parts = path.split("/").filter((p) => p !== "");
	return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};
/** True if `path` is `root` or lies under it. */
export const isWithinPath = (root: string, path: string): boolean =>
	path === root || path.startsWith(`${root}/`);

export const TOKEN_PREFIX = { pat: "tpat_", agent: "tagt_" } as const;
export type TokenKind = keyof typeof TOKEN_PREFIX;
export const TOKEN_RE = /^(tpat|tagt)_[A-Za-z0-9_-]{43}$/;
export const tokenKind = (token: string): TokenKind | null => {
	const m = TOKEN_RE.exec(token);
	return m ? (m[1] === "tpat" ? "pat" : "agent") : null;
};

export const COOKIE = {
	session: "__Host-tartan-session",
	loginPrefix: "__Host-tartan-login-",
	setup: "__Host-tartan-setup",
} as const;

/** Producer idempotency key for events: `<source>:<causedBy|request>:<type>:<n>`. */
export const eventIdemKey = (
	source: string,
	causedByOrRequest: string,
	type: string,
	n = 0,
): string => `${source}:${causedByOrRequest}:${type}:${n}`;
