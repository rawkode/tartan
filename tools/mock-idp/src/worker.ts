// The e2e mock OIDC IdP Worker (`tartan-e2e--idp`). Every request goes to
// the one `IdpState` Durable Object (`default`), which holds the clients,
// pending authorization requests, codes and rate limits in SQLite and runs
// `createIdpApp`. Both classes are thin adapters; the behaviour and its tests
// live in the sibling modules.
//
// Deployed only by `deno task e2e -- stage up` with `wrangler.jsonc` next to
// this directory. Only the dev-e2e forge ever trusts it (docs/testing/e2e.md).

import { DurableObject } from "cloudflare:workers";
import { createIdpApp, type IdpApp } from "./app.ts";
import type { IdpEnv } from "./config.ts";
import { cryptoRandom } from "./encoding.ts";
import { createStore } from "./store.ts";

export type Env = IdpEnv & {
	readonly IDP: DurableObjectNamespace<IdpState>;
};

export class IdpState extends DurableObject<Env> {
	private readonly app: IdpApp;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.app = createIdpApp({
			env,
			store: createStore(ctx.storage),
			now: () => Date.now(),
			random: cryptoRandom,
		});
	}

	override fetch(request: Request): Promise<Response> {
		return this.app(request);
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return env.IDP.getByName("default").fetch(request);
	},
} satisfies ExportedHandler<Env>;
