// Why provenance: the why note in `refs/notes/tartan` and the squash-commit
// trailers (K4).

import { z } from "zod";
import {
	ChangeIdSchema,
	LaneIdSchema,
	PrincipalIdSchema,
	RefNameSchema,
	Sha256HexSchema,
	ShaSchema,
	UlidSchema,
} from "./common.ts";
import { CHANGES_PREFIX, GERRIT_CHANGE_ID_RE } from "./ids.ts";
import { TRAILER_KEY_RE, TrailerSchema } from "./land.ts";
import { LaneBackendNameSchema } from "./lanes.ts";

export const WHY_NOTE_VERSION = 1;

export const WhyNoteGateSchema = z.strictObject({
	/** `<extId>@<version>`. */
	ext: z.string(),
	decision: z.enum(["allow", "advise", "veto"]),
	mode: z.enum(["enforce", "shadow"]),
	message: z.string().max(2000).optional(),
});

/** The kernel section: always present, written from verified kernel state. */
export const WhyNoteKernelSchema = z.strictObject({
	advance: z.string(),
	ref: RefNameSchema,
	batch: z.string(),
	/** Installation id of the `queue@1` provider that submitted the batch. */
	landedBy: z.string(),
	actor: PrincipalIdSchema,
	onBehalfOf: PrincipalIdSchema.optional(),
	change: ChangeIdSchema,
	lane: LaneIdSchema,
	laneHead: ShaSchema,
	/** The backend the lane was on when it landed. */
	laneMode: LaneBackendNameSchema,
	/** Where the landed lane head stays fetchable after lane GC: `refs/tartan/changes/<changeId>`. */
	laneHeadRef: RefNameSchema.refine(
		(r) => r.startsWith(CHANGES_PREFIX),
		"a refs/tartan/changes/ ref",
	),
	/** The lane range's base (K17). */
	rangeBase: ShaSchema,
	/**
	 * First pushers of the commits in the lane range other than the verified
	 * pusher (`commit_firsts`); each also gets a `Co-authored-by`.
	 */
	firstPushers: z.array(z.strictObject({
		principal: PrincipalIdSchema,
		commits: z.number().int().min(1),
	})),
	/** `partial` when the range listing was truncated. */
	provenance: z.enum(["complete", "partial"]),
	reason: z.strictObject({
		summary: z.string(),
		events: z.array(UlidSchema).min(1),
	}),
	gates: z.array(WhyNoteGateSchema),
	checks: z.strictObject({
		state: z.enum(["success", "failure", "skipped"]),
		runs: z.array(z.string()),
		evidenceReused: z.boolean(),
		/** K6: landings (commit shas) the disjointness check ran against. */
		checkedAgainst: z.array(ShaSchema).optional(),
	}),
	chain: z.strictObject({
		seq: z.number().int().nonnegative(),
		head: Sha256HexSchema,
	}),
	/** Written by the audited dev-only `seedHistory`; labelled in every UI. */
	seeded: z.boolean().optional(),
});
export type WhyNoteKernel = z.infer<typeof WhyNoteKernelSchema>;

/** One JSON document per landed commit; `ext` holds `notes.contribute` sections keyed by extension id. */
export const WhyNoteSchema = z.strictObject({
	v: z.literal(WHY_NOTE_VERSION),
	kernel: WhyNoteKernelSchema,
	ext: z.record(z.string(), z.unknown()),
});
export type WhyNote = z.infer<typeof WhyNoteSchema>;

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

/** Trailers the kernel writes from verified state (push log, lane ownership); providers may not set them. */
export const KERNEL_TRAILER_KEYS = [
	"Change-Id",
	"Tartan-Agent",
	"Tartan-On-Behalf-Of",
	"Tartan-Advance",
	"Co-authored-by",
] as const;
/** Trailers the queue provider supplies (validated as syntax only). */
export const PROVIDER_TRAILER_KEYS = [
	"Tartan-Change",
	"Tartan-Work",
	"Tartan-Review",
] as const;

export type TrailerLine = z.infer<typeof TrailerSchema>;

/** True when a provider-supplied trailer key is allowed (not kernel-verified). */
export const isProviderTrailerKey = (key: string): boolean =>
	TRAILER_KEY_RE.test(key) &&
	!(KERNEL_TRAILER_KEYS as readonly string[]).some((k) =>
		k.toLowerCase() === key.toLowerCase()
	);

/** Kernel-verified trailer values for one landed change. */
export type KernelTrailers = {
	/** `I<40hex>` (Gerrit style). */
	readonly changeId: string;
	/** `codex-2 (codex/gpt-5-codex)`: lane owner = pusher in the push log. */
	readonly agent?: string;
	readonly onBehalfOf?: string;
	/** `adv_<batchUlid>_<n>`. */
	readonly advance: string;
	/**
	 * `codex-2 <agent+a_01k6…@agents.git.example.com>`: every other first
	 * pusher of a lane-range commit (`commit_firsts`).
	 */
	readonly coAuthoredBy: readonly string[];
};

/** Input of the squash-message composer (implemented by WP10). */
export type SquashMessageInput = {
	readonly title: string;
	/** ≤ 4 KB. */
	readonly summary: string;
	readonly kernel: KernelTrailers;
	/** From the `land.submit` request; kernel keys are dropped. */
	readonly provider: readonly TrailerLine[];
};

export const isGerritChangeId = (value: string): boolean =>
	GERRIT_CHANGE_ID_RE.test(value);

/** Synthetic email for agent co-authors. */
export const agentCoAuthorEmail = (
	agentPrincipal: string,
	host: string,
): string => `agent+${agentPrincipal}@agents.${host}`;
