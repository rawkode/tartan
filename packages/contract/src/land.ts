// The Advance: land requests, verdicts and statuses (K4, K5, K6, K14).

import { z } from "zod";
import {
	BatchIdSchema,
	ChangeIdSchema,
	EntityRefSchema,
	LaneIdSchema,
	RefNameSchema,
	RepoRefSchema,
	ShaSchema,
	UlidSchema,
} from "./common.ts";

export const MAX_LAND_ATTEMPTS = 3;
export const MAX_BATCH_SIZE = 16;
export const SUMMARY_MAX_BYTES = 4096;

/** Trailer syntax only: the provider's trailers are validated as syntax, never trusted. */
export const TRAILER_KEY_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
export const TrailerSchema = z.strictObject({
	key: z.string().regex(TRAILER_KEY_RE),
	value: z.string().min(1).max(500).regex(/^[^\r\n]*$/),
});

export const LandChangeSchema = z.strictObject({
	changeId: ChangeIdSchema,
	laneId: LaneIdSchema,
	/**
	 * Must equal `lanes.head_sha` at submit, else the batch is refused with
	 * `conflict` (reason `head-moved`). Submitted lanes are frozen (`landing`)
	 * and released on every non-landing outcome.
	 */
	head: ShaSchema,
	title: z.string().min(1).max(200).regex(/^[^\r\n]*$/),
	message: z.string().max(SUMMARY_MAX_BYTES),
	trailers: z.array(TrailerSchema).max(32),
});
export type LandChange = z.infer<typeof LandChangeSchema>;

/** K4: non-empty causal event ids from this repo's log (validated per change by the kernel). */
export const LandReasonSchema = z.strictObject({
	events: z.array(UlidSchema).min(1).max(256),
	entities: z.array(EntityRefSchema).max(64).optional(),
	summary: z.string().min(1).max(1000),
});
export type LandReason = z.infer<typeof LandReasonSchema>;

export const TestPolicySchema = z.enum(["checks", "none"]);
export type TestPolicy = z.infer<typeof TestPolicySchema>;

/** `caps.land.submit` input. `batchId` is minted and stored by the caller first. */
export const LandRequestSchema = z.strictObject({
	batchId: BatchIdSchema,
	repo: RepoRefSchema,
	ref: RefNameSchema.refine((r) => r.startsWith("refs/heads/"), "branch ref"),
	batch: z.array(LandChangeSchema).min(1).max(MAX_BATCH_SIZE),
	reason: LandReasonSchema,
	testPolicy: TestPolicySchema,
	partitionKey: z.string().max(1024).optional(),
});
export type LandRequest = z.infer<typeof LandRequestSchema>;

export const LAND_BATCH_STATES = [
	"composing",
	"gating",
	"testing",
	"advancing",
	"landed",
	"conflicted",
	"vetoed",
	"failed",
	"stale",
	"cancelled",
] as const;
export type LandBatchState = typeof LAND_BATCH_STATES[number];
export const TERMINAL_BATCH_STATES: readonly LandBatchState[] = [
	"landed",
	"conflicted",
	"vetoed",
	"failed",
	"cancelled",
];

export type LandStatus = {
	readonly batchId: string;
	readonly repoId: string;
	readonly ref: string;
	readonly state: LandBatchState;
	readonly attempt: number;
	readonly candidateSha?: string;
	readonly baseSha: string;
	readonly changes: readonly {
		readonly changeId: string;
		readonly laneId: string;
		readonly outcome?: "landed" | "conflicted" | "vetoed" | "pending";
		readonly commit?: string;
	}[];
	readonly advanceId?: string;
	readonly result?: unknown;
	readonly createdAt: number;
	readonly finishedAt?: number;
};

/** `caps.land.report` input (K14): must echo the attempt and candidate announced by `land.testing`. */
export const LandVerdictSchema = z.strictObject({
	attempt: z.number().int().min(1),
	candidateSha: ShaSchema,
	state: z.enum(["success", "failure"]),
	runIds: z.array(z.string().max(64)).max(64),
	evidence: z.unknown(),
});
export type LandVerdict = z.infer<typeof LandVerdictSchema>;

/**
 * `kernel_writes.purpose` (K1, K2). The lane purposes carry
 * `target` = the lane:
 * - `lane-seed`: one intent per seed attempt (`refs/heads/main`, zeros →
 *   base, in the lane repo), each superseding the previous one;
 * - `lane-gc`: the ref-only delete of a `branch`-backend lane ref;
 * - `lane-delete`: deletion of a whole lane repo (`new_sha` zeros), by lane GC
 *   and by the orphan sweep;
 * - `purge`: an Owner's immediate deletion of a closed lane's repo or attic.
 */
export const KERNEL_WRITE_PURPOSES = [
	"candidate",
	"trunk",
	"notes",
	"change-ref",
	"attic",
	"lane-sync",
	"lane-seed",
	"lane-gc",
	"lane-delete",
	"purge",
	"genesis",
	"seed",
] as const;
export type KernelWritePurpose = typeof KERNEL_WRITE_PURPOSES[number];
export type KernelWriteState = "intent" | "pushed" | "observed" | "abandoned";
export type KernelWriteOwnerKind = "land" | "job" | "kernel";

export const ADVANCE_STEPS = [
	"locked",
	"restacked",
	"trunk-pushed",
	"notes-pushed",
	"refs-pushed",
] as const;
export type AdvanceStep = typeof ADVANCE_STEPS[number];
export type AdvanceState =
	| "locked"
	| "pushing"
	| "done"
	| "stale"
	| "failed"
	| "released";

/** K5 lease and wait bounds. */
export const ADVANCE_LEASE_MS = 5 * 60 * 1000;
export const K5_WAIT_MAX_MS = 30 * 60 * 1000;
export const VERDICT_TIMEOUT = "60 minutes" as const;
export const VERDICT_POLL_MS = 15_000;

export const AdvanceSchema = z.strictObject({
	id: z.string(),
	batchId: BatchIdSchema,
	attempt: z.number().int().min(0),
	ref: RefNameSchema,
	expectOld: ShaSchema,
	newSha: ShaSchema.optional(),
	ownerInstance: z.string(),
	leaseUntil: z.number().int(),
	step: z.enum(ADVANCE_STEPS),
	state: z.enum(["locked", "pushing", "done", "stale", "failed", "released"]),
	evidenceReused: z.boolean(),
	createdAt: z.number().int(),
	finishedAt: z.number().int().optional(),
});
export type Advance = z.infer<typeof AdvanceSchema>;
