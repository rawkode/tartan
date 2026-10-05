// Lifecycle of the mock IdP Worker (`tartan-e2e--idp`).
//
// `ensureIdp` (from `stage up`): refuse when the name answers as a Tartan
// forge; deploy `tools/mock-idp` with the rendered ISSUER and allow-list
// (`--var`); when the seed is unknown locally, the Worker lacks either
// secret, or `--rotate-idp` is given, make a new seed and RS256 key and
// write both through stdin (never argv). Locally only the seed, issuer,
// allow-list and the key's kid are kept (`.wrangler/e2e/idp.json`, 0600):
// Worker secrets survive redeploys, so the private key never touches disk.
// `removeIdp` (from `stage down`) deletes the Worker by its config name.

import { HEALTH_PRODUCT } from "../../tools/mock-idp/src/app.ts";
import { b64url } from "../../tools/mock-idp/src/encoding.ts";
import { generateSigningJwk } from "../../tools/mock-idp/src/jwt.ts";
import type { Run } from "../preflight.ts";
import {
	assertWorkerName,
	callbackOf,
	forgeOriginFor,
	GuardError,
	IDP_WORKER,
	idpOriginFor,
} from "./guards.ts";
import { idpWrangler } from "./proc.ts";
import {
	type IdpState,
	readIdpState,
	type StateFs,
	type StatePaths,
	writeIdpState,
} from "./state.ts";

export const SECRET_SEED = "E2E_IDP_SEED";
export const SECRET_JWK = "E2E_IDP_SIGNING_JWK";

export type IdpDeps = {
	readonly run: Run;
	/** Bounded (`timedFetch`): a hung request fails instead of stalling the launcher. */
	readonly fetch: typeof fetch;
	/** From `CLOUDFLARE_ACCOUNT_ID`, already checked (`accountIdFrom`). */
	readonly accountId: string;
	readonly fs: StateFs;
	readonly paths: StatePaths;
	readonly root: string;
	readonly now: () => number;
	readonly random: (n: number) => Uint8Array;
	readonly sleep: (ms: number) => Promise<void>;
	readonly log: (line: string) => void;
};

type Health = { product?: unknown; ok?: unknown; stage?: unknown };

const healthOf = async (
	fetchFn: typeof fetch,
	origin: string,
): Promise<Health | null> => {
	try {
		const response = await fetchFn(`${origin}/-/health`, {
			headers: { "cache-control": "no-store" },
		});
		return await response.json().catch(() => null) as Health | null;
	} catch {
		return null;
	}
};

/** Refuses when something other than the mock IdP answers on its name. */
export const assertNotAForge = async (
	fetchFn: typeof fetch,
	issuer: string,
): Promise<void> => {
	const health = await healthOf(fetchFn, issuer);
	if (health?.product === "Tartan") {
		throw new GuardError(
			`${IDP_WORKER} answers as a Tartan forge; refusing to overwrite it`,
		);
	}
};

const secretNames = async (deps: IdpDeps): Promise<Set<string>> => {
	const out = await idpWrangler(deps.run, deps.root, deps.accountId, [
		"secret",
		"list",
		"--format",
		"json",
	]);
	if (out.code !== 0) return new Set();
	try {
		const list = JSON.parse(out.stdout.slice(out.stdout.indexOf("[")));
		return new Set(list.map((s: { name?: unknown }) => String(s.name)));
	} catch {
		return new Set();
	}
};

const putSecret = async (deps: IdpDeps, name: string, value: string) => {
	const out = await idpWrangler(
		deps.run,
		deps.root,
		deps.accountId,
		["secret", "put", name],
		{ stdin: value },
	);
	if (out.code !== 0) {
		throw new GuardError(
			`wrangler secret put ${name} failed (exit ${out.code})`,
		);
	}
	deps.log(`set IdP secret ${name} (generated, written through stdin)`);
};

export const ensureIdp = async (
	deps: IdpDeps,
	input: { readonly subdomain: string; readonly rotate: boolean },
): Promise<IdpState> => {
	assertWorkerName(IDP_WORKER);
	const issuer = idpOriginFor(input.subdomain);
	const redirectUris = [callbackOf(forgeOriginFor(input.subdomain))];
	await assertNotAForge(deps.fetch, issuer);

	const local = await readIdpState(deps.fs, deps.paths);
	const deploy = await idpWrangler(deps.run, deps.root, deps.accountId, [
		"deploy",
		"--var",
		`ISSUER:${issuer}`,
		"--var",
		`ALLOWED_REDIRECT_URIS:${JSON.stringify(redirectUris)}`,
	]);
	if (deploy.code !== 0) {
		throw new GuardError(
			`wrangler deploy of ${IDP_WORKER} failed (exit ${deploy.code})`,
		);
	}
	deps.log(`deployed ${IDP_WORKER} at ${issuer}`);

	const present = await secretNames(deps);
	const rotate = input.rotate || local === null ||
		!present.has(SECRET_SEED) || !present.has(SECRET_JWK);
	let state: IdpState;
	if (rotate) {
		const seed = b64url(deps.random(32));
		const jwk = await generateSigningJwk();
		await putSecret(deps, SECRET_SEED, seed);
		await putSecret(deps, SECRET_JWK, JSON.stringify(jwk));
		state = {
			version: 1,
			seed,
			issuer,
			redirectUris,
			kid: String(jwk.kid),
			createdAt: new Date(deps.now()).toISOString(),
		};
	} else {
		state = { ...local, issuer, redirectUris };
	}
	await writeIdpState(deps.fs, deps.paths, state);

	const deadline = deps.now() + 120_000;
	for (;;) {
		const health = await healthOf(deps.fetch, issuer);
		if (health?.product === HEALTH_PRODUCT && health.ok === true) break;
		if (deps.now() > deadline) {
			throw new GuardError(`${issuer}/-/health did not report ok within 2 min`);
		}
		await deps.sleep(3_000);
	}
	const kid = await idpKid(deps.fetch, issuer);
	if (kid !== state.kid) {
		deps.log(
			`warning: the IdP serves key ${
				kid ?? "none"
			}, the local state names ${state.kid}; run stage up --rotate-idp`,
		);
	}
	return state;
};

/** The kid the IdP publishes at `/jwks` (its fingerprint), or null. */
export const idpKid = async (
	fetchFn: typeof fetch,
	issuer: string,
): Promise<string | null> => {
	try {
		const body = await (await fetchFn(`${issuer}/jwks`)).json() as {
			keys?: { kid?: unknown }[];
		};
		const kid = body.keys?.[0]?.kid;
		return typeof kid === "string" ? kid : null;
	} catch {
		return null;
	}
};

export const removeIdp = async (
	deps: IdpDeps,
	input: { readonly subdomain: string },
): Promise<void> => {
	assertWorkerName(IDP_WORKER);
	await assertNotAForge(deps.fetch, idpOriginFor(input.subdomain));
	const out = await idpWrangler(
		deps.run,
		deps.root,
		deps.accountId,
		["delete"],
		{
			stdin: "y\n",
		},
	);
	if (out.code !== 0) {
		throw new GuardError(
			`wrangler delete of ${IDP_WORKER} failed (exit ${out.code})`,
		);
	}
	await deps.fs.remove(deps.paths.idp);
	deps.log(`deleted ${IDP_WORKER} and .wrangler/e2e/idp.json`);
};
