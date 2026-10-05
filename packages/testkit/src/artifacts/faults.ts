// Fault injection for FakeArtifacts: scripted errors, 429s,
// timeouts, latency and held calls, per operation, optionally matched on the
// call's arguments and limited to a number of hits.

import {
	artifactsError,
	type FakeArtifactsErrorCode,
	FakeRateLimitError,
	FakeTimeoutError,
} from "./errors.ts";

/** Every operation a fault can target: binding calls and smart-HTTP requests. */
export type FakeArtifactsOp =
	| "create"
	| "get"
	| "import"
	| "list"
	| "delete"
	| "repo.info"
	| "repo.createToken"
	| "repo.listTokens"
	| "repo.revokeToken"
	| "repo.readBlob"
	| "repo.readTree"
	| "repo.readCommit"
	| "repo.readFile"
	| "repo.log"
	| "git.info-refs"
	| "git.upload-pack"
	| "git.receive-pack";

export type Fault =
	/** Throw this `ArtifactsError` (e.g. `MEMORY_LIMIT` 10402, `INTERNAL_ERROR` 10400). */
	| {
		readonly kind: "error";
		readonly code: FakeArtifactsErrorCode;
		readonly message?: string;
	}
	/** Answer 429 (binding: `FakeRateLimitError`; HTTP: status 429). */
	| { readonly kind: "rate-limit" }
	/** Delay the call, then run it normally. */
	| { readonly kind: "latency"; readonly ms: number }
	/**
	 * The caller sees a `TimeoutError` after `ms`. With `complete: true` the
	 * operation still finishes `lateMs` after the timeout, outliving its caller
	 * (e.g. an import whose repo appears after the seeder gave up).
	 */
	| {
		readonly kind: "timeout";
		readonly ms: number;
		readonly complete?: boolean;
		readonly lateMs?: number;
	}
	/** Park the call until the handle's `release()` (deterministic outliving). */
	| { readonly kind: "hold" };

export type FaultRule = {
	readonly op: FakeArtifactsOp;
	readonly fault: Fault;
	/** Hits before the rule retires (default: unlimited). */
	readonly times?: number;
	/** Only calls whose arguments match (e.g. one repo name). */
	readonly match?: (args: readonly unknown[]) => boolean;
};

export type FaultHandle = {
	/** Calls this rule has hit so far. */
	readonly hits: () => number;
	/** Lets every held call proceed (and future holds pass at once). */
	readonly release: () => void;
	/** Stops matching new calls. */
	readonly remove: () => void;
};

export type FaultPlan = {
	inject(rule: FaultRule): FaultHandle;
	clear(): void;
	/**
	 * Runs `work` under the first matching rule. `onLate` receives the outcome
	 * of work that finished after its caller timed out.
	 */
	run<T>(
		op: FakeArtifactsOp,
		args: readonly unknown[],
		work: () => Promise<T>,
		onLate?: (
			outcome: { ok: true; value: T } | { ok: false; error: unknown },
		) => void,
	): Promise<T>;
	/** The first matching rule's fault for an HTTP request (consumes a hit), or null. */
	take(op: FakeArtifactsOp, args: readonly unknown[]): Fault | null;
};

type Active = {
	rule: FaultRule;
	hits: number;
	removed: boolean;
	released: boolean;
	waiters: (() => void)[];
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createFaultPlan = (): FaultPlan => {
	let rules: Active[] = [];

	const match = (op: FakeArtifactsOp, args: readonly unknown[]) => {
		const found = rules.find((a) =>
			!a.removed && a.rule.op === op &&
			(a.rule.times === undefined || a.hits < a.rule.times) &&
			(a.rule.match === undefined || a.rule.match(args))
		);
		if (found) found.hits++;
		return found;
	};

	const take = (op: FakeArtifactsOp, args: readonly unknown[]) =>
		match(op, args)?.rule.fault ?? null;

	return {
		inject: (rule) => {
			const active: Active = {
				rule,
				hits: 0,
				removed: false,
				released: false,
				waiters: [],
			};
			rules = [...rules, active];
			return {
				hits: () => active.hits,
				release: () => {
					active.released = true;
					active.waiters.splice(0).forEach((w) => w());
				},
				remove: () => {
					active.removed = true;
				},
			};
		},
		clear: () => {
			rules.forEach((a) => a.waiters.splice(0).forEach((w) => w()));
			rules = [];
		},
		take,
		run: async (op, args, work, onLate) => {
			const active = match(op, args);
			if (!active) return await work();
			const fault = active.rule.fault;
			switch (fault.kind) {
				case "error":
					throw artifactsError(fault.code, fault.message);
				case "rate-limit":
					throw new FakeRateLimitError(op);
				case "latency":
					await sleep(fault.ms);
					return await work();
				case "hold":
					if (!active.released) {
						await new Promise<void>((resolve) => active.waiters.push(resolve));
					}
					return await work();
				case "timeout": {
					await sleep(fault.ms);
					if (fault.complete) {
						// Outlive the caller: finish the work later and report it.
						const late = sleep(fault.lateMs ?? 0).then(work);
						late.then(
							(value) => onLate?.({ ok: true, value }),
							(error) => onLate?.({ ok: false, error }),
						);
					}
					throw new FakeTimeoutError(op, fault.ms, fault.complete === true);
				}
			}
		},
	};
};
