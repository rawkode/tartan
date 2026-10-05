// The `lane.open` gates: WP7b's dispatcher
// runs every gate in force (300 ms each, default allow) before the open
// transaction; RepoDO core records each decision as `gate.decided` in that
// transaction and refuses the lane on an enforce veto.
//
// Until WP7b merges, its dispatcher stub answers `not_implemented`; that one
// answer means "no gates in force" (no installation can exist without
// WP7b). Any other dispatcher failure fails closed (`unavailable`).

import {
	type EffectiveGateDecision,
	fromRpcError,
	type LaneOpenGateInput,
	SYS_KERNEL,
	truncateChars,
	unavailable,
} from "@tartan/contract";
import type { DispatchAt } from "@tartan/contract/kernel.ts";
import { type Core, emit, errorText } from "../core.ts";

/** Overall bound on one dispatch (each gate has its own 300 ms). */
export const LANE_OPEN_GATES_BUDGET_MS = 1_500;

export type LaneOpenGates = {
	readonly effective: readonly EffectiveGateDecision[];
	readonly blocked: boolean;
};

const NO_GATES: LaneOpenGates = { effective: [], blocked: false };

export const runLaneOpenGates = async (
	core: Core,
	input: LaneOpenGateInput,
	at: DispatchAt,
): Promise<LaneOpenGates> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), LANE_OPEN_GATES_BUDGET_MS);
	});
	try {
		const result = await Promise.race([
			core.ports.dispatch.gates("lane.open", input, at),
			budget,
		]);
		if (result === "timeout") {
			throw unavailable("lane.open gates did not answer in time");
		}
		return { effective: result.effective, blocked: result.blocked };
	} catch (error) {
		const e = fromRpcError(error);
		if (e.code === "not_implemented") return NO_GATES;
		// The post-claim self-test's scratch repo (a lane the kernel owns) is
		// not a node of the tree, so nothing can be installed on it. Every
		// other lane stays fail-closed.
		if (e.code === "not_found" && input.owner === SYS_KERNEL) return NO_GATES;
		core.ports.log("lane.open gates failed", { error: errorText(error) });
		throw e.code === "unavailable" ? e : unavailable("lane.open gates failed");
	} finally {
		clearTimeout(timer);
	}
};

/** `gate.decided` for each decision, inside the caller's transaction. */
export const recordLaneOpenGates = (
	core: Core,
	gates: LaneOpenGates,
	laneId: string,
): void => {
	for (const decision of gates.effective) {
		emit(core, {
			type: "gate.decided",
			subject: { kind: "lane", id: laneId },
			data: {
				point: "lane.open",
				inst: decision.installation,
				ext: decision.ext,
				decision: decision.decision,
				mode: decision.mode,
				message: truncateChars(decision.message, 2000),
				basis: decision.basis,
			},
		});
	}
};
