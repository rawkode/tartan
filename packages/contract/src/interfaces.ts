// The replaceable coordination model: versioned interfaces.
//
// Source of truth for `work@1`, `changes@1`, `conflicts@1`, `checks@1`,
// `review@1`, `queue@1` and `context@1` (contract v0.2).
// `interfaces/<name>@<major>.json` is generated from these schemas by
// `scripts/gen-schemas.ts` (`deno task gen`; never committed) and checked by
// `generated.test.ts`.
//
// Entities and event payloads are open objects (`looseObject`): the kernel
// validates required fields (K10) and later minors may add fields. Tool inputs
// strip unknown keys; tool outputs are open.

import { z } from "zod";
import {
	ActorSchema,
	ChangeIdSchema,
	FootprintSchema,
	type InterfaceId,
	LaneIdSchema,
	NodePathSchema,
	PrincipalIdSchema,
	RepoPathSchema,
	RoleSchema,
	ShaSchema,
} from "./common.ts";
import { type Lane, LaneBackendNameSchema, laneGitCommands } from "./lanes.ts";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** `<repoPath>#<n>`, e.g. `acme/platform/router#42`. */
export const WORK_REF_RE =
	/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+#[1-9][0-9]{0,9}$/;
export const WorkRefSchema = z.string().regex(
	WORK_REF_RE,
	"work ref <repo>#<n>",
);
/** MCP/API repo argument: a repo path (or a repo id). */
export const RepoArgSchema = z.string().min(1).max(4096);
/**
 * The repo of an id-keyed tool. Lane, change, conflict and run
 * ids do not encode their repo, so the MCP host routes by: this argument,
 * else the session's repo scope (an MCP URL at a repo, or a lane-pinned
 * token), else `invalid("repo required")`.
 */
export const RepoHintSchema = RepoArgSchema.optional();
const Text = (max: number) => z.string().max(max);
const Title = z.string().min(1).max(200);
const Cursor = z.string().max(200);

export const SUGGESTIONS = [
	"proceed",
	"coordinate",
	"stack",
	"rebase",
	"yield",
] as const;
export const SuggestionSchema = z.enum(SUGGESTIONS);

export const DiffstatSchema = z.looseObject({
	files: z.number().int().nonnegative(),
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
});

export const HunkSchema = z.looseObject({
	oldStart: z.number().int().nonnegative(),
	oldLines: z.number().int().nonnegative(),
	newStart: z.number().int().nonnegative(),
	newLines: z.number().int().nonnegative(),
});

/**
 * The lane object of `work_claim` and `lanes_open`. A provider returns
 * the handle as `caps.lanes.open` gave it (a `repo` lane may still be
 * `opening`); the MCP host completes an `opening` handle with `awaitLane`
 * (≤ `LANE_OPEN_WAIT_MS`) before answering, and may still return `opening`
 * for the agent to poll with `lanes_get`.
 *
 * Rule: the MCP host rebuilds `remote` and `git` of **every**
 * handle in a tool result with `laneHandleOf`, whichever provider built it,
 * so a `branch` lane (open at once) always carries its commands. A lane that
 * was closed while `opening` has no handle: the tool answers
 * `conflict("lane closed while opening")` with `details {laneId, state}`.
 */
export const LaneHandleSchema = z.looseObject({
	id: LaneIdSchema,
	mode: LaneBackendNameSchema,
	state: z.enum(["opening", "open"]),
	/**
	 * Absolute git URL: the lane remote
	 * `https://<host>/<repo>/-/lanes/<id>.git` (`repo`), or the repo's git URL
	 * (`branch`). Providers return `Lane.remote` (a path); the MCP host
	 * rewrites it to the canonical origin before the result reaches the agent.
	 */
	remote: z.string(),
	/** `refs/heads/main` in the lane repo (`repo`), or `refs/heads/lanes/<id>` (`branch`). */
	ref: z.string(),
	/** The local branch name: `lanes/<id>`. */
	branch: z.string(),
	base: ShaSchema,
	/** The exact git commands for the lane's backend; absent while `opening`. */
	git: z.looseObject({
		start: z.string(),
		push: z.string(),
	}).optional(),
});
export type LaneHandle = z.infer<typeof LaneHandleSchema>;

/**
 * The handle of an `opening` or `open` lane, with the absolute remote
 * (`origin` + `lane.remote`) and, unless `opening`, the git commands
 * (`laneGitCommands`). Null for any other state (the caller answers
 * `conflict`, see `LaneHandleSchema`).
 */
export const laneHandleOf = (lane: Lane, origin: string): LaneHandle | null => {
	if (lane.state !== "opening" && lane.state !== "open") return null;
	const remote = `${origin.replace(/\/+$/, "")}${lane.remote}`;
	return {
		id: lane.id,
		mode: lane.mode,
		state: lane.state,
		remote,
		ref: lane.ref,
		branch: lane.branch,
		base: lane.base,
		...(lane.state === "open" ? { git: laneGitCommands(lane, remote) } : {}),
	};
};

const OverlapSchema = z.looseObject({
	laneId: LaneIdSchema,
	agent: z.string(),
	work: z.string().optional(),
	why: z.string().optional(),
	paths: z.array(z.string()),
	severity: z.string(),
	suggestion: SuggestionSchema,
});

const OkSchema = z.looseObject({ ok: z.boolean() });

// ---------------------------------------------------------------------------
// Interface definition shape
// ---------------------------------------------------------------------------

export type ToolDef = {
	readonly input: z.ZodType;
	readonly output: z.ZodType;
	/** Minimum actor role at the node. */
	readonly role: z.infer<typeof RoleSchema>;
	/**
	 * Mutating: denied in a read-only ExtCtx (render, context) and never
	 * run outside the ExtensionDO mutex. Which tools reject a bare
	 * installation actor is `ACTOR_REQUIRED_TOOLS` (K12), not this flag.
	 */
	readonly mutating: boolean;
	readonly description: string;
};

export type InterfaceDef = {
	readonly id: InterfaceId;
	readonly name: string;
	readonly version: number;
	readonly minor: number;
	readonly cardinality: "single" | "multi";
	readonly entity: z.ZodType | null;
	readonly events: Readonly<Record<string, z.ZodType>>;
	readonly tools: Readonly<Record<string, ToolDef>>;
};

const tool = (
	input: z.ZodType,
	output: z.ZodType,
	role: z.infer<typeof RoleSchema>,
	mutating: boolean,
	description: string,
): ToolDef => ({ input, output, role, mutating, description });

// ---------------------------------------------------------------------------
// work@1 (tartan.work)
// ---------------------------------------------------------------------------

export const WorkKindSchema = z.enum(["issue", "intent", "resolve"]);
export const WorkStateSchema = z.enum([
	"open",
	"claimed",
	"in_review",
	"done",
	"abandoned",
]);
export const ClaimStateSchema = z.enum([
	"active",
	"submitted",
	"released",
	"landed",
	"lease_lost",
]);
export const WorkOriginSchema = z.looseObject({
	resolveOf: z.array(ChangeIdSchema).optional(),
	issue: WorkRefSchema.optional(),
	federation: z.unknown().optional(),
});

export const WorkItemSchema = z.looseObject({
	ref: WorkRefSchema,
	kind: WorkKindSchema,
	title: Title,
	why: Text(8000),
	acceptance: z.array(Text(1000)).max(50),
	footprint: FootprintSchema,
	parent: WorkRefSchema.optional(),
	origin: WorkOriginSchema.optional(),
	state: WorkStateSchema,
	claims: z.array(z.looseObject({
		principal: PrincipalIdSchema,
		laneId: LaneIdSchema,
		state: ClaimStateSchema,
	})),
	labels: z.array(z.string().max(64)).max(32),
	priority: z.number().int().min(0).max(4),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WORK_EVENTS = {
	"work.created": z.looseObject({
		ref: WorkRefSchema,
		kind: WorkKindSchema,
		title: Title,
		footprint: FootprintSchema.optional(),
		parent: WorkRefSchema.optional(),
		origin: WorkOriginSchema.optional(),
	}),
	"work.updated": z.looseObject({
		ref: WorkRefSchema,
		state: WorkStateSchema.optional(),
		priority: z.number().int().min(0).max(4).optional(),
		labels: z.array(z.string()).optional(),
		changed: z.array(z.string()),
	}),
	"work.claimed": z.looseObject({
		ref: WorkRefSchema,
		principal: PrincipalIdSchema,
		laneId: LaneIdSchema,
		footprint: FootprintSchema.optional(),
	}),
	"work.released": z.looseObject({
		ref: WorkRefSchema,
		principal: PrincipalIdSchema,
		laneId: LaneIdSchema.optional(),
		reason: z.string().max(500).optional(),
	}),
	"work.done": z.looseObject({
		ref: WorkRefSchema,
		changeId: ChangeIdSchema.optional(),
		commit: ShaSchema.optional(),
	}),
	"work.commented": z.looseObject({
		ref: WorkRefSchema,
		commentId: z.string(),
		author: PrincipalIdSchema,
	}),
} as const;

export const WORK_TOOLS = {
	work_list: tool(
		z.object({
			repo: RepoArgSchema,
			state: WorkStateSchema.optional(),
			kind: WorkKindSchema.optional(),
			labels: z.array(z.string()).optional(),
			limit: z.number().int().min(1).max(200).optional(),
			cursor: Cursor.optional(),
		}),
		z.looseObject({
			items: z.array(WorkItemSchema),
			cursor: Cursor.optional(),
		}),
		20,
		false,
		"List work items (issues, intents, resolver items) in a repo",
	),
	work_get: tool(
		z.object({ ref: WorkRefSchema }),
		WorkItemSchema,
		20,
		false,
		"Get one work item with its claims",
	),
	work_create: tool(
		z.object({
			repo: RepoArgSchema,
			kind: WorkKindSchema,
			title: Title,
			why: Text(8000).optional(),
			acceptance: z.array(Text(1000)).max(50).optional(),
			footprint: FootprintSchema.optional(),
			parent: WorkRefSchema.optional(),
			origin: WorkOriginSchema.optional(),
			labels: z.array(z.string().max(64)).max(32).optional(),
			priority: z.number().int().min(0).max(4).optional(),
		}),
		WorkItemSchema,
		30,
		true,
		"Create a work item",
	),
	work_update: tool(
		z.object({
			ref: WorkRefSchema,
			state: WorkStateSchema.optional(),
			priority: z.number().int().min(0).max(4).optional(),
			labels: z.array(z.string().max(64)).max(32).optional(),
		}),
		WorkItemSchema,
		30,
		true,
		"Update a work item's state, priority or labels",
	),
	work_claim: tool(
		z.object({
			ref: WorkRefSchema,
			footprint: FootprintSchema.optional(),
			plan: Text(4000).optional(),
		}),
		z.looseObject({
			lane: LaneHandleSchema,
			work: WorkItemSchema,
			overlaps: z.array(OverlapSchema),
			context: z.unknown(),
		}),
		30,
		true,
		"Claim a work item with a footprint; returns your lane, overlaps and context",
	),
	work_release: tool(
		z.object({ ref: WorkRefSchema, reason: Text(500).optional() }),
		OkSchema,
		30,
		true,
		"Release your claim on a work item",
	),
	work_comment: tool(
		z.object({ ref: WorkRefSchema, body: Text(8000).min(1) }),
		z.looseObject({ commentId: z.string() }),
		20,
		true,
		"Comment on a work item",
	),
} as const;

// ---------------------------------------------------------------------------
// changes@1 (tartan.changes)
// ---------------------------------------------------------------------------

export const ChangeStateSchema = z.enum([
	"draft",
	"submitted",
	"approved",
	"queued",
	"landing",
	"landed",
	"ejected",
	"abandoned",
	"superseded",
]);

export const RevisionSchema = z.looseObject({
	n: z.number().int().min(1),
	head: ShaSchema,
	/** The lane range's base at this revision (K17 `rangeBase`), not the lane's opening base. */
	base: ShaSchema,
	affected: z.array(z.string()),
	diffstat: DiffstatSchema,
	at: z.number().int(),
});

export const ChangeSchema = z.looseObject({
	changeId: ChangeIdSchema,
	repo: z.string(),
	workRef: WorkRefSchema.optional(),
	laneId: LaneIdSchema,
	sourceRef: z.string().optional(),
	title: Title,
	summary: Text(16000),
	author: PrincipalIdSchema,
	onBehalfOf: PrincipalIdSchema.optional(),
	revisions: z.array(RevisionSchema),
	state: ChangeStateSchema,
	landedCommit: ShaSchema.optional(),
});
export type Change = z.infer<typeof ChangeSchema>;

const RevisionEventShape = {
	changeId: ChangeIdSchema,
	laneId: LaneIdSchema,
	revision: z.number().int().min(1),
	head: ShaSchema,
	base: ShaSchema,
	affected: z.array(z.string()),
	workRef: WorkRefSchema.optional(),
};

export const CHANGES_EVENTS = {
	"changes.opened": z.looseObject({
		changeId: ChangeIdSchema,
		laneId: LaneIdSchema,
		workRef: WorkRefSchema.optional(),
		sourceRef: z.string().optional(),
		title: z.string().optional(),
	}),
	"changes.submitted": z.looseObject(RevisionEventShape),
	"changes.revised": z.looseObject(RevisionEventShape),
	"changes.landed": z.looseObject({
		changeId: ChangeIdSchema,
		laneId: LaneIdSchema,
		commit: ShaSchema,
		advanceId: z.string(),
		workRef: WorkRefSchema.optional(),
	}),
	"changes.abandoned": z.looseObject({
		changeId: ChangeIdSchema,
		/** Set when known; moves the lane back to `open` (LANE_EVENT_TRANSITIONS). */
		laneId: LaneIdSchema.optional(),
		reason: z.string().max(500).optional(),
	}),
	"changes.superseded": z.looseObject({
		changeId: ChangeIdSchema,
		laneId: LaneIdSchema.optional(),
		by: ChangeIdSchema.optional(),
	}),
	"changes.commented": z.looseObject({
		changeId: ChangeIdSchema,
		commentId: z.string(),
		revision: z.number().int().min(1),
		path: z.string().optional(),
		line: z.number().int().optional(),
	}),
} as const;

export const CHANGES_TOOLS = {
	changes_open: tool(
		z.object({
			repo: RepoArgSchema,
			laneId: LaneIdSchema.optional(),
			sourceRef: z.string().max(1024).optional(),
			title: Title.optional(),
			workRef: WorkRefSchema.optional(),
		}),
		ChangeSchema,
		30,
		true,
		"Open a change from a lane or a pushed branch",
	),
	changes_submit: tool(
		z.object({
			repo: RepoHintSchema,
			laneId: LaneIdSchema,
			title: Title,
			summary: Text(16000),
			why: Text(8000).optional(),
		}),
		z.looseObject({
			changeId: ChangeIdSchema,
			revision: z.number().int().min(1),
			checks: z.unknown().optional(),
			route: z.enum(["auto", "human"]).optional(),
		}),
		30,
		true,
		"Submit your lane as a change (when acceptance criteria pass); refused for a quarantined or opening lane and for a lane you have not pushed (empty-lane)",
	),
	changes_get: tool(
		z.object({ changeId: ChangeIdSchema, repo: RepoHintSchema }),
		ChangeSchema,
		20,
		false,
		"Get a change with its revisions",
	),
	changes_list: tool(
		z.object({
			repo: RepoArgSchema,
			state: ChangeStateSchema.optional(),
			mine: z.boolean().optional(),
			limit: z.number().int().min(1).max(200).optional(),
			cursor: Cursor.optional(),
		}),
		z.looseObject({
			changes: z.array(ChangeSchema),
			cursor: Cursor.optional(),
		}),
		20,
		false,
		"List changes in a repo",
	),
	changes_abandon: tool(
		z.object({
			repo: RepoHintSchema,
			changeId: ChangeIdSchema,
			reason: Text(500).optional(),
		}),
		OkSchema,
		30,
		true,
		"Abandon a change",
	),
	changes_comment: tool(
		z.object({
			repo: RepoHintSchema,
			changeId: ChangeIdSchema,
			body: Text(8000).min(1),
			revision: z.number().int().min(1).optional(),
			path: RepoPathSchema.optional(),
			line: z.number().int().min(1).optional(),
			side: z.enum(["base", "head"]).optional(),
		}),
		z.looseObject({ commentId: z.string() }),
		20,
		true,
		"Comment on a change (optionally on a line)",
	),
} as const;

// ---------------------------------------------------------------------------
// conflicts@1 (tartan.radar)
// ---------------------------------------------------------------------------

export const CONFLICT_SEVERITIES = [
	"declared",
	"same_project",
	"same_file",
	"adjacent",
	"textual",
	"semantic",
	"trunk_drift",
] as const;
export const ConflictSeveritySchema = z.enum(CONFLICT_SEVERITIES);
export const ConflictStateSchema = z.enum(["open", "acked", "cleared"]);
/** A conflict side: a lane id or `trunk`. */
const ConflictSideSchema = z.union([LaneIdSchema, z.literal("trunk")]);

export const ConflictSchema = z.looseObject({
	id: z.string(),
	a: ConflictSideSchema,
	b: ConflictSideSchema,
	path: z.string(),
	project: z.string().optional(),
	severity: ConflictSeveritySchema,
	hunksA: z.array(HunkSchema).optional(),
	hunksB: z.array(HunkSchema).optional(),
	suggestion: SuggestionSchema,
	state: ConflictStateSchema,
	avoided: z.boolean().optional(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const ConflictResolutionSchema = z.enum([
	"adapt",
	"coordinate",
	"rebase",
	"stack",
	"yield",
	"ignore",
]);

export const CONFLICTS_EVENTS = {
	"conflicts.detected": z.looseObject({
		conflictId: z.string(),
		a: ConflictSideSchema,
		b: ConflictSideSchema,
		path: z.string(),
		severity: ConflictSeveritySchema,
		hunksA: z.array(HunkSchema).optional(),
		hunksB: z.array(HunkSchema).optional(),
		suggestion: SuggestionSchema,
	}),
	"conflicts.escalated": z.looseObject({
		conflictId: z.string(),
		from: ConflictSeveritySchema,
		to: ConflictSeveritySchema,
	}),
	"conflicts.acked": z.looseObject({
		conflictId: z.string(),
		by: PrincipalIdSchema,
		resolution: ConflictResolutionSchema,
	}),
	"conflicts.cleared": z.looseObject({
		conflictId: z.string(),
		avoided: z.boolean(),
	}),
} as const;

export const CONFLICTS_TOOLS = {
	conflicts_check: tool(
		z.object({
			repo: RepoArgSchema,
			laneId: LaneIdSchema.optional(),
			footprint: FootprintSchema.optional(),
			paths: z.array(RepoPathSchema).max(200).optional(),
		}),
		z.looseObject({
			results: z.array(z.looseObject({
				target: z.string(),
				lanes: z.array(z.looseObject({
					laneId: LaneIdSchema,
					agent: z.string(),
					work: z.string().optional(),
					why: z.string().optional(),
				})),
				severity: ConflictSeveritySchema.optional(),
				suggestion: SuggestionSchema,
			})),
		}),
		20,
		false,
		"If I edit these paths (or this footprint), who do I collide with?",
	),
	conflicts_list: tool(
		z.object({
			repo: RepoArgSchema,
			laneId: LaneIdSchema.optional(),
			state: ConflictStateSchema.optional(),
		}),
		z.looseObject({ conflicts: z.array(ConflictSchema) }),
		20,
		false,
		"List conflicts in a repo or for a lane",
	),
	conflicts_ack: tool(
		z.object({
			repo: RepoHintSchema,
			conflictId: z.string().min(1),
			resolution: ConflictResolutionSchema,
			note: Text(1000).optional(),
		}),
		ConflictSchema,
		30,
		true,
		"Acknowledge a conflict and say how you will resolve it",
	),
} as const;

// ---------------------------------------------------------------------------
// checks@1 (tartan.ci)
// ---------------------------------------------------------------------------

export const CheckStateSchema = z.enum([
	"pending",
	"running",
	"success",
	"failure",
	"cancelled",
	"skipped",
	"cached",
]);
export const CheckSubjectSchema = z.looseObject({
	kind: z.enum(["change", "land"]),
	id: z.string(),
});

export const CheckSchema = z.looseObject({
	subject: CheckSubjectSchema,
	sha: ShaSchema,
	context: z.string(),
	state: CheckStateSchema,
	runId: z.string().optional(),
	cached: z.boolean(),
});
export type Check = z.infer<typeof CheckSchema>;

export const CHECKS_EVENTS = {
	"checks.updated": z.looseObject({
		subject: CheckSubjectSchema,
		sha: ShaSchema,
		context: z.string(),
		state: CheckStateSchema,
		runId: z.string().optional(),
		cached: z.boolean().optional(),
	}),
	"checks.completed": z.looseObject({
		subject: CheckSubjectSchema,
		sha: ShaSchema,
		state: z.enum(["success", "failure", "cancelled"]),
		contexts: z.array(z.looseObject({
			context: z.string(),
			state: CheckStateSchema,
		})),
		cached: z.boolean(),
	}),
} as const;

export const CHECKS_TOOLS = {
	checks_get: tool(
		z.object({
			repo: RepoArgSchema,
			changeId: ChangeIdSchema.optional(),
			subject: CheckSubjectSchema.optional(),
			sha: ShaSchema.optional(),
		}),
		z.looseObject({ checks: z.array(CheckSchema) }),
		20,
		false,
		"Get check results for a change or a land candidate",
	),
	checks_rerun: tool(
		z.object({
			repo: RepoArgSchema,
			changeId: ChangeIdSchema.optional(),
			subject: CheckSubjectSchema.optional(),
			sha: ShaSchema.optional(),
		}),
		z.looseObject({ runId: z.string().optional() }),
		30,
		true,
		"Re-run checks",
	),
} as const;

// ---------------------------------------------------------------------------
// review@1 (tartan.review)
// ---------------------------------------------------------------------------

export const ReviewRouteSchema = z.enum(["auto", "human"]);
export const ReviewDecisionSchema = z.enum(["approve", "request_changes"]);

export const ReviewSchema = z.looseObject({
	changeId: ChangeIdSchema,
	revision: z.number().int().min(1),
	/** The lane head this review covers (K4). */
	head: ShaSchema,
	risk: z.number().min(0).max(1),
	factors: z.record(z.string(), z.number()),
	route: ReviewRouteSchema,
	attentionSet: z.array(PrincipalIdSchema),
	decision: ReviewDecisionSchema.optional(),
	decidedBy: ActorSchema.optional(),
	evidence: z.unknown(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const REVIEW_EVENTS = {
	"review.requested": z.looseObject({
		changeId: ChangeIdSchema,
		revision: z.number().int().min(1),
		/** The lane head the review is requested for. */
		head: ShaSchema,
		route: z.literal("human"),
		attentionSet: z.array(PrincipalIdSchema),
		risk: z.number().min(0).max(1).optional(),
		factors: z.record(z.string(), z.number()).optional(),
	}),
	"review.decided": z.looseObject({
		changeId: ChangeIdSchema,
		revision: z.number().int().min(1),
		/** The lane head the decision covers; K4 matches it against the batch's `LandChange.head`. */
		head: ShaSchema,
		decision: ReviewDecisionSchema,
		route: ReviewRouteSchema,
		risk: z.number().min(0).max(1).optional(),
		decidedBy: ActorSchema,
		evidence: z.unknown().optional(),
	}),
} as const;

export const REVIEW_TOOLS = {
	review_get: tool(
		z.object({ repo: RepoHintSchema, changeId: ChangeIdSchema }),
		ReviewSchema,
		20,
		false,
		"Get the review state and evidence of a change",
	),
	review_decide: tool(
		z.object({
			repo: RepoHintSchema,
			changeId: ChangeIdSchema,
			decision: ReviewDecisionSchema,
			revision: z.number().int().min(1).optional(),
			note: Text(4000).optional(),
		}),
		ReviewSchema,
		40,
		true,
		"Approve or request changes",
	),
	review_queue: tool(
		z.object({ repo: RepoArgSchema.optional(), mine: z.boolean().optional() }),
		z.looseObject({ reviews: z.array(ReviewSchema) }),
		20,
		false,
		"Changes waiting for a human",
	),
} as const;

// ---------------------------------------------------------------------------
// queue@1 (tartan.weave, tartan.fifo)
// ---------------------------------------------------------------------------

export const QueueEntryStateSchema = z.enum([
	"waiting",
	"batched",
	"landing",
	"landed",
	"ejected",
	"withdrawn",
]);

export const QueueEntrySchema = z.looseObject({
	changeId: ChangeIdSchema,
	partition: z.string(),
	position: z.number().int().nonnegative(),
	state: QueueEntryStateSchema,
	batchId: z.string().optional(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const QUEUE_EVENTS = {
	"queue.enqueued": z.looseObject({
		changeId: ChangeIdSchema,
		partition: z.string(),
	}),
	"queue.batched": z.looseObject({
		batchId: z.string(),
		partition: z.string(),
		changes: z.array(ChangeIdSchema),
	}),
	"queue.ejected": z.looseObject({
		changeId: ChangeIdSchema,
		reason: z.enum(["conflict", "veto", "failure", "stale", "withdrawn"]),
		paths: z.array(z.string()).optional(),
		conflictsWith: z.array(ChangeIdSchema).optional(),
		/**
		 * The kernel refusal that named the change, when one ejected it: the
		 * `denied` reason of `land.submit` (`policy-signoff`, K13.3).
		 */
		code: z.string().max(64).optional(),
	}),
	"queue.landed": z.looseObject({
		changeId: ChangeIdSchema,
		batchId: z.string(),
		commit: ShaSchema.optional(),
	}),
	"queue.paused": z.looseObject({
		reason: z.string().max(500),
		partition: z.string().optional(),
	}),
} as const;

export const QUEUE_TOOLS = {
	queue_status: tool(
		z.object({ repo: RepoArgSchema }),
		z.looseObject({
			partitions: z.array(z.looseObject({
				key: z.string(),
				entries: z.array(QueueEntrySchema),
			})),
			paused: z.boolean().optional(),
		}),
		20,
		false,
		"Show the queue (Weave) for a repo",
	),
	queue_enqueue: tool(
		z.object({ repo: RepoHintSchema, changeId: ChangeIdSchema }),
		QueueEntrySchema,
		30,
		true,
		"Enqueue an approved change",
	),
	queue_withdraw: tool(
		z.object({
			repo: RepoHintSchema,
			changeId: ChangeIdSchema,
			reason: Text(500).optional(),
		}),
		OkSchema,
		30,
		true,
		"Withdraw a change from the queue",
	),
} as const;

// ---------------------------------------------------------------------------
// context@1 (multi; every installation with `contributes.context`)
// ---------------------------------------------------------------------------

export const CONTEXT_PRIORITIES = [
	"protocol",
	"negative",
	"conflicts",
	"ownership",
	"hints",
] as const;
export const ContextPrioritySchema = z.enum(CONTEXT_PRIORITIES);
export type ContextPriority = z.infer<typeof ContextPrioritySchema>;

/** Kernel → contributor. */
export const ContextRequestSchema = z.looseObject({
	repo: NodePathSchema,
	repoId: z.string(),
	work: WorkRefSchema.optional(),
	laneId: LaneIdSchema.optional(),
	paths: z.array(z.string()).optional(),
	/** The contributor's own budget (its manifest `maxBytes`, ≤ 4096). */
	maxBytes: z.number().int().positive().max(4096),
	actor: ActorSchema,
});
export type ContextRequest = z.infer<typeof ContextRequestSchema>;

/** Contributor → kernel. Untrusted: the kernel fences `md` as ```` ```untrusted ```` when it quotes others' text. */
export const ContextSectionSchema = z.strictObject({
	id: z.string().min(1).max(64),
	title: z.string().max(120).optional(),
	priority: ContextPrioritySchema,
	md: z.string().max(16384),
	data: z.json().optional(),
});
export type ContextSection = z.infer<typeof ContextSectionSchema>;

/** Per-contributor timeout, contributor cap and total cap. */
export const CONTEXT_LIMITS = {
	timeoutMs: 300,
	maxContributors: 8,
	totalBytes: 16384,
	defaultBudgetTokens: 6000,
	bytesPerToken: 4,
} as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const single = (
	id: InterfaceId,
	entity: z.ZodType,
	events: Readonly<Record<string, z.ZodType>>,
	tools: Readonly<Record<string, ToolDef>>,
): InterfaceDef => ({
	id,
	name: id.split("@")[0],
	version: Number(id.split("@")[1]),
	minor: 0,
	cardinality: "single",
	entity,
	events,
	tools,
});

/** Interfaces of contract v0.2. */
export const INTERFACES = {
	"work@1": single("work@1", WorkItemSchema, WORK_EVENTS, WORK_TOOLS),
	"changes@1": single("changes@1", ChangeSchema, CHANGES_EVENTS, CHANGES_TOOLS),
	"conflicts@1": single(
		"conflicts@1",
		ConflictSchema,
		CONFLICTS_EVENTS,
		CONFLICTS_TOOLS,
	),
	"checks@1": single("checks@1", CheckSchema, CHECKS_EVENTS, CHECKS_TOOLS),
	"review@1": single("review@1", ReviewSchema, REVIEW_EVENTS, REVIEW_TOOLS),
	"queue@1": single("queue@1", QueueEntrySchema, QUEUE_EVENTS, QUEUE_TOOLS),
	"context@1": {
		id: "context@1",
		name: "context",
		version: 1,
		minor: 0,
		cardinality: "multi",
		entity: null,
		events: {},
		tools: {},
	},
} as const satisfies Partial<Record<InterfaceId, InterfaceDef>>;

export type DefinedInterfaceId = keyof typeof INTERFACES;
export const DEFINED_INTERFACE_IDS = Object.keys(
	INTERFACES,
) as DefinedInterfaceId[];

/** Every interface event type → its payload schema (K10 validation). */
export const INTERFACE_EVENT_SCHEMAS: Readonly<Record<string, z.ZodType>> =
	Object.fromEntries(
		Object.values(INTERFACES).flatMap((def) => Object.entries(def.events)),
	);

/** The interface whose events use `type`'s namespace (`changes.submitted` → `changes@1`). */
export const interfaceOfEventType = (
	type: string,
): DefinedInterfaceId | null => {
	const found = Object.values(INTERFACES).find((def) =>
		Object.hasOwn(def.events, type)
	);
	return found ? found.id as DefinedInterfaceId : null;
};

/** Every interface tool name → its interface and definition. */
export const INTERFACE_TOOLS: Readonly<
	Record<string, { readonly iface: DefinedInterfaceId; readonly def: ToolDef }>
> = Object.fromEntries(
	Object.values(INTERFACES).flatMap((def) =>
		Object.entries(def.tools).map((
			[name, t],
		) => [name, { iface: def.id as DefinedInterfaceId, def: t }])
	),
);

const JSON_SCHEMA_OPTIONS = {
	target: "draft-2020-12",
	io: "input",
	unrepresentable: "any",
} as const;

const toJson = (schema: z.ZodType): Record<string, unknown> => {
	const out = z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS) as Record<
		string,
		unknown
	>;
	delete out.$schema;
	return out;
};

/**
 * The JSON bundle of one interface, as published in
 * `packages/contract/interfaces/<name>@<major>.json`.
 */
export const interfaceToJson = (
	def: InterfaceDef,
): Record<string, unknown> => ({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: `https://tartan.dev/interfaces/${def.id}.json`,
	name: def.name,
	version: def.version,
	minor: def.minor,
	cardinality: def.cardinality,
	entity: def.entity ? toJson(def.entity) : null,
	events: Object.fromEntries(
		Object.entries(def.events).map(([type, s]) => [type, toJson(s)]),
	),
	tools: Object.fromEntries(
		Object.entries(def.tools).map(([name, t]) => [name, {
			description: t.description,
			role: t.role,
			mutating: t.mutating,
			input: toJson(t.input),
			output: toJson(t.output),
		}]),
	),
	...(def.id === "context@1"
		? {
			context: {
				request: toJson(ContextRequestSchema),
				section: toJson(ContextSectionSchema),
			},
		}
		: {}),
});
