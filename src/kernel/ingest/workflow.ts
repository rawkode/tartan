// IngestWorkflow: target of the `cf.artifacts.repo.pushed` event trigger, one
// instance per ref update of an `r-*` or `l-*` repo, instance id = event id
// [E A5]. It maps the event (`map.ts`: lowercased name, family parsed from it)
// and calls `RepoDO.core().observePush` in one step, which is idempotent per
// event id. An event that names no Tartan repo, or a repo in another namespace,
// is logged and dropped.
//
// Phase 2 of a trigger-only push runs inside RepoDO (`observePush` starts it
// and the `diff` timer backstops it): the contract's `observePush` returns
// nothing, so this Workflow has no push id for a second step.

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { artifactsNamespace, fromRpcError } from "@tartan/contract";
import type { Env } from "../../env.ts";
import { type IngestWorkflowParams, mapTriggerEvent } from "./map.ts";

export type { IngestWorkflowParams } from "./map.ts";

/** Errors a retry cannot fix (a malformed observation, a repo that does not exist). */
const FINAL = new Set(["invalid", "not_found"]);

const namespaceOf = (stage: string | undefined): string => {
	try {
		return artifactsNamespace(stage);
	} catch {
		return artifactsNamespace();
	}
};

export class IngestWorkflow
	extends WorkflowEntrypoint<Env, IngestWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<IngestWorkflowParams>>,
		step: WorkflowStep,
	): Promise<unknown> {
		const mapped = mapTriggerEvent(event.payload, {
			instanceId: event.instanceId,
			at: event.timestamp instanceof Date
				? event.timestamp.getTime()
				: Number(event.timestamp),
			namespace: namespaceOf(this.env.TARTAN_STAGE),
		});
		if (!mapped.ok) {
			console.error(
				"[tartan] ingest: event dropped",
				JSON.stringify({ instanceId: event.instanceId, why: mapped.drop }),
			);
			return { dropped: mapped.drop };
		}
		const { doName, observation } = mapped;
		await step.do(
			"observe",
			{
				retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
				timeout: "30 seconds",
			},
			async () => {
				try {
					await this.env.REPO.getByName(doName).core().observePush(
						observation,
					);
				} catch (error) {
					const e = fromRpcError(error);
					if (FINAL.has(e.code)) throw new NonRetryableError(e.message);
					throw error;
				}
				return { observed: true };
			},
		);
		return { observed: observation.eventId };
	}
}
