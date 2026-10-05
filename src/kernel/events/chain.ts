// The per-repo event hash chain (K3; WP6).
//
// `hash = sha256(prev_hash ‖ "\n" ‖ canonical(row))`, computed synchronously
// inside the append's `transactionSync` with `node:crypto` (`createHash`
// is synchronous in workerd, so `packages/sha256` is not
// needed). `canonical(row)` is a JSON array of the hashed columns in a fixed
// order; `pinned` (set later by K4) and the chain columns themselves are not
// hashed.
//
// Pruning keeps the chain verifiable: a pruned row leaves a
// skeleton `(seq, prev_hash, hash)`, and a skeleton block is dropped only when
// its whole checkpoint block (`EVENT_CHECKPOINT_EVERY` events, ending at a
// checkpoint) is gone and holds no pinned event. A dropped block is a gap
// whose two ends are checkpoints, so the first item after it must link to the
// checkpoint at the gap's end.

import { createHash } from "node:crypto";
import type { Sha256Sync } from "@tartan/contract/kernel.ts";
import { EVENT_CHECKPOINT_EVERY } from "@tartan/contract/kernel.ts";

export const sha256Hex: Sha256Sync = (data) =>
	createHash("sha256").update(data).digest("hex");

/** The hashed columns, in hash order. */
export type HashedEventFields = {
	readonly seq: number;
	readonly id: string;
	readonly idem_key: string;
	readonly type: string;
	readonly v: number;
	readonly source: string;
	readonly source_ext: string | null;
	readonly shadow: 0 | 1;
	readonly sim: 0 | 1;
	readonly actor_kind: string;
	readonly actor_id: string;
	readonly on_behalf_of: string | null;
	readonly subject_kind: string | null;
	readonly subject_id: string | null;
	readonly caused_by: string | null;
	readonly correlation: string | null;
	readonly depth: number;
	readonly node: string;
	readonly repo: string | null;
	readonly data_json: string;
	readonly at: number;
};

export const CHAIN_FIELDS = [
	"seq",
	"id",
	"idem_key",
	"type",
	"v",
	"source",
	"source_ext",
	"shadow",
	"sim",
	"actor_kind",
	"actor_id",
	"on_behalf_of",
	"subject_kind",
	"subject_id",
	"caused_by",
	"correlation",
	"depth",
	"node",
	"repo",
	"data_json",
	"at",
] as const satisfies readonly (keyof HashedEventFields)[];

/** The canonical serialization the chain hashes. */
export const canonicalEventRow = (row: HashedEventFields): string =>
	JSON.stringify(CHAIN_FIELDS.map((field) => row[field] ?? null));

export const chainHash = (
	prevHash: string,
	row: HashedEventFields,
	sha256: Sha256Sync = sha256Hex,
): string => sha256(`${prevHash}\n${canonicalEventRow(row)}`);

export const isCheckpointSeq = (seq: number): boolean =>
	seq > 0 && seq % EVENT_CHECKPOINT_EVERY === 0;

/** Checkpoint block of a seq: block k holds seqs k·N+1 … (k+1)·N. */
export const blockOf = (seq: number): number =>
	Math.floor((seq - 1) / EVENT_CHECKPOINT_EVERY);

/** One position of the chain as verification sees it. */
export type ChainItem =
	| {
		readonly kind: "row";
		readonly seq: number;
		readonly prevHash: string;
		readonly hash: string;
		readonly row: HashedEventFields;
	}
	| {
		/** A pruned row: its links remain, its content is gone. */
		readonly kind: "skeleton";
		readonly seq: number;
		readonly prevHash: string;
		readonly hash: string;
	};

export type ChainVerdict = { ok: boolean; brokenAt?: number };

export type ChainVerifier = {
	/** Feed items in ascending seq order; stops at the first break. */
	push(item: ChainItem): boolean;
	result(): ChainVerdict;
};

/**
 * Incremental verifier over `[from, …]`. `anchor` is the hash at `from - 1`
 * (genesis for `from = 1`), or null when that position is unknown (the first
 * item's link is then not checked). `checkpoint(seq)` returns the stored
 * checkpoint hash or null.
 */
export const createChainVerifier = (input: {
	readonly from: number;
	readonly anchor: string | null;
	readonly checkpoint: (seq: number) => string | null;
	readonly sha256?: Sha256Sync;
}): ChainVerifier => {
	const sha256 = input.sha256 ?? sha256Hex;
	let lastSeq = input.from - 1;
	let expectedPrev = input.anchor;
	let brokenAt: number | undefined;

	const push = (item: ChainItem): boolean => {
		if (brokenAt !== undefined) return false;
		const fail = (): boolean => {
			brokenAt = item.seq;
			return false;
		};
		if (item.seq <= lastSeq) return fail();
		if (item.seq !== lastSeq + 1) {
			// A gap: only whole checkpoint blocks are ever dropped.
			const gapEnd = item.seq - 1;
			const aligned = lastSeq % EVENT_CHECKPOINT_EVERY === 0 &&
				isCheckpointSeq(gapEnd);
			const anchor = aligned ? input.checkpoint(gapEnd) : null;
			if (anchor === null) return fail();
			expectedPrev = anchor;
		}
		if (expectedPrev !== null && item.prevHash !== expectedPrev) return fail();
		if (
			item.kind === "row" &&
			chainHash(item.prevHash, item.row, sha256) !== item.hash
		) {
			return fail();
		}
		if (isCheckpointSeq(item.seq)) {
			const stored = input.checkpoint(item.seq);
			if (stored !== null && stored !== item.hash) return fail();
		}
		expectedPrev = item.hash;
		lastSeq = item.seq;
		return true;
	};

	return {
		push,
		result: () =>
			brokenAt === undefined ? { ok: true } : { ok: false, brokenAt },
	};
};
