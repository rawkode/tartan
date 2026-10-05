// SwarmWorkflow (`swarm-<ulid>`, cohorts `swarm-<ulid>-c<nn>-g<n>`): simulated
// agents speaking MCP and git HTTP to the Worker's own router, on sharded sim
// repos. Dev-only: only the dev-tools-gated `POST /-/api/swarm` creates
// instances. A thin adapter: the plan and cohort logic is `driver.ts`, the real
// dependencies `wiring.ts`.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../../env.ts";
import {
	paramsProblem,
	runCohort,
	runPlan,
	type Step,
	type SwarmWorkflowParams,
} from "./driver.ts";
import { createDriverDeps } from "./wiring.ts";

export type {
	SwarmCohortParams,
	SwarmPlanParams,
	SwarmWorkflowParams,
} from "./driver.ts";

/** A round runs for about a minute; provisioning 20 shards takes longer. */
const STEP_CONFIG = {
	retries: { limit: 2, delay: "10 seconds", backoff: "linear" },
	timeout: "15 minutes",
} as const;

export class SwarmWorkflow
	extends WorkflowEntrypoint<Env, SwarmWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<SwarmWorkflowParams>>,
		step: WorkflowStep,
	): Promise<unknown> {
		const params = event.payload;
		const problem = paramsProblem(params, event.instanceId);
		if (problem !== null) {
			throw new NonRetryableError(`invalid swarm params: ${problem}`);
		}
		const deps = createDriverDeps(this.env, params.by);
		const steps: Step = {
			do: <T>(name: string, fn: () => Promise<T>) =>
				step.do(
					name,
					STEP_CONFIG,
					fn as () => Promise<never>,
				) as Promise<T>,
		};
		return params.kind === "plan"
			? await runPlan(params, steps, deps)
			: await runCohort(params, steps, deps);
	}
}
