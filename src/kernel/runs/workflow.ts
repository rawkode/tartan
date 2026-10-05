// RunWorkflow (`run-<repoUlid>-<runUlid>`): the
// durable job-graph executor. A thin adapter over `driveRun` (driver.ts),
// with the services bound to RepoDO `runs()`, ForgeDO `slots()` and the
// run's `job:<runId>` sandbox.
//
// Params carry the validated job graph (no secrets: v1 has no pipeline
// secrets, and tokens are minted inside sandbox calls, K11), so the workflow
// never needs a RepoDO read beyond run and job states.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	isUlid,
	type JobGraph,
	type JobGraphInput,
	JobGraphSchema,
	jobSandboxName,
	repoDoName,
	runInstanceId,
} from "@tartan/contract";
import { WAIT_MODE } from "../../constants.ts";
import type { Env } from "../../env.ts";
import {
	type DriveResult,
	driveRun,
	type RunServices,
	type StepLike,
} from "./driver.ts";

export type RunWorkflowParams = {
	readonly repoId: string;
	readonly runId: string;
	readonly graph: JobGraphInput;
	readonly requestedBy: string;
};

/** Binds the driver's services to the Worker's bindings. */
export const envRunServices = (
	env: Env,
	repoId: string,
	runId: string,
): RunServices => {
	const repo = () => env.REPO.getByName(repoDoName(repoId)).runs();
	const slots = () => env.FORGE.getByName("forge").slots();
	const sandbox = () => env.SANDBOX.getByName(jobSandboxName(runId));
	return {
		runs: {
			get: (id) => repo().get(id),
			setRunState: (id, state) => repo().setRunState(id, state),
			setJobState: (id, jobId, update) => repo().setJobState(id, jobId, update),
		},
		slots: {
			acquire: (kind, id, ttl) => slots().acquire(kind, id, ttl),
			release: (key) => slots().release(key),
			recordUsage: (kind, ms) => slots().recordUsage(kind, ms),
		},
		sandbox: {
			prepare: (input) => sandbox().prepare(input),
			runJob: (input) => sandbox().runJob(input),
			reconcile: () => sandbox().reconcile(),
			stopRun: () => sandbox().stopRun(),
		},
	};
};

/** `WorkflowStep` as the driver's `StepLike` (types only; same behaviour). */
export const asStepLike = (step: WorkflowStep): StepLike => ({
	do: (<T>(
		name: string,
		configOrFn: unknown,
		maybeFn?: () => Promise<T>,
	): Promise<T> =>
		maybeFn === undefined
			? (step.do as (n: string, f: () => Promise<unknown>) => Promise<T>)(
				name,
				configOrFn as () => Promise<T>,
			)
			: (step.do as (
				n: string,
				c: unknown,
				f: () => Promise<unknown>,
			) => Promise<T>)(name, configOrFn, maybeFn)) as StepLike["do"],
	sleep: (name, ms) => step.sleep(name, ms),
	waitForEvent: <T>(name: string, options: { type: string; timeout: number }) =>
		(step.waitForEvent as (
			n: string,
			o: { type: string; timeout: number },
		) => Promise<{ payload: T }>)(name, options),
});

export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<RunWorkflowParams>>,
		step: WorkflowStep,
	): Promise<DriveResult> {
		const { repoId, runId, requestedBy } = event.payload;
		if (!isUlid(repoId) || !isUlid(runId)) {
			throw new NonRetryableError("invalid run params: repoId and runId");
		}
		if (event.instanceId !== runInstanceId(repoId, runId)) {
			throw new NonRetryableError("instance id does not match the run");
		}
		const parsed = JobGraphSchema.safeParse(event.payload.graph);
		if (!parsed.success) {
			throw new NonRetryableError("invalid run params: graph");
		}
		const graph: JobGraph = parsed.data;
		return await driveRun(
			asStepLike(step),
			envRunServices(this.env, repoId, runId),
			{
				repoId,
				runId,
				instanceId: event.instanceId,
				graph,
				requestedBy,
				waitMode: WAIT_MODE,
			},
		);
	}
}
