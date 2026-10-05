// `work@1` tools of tartan.work: list, get, create, update (the board moves
// cards through it as the viewing user), claim with a footprint (opens the
// claimant's lane through `caps.lanes.open`, asks `conflicts@1` for declared
// overlaps and returns the lane handle, the overlaps and the item's context),
// release and comment.
//
// Mutating tools run under the ExtensionDO mutex, so a claim's checks, its
// `lanes.open` and its write cannot interleave with another claim of the same
// repo. Writes come before the event; an event whose emit failed is emitted
// again on the next call (idempotent keys), so the log never misses one.

import {
	conflict,
	denied,
	type EntityRef,
	type ExtCtx,
	invalid,
	type Lane,
	type LaneHandle,
	laneHandleOf,
	notFound,
	type ToolContext,
	WORK_TOOLS,
	type WorkItem,
} from "@tartan/contract";
import { actingPrincipals, requireInteractiveActor } from "@tartan/ext-api";
import { itemSections } from "./context.ts";
import {
	itemOfRef,
	type RepoCtx,
	repoOf,
	requireSameRepo,
	workEntityId,
	workItemOf,
} from "./repo.ts";
import {
	type ClaimRow,
	createStore,
	type ItemRow,
	LIVE_CLAIM_STATES,
	workRef,
} from "./store.ts";

type Tool = (args: unknown, ctx: ToolContext, x: ExtCtx) => Promise<unknown>;

const parse = <N extends keyof typeof WORK_TOOLS>(name: N, args: unknown) => {
	const r = WORK_TOOLS[name].input.safeParse(args);
	if (!r.success) {
		throw invalid(
			`${name}: ${r.error.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return r.data as Record<string, unknown>;
};

const LIST_DEFAULT = 50;

/** Emits a `work.*` event of this repo with the item as subject. */
export const emitWork = (
	x: ExtCtx,
	repo: RepoCtx,
	row: Pick<ItemRow, "id" | "number">,
	type: string,
	data: Record<string, unknown>,
	idemKey?: string,
): Promise<string> => {
	const ref = workRef(repo.path, row.number);
	return x.caps.events.emit(type, data, {
		repo: { id: repo.id },
		subject: { kind: "work", id: workEntityId(ref, row.id) },
		...(`work:${ref}`.length <= 256 ? { correlation: `work:${ref}` } : {}),
		...(idemKey ? { idemKey } : {}),
	});
};

const liveClaims = (claims: readonly ClaimRow[]): ClaimRow[] =>
	claims.filter((c) => LIVE_CLAIM_STATES.includes(c.state));

/** The lane object of a claim result; the MCP host makes `remote` absolute. */
export const handleOf = (lane: Lane): LaneHandle => {
	const handle = laneHandleOf(lane, "");
	if (handle === null) {
		throw conflict("lane closed while opening", {
			laneId: lane.id,
			state: lane.state,
		});
	}
	return handle;
};

type Overlap = {
	laneId: string;
	agent: string;
	work?: string;
	why?: string;
	paths: string[];
	severity: string;
	suggestion: "proceed" | "coordinate" | "stack" | "rebase" | "yield";
};

type CheckResult = {
	readonly results?: readonly {
		readonly target: string;
		readonly lanes: readonly {
			readonly laneId: string;
			readonly agent: string;
			readonly work?: string;
			readonly why?: string;
		}[];
		readonly severity?: string;
		readonly suggestion: Overlap["suggestion"];
	}[];
};

const SEVERITY_ORDER = [
	"declared",
	"same_project",
	"same_file",
	"adjacent",
	"textual",
	"semantic",
	"trunk_drift",
];
const worse = (a: string, b: string): string =>
	SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;

/** Declared overlaps from `conflicts@1`, grouped per other lane. */
export const overlapsOf = (
	result: CheckResult,
	ownLane: string,
): Overlap[] => {
	const byLane = new Map<string, Overlap>();
	for (const r of result.results ?? []) {
		for (const l of r.lanes) {
			if (l.laneId === ownLane) continue;
			const seen = byLane.get(l.laneId);
			const severity = r.severity ?? "declared";
			if (seen === undefined) {
				byLane.set(l.laneId, {
					laneId: l.laneId,
					agent: l.agent,
					...(l.work !== undefined ? { work: l.work } : {}),
					...(l.why !== undefined ? { why: l.why } : {}),
					paths: [r.target],
					severity,
					suggestion: r.suggestion,
				});
			} else {
				if (!seen.paths.includes(r.target)) seen.paths.push(r.target);
				const next = worse(seen.severity, severity);
				if (next !== seen.severity) {
					seen.severity = next;
					seen.suggestion = r.suggestion;
				}
			}
		}
	}
	return [...byLane.values()];
};

const checkOverlaps = async (
	x: ExtCtx,
	repo: RepoCtx,
	laneId: string,
	footprint: WorkItem["footprint"],
): Promise<Overlap[]> => {
	try {
		const out = await x.caps.interfaces.call(
			"conflicts@1",
			"conflicts_check",
			{ repo: repo.path, laneId, footprint },
		) as CheckResult;
		return overlapsOf(out, laneId);
	} catch (error) {
		// No conflicts@1 provider in force (e.g. the Classic pack) or radar is
		// down: the claim stands without overlaps.
		x.log.warn("conflicts_check failed; claim continues without overlaps", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
};

const claimResult = async (
	x: ExtCtx,
	repo: RepoCtx,
	row: ItemRow,
	lane: Lane,
) => {
	const store = createStore(x.sql);
	const work = workItemOf(x, repo, store.item(row.id) ?? row);
	const overlaps = await checkOverlaps(x, repo, lane.id, lane.footprint);
	return {
		lane: handleOf(lane),
		work,
		overlaps,
		context: { sections: itemSections(work, 4096) },
	};
};

const workList: Tool = async (args, ctx, x) => {
	const input = parse("work_list", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string);
	const limit = (input.limit as number | undefined) ?? LIST_DEFAULT;
	const after = input.cursor === undefined ? 0 : Number(input.cursor);
	if (!Number.isInteger(after) || after < 0) throw invalid("bad cursor");
	const store = createStore(x.sql);
	const rows = store.items({
		state: input.state as WorkItem["state"] | undefined,
		kind: input.kind as WorkItem["kind"] | undefined,
		labels: input.labels as string[] | undefined,
		after,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	return {
		items: page.map((r) => workItemOf(x, repo, r)),
		...(rows.length > limit ? { cursor: String(page.at(-1)!.number) } : {}),
	};
};

const workGet: Tool = async (args, ctx, x) => {
	const input = parse("work_get", args);
	const repo = await repoOf(x, ctx.repo);
	return workItemOf(x, repo, itemOfRef(x, repo, input.ref as string));
};

/** Creates an item (also the `create` action of the Work tab). */
export const createItem = async (
	x: ExtCtx,
	repo: RepoCtx,
	input: Record<string, unknown>,
): Promise<WorkItem> => {
	const store = createStore(x.sql);
	const at = x.caps.clock.now();
	const id = x.caps.ids.ulid();
	const number = store.insertItem({
		id,
		kind: input.kind as WorkItem["kind"],
		title: input.title as string,
		why: (input.why as string | undefined) ?? "",
		acceptance: (input.acceptance as string[] | undefined) ?? [],
		footprint: (input.footprint as WorkItem["footprint"] | undefined) ??
			{ projects: [], prefixes: [] },
		...(input.parent ? { parent: input.parent as string } : {}),
		...(input.origin
			? { origin: input.origin as Record<string, unknown> }
			: {}),
		priority: (input.priority as number | undefined) ?? 2,
		labels: (input.labels as string[] | undefined) ?? [],
		createdBy: x.actor.id,
		at,
	});
	const item = workItemOf(x, repo, store.item(id)!);
	await emitWork(x, repo, { id, number }, "work.created", {
		ref: item.ref,
		kind: item.kind,
		title: item.title,
		footprint: item.footprint,
		...(item.parent ? { parent: item.parent } : {}),
		...(item.origin ? { origin: item.origin } : {}),
	}, `created:${id}`);
	return item;
};

const workCreate: Tool = async (args, ctx, x) => {
	const input = parse("work_create", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string);
	return await createItem(x, repo, input);
};

/** State, priority and labels, as the caller (the board passes the viewing user). */
export const updateItem = async (
	x: ExtCtx,
	repo: RepoCtx,
	input: Record<string, unknown>,
): Promise<WorkItem> => {
	const store = createStore(x.sql);
	const row = itemOfRef(x, repo, input.ref as string);
	const patch = {
		...(input.state !== undefined && input.state !== row.state
			? { state: input.state as WorkItem["state"] }
			: {}),
		...(input.priority !== undefined && input.priority !== row.priority
			? { priority: input.priority as number }
			: {}),
		...(input.labels !== undefined &&
				JSON.stringify(input.labels) !== row.labels_json
			? { labels: input.labels as string[] }
			: {}),
	};
	const changed = Object.keys(patch);
	if (changed.length === 0) return workItemOf(x, repo, row);
	const at = x.caps.clock.now();
	store.updateItem(row.id, patch, at);
	const item = workItemOf(x, repo, store.item(row.id)!);
	await emitWork(x, repo, row, "work.updated", {
		ref: item.ref,
		...patch,
		changed,
	}, `updated:${row.id}:${x.caps.ids.ulid()}`);
	return item;
};

const workUpdate: Tool = async (args, ctx, x) => {
	const input = parse("work_update", args);
	const repo = await repoOf(x, ctx.repo);
	return await updateItem(x, repo, input);
};

const workClaim: Tool = async (args, ctx, x) => {
	requireInteractiveActor(x, "work_claim");
	const input = parse("work_claim", args);
	const repo = await repoOf(x, ctx.repo);
	const store = createStore(x.sql);
	const row = itemOfRef(x, repo, input.ref as string);
	const ref = workRef(repo.path, row.number);
	const claims = store.claimsOf(row.id);
	const live = liveClaims(claims);
	const me = actingPrincipals(x);

	// A repeated claim by the same principal returns its lane (idempotent).
	const mine = live.find((c) => me.includes(c.principal_id));
	if (mine !== undefined) {
		const lane = await x.caps.lanes.get(mine.lane_id, {
			repo: { id: repo.id },
		});
		await emitWork(x, repo, row, "work.claimed", {
			ref,
			principal: mine.principal_id,
			laneId: mine.lane_id,
			footprint: lane.footprint,
		}, `claimed:${mine.lane_id}`);
		return await claimResult(x, repo, row, lane);
	}
	if (row.state === "done" || row.state === "abandoned") {
		throw conflict(`work item ${ref} is ${row.state}`, { state: row.state });
	}
	if (live.length > 0) {
		throw conflict(`work item ${ref} is already claimed`, {
			claims: live.map((c) => ({
				principal: c.principal_id,
				laneId: c.lane_id,
			})),
		});
	}
	const footprint = (input.footprint as WorkItem["footprint"] | undefined) ??
		workItemOf(x, repo, row).footprint;
	const entity: EntityRef = { kind: "work", id: workEntityId(ref, row.id) };
	// Returns at once: `opening` on the repo backend, `open` on branch.
	const lane = await x.caps.lanes.open({
		repo: { id: repo.id },
		entity,
		owner: x.actor.id,
		footprint,
	});
	const at = x.caps.clock.now();
	store.db.tx(() => {
		store.insertClaim({
			itemId: row.id,
			laneId: lane.id,
			principal: x.actor.id,
			plan: (input.plan as string | undefined) ?? null,
			at,
		});
		if (row.state === "open") store.setItemState(row.id, "claimed", at);
	});
	await emitWork(x, repo, row, "work.claimed", {
		ref,
		principal: x.actor.id,
		laneId: lane.id,
		footprint,
	}, `claimed:${lane.id}`);
	return await claimResult(x, repo, row, lane);
};

/** Puts an item back to `open` when its last live claim ended (and it was only claimed). */
export const reopenIfUnclaimed = (
	store: ReturnType<typeof createStore>,
	itemId: string,
	at: number,
): boolean => {
	const row = store.item(itemId);
	if (row === null || row.state !== "claimed") return false;
	if (liveClaims(store.claimsOf(itemId)).length > 0) return false;
	store.setItemState(itemId, "open", at);
	return true;
};

const workRelease: Tool = async (args, ctx, x) => {
	requireInteractiveActor(x, "work_release");
	const input = parse("work_release", args);
	const repo = await repoOf(x, ctx.repo);
	const store = createStore(x.sql);
	const row = itemOfRef(x, repo, input.ref as string);
	const ref = workRef(repo.path, row.number);
	const me = actingPrincipals(x);
	const mine = liveClaims(store.claimsOf(row.id)).find((c) =>
		me.includes(c.principal_id)
	);
	if (mine === undefined) {
		throw notFound(`you hold no claim on ${ref}`);
	}
	if (mine.state === "submitted") {
		throw conflict(
			`${ref}: your change is submitted; abandon it (changes_abandon) before releasing`,
			{ changeId: mine.change_id },
		);
	}
	const reason = (input.reason as string | undefined) ?? "released";
	const at = x.caps.clock.now();
	store.db.tx(() => {
		store.setClaim(row.id, mine.lane_id, "released", at);
		reopenIfUnclaimed(store, row.id, at);
	});
	await emitWork(x, repo, row, "work.released", {
		ref,
		principal: mine.principal_id,
		laneId: mine.lane_id,
		reason,
	}, `released:${mine.lane_id}`);
	try {
		await x.caps.lanes.close(mine.lane_id, `work released: ${reason}`, {
			repo: { id: repo.id },
		});
	} catch (error) {
		x.log.warn("lane close after release failed", {
			laneId: mine.lane_id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return { ok: true };
};

/** Adds a comment as the caller (also the `comment` action of the item panel). */
export const commentOn = async (
	x: ExtCtx,
	repo: RepoCtx,
	ref: string,
	body: string,
): Promise<{ commentId: string }> => {
	if (x.actor.kind === "ext" || x.actor.kind === "system") {
		throw denied("actor", "comments are written by users and agents");
	}
	const store = createStore(x.sql);
	const row = itemOfRef(x, repo, ref);
	const id = x.caps.ids.ulid();
	store.insertComment({
		id,
		item_id: row.id,
		author_id: x.actor.id,
		body_md: body,
		at: x.caps.clock.now(),
	});
	await emitWork(x, repo, row, "work.commented", {
		ref: workRef(repo.path, row.number),
		commentId: id,
		author: x.actor.id,
	}, `commented:${id}`);
	return { commentId: id };
};

const workComment: Tool = async (args, ctx, x) => {
	const input = parse("work_comment", args);
	const repo = await repoOf(x, ctx.repo);
	return await commentOn(x, repo, input.ref as string, input.body as string);
};

export const TOOLS: Readonly<Record<string, Tool>> = {
	work_list: workList,
	work_get: workGet,
	work_create: workCreate,
	work_update: workUpdate,
	work_claim: workClaim,
	work_release: workRelease,
	work_comment: workComment,
};

export const callTool = (
	name: string,
	args: unknown,
	ctx: ToolContext,
	x: ExtCtx,
): Promise<unknown> => {
	const tool = TOOLS[name];
	if (tool === undefined) {
		return Promise.reject(notFound(`tartan.work has no tool ${name}`));
	}
	return tool(args, ctx, x);
};
