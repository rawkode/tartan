// Name, origin, account and disk guards of the e2e launcher (deploy tooling;
// runtime code never imports it). The launcher drives exactly one forge,
// stage `dev-e2e` (Worker `tartan-dev-e2e`), and one IdP Worker
// (`tartan-e2e--idp`), both on workers.dev in the one account the person
// running it names in `CLOUDFLARE_ACCOUNT_ID`. Nothing in the repository
// names an account, so any self-deployer runs the harness in their own.
// Every Cloudflare-facing step asserts the name, origin or account it is
// about to touch with these functions first; there is no code path that
// names another Worker, a zone or DNS.

import {
	IDP_WORKER,
	ISSUER_RE,
	REDIRECT_URI_RE,
} from "../../tools/mock-idp/src/config.ts";
import { parseDfAvailable, type Run } from "../preflight.ts";

export { IDP_WORKER };

export const STAGE = "dev-e2e";
export const FORGE_WORKER = "tartan-dev-e2e";
/**
 * The variable that names the account of the e2e stage (wrangler's own). It
 * is read once, checked, asserted against the login and the deploy record,
 * and pinned for every wrangler child; no tracked file holds a value.
 */
export const ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";
/** A Cloudflare account id: 32 lowercase hex characters. */
export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

export const FORGE_ORIGIN_RE =
	/^https:\/\/tartan-dev-e2e\.[a-z0-9-]+\.workers\.dev$/;
export const IDP_ORIGIN_RE = ISSUER_RE;
export const WORKER_NAMES: readonly string[] = [FORGE_WORKER, IDP_WORKER];

/** 1.5 GB (AGENTS.md disk hygiene). */
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;

/** The launcher's exit code for a failed guard or preflight. */
export const GUARD_EXIT = 2;

export class GuardError extends Error {
	override name = "GuardError";
}

export const assertWorkerName = (name: string): string => {
	if (!WORKER_NAMES.includes(name)) {
		throw new GuardError(
			`refusing to touch Worker ${
				JSON.stringify(name)
			}: only ${FORGE_WORKER} and ${IDP_WORKER}`,
		);
	}
	return name;
};

export const assertStage = (stage: string): string => {
	if (stage !== STAGE) {
		throw new GuardError(
			`refusing stage ${JSON.stringify(stage)}: only ${STAGE}`,
		);
	}
	return stage;
};

/**
 * The account id from the environment (`CLOUDFLARE_ACCOUNT_ID`): required,
 * and an id, never a name, so nothing is resolved by guessing.
 */
export const accountIdFrom = (
	env: (name: string) => string | undefined,
): string => {
	const value = env(ACCOUNT_ENV)?.trim() ?? "";
	if (value === "") {
		throw new GuardError(
			`${ACCOUNT_ENV} is not set: export the id of the Cloudflare account the dev-e2e stage lives in`,
		);
	}
	if (!ACCOUNT_ID_RE.test(value)) {
		throw new GuardError(
			`${ACCOUNT_ENV} is not an account id (32 lowercase hex characters)`,
		);
	}
	return value;
};

/** Refuses every account but the one the environment names. */
export const assertAccount = (actual: string, expected: string): string => {
	if (actual !== expected) {
		throw new GuardError(
			`expected account ${expected} (${ACCOUNT_ENV}), got ${
				ACCOUNT_ID_RE.test(actual) ? actual : JSON.stringify(actual)
			}`,
		);
	}
	return actual;
};

export const assertForgeOrigin = (origin: string): string => {
	if (!FORGE_ORIGIN_RE.test(origin)) {
		throw new GuardError(
			"the forge origin is not https://tartan-dev-e2e.<subdomain>.workers.dev",
		);
	}
	return origin;
};

export const assertIdpOrigin = (origin: string): string => {
	if (!IDP_ORIGIN_RE.test(origin)) {
		throw new GuardError(
			"the IdP origin is not https://tartan-e2e--idp.<subdomain>.workers.dev",
		);
	}
	return origin;
};

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const assertSubdomain = (subdomain: string): string => {
	if (!SUBDOMAIN_RE.test(subdomain)) {
		throw new GuardError("the account's workers.dev subdomain is malformed");
	}
	return subdomain;
};

export const forgeOriginFor = (subdomain: string): string =>
	assertForgeOrigin(
		`https://${FORGE_WORKER}.${assertSubdomain(subdomain)}.workers.dev`,
	);

export const idpOriginFor = (subdomain: string): string =>
	assertIdpOrigin(
		`https://${IDP_WORKER}.${assertSubdomain(subdomain)}.workers.dev`,
	);

/** The forge's OIDC callback, checked against the IdP's own allow-list rule. */
export const callbackOf = (forgeOrigin: string): string => {
	const uri = `${assertForgeOrigin(forgeOrigin)}/-/auth/callback`;
	if (!REDIRECT_URI_RE.test(uri)) {
		throw new GuardError("the forge callback is not allowed by the IdP");
	}
	return uri;
};

/** Stops before any install, build or deploy when the disk is nearly full. */
export const checkDisk = async (run: Run, path: string): Promise<number> => {
	const df = await run("df", ["-Pk", path]).catch(() => null);
	const free = df?.code === 0 ? parseDfAvailable(df.stdout) : null;
	if (free === null) {
		throw new GuardError(`could not read the free disk space (df -Pk ${path})`);
	}
	if (free < MIN_FREE_BYTES) {
		throw new GuardError(
			`only ${
				(free / 1024 ** 3).toFixed(2)
			} GB free; at least 1.5 GB is needed (AGENTS.md disk hygiene)`,
		);
	}
	return free;
};
