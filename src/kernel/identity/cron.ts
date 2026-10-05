// identity cron task (WP2): the IdP metadata is re-discovered once it is a day
// old. Registered in `src/cron.ts`; runs every 5 minutes in its own try/catch,
// and ForgeDO decides whether a refresh is due, so most runs are one cheap RPC.

import type { CronTask } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { forgeIdentity } from "../http/isolate.ts";

export const identityCron: CronTask<Env> = async (env) => {
	await forgeIdentity(env).refreshIdp();
};
