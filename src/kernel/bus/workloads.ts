// The `workloads` group handler (WP26). Pure over its ports:
// `(record) → outcome`, order-insensitive, every effect idempotent and
// re-checked by the DO that owns it, so duplicates and reordering are
// harmless.
//
// - A queued `run.started` marked `ce_tartanworkload: k2` asks the run's
//   RepoDO to `dispatch(runId, {via: "k2"})`: dispatched, already, terminal
//   and superseded are done; an unknown run is poison (an older epoch of a
//   wiped dev repo, or a forged record); a transient RPC or create error is
//   retry.
// - `run.dispatched` counts toward the via counters for its hour (applied in
//   the same transaction that marks the record seen, so a redelivery never
//   counts twice).
// - Everything else is skipped on its headers; content is parsed only for a
//   workload record.

import { isUlid, repoDoName } from "@tartan/contract";
import type { Env } from "../../env.ts";
import { HEADERS, type LogRecord, timeOf } from "./codec.ts";
import type { DispatchOutcome, RunDispatchVia } from "./contract.ts";
import { withRpc } from "../../do/dispose.ts";

/** What a group handler decides for one record. */
export type HandlerOutcome =
	| { readonly outcome: "done"; readonly applySync?: () => void }
	| { readonly outcome: "skip" }
	| { readonly outcome: "retry"; readonly error: string }
	| { readonly outcome: "poison"; readonly error: string };

export type GroupHandler = (
	record: LogRecord,
	signal: AbortSignal,
) => Promise<HandlerOutcome>;

export type WorkloadsPorts = {
	dispatch(
		repoId: string,
		runId: string,
		options: { via: RunDispatchVia; requestedAt?: number },
	): Promise<DispatchOutcome>;
	/** Inside the consumer's transaction: one `run.dispatched` for `hour`. */
	countViaSync(hour: number, via: RunDispatchVia): void;
};

const HOUR_MS = 3_600_000;
export const hourOf = (ms: number): number =>
	Math.floor(ms / HOUR_MS) * HOUR_MS;

const VIAS: ReadonlySet<string> = new Set(["k2", "backstop", "local"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const DONE: ReadonlySet<DispatchOutcome> = new Set([
	"dispatched",
	"already",
	"terminal",
	"superseded",
]);

export const createWorkloadsHandler =
	(ports: WorkloadsPorts): GroupHandler => async (record) => {
		if (record.flags.includes("shadow")) return { outcome: "skip" };
		if (
			record.type === "run.started" && record.headers[HEADERS.workload] === "k2"
		) {
			const repo = record.headers[HEADERS.repo];
			if (repo === undefined || !isUlid(repo)) {
				return { outcome: "poison", error: "no repo" };
			}
			const data = record.envelope()?.data;
			const runId = isObject(data) ? data.runId : undefined;
			if (typeof runId !== "string" || !isUlid(runId)) {
				return { outcome: "poison", error: "no run id" };
			}
			const requestedAt = timeOf(record);
			let outcome: DispatchOutcome;
			try {
				outcome = await ports.dispatch(repo, runId, {
					via: "k2",
					...(requestedAt === null ? {} : { requestedAt }),
				});
			} catch (error) {
				return {
					outcome: "retry",
					error: error instanceof Error ? error.name : "error",
				};
			}
			if (DONE.has(outcome)) return { outcome: "done" };
			return { outcome: "poison", error: outcome };
		}
		if (record.type === "run.dispatched") {
			const via = record.headers[HEADERS.via];
			if (via === undefined || !VIAS.has(via)) return { outcome: "skip" };
			const hour = hourOf(timeOf(record) ?? record.timestampMs);
			return {
				outcome: "done",
				applySync: () => ports.countViaSync(hour, via as RunDispatchVia),
			};
		}
		return { outcome: "skip" };
	};

/** The production dispatch port: the run's RepoDO over RPC. */
export const repoDispatch =
	(env: Env): WorkloadsPorts["dispatch"] => (repoId, runId, options) =>
		withRpc(
			() => env.REPO.getByName(repoDoName(repoId)).runs(),
			(runs) => runs.dispatch(runId, options),
		);
