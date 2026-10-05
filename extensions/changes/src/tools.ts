// `changes@1` tools of tartan.changes: open (a draft for a lane, or
// `lanes.adopt` of a human branch: users only, K16), submit (revision `head`
// and `base` from the lane range, K17: the push the agent just made is always
// the one submitted; refused for a quarantined, opening or landing lane and for
// a lane its owner has not pushed, `empty-lane`), get, list, abandon and
// comment.

import {
	CHANGES_TOOLS,
	conflict,
	denied,
	type ExtCtx,
	invalid,
	type Lane,
	NOTE_SECTION_MAX_BYTES,
	notFound,
	TartanError,
	type ToolContext,
	truncateBytes,
	WORK_REF_RE,
} from "@tartan/contract";
import { actingPrincipals } from "@tartan/ext-api";
import {
	affectedOf,
	changeDto,
	changeOf,
	diffstatOf,
	emitChange,
	type RepoCtx,
	repoOf,
	requireSameRepo,
} from "./core.ts";
import {
	changeIdForLane,
	type ChangeRow,
	createStore,
	FINAL,
	REVISABLE,
} from "./store.ts";

type Tool = (args: unknown, ctx: ToolContext, x: ExtCtx) => Promise<unknown>;

const parse = <N extends keyof typeof CHANGES_TOOLS>(
	name: N,
	args: unknown,
) => {
	const r = CHANGES_TOOLS[name].input.safeParse(args);
	if (!r.success) {
		throw invalid(
			`${name}: ${r.error.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return r.data as Record<string, unknown>;
};

const refused = (reason: string, text: string, laneId: string) =>
	new TartanError("conflict", text, { reason, details: { laneId } });

/** The owner or a delegate of the lane (or the user an agent owner acts for). */
const requireLaneHolder = (x: ExtCtx, lane: Lane, what: string): void => {
	const me = actingPrincipals(x);
	const holders = [
		lane.owner,
		...(lane.onBehalfOf ? [lane.onBehalfOf] : []),
		...lane.delegates,
	];
	if (!holders.some((h) => me.includes(h))) {
		throw denied("lane-op", `${what}: only the lane's owner or a delegate`);
	}
};

const workRefOfLane = (lane: Lane): string | undefined =>
	lane.entity?.kind === "work" && WORK_REF_RE.test(lane.entity.id)
		? lane.entity.id
		: undefined;

/** Inserts the draft of a lane if it has none and announces it (`changes.opened`). */
export const ensureDraft = async (
	x: ExtCtx,
	repo: RepoCtx,
	draft: {
		readonly laneId: string;
		readonly owner: string;
		readonly onBehalfOf?: string;
		readonly workRef?: string;
		readonly sourceRef?: string;
		readonly title?: string;
		readonly at: number;
	},
): Promise<ChangeRow> => {
	const store = createStore(x.sql);
	const existing = store.changeByLane(draft.laneId);
	if (existing !== null) return existing;
	const changeId = await changeIdForLane(draft.laneId);
	const title = draft.title ??
		(draft.workRef
			? `Work ${draft.workRef}`
			: draft.sourceRef
			? draft.sourceRef.replace(/^refs\/heads\//, "")
			: `Lane ${draft.laneId}`);
	await emitChange(
		x,
		repo,
		{
			change_id: changeId,
			work_ref: draft.workRef ?? null,
		},
		"changes.opened",
		{
			changeId,
			laneId: draft.laneId,
			...(draft.workRef ? { workRef: draft.workRef } : {}),
			...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
			title: title.slice(0, 200),
		},
		`opened:${changeId}`,
	);
	store.insertChange({
		changeId,
		laneId: draft.laneId,
		...(draft.workRef ? { workRef: draft.workRef } : {}),
		...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),

		title: title.slice(0, 200),
		author: draft.owner,
		...(draft.onBehalfOf ? { onBehalfOf: draft.onBehalfOf } : {}),
		at: draft.at,
	});
	store.note({
		id: `${changeId}:opened`,
		change_id: changeId,
		at: draft.at,
		kind: "opened",
		text: draft.sourceRef
			? `opened from ${draft.sourceRef}`
			: `draft opened for lane ${draft.laneId}`,
		actor: draft.owner,
		revision: null,
	});
	return store.change(changeId)!;
};

/** The changes section of the why note (≤ 8 KB). */
export const noteSection = (
	row: ChangeRow,
	revision: { n: number; head: string; base: string; affected: string[] },
	why?: string,
): Record<string, unknown> => {
	const section = {
		change: row.change_id,
		title: row.title,
		summary: truncateBytes(row.summary_md ?? "", 4096),
		...(why ? { why: truncateBytes(why, 2048) } : {}),
		revision: revision.n,
		head: revision.head,
		base: revision.base,
		affected: revision.affected.slice(0, 50),
		...(row.work_ref ? { work: row.work_ref } : {}),
	};
	return JSON.stringify(section).length <= NOTE_SECTION_MAX_BYTES
		? section
		: { ...section, summary: truncateBytes(section.summary, 1024) };
};

const contributeNote = async (
	x: ExtCtx,
	repo: RepoCtx,
	row: ChangeRow,
	revision: { n: number; head: string; base: string; affected: string[] },
	why?: string,
): Promise<void> => {
	try {
		await x.caps.notes.contribute(
			{ id: repo.id },
			row.change_id,
			noteSection(row, revision, why),
		);
	} catch (error) {
		x.log.warn("notes.contribute failed", {
			changeId: row.change_id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

/** `changes_submit`. */
export const submitLane = async (
	x: ExtCtx,
	repo: RepoCtx,
	input: {
		readonly laneId: string;
		readonly title: string;
		readonly summary: string;
		readonly why?: string;
	},
): Promise<{ changeId: string; revision: number }> => {
	const laneId = input.laneId;
	const lane = await x.caps.lanes.get(laneId, { repo: { id: repo.id } });
	requireLaneHolder(x, lane, "changes_submit");
	if (lane.quarantined) {
		throw refused(
			"lane-quarantined",
			"the lane is quarantined (an unexplained head change); an Owner must acknowledge it first",
			laneId,
		);
	}
	if (lane.state === "opening") {
		throw refused(
			"lane-opening",
			"the lane is still opening; push to it once it is open",
			laneId,
		);
	}
	if (lane.state === "landing") {
		throw refused("lane-landing", "the lane is landing", laneId);
	}
	if (lane.state !== "open" && lane.state !== "submitted") {
		throw refused("lane-state", `the lane is ${lane.state}`, laneId);
	}
	if (lane.pushes === 0 || lane.head === undefined || lane.head === lane.base) {
		throw refused(
			"empty-lane",
			"nothing to submit: push your work to the lane first",
			laneId,
		);
	}
	// Runs or awaits phase 2 of the latest push: head and its range base match.
	const range = await x.caps.repo.laneRange(laneId, { repo: { id: repo.id } });
	if (range.head === range.rangeBase) {
		throw refused(
			"empty-lane",
			"the lane has no commits beyond trunk",
			laneId,
		);
	}
	const store = createStore(x.sql);
	const at = x.caps.clock.now();
	const draft = await ensureDraft(x, repo, {
		laneId,
		owner: lane.owner,
		...(lane.onBehalfOf ? { onBehalfOf: lane.onBehalfOf } : {}),
		...(workRefOfLane(lane) ? { workRef: workRefOfLane(lane) } : {}),
		...(lane.kind === "adopted" ? { sourceRef: lane.ref } : {}),
		at,
	});
	if (draft.state === "landing" || FINAL.includes(draft.state)) {
		if (draft.state !== "abandoned") {
			throw conflict(`change ${draft.change_id} is ${draft.state}`, {
				changeId: draft.change_id,
				state: draft.state,
			});
		}
	}
	const latest = store.latest(draft.change_id);
	if (
		latest !== null && latest.head === range.head &&
		REVISABLE.includes(draft.state)
	) {
		// Already submitted at this head: the same answer (idempotent).
		store.setText(draft.change_id, input.title, input.summary, at);
		return { changeId: draft.change_id, revision: latest.n };
	}
	const n = (latest?.n ?? 0) + 1;
	const affected = await affectedOf(
		x,
		repo,
		laneId,
		range.rangeBase,
		range.head,
	);
	const diffstat = await diffstatOf(
		x,
		repo,
		laneId,
		range.rangeBase,
		range.head,
	);
	// The event first, then the store (as `push.diffed` does): the store
	// says `submitted` only once `changes.submitted` is in the log, so the
	// idempotent answer above never hides a lost emit. A retry after a failed
	// emit recomputes the same revision and idempotency key (the kernel
	// dedupes it).
	await emitChange(x, repo, draft, "changes.submitted", {
		changeId: draft.change_id,
		laneId,
		revision: n,
		head: range.head,
		base: range.rangeBase,
		affected,
		...(draft.work_ref ? { workRef: draft.work_ref } : {}),
	}, `submitted:${draft.change_id}:${n}`);
	store.db.tx(() => {
		store.insertRevision({
			changeId: draft.change_id,
			n,
			head: range.head,
			base: range.rangeBase,
			affected,
			diffstat,
			at,
		});
		store.setText(draft.change_id, input.title, input.summary, at);
		store.setState(draft.change_id, "submitted", at);
		store.note({
			id: `${draft.change_id}:rev:${n}`,
			change_id: draft.change_id,
			at,
			kind: "submitted",
			text: `revision ${n} submitted at ${range.head.slice(0, 12)}`,
			actor: x.actor.id,
			revision: n,
		});
	});
	const row = store.change(draft.change_id)!;
	await contributeNote(x, repo, row, {
		n,
		head: range.head,
		base: range.rangeBase,
		affected,
	}, input.why);
	return { changeId: row.change_id, revision: n };
};

const changesSubmit: Tool = async (args, ctx, x) => {
	const input = parse("changes_submit", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string | undefined);
	return await submitLane(x, repo, {
		laneId: input.laneId as string,
		title: input.title as string,
		summary: input.summary as string,
		...(input.why ? { why: input.why as string } : {}),
	});
};

const changesOpen: Tool = async (args, ctx, x) => {
	const input = parse("changes_open", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string);
	const laneId = input.laneId as string | undefined;
	const sourceRef = input.sourceRef as string | undefined;
	if ((laneId === undefined) === (sourceRef === undefined)) {
		throw invalid("changes_open takes either laneId or sourceRef");
	}
	const at = x.caps.clock.now();
	const title = input.title as string | undefined;
	const workRef = input.workRef as string | undefined;
	if (laneId !== undefined) {
		const lane = await x.caps.lanes.get(laneId, { repo: { id: repo.id } });
		requireLaneHolder(x, lane, "changes_open");
		if (lane.state === "opening") {
			throw refused("lane-opening", "the lane is still opening", laneId);
		}
		const row = await ensureDraft(x, repo, {
			laneId,
			owner: lane.owner,
			...(lane.onBehalfOf ? { onBehalfOf: lane.onBehalfOf } : {}),
			...(workRef ?? workRefOfLane(lane)
				? { workRef: workRef ?? workRefOfLane(lane) }
				: {}),
			...(title ? { title } : {}),
			at,
		});
		return changeDto(x, repo, row);
	}
	// K16: only a human adopts a branch (who last pushed it, or a Maintainer+;
	// RepoDO enforces that). An agent works in lanes it claims.
	if (x.actor.kind !== "user") {
		throw denied(
			"lane-op",
			"changes_open {sourceRef} adopts a human branch: users only (K16); agents claim work for a lane",
		);
	}
	const ref = sourceRef!.startsWith("refs/")
		? sourceRef!
		: `refs/heads/${sourceRef}`;
	const lane = await x.caps.lanes.adopt({
		repo: { id: repo.id },
		ref,
		owner: x.actor.id,
		...(workRef ? { entity: { kind: "work", id: workRef } } : {}),
	});
	const row = await ensureDraft(x, repo, {
		laneId: lane.id,
		owner: lane.owner,
		sourceRef: ref,
		...(workRef ? { workRef } : {}),
		...(title ? { title } : {}),
		at,
	});
	return changeDto(x, repo, row);
};

const changesGet: Tool = async (args, ctx, x) => {
	const input = parse("changes_get", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string | undefined);
	return changeDto(x, repo, changeOf(x, input.changeId as string));
};

const LIST_DEFAULT = 50;

const changesList: Tool = async (args, ctx, x) => {
	const input = parse("changes_list", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string);
	const limit = (input.limit as number | undefined) ?? LIST_DEFAULT;
	const offset = input.cursor === undefined ? 0 : Number(input.cursor);
	if (!Number.isInteger(offset) || offset < 0) throw invalid("bad cursor");
	const rows = createStore(x.sql).changes({
		...(input.state ? { state: input.state as ChangeRow["state"] } : {}),
		...(input.mine ? { authors: actingPrincipals(x) } : {}),
		offset,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	return {
		changes: page.map((r) => changeDto(x, repo, r)),
		...(rows.length > limit ? { cursor: String(offset + limit) } : {}),
	};
};

/** Abandons a change (its author, or a Maintainer+). */
export const abandonChange = async (
	x: ExtCtx,
	repo: RepoCtx,
	changeId: string,
	reason: string | undefined,
): Promise<void> => {
	const store = createStore(x.sql);
	const row = changeOf(x, changeId);
	const me = actingPrincipals(x);
	const isAuthor = me.includes(row.author_id) ||
		(row.on_behalf_of !== null && me.includes(row.on_behalf_of));
	if (
		!isAuthor &&
		!(await x.caps.authz.check(x.actor.id, { id: repo.id }, "approve"))
	) {
		throw denied("role", "only the author or a Maintainer abandons a change");
	}
	if (row.state === "abandoned") return;
	if (row.state === "landing" || FINAL.includes(row.state)) {
		throw conflict(`change ${changeId} is ${row.state}`, { state: row.state });
	}
	const at = x.caps.clock.now();
	await emitChange(x, repo, row, "changes.abandoned", {
		changeId,
		laneId: row.lane_id,
		...(reason ? { reason } : {}),
	}, `abandoned:${changeId}:${x.caps.ids.ulid()}`);
	store.db.tx(() => {
		store.setState(changeId, "abandoned", at);
		store.note({
			id: `${changeId}:abandoned:${at}`,
			change_id: changeId,
			at,
			kind: "abandoned",
			text: reason ? `abandoned: ${reason}` : "abandoned",
			actor: x.actor.id,
			revision: null,
		});
	});
};

const changesAbandon: Tool = async (args, ctx, x) => {
	const input = parse("changes_abandon", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string | undefined);
	await abandonChange(
		x,
		repo,
		input.changeId as string,
		input.reason as string | undefined,
	);
	return { ok: true };
};

/** A comment on a change, optionally on a line of a revision. */
export const commentOn = async (
	x: ExtCtx,
	repo: RepoCtx,
	input: {
		readonly changeId: string;
		readonly body: string;
		readonly revision?: number;
		readonly path?: string;
		readonly line?: number;
		readonly side?: "base" | "head";
	},
): Promise<{ commentId: string }> => {
	if (x.actor.kind === "ext" || x.actor.kind === "system") {
		throw denied("actor", "comments are written by users and agents");
	}
	const store = createStore(x.sql);
	const row = changeOf(x, input.changeId);
	const latest = store.latest(row.change_id);
	const n = input.revision ?? latest?.n ?? 1;
	if (latest !== null && n > latest.n) {
		throw notFound(`revision ${n} of ${row.change_id}`);
	}
	if (input.line !== undefined && input.path === undefined) {
		throw invalid("a line comment needs a path");
	}
	const id = x.caps.ids.ulid();
	store.insertComment({
		id,
		change_id: row.change_id,
		n,
		path: input.path ?? null,
		line: input.line ?? null,
		side: input.path ? input.side ?? "head" : null,
		body_md: input.body,
		author_id: x.actor.id,
		at: x.caps.clock.now(),
	});
	await emitChange(x, repo, row, "changes.commented", {
		changeId: row.change_id,
		commentId: id,
		revision: n,
		...(input.path ? { path: input.path } : {}),
		...(input.line !== undefined ? { line: input.line } : {}),
	}, `commented:${id}`);
	return { commentId: id };
};

const changesComment: Tool = async (args, ctx, x) => {
	const input = parse("changes_comment", args);
	const repo = await repoOf(x, ctx.repo);
	requireSameRepo(repo, input.repo as string | undefined);
	return await commentOn(x, repo, {
		changeId: input.changeId as string,
		body: input.body as string,
		...(input.revision ? { revision: input.revision as number } : {}),
		...(input.path ? { path: input.path as string } : {}),
		...(input.line ? { line: input.line as number } : {}),
		...(input.side ? { side: input.side as "base" | "head" } : {}),
	});
};

export const TOOLS: Readonly<Record<string, Tool>> = {
	changes_open: changesOpen,
	changes_submit: changesSubmit,
	changes_get: changesGet,
	changes_list: changesList,
	changes_abandon: changesAbandon,
	changes_comment: changesComment,
};

export const callTool = (
	name: string,
	args: unknown,
	ctx: ToolContext,
	x: ExtCtx,
): Promise<unknown> => {
	const tool = TOOLS[name];
	if (tool === undefined) {
		return Promise.reject(notFound(`tartan.changes has no tool ${name}`));
	}
	return tool(args, ctx, x);
};
