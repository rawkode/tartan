// Types shared by the land module (RepoDO), LandWorkflow and the kernel git
// jobs (WP10). Contract types stay the source of truth (the compose types and
// the facade are in `@tartan/contract/kernel`); what is here is WP10-internal:
// `LandChangeRow` is the `land_changes` design-lag table (schema.ts).

import type { LandBatchState, WhyNote } from "@tartan/contract";
import type {
	ComposedChange,
	ComposePlan,
	ComposeRange,
	RepoLandFacade,
} from "@tartan/contract/kernel.ts";

export type LandChangeOutcome = "pending" | "landed" | "conflicted" | "vetoed";

/** One row of `land_changes`. */
export type LandChangeRow = {
	batch_id: string;
	change_id: string;
	lane_id: string;
	position: number;
	head: string;
	outcome: LandChangeOutcome;
	attempt: number | null;
	commit_sha: string | null;
	paths_json: string | null;
	conflict_json: string | null;
	gates_json: string | null;
	provenance_json: string | null;
};

/** How many lane-range commits the attribution lists per change. */
export const RANGE_LIST_MAX = 500;

/** One change's `ref.advance` gate outcome (`recordGates` decisions). */
export type GatedChange = {
	readonly changeId: string;
	readonly truncated: boolean;
	readonly effective: readonly {
		readonly installation: string;
		readonly ext: string;
		readonly mode: "enforce" | "shadow";
		readonly decision: "allow" | "advise" | "veto";
		readonly message: string;
		readonly basis: "answer" | "default" | "truncated";
	}[];
	readonly blocked: boolean;
};

/** `setBatchState` results the land module understands. */
export type BatchStateResult =
	| { readonly affected: readonly string[] }
	| {
		readonly reason:
			| "tests"
			| "stale"
			| "abandoned"
			| "conflicted"
			| "vetoed"
			| "error"
			| "trunk-unexplained"
			| "config-hold";
		readonly failing?: readonly string[];
		readonly message?: string;
	};

export type LandFacade = RepoLandFacade;

export type {
	ComposedChange,
	ComposePlan,
	ComposeRange,
	LandBatchState,
	WhyNote,
};
