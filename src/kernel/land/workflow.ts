// LandWorkflow (`land-<repoUlid>-<batchUlid>`): the
// Advance, the only code path that moves trunk. A thin adapter over
// `driveLand` (driver.ts) with its services bound to RepoDO (`land()`,
// `core()`), the canonical repo in Artifacts (tokens minted per use), the
// warm `git:<repoId>` sandbox, RepoProbe and WP7b's gate dispatcher.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	gitSandboxName,
	isIdOf,
	isUlid,
	landInstanceId,
	repoDoName,
} from "@tartan/contract";
import type { RepoCoreFacade, RepoProbeApi } from "@tartan/contract/kernel.ts";
import { WAIT_MODE } from "../../constants.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { createExtDispatch } from "../exthost/host/dispatch.ts";
import { asStepLike } from "../runs/workflow.ts";
import { driveLand, type DriveResult, type LandServices } from "./driver.ts";
import { createLandGit } from "./git.ts";
import type { LandWorkflowParams } from "./params.ts";
import type { LandFacade } from "./types.ts";
import { createLaneRepoAccess } from "./lanerepos.ts";
import { createCanonicalAccess } from "./upstream.ts";

export type { LandWorkflowParams };

const log = (message: string, data: Record<string, unknown>): void =>
	console.error(`[tartan] land workflow: ${message}`, JSON.stringify(data));

/** Binds the driver's services to the Worker's bindings. */
export const envLandServices = (
	env: Env,
	host: { readonly exports: unknown },
	repoId: string,
): LandServices => {
	const repo = () => env.REPO.getByName(repoDoName(repoId));
	return {
		land: repo().land() as unknown as LandFacade,
		core: repo().core() as unknown as RepoCoreFacade,
		canonical: createCanonicalAccess({ artifacts: env.ARTIFACTS, repoId }),
		laneRepos: createLaneRepoAccess({ artifacts: env.ARTIFACTS, repoId }),
		git: () =>
			createLandGit({
				exec: (argv, options) =>
					env.SANDBOX.getByName(gitSandboxName(repoId)).gitExec(argv, options),
				repoId,
			}),
		probe: () => loopback(host).RepoProbe as unknown as RepoProbeApi,
		gates: createExtDispatch(env, host),
		log,
	};
};

export class LandWorkflow extends WorkflowEntrypoint<Env, LandWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<LandWorkflowParams>>,
		step: WorkflowStep,
	): Promise<DriveResult> {
		const { repoId, batchId } = event.payload ?? ({} as LandWorkflowParams);
		if (!isUlid(repoId) || !isIdOf("batch", batchId)) {
			throw new NonRetryableError("invalid land params: repoId and batchId");
		}
		if (event.instanceId !== landInstanceId(repoId, batchId)) {
			throw new NonRetryableError("instance id does not match the batch");
		}
		return await driveLand(
			asStepLike(step),
			envLandServices(this.env, this.ctx, repoId),
			{
				repoId,
				batchId,
				instanceId: event.instanceId,
				waitMode: WAIT_MODE,
			},
		);
	}
}
