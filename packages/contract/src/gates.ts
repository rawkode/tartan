// Gates and echo hooks (K8, K9).
//
// Inputs are prefetched by the host (no async imports needed). Gate outputs
// and echo lines come from extension code and are validated here before the
// kernel uses them.

import { z } from "zod";
import type { Actor, EntityRef, Footprint, InstallMode } from "./common.ts";
import type { AddedLine } from "./git.ts";
import type { LaneBackendName } from "./lanes.ts";
import { stripControl, truncateChars } from "./text.ts";

export const GATE_POINT_VALUES = ["ref.advance", "lane.open", "push"] as const;
export type GatePoint = typeof GATE_POINT_VALUES[number];

/** Per-point defaults: timeout, decision on timeout, `onTruncated`. */
export const GATE_DEFAULTS: Readonly<
	Record<GatePoint, {
		readonly timeoutMs: number;
		readonly onTimeout: "allow" | "veto";
		readonly onTruncated: "allow" | "veto";
	}>
> = {
	"ref.advance": { timeoutMs: 1500, onTimeout: "allow", onTruncated: "veto" },
	"lane.open": { timeoutMs: 300, onTimeout: "allow", onTruncated: "allow" },
	"push": { timeoutMs: 300, onTimeout: "allow", onTruncated: "allow" },
};

/** Prefetch caps for `ref.advance` inputs. */
export const GATE_INPUT_LIMITS = {
	addedLines: 2000,
	addedBytes: 256 * 1024,
} as const;

export type RefAdvanceGateInput = {
	readonly point: "ref.advance";
	readonly repo: string;
	readonly ref: string;
	readonly base: string;
	/** The commit that would advance `ref` (LandWorkflow: the composed squash commit). */
	readonly head: string;
	/**
	 * The lane head the change was composed from, the head approvals bind to
	 * (K4). LandWorkflow sets it; a gate that checks an approval reads it,
	 * and falls back to `head` when it is absent.
	 */
	readonly laneHead?: string;
	readonly changeId: string;
	readonly changedPaths: readonly string[];
	readonly addedLines: readonly AddedLine[];
	readonly truncated: boolean;
	readonly workRefs: readonly string[];
	readonly actor: Actor;
	readonly review?: {
		readonly route: "auto" | "human";
		readonly decision?: "approve" | "request_changes";
		readonly decidedBy?: Actor;
		readonly risk?: number;
	};
	/** True for lane archiving (advisory) and gate replays. */
	readonly advisory?: boolean;
};

export type LaneOpenGateInput = {
	readonly point: "lane.open";
	readonly repo: string;
	/** The backend the kernel will try for this lane. */
	readonly mode: LaneBackendName;
	readonly owner: string;
	readonly entity?: EntityRef;
	readonly footprint: Footprint;
	readonly openLanesByOwner: number;
	readonly truncated: false;
};

export type PushGateInput = {
	readonly point: "push";
	readonly repo: string;
	/** `"repo"` (the canonical repo) or a lane id (a lane remote, or a `branch`-lane ref). */
	readonly target: "repo" | string;
	readonly commands: readonly {
		readonly ref: string;
		readonly old: string;
		readonly new: string;
	}[];
	readonly actor: Actor;
	readonly truncated: false;
};

export type GateInput = RefAdvanceGateInput | LaneOpenGateInput | PushGateInput;

export const GateDecisionSchema = z.strictObject({
	decision: z.enum(["allow", "advise", "veto"]),
	message: z.string().max(2000),
	annotations: z.array(z.strictObject({
		path: z.string().max(4096),
		line: z.number().int().min(0),
		text: z.string().max(500),
	})).max(200).optional(),
	/** The gate declares it scanned the full change even though the input was truncated. */
	fullScan: z.boolean().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export type GateCall = {
	readonly installation: string;
	readonly ext: string;
	readonly mode: InstallMode;
	readonly onTruncated: "allow" | "veto";
	readonly default: "allow" | "veto";
	/** The extension's answer, or `timeout`/`error` when it failed. */
	readonly outcome:
		| { readonly kind: "decision"; readonly decision: GateDecision }
		| { readonly kind: "timeout" }
		| { readonly kind: "error"; readonly message: string };
};

export type EffectiveGateDecision = {
	readonly installation: string;
	readonly ext: string;
	readonly mode: InstallMode;
	readonly decision: "allow" | "advise" | "veto";
	readonly message: string;
	/** Why the kernel overrode or defaulted the decision. */
	readonly basis: "answer" | "default" | "truncated";
};

const stricter = (
	a: "allow" | "veto",
	b: "allow" | "veto",
): "allow" | "veto" => (a === "veto" || b === "veto" ? "veto" : "allow");

/**
 * One gate's effective decision (K8):
 * - a truncated input applies `onTruncated` unless the gate itself answered
 *   `fullScan: true`; a gate that timed out or failed declared nothing, so it
 *   gets the stricter of its `default` and `onTruncated` (veto wins);
 * - otherwise a timeout or error uses the declared `default`.
 * `basis` says whether the decision is the extension's answer or a kernel
 * default; K4 counts only `basis: "answer"` as a passing human-review gate.
 */
export const effectiveGateDecision = (
	call: GateCall,
	truncated: boolean,
): EffectiveGateDecision => {
	const base = {
		installation: call.installation,
		ext: call.ext,
		mode: call.mode,
	};
	const outcome = call.outcome;
	if (outcome.kind !== "decision") {
		const failure = outcome.kind === "timeout"
			? "gate timed out"
			: `gate failed: ${outcome.message}`;
		if (truncated) {
			return {
				...base,
				decision: stricter(call.default, call.onTruncated),
				message: `${failure}; input truncated (onTruncated)`,
				basis: "truncated",
			};
		}
		return {
			...base,
			decision: call.default,
			message: failure,
			basis: "default",
		};
	}
	const d = outcome.decision;
	if (truncated && d.fullScan !== true && call.onTruncated === "veto") {
		return {
			...base,
			decision: "veto",
			message: "input truncated; gate vetoes by default (onTruncated)",
			basis: "truncated",
		};
	}
	return { ...base, decision: d.decision, message: d.message, basis: "answer" };
};

/** K8/K9 aggregation: any enforce veto blocks; shadow decisions never block. */
export const aggregateGates = (
	decisions: readonly EffectiveGateDecision[],
): {
	readonly blocked: boolean;
	readonly vetoes: readonly EffectiveGateDecision[];
} => {
	const vetoes = decisions.filter((d) =>
		d.mode === "enforce" && d.decision === "veto"
	);
	return { blocked: vetoes.length > 0, vetoes };
};

// ---------------------------------------------------------------------------
// Echo
// ---------------------------------------------------------------------------

export const ECHO_LIMITS = {
	totalBudgetMs: 1500,
	maxLines: 10,
	maxChars: 200,
} as const;

export type PrefetchedInputs = {
	readonly diff?: unknown;
	readonly addedLines?: readonly AddedLine[];
	readonly changedPaths?: readonly string[];
	/** `file:<path>` inputs, by path; null when absent. */
	readonly files?: Readonly<Record<string, string | null>>;
	readonly truncated: boolean;
};

export const EchoLinesSchema = z.array(z.string()).max(64);

/**
 * Sanitizes an extension's echo output for band-2 injection: at most 10
 * lines, control characters and ESC stripped, ≤ 200 chars, prefixed
 * `[<short>] ` so third-party text cannot impersonate the kernel.
 */
export const sanitizeEchoLines = (short: string, lines: unknown): string[] => {
	const parsed = EchoLinesSchema.safeParse(lines);
	if (!parsed.success) return [];
	const label = stripControl(short).replace(/[^a-z0-9._-]/gi, "").slice(0, 24);
	return parsed.data
		.slice(0, ECHO_LIMITS.maxLines)
		.map((line) =>
			truncateChars(stripControl(line).trim(), ECHO_LIMITS.maxChars)
		)
		.filter((line) => line.length > 0)
		.map((line) => `[${label}] ${line}`);
};
