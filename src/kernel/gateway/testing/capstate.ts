// Test-only (Deno and workerd): RepoDO's capability state as the contract
// describes it (`RepoCoreFacade.capUse`/`capReport`, WP5b's
// semantics), in memory, with a call spy, plus helpers to
// sign capability paths with a real HMAC key (WP2's `capMacOf`).

import {
	type CapFields,
	capPath,
	laneId as laneIdOf,
	ulid,
} from "@tartan/contract";
import type {
	CapContext,
	CapMac,
	CapReport,
	CapUse,
} from "@tartan/contract/kernel.ts";
import { CAP_INFO_USES_MAX } from "../../../constants.ts";
import { capMacOf } from "../../http/capmac.ts";
import type { CapRepo } from "../cap.ts";

export type CapLane = {
	readonly repoId: string;
	readonly laneId: string;
	state: "opening" | "open" | "closed";
	mode: "repo" | "branch";
	seed: "import";
	nonce: string | null;
	attempt: number;
	base: string;
	defaultBranch: string;
	pinBase: boolean;
	explainedTips: string[];
	infoUses: number;
	consumed: boolean;
};

export type CapStateCall = {
	readonly repoId: string;
	readonly method: "capUse" | "capReport";
	readonly laneId: string;
	readonly op?: string;
};

export type CapState = {
	readonly lanes: Map<string, CapLane>;
	readonly calls: CapStateCall[];
	readonly reports: { laneId: string; nonce: string; report: CapReport }[];
	/** How many times the route asked for a RepoDO port (each would be a DO stub + RPC). */
	repoPorts: number;
	/** `CapDeps.repo`. */
	repo(repoId: string): CapRepo;
	/** Adds an `opening` lane on attempt 1 with a fresh nonce. */
	addLane(
		repoId: string,
		base: string,
		over?: Partial<CapLane>,
	): CapLane;
};

export const createCapState = (): CapState => {
	const state: CapState = {
		lanes: new Map(),
		calls: [],
		reports: [],
		repoPorts: 0,
		repo: (repoId) => {
			state.repoPorts++;
			return {
				capUse: (laneId, nonce, op): Promise<CapUse> => {
					state.calls.push({ repoId, method: "capUse", laneId, op });
					const lane = state.lanes.get(laneId);
					if (lane === undefined || lane.repoId !== repoId) {
						return Promise.resolve({ ok: false, reason: "unknown" });
					}
					if (
						lane.state !== "opening" || lane.mode !== "repo" ||
						lane.seed !== "import"
					) {
						return Promise.resolve({ ok: false, reason: "not-opening" });
					}
					if (lane.nonce === null || lane.nonce !== nonce) {
						return Promise.resolve({ ok: false, reason: "unknown" });
					}
					if (lane.consumed) {
						return Promise.resolve({ ok: false, reason: "consumed" });
					}
					if (op === "info") {
						if (lane.infoUses >= CAP_INFO_USES_MAX) {
							return Promise.resolve({ ok: false, reason: "uses-exceeded" });
						}
						lane.infoUses++;
					} else lane.consumed = true;
					const ctx: CapContext = {
						repoId,
						laneId,
						nonce,
						attempt: lane.attempt,
						base: lane.base,
						defaultBranch: lane.defaultBranch,
						pinBase: lane.pinBase,
						explainedTips: [...lane.explainedTips],
					};
					return Promise.resolve({ ok: true, ctx });
				},
				capReport: (laneId, nonce, report) => {
					state.calls.push({ repoId, method: "capReport", laneId });
					state.reports.push({ laneId, nonce, report });
					return Promise.resolve();
				},
			};
		},
		addLane: (repoId, base, over = {}) => {
			const lane: CapLane = {
				repoId,
				laneId: laneIdOf(ulid()),
				state: "opening",
				mode: "repo",
				seed: "import",
				nonce: randomNonce(),
				attempt: 1,
				base,
				defaultBranch: "main",
				pinBase: false,
				explainedTips: [],
				infoUses: 0,
				consumed: false,
				...over,
			};
			state.lanes.set(lane.laneId, lane);
			return lane;
		},
	};
	return state;
};

export const randomNonce = (): string =>
	[...crypto.getRandomValues(new Uint8Array(16))].map((b) =>
		b.toString(16).padStart(2, "0")
	).join("");

/** A real HMAC-SHA256 `CapMac` over a fresh non-extractable key (as WP2's keyring holds it). */
export const testCapMac = async (): Promise<CapMac> => {
	const key = await crypto.subtle.importKey(
		"raw",
		crypto.getRandomValues(new Uint8Array(32)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return capMacOf(() => Promise.resolve(key));
};

/** The signed capability path of `lane` (`/-/cap/v1/…/<repoId>.git`). */
export const signedCapPath = async (
	mac: CapMac,
	lane: Pick<CapLane, "repoId" | "laneId" | "nonce">,
	exp: number,
): Promise<string> => {
	const fields: CapFields = {
		exp,
		laneId: lane.laneId,
		nonce: lane.nonce as string,
		repoId: lane.repoId,
	};
	return capPath({ ...fields, mac: await mac.sign(fields) });
};
