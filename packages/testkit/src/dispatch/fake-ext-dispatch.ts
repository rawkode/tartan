// FakeExtDispatch: a scriptable `ExtDispatch` (WP7b's fan-out) for the
// kernel callers that consume it (gateway, RepoDO core, LandWorkflow, MCP).
// Gate answers are scripted per point as `GateCall`s; the effective
// decisions and `blocked` come from the contract's own
// `effectiveGateDecision` and `aggregateGates`, so K8 and the truncation default hold exactly
// as in the real dispatcher. Every call is recorded.

import {
	type ActorBounds,
	aggregateGates,
	type ContextPack,
	effectiveGateDecision,
	type Envelope,
	type GateCall,
	type GateDecision,
	type GateInput,
	type GatePoint,
} from "@tartan/contract";
import type {
	AuthContext,
	ContextAssemblyRequest,
	DispatchAt,
	ExtDispatch,
	GateDispatchResult,
	ResolvedTool,
} from "@tartan/contract/kernel.ts";

type Maybe<T, A extends unknown[]> = T | ((...args: A) => T | Promise<T>);

export type FakeExtDispatchOptions = {
	readonly gates?: Partial<
		Record<GatePoint, Maybe<readonly GateCall[], [GateInput, DispatchAt]>>
	>;
	readonly echo?: Maybe<readonly string[], [Envelope, DispatchAt]>;
	readonly context?: Maybe<ContextPack, [ContextAssemblyRequest, ActorBounds]>;
	readonly tools?: Maybe<
		{ name: string; description: string; inputSchema: unknown }[],
		[string, AuthContext]
	>;
	readonly resolveTool?: Maybe<
		ResolvedTool | null,
		[string, string, AuthContext]
	>;
};

export type DispatchCall = {
	readonly method: keyof ExtDispatch;
	readonly args: readonly unknown[];
};

export type FakeExtDispatch = ExtDispatch & {
	readonly calls: readonly DispatchCall[];
	/** Re-scripts the gates of one point. */
	scriptGates(
		point: GatePoint,
		calls: Maybe<readonly GateCall[], [GateInput, DispatchAt]>,
	): void;
};

const answer = async <T, A extends unknown[]>(
	value: Maybe<T, A> | undefined,
	fallback: T,
	args: A,
): Promise<T> =>
	value === undefined
		? fallback
		: typeof value === "function"
		? await (value as (...a: A) => T | Promise<T>)(...args)
		: value;

/** A gate call that answered `decision` (helper for scripts). */
export const gateAnswer = (
	ext: string,
	decision: "allow" | "advise" | "veto",
	options: Partial<Omit<GateCall, "ext" | "outcome">> & {
		readonly message?: string;
		readonly fullScan?: boolean;
	} = {},
): GateCall => ({
	installation: options.installation ?? `i_${"0".repeat(26)}`,
	ext,
	mode: options.mode ?? "enforce",
	onTruncated: options.onTruncated ?? "allow",
	default: options.default ?? "allow",
	outcome: {
		kind: "decision",
		decision: {
			decision,
			message: options.message ?? `${ext}: ${decision}`,
			...(options.fullScan === undefined ? {} : { fullScan: options.fullScan }),
		} satisfies GateDecision,
	},
});

const EMPTY_PACK: ContextPack = {
	md: "",
	sections: [],
	budgetTokens: 0,
	truncated: false,
};

export const createFakeExtDispatch = (
	options: FakeExtDispatchOptions = {},
): FakeExtDispatch => {
	const calls: DispatchCall[] = [];
	const gates = new Map(Object.entries(options.gates ?? {})) as Map<
		GatePoint,
		Maybe<readonly GateCall[], [GateInput, DispatchAt]>
	>;
	return {
		calls,
		scriptGates: (point, script) => {
			gates.set(point, script);
		},
		gates: async (point, input, at): Promise<GateDispatchResult> => {
			calls.push({ method: "gates", args: [point, input, at] });
			const scripted = await answer(gates.get(point), [], [input, at]);
			const truncated = (input as { truncated?: boolean }).truncated === true;
			const effective = scripted.map((c) =>
				effectiveGateDecision(c, truncated)
			);
			return {
				calls: scripted,
				effective,
				blocked: aggregateGates(effective).blocked,
			};
		},
		echo: async (event, at, budgetMs) => {
			calls.push({ method: "echo", args: [event, at, budgetMs] });
			return [...await answer(options.echo, [], [event, at])];
		},
		context: async (req, bounds) => {
			calls.push({ method: "context", args: [req, bounds] });
			return await answer(options.context, EMPTY_PACK, [req, bounds]);
		},
		tools: async (scopeNodeId, auth) => {
			calls.push({ method: "tools", args: [scopeNodeId, auth] });
			return await answer(options.tools, [], [scopeNodeId, auth]);
		},
		resolveTool: async (scopeNodeId, name, auth) => {
			calls.push({ method: "resolveTool", args: [scopeNodeId, name, auth] });
			return await answer(options.resolveTool, null, [scopeNodeId, name, auth]);
		},
	};
};
