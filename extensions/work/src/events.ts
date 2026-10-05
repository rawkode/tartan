// tartan.work event handlers: a lane that closes or is lost ends its claim; a
// submitted change puts the item in review and contributes the work section to
// the why note; an abandoned change puts it back; a landed change finishes the
// item (⇒ `work.done`).
//
// Handlers are idempotent: every state change is guarded by the current
// state, so a redelivered event changes nothing and emits nothing new (the
// host dedupes the emits of a retried handler by `<inst>:<causedBy>:<type>:<n>`).

import {
	type Envelope,
	type ExtCtx,
	NOTE_SECTION_MAX_BYTES,
	truncateBytes,
} from "@tartan/contract";
import { json } from "@tartan/ext-api";
import { repoOf } from "./repo.ts";
import { type ClaimRow, createStore, type ItemRow, workRef } from "./store.ts";
import { emitWork, reopenIfUnclaimed } from "./tools.ts";

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
	typeof v === "string" && v !== "" ? v : undefined;

type Handler = (ev: Envelope<Data>, x: ExtCtx) => Promise<void>;

const withClaim = (
	x: ExtCtx,
	find: (store: ReturnType<typeof createStore>) => ClaimRow | null,
): {
	store: ReturnType<typeof createStore>;
	claim: ClaimRow;
	item: ItemRow;
} | null => {
	const store = createStore(x.sql);
	const claim = find(store);
	if (claim === null) return null;
	const item = store.item(claim.item_id);
	return item === null ? null : { store, claim, item };
};

/** `lane.closed` / `lane.lost`: the claim on that lane ends. */
const laneEnded = (lost: boolean): Handler => async (ev, x) => {
	const laneId = str(ev.data.laneId);
	if (laneId === undefined) return;
	const found = withClaim(x, (s) => s.claimByLane(laneId));
	if (found === null) return;
	const { store, claim, item } = found;
	if (claim.state !== "active" && claim.state !== "submitted") return;
	const repo = await repoOf(x, ev.repo);
	const reason = lost ? "lease lost" : str(ev.data.reason) ?? "lane closed";
	await emitWork(x, repo, item, "work.released", {
		ref: workRef(repo.path, item.number),
		principal: claim.principal_id,
		laneId,
		reason,
	});
	const at = ev.at;
	store.db.tx(() => {
		store.setClaim(item.id, laneId, lost ? "lease_lost" : "released", at);
		const reopened = reopenIfUnclaimed(store, item.id, at);
		if (!reopened && item.state === "in_review") {
			const live = store.claimsOf(item.id).some((c) =>
				c.state === "active" || c.state === "submitted"
			);
			if (!live) store.setItemState(item.id, "open", at);
		}
	});
};

const NOTE_KEYS = ["ref", "title", "kind", "why", "acceptance", "plan"];

/** The work section of the why note (≤ 8 KB): what the change was for. */
export const noteSection = (
	ref: string,
	item: ItemRow,
	claim: ClaimRow,
): Record<string, unknown> => {
	const full = {
		ref,
		title: item.title,
		kind: item.kind,
		why: item.why,
		acceptance: json.decode<string[]>(item.acceptance_json, []),
		...(claim.plan ? { plan: claim.plan } : {}),
		agent: claim.principal_id,
	};
	if (JSON.stringify(full).length <= NOTE_SECTION_MAX_BYTES) return full;
	const budget = Math.floor(NOTE_SECTION_MAX_BYTES / 4);
	return Object.fromEntries(
		Object.entries(full).map(([k, v]) => [
			k,
			NOTE_KEYS.includes(k) && typeof v === "string"
				? truncateBytes(v, budget)
				: k === "acceptance"
				? (v as string[]).slice(0, 10).map((a) => truncateBytes(a, 200))
				: v,
		]),
	);
};

/** `changes.submitted`: the claim is submitted, the item in review. */
const changeSubmitted: Handler = async (ev, x) => {
	const laneId = str(ev.data.laneId);
	const changeId = str(ev.data.changeId);
	if (laneId === undefined || changeId === undefined) return;
	const found = withClaim(x, (s) => s.claimByLane(laneId));
	if (found === null) return;
	const { store, claim, item } = found;
	const repo = await repoOf(x, ev.repo);
	const ref = workRef(repo.path, item.number);
	if (claim.state === "active") {
		if (item.state === "claimed") {
			await emitWork(x, repo, item, "work.updated", {
				ref,
				state: "in_review",
				changed: ["state"],
			});
		}
		store.db.tx(() => {
			store.setClaim(item.id, laneId, "submitted", ev.at, changeId);
			if (item.state === "claimed") {
				store.setItemState(item.id, "in_review", ev.at);
			}
		});
	}
	// Every revision: the note section is replaced (keyed by change and extension).
	try {
		await x.caps.notes.contribute(
			{ id: repo.id },
			changeId,
			noteSection(ref, item, claim),
		);
	} catch (error) {
		x.log.warn("notes.contribute failed", {
			changeId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

/** `changes.abandoned` / `changes.superseded`: the claim is active again. */
const changeAbandoned: Handler = async (ev, x) => {
	const changeId = str(ev.data.changeId);
	const laneId = str(ev.data.laneId);
	const found = withClaim(
		x,
		(s) =>
			(changeId ? s.claimByChange(changeId) : null) ??
				(laneId ? s.claimByLane(laneId) : null),
	);
	if (found === null) return;
	const { store, claim, item } = found;
	if (claim.state !== "submitted") return;
	const repo = await repoOf(x, ev.repo);
	const backToClaimed = item.state === "in_review" &&
		!store.claimsOf(item.id).some((c) =>
			c.lane_id !== claim.lane_id && c.state === "submitted"
		);
	if (backToClaimed) {
		await emitWork(x, repo, item, "work.updated", {
			ref: workRef(repo.path, item.number),
			state: "claimed",
			changed: ["state"],
		});
	}
	store.db.tx(() => {
		store.setClaim(item.id, claim.lane_id, "active", ev.at);
		if (backToClaimed) store.setItemState(item.id, "claimed", ev.at);
	});
};

/** `changes.landed`: the claim landed and the item is done (⇒ `work.done`). */
const changeLanded: Handler = async (ev, x) => {
	const changeId = str(ev.data.changeId);
	const laneId = str(ev.data.laneId);
	const commit = str(ev.data.commit);
	const found = withClaim(
		x,
		(s) =>
			(changeId ? s.claimByChange(changeId) : null) ??
				(laneId ? s.claimByLane(laneId) : null),
	);
	if (found === null) return;
	const { store, claim, item } = found;
	if (claim.state === "landed" && item.state === "done") return;
	const repo = await repoOf(x, ev.repo);
	if (item.state !== "done") {
		await emitWork(x, repo, item, "work.done", {
			ref: workRef(repo.path, item.number),
			...(changeId ? { changeId } : {}),
			...(commit ? { commit } : {}),
		});
	}
	store.db.tx(() => {
		store.setClaim(item.id, claim.lane_id, "landed", ev.at, changeId);
		if (item.state !== "done") store.setItemState(item.id, "done", ev.at);
		if (commit) store.setLandedCommit(item.id, commit);
	});
};

const HANDLERS: Readonly<Record<string, Handler>> = {
	"lane.closed": laneEnded(false),
	"lane.lost": laneEnded(true),
	"changes.submitted": changeSubmitted,
	"changes.abandoned": changeAbandoned,
	"changes.superseded": changeAbandoned,
	"changes.landed": changeLanded,
};

export const onEvent = async (ev: Envelope, x: ExtCtx): Promise<void> => {
	if (ev.shadow) return;
	await HANDLERS[ev.type]?.(ev as Envelope<Data>, x);
};
