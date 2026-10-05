// The Cloudflare account the e2e launcher works in, asserted before any
// change: the account id comes from `CLOUDFLARE_ACCOUNT_ID` (guards.ts), the
// login must hold exactly that account, every wrangler child gets it pinned
// in its environment, and the REST client is bound to it. The workers.dev
// subdomain names both Workers' origins.

import {
	type CfApi,
	createCfApi,
	parseJsonOutput,
	parseWhoami,
	type Run,
} from "../preflight.ts";
import { ACCOUNT_ENV, assertAccount, GuardError } from "./guards.ts";
import { bins } from "./proc.ts";

export type Account = {
	readonly api: CfApi;
	readonly accountId: string;
	readonly subdomain: string;
};

export const resolveAccount = async (deps: {
	readonly run: Run;
	readonly root: string;
	readonly fetch: typeof fetch;
	readonly env: (name: string) => string | undefined;
	/** From `accountIdFrom` (the environment), already checked. */
	readonly accountId: string;
}): Promise<Account> => {
	const wrangler = bins(deps.root).wrangler;
	const env = { [ACCOUNT_ENV]: deps.accountId };
	const who = await deps.run(wrangler, ["whoami", "--json"], {
		cwd: deps.root,
		env,
	});
	let me;
	try {
		me = parseWhoami(who.stdout);
	} catch {
		throw new GuardError("`wrangler whoami --json` gave no JSON; log in first");
	}
	if (!me.loggedIn) {
		throw new GuardError(
			"not logged in to Cloudflare: run `npx wrangler login`",
		);
	}
	const account = me.accounts.find((a) => a.id === deps.accountId);
	if (account === undefined) {
		throw new GuardError(
			`this login cannot reach account ${deps.accountId} (${ACCOUNT_ENV})`,
		);
	}
	assertAccount(account.id, deps.accountId);
	let token = deps.env("CLOUDFLARE_API_TOKEN") ?? null;
	if (token === null) {
		const out = await deps.run(wrangler, ["auth", "token", "--json"], {
			cwd: deps.root,
			env,
		});
		try {
			const value = parseJsonOutput(out.stdout) as { token?: unknown };
			token = typeof value.token === "string" && value.token !== ""
				? value.token
				: null;
		} catch {
			token = null;
		}
	}
	if (token === null) {
		throw new GuardError(
			"no API token (wrangler auth token, CLOUDFLARE_API_TOKEN)",
		);
	}
	const api = createCfApi({
		token,
		accountId: deps.accountId,
		fetch: deps.fetch,
	});
	const sub = await api.account("GET", "/workers/subdomain");
	const subdomain = sub.body?.result?.subdomain;
	if (sub.status !== 200 || typeof subdomain !== "string") {
		throw new GuardError(
			`could not read the account's workers.dev subdomain (HTTP ${sub.status})`,
		);
	}
	return { api, accountId: account.id, subdomain };
};
