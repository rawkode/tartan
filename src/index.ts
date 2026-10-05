// Worker entry: one Worker script exporting every Durable Object, Workflow and
// WorkerEntrypoint class from its module file, with the router as `fetch`.
//
// Integrator-owned. wrangler.jsonc binds these exact class
// names; renaming one needs a new `migrations` tag.

import { CRON_TASKS, runCron } from "./cron.ts";
import type { Env } from "./env.ts";
import { createRouter } from "./router.ts";

export { BusDO } from "./do/bus.ts";
export { ForgeDO } from "./do/forge.ts";
export { RepoDO } from "./do/repo.ts";
export { InboxDO } from "./kernel/inbox/do.ts";
export { ExtensionDO } from "./kernel/exthost/host/do.ts";
export { TartanSandbox } from "./kernel/runs/sandbox.ts";
export { RunWorkflow } from "./kernel/runs/workflow.ts";
export { LandWorkflow } from "./kernel/land/workflow.ts";
export { IngestWorkflow } from "./kernel/ingest/workflow.ts";
export { SwarmWorkflow } from "./kernel/swarm/workflow.ts";
export { KernelCaps } from "./kernel/caps/entrypoint.ts";
export { RepoProbe } from "./kernel/probe/entrypoint.ts";
export { ExtTail } from "./kernel/exthost/host/tail.ts";

const router = createRouter();

export default {
	fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
		router(req, env, ctx),
	// The 5-minute cron: every task registered in `src/cron.ts` (lane
	// GC, ref reconciliation, retention, IdP metadata refresh, …).
	scheduled: async (controller, env, ctx) => {
		await runCron(CRON_TASKS, env, ctx, controller.scheduledTime);
	},
} satisfies ExportedHandler<Env>;
