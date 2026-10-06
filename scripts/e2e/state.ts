// Checkout-local state of the e2e stage (all under gitignored `.wrangler/`):
//
//   .wrangler/e2e/            0700
//     idp.json                0600: the IdP seed, issuer, allow-list and the
//                             signing key's kid (never the private key)
//     stage.json              0600: when the stage came up and when it
//                             should come down (an 8 h expiry)
//   .wrangler/deploy/record.dev-e2e.json       written by `deno task deploy`
//   .wrangler/deploy/setup-url.dev-e2e.txt     0600, written by deploy while
//                                              the forge is unclaimed
//
// Files holding a secret are written 0600 (and chmod-ed, as deploy.ts does)
// and refused on read when the group or others can read them. Paths are
// exact: nothing here globs, so another stage's setup URL file is never read.

import * as path from "node:path";
import { REDIRECT_URI_RE } from "../../tools/mock-idp/src/config.ts";
import { isSeed } from "../../tools/mock-idp/src/password.ts";
import {
	assertForgeOrigin,
	assertIdpOrigin,
	GuardError,
	STAGE,
} from "./guards.ts";

export const STAGE_TTL_MS = 8 * 60 * 60 * 1000;

export type StatePaths = {
	readonly root: string;
	readonly dir: string;
	readonly idp: string;
	readonly stage: string;
	readonly record: string;
	readonly setupUrl: string;
	readonly output: string;
	readonly evidence: string;
};

export const statePaths = (root: string): StatePaths => ({
	root,
	dir: path.join(root, ".wrangler", "e2e"),
	idp: path.join(root, ".wrangler", "e2e", "idp.json"),
	stage: path.join(root, ".wrangler", "e2e", "stage.json"),
	record: path.join(root, ".wrangler", "deploy", `record.${STAGE}.json`),
	setupUrl: path.join(root, ".wrangler", "deploy", `setup-url.${STAGE}.txt`),
	output: path.join(root, "e2e", ".e2e"),
	evidence: path.join(root, ".private", "e2e", "evidence"),
});

export type StateFs = {
	readText(file: string): Promise<string | null>;
	/** Permission bits, or null when the file does not exist. */
	mode(file: string): Promise<number | null>;
	writePrivate(file: string, text: string): Promise<void>;
	remove(file: string): Promise<void>;
};

export const denoStateFs: StateFs = {
	readText: async (file) => {
		try {
			return await Deno.readTextFile(file);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return null;
			throw error;
		}
	},
	mode: async (file) => {
		try {
			return ((await Deno.stat(file)).mode ?? 0) & 0o777;
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return null;
			throw error;
		}
	},
	writePrivate: async (file, text) => {
		const dir = path.dirname(file);
		await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
		await Deno.chmod(dir, 0o700);
		await Deno.writeTextFile(file, text, { mode: 0o600 });
		await Deno.chmod(file, 0o600);
	},
	remove: async (file) => {
		try {
			await Deno.remove(file);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
	},
};

/** Reads a secret-bearing file; refuses one the group or others can read. */
export const readPrivate = async (
	fs: StateFs,
	file: string,
): Promise<string | null> => {
	const mode = await fs.mode(file);
	if (mode === null) return null;
	if ((mode & 0o077) !== 0) {
		throw new GuardError(
			`${path.basename(file)} is readable by others (mode ${
				mode.toString(8)
			}); chmod 600 it or delete it`,
		);
	}
	return await fs.readText(file);
};

// ---------------------------------------------------------------------------
// The IdP's local state
// ---------------------------------------------------------------------------

export type IdpState = {
	readonly version: 1;
	readonly seed: string;
	readonly issuer: string;
	readonly redirectUris: readonly string[];
	/** The signing key's kid; the key itself exists only as a Worker secret. */
	readonly kid: string;
	readonly createdAt: string;
};

export const parseIdpState = (text: string): IdpState => {
	let value: Partial<IdpState> & Record<string, unknown>;
	try {
		value = JSON.parse(text);
	} catch {
		throw new GuardError("idp.json is not JSON");
	}
	if (
		value.version !== 1 || !isSeed(value.seed) ||
		typeof value.issuer !== "string" || !Array.isArray(value.redirectUris) ||
		typeof value.kid !== "string" || typeof value.createdAt !== "string"
	) {
		throw new GuardError("idp.json is malformed; run stage up --rotate-idp");
	}
	if ("jwk" in value || "privateKey" in value || "d" in value) {
		throw new GuardError(
			"idp.json holds a private key; delete it and run stage up --rotate-idp",
		);
	}
	assertIdpOrigin(value.issuer);
	for (const uri of value.redirectUris) {
		if (typeof uri !== "string" || !REDIRECT_URI_RE.test(uri)) {
			throw new GuardError("idp.json names a redirect URI outside dev-e2e");
		}
	}
	return value as IdpState;
};

export const readIdpState = async (
	fs: StateFs,
	paths: StatePaths,
): Promise<IdpState | null> => {
	const text = await readPrivate(fs, paths.idp);
	return text === null ? null : parseIdpState(text);
};

export const writeIdpState = (
	fs: StateFs,
	paths: StatePaths,
	state: IdpState,
): Promise<void> =>
	fs.writePrivate(paths.idp, `${JSON.stringify(state, null, "\t")}\n`);

// ---------------------------------------------------------------------------
// The forge: deploy record, setup URL, stage expiry
// ---------------------------------------------------------------------------

export type ForgeRecord = {
	readonly origin: string;
	readonly setupState: string;
	readonly containers: boolean;
	readonly accountId: string;
	/** The commit deploy ran from (`git rev-parse HEAD`), or null when unknown. */
	readonly commit: string | null;
	/** When the deploy finished (epoch ms), or null when unknown. */
	readonly deployedAt: number | null;
	/** The switches the deploy rendered (ids, names and modes only). */
	readonly switches: RecordSwitches;
};

/** What the suites learn about the stage's switches (`TARTAN_E2E_SWITCHES`). */
export type RecordSwitches = {
	readonly laneMode: string | null;
	readonly workloadTransport: string | null;
	readonly projects: boolean;
	readonly repoConfig: boolean;
	/** The global log is bound (a K2 stream). */
	readonly k2: boolean;
	/** The K2 consume token is bound. */
	readonly k2Token: boolean;
	/** The WASM extension packages were built for this deploy. */
	readonly buildExt: boolean;
	/** `TARTAN_ECHO` as rendered (`on`, `off`), or null for the compiled default. */
	readonly echo: "on" | "off" | null;
};

const MODE_RE = /^[a-z0-9]{1,16}$/;

export const switchesOfRecord = (
	value: Record<string, unknown>,
): RecordSwitches => {
	const s = (value.switches ?? {}) as Record<string, unknown>;
	const k2 = value.k2 as { token?: unknown } | undefined;
	const mode = (v: unknown) =>
		typeof v === "string" && MODE_RE.test(v) ? v : null;
	return {
		laneMode: mode(s.laneMode),
		workloadTransport: mode(s.workloadTransport),
		projects: s.projects === true,
		repoConfig: s.repoConfig === true,
		k2: k2 !== undefined && k2 !== null,
		k2Token: k2?.token !== undefined && k2?.token !== null,
		buildExt: s.buildExt === true,
		echo: s.echo === "on" || s.echo === "off" ? s.echo : null,
	};
};

/**
 * A run starts at least this long after a deploy: for a while after a new
 * version goes live, calls into Durable Objects that were running the old
 * code can fail with "Durable Object reset because its code was updated".
 */
export const DEPLOY_SETTLE_MS = 90_000;

/** How long a run waits before it starts (0 once the deploy has settled). */
export const settleWait = (record: ForgeRecord, now: number): number =>
	record.deployedAt === null
		? 0
		: Math.max(0, record.deployedAt + DEPLOY_SETTLE_MS - now);

export const parseForgeRecord = (text: string): ForgeRecord => {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(text);
	} catch {
		throw new GuardError(`record.${STAGE}.json is not JSON`);
	}
	if (value.stage !== STAGE) {
		throw new GuardError(`record.${STAGE}.json names another stage`);
	}
	if (value.domain !== null && value.domain !== undefined) {
		throw new GuardError("the dev-e2e forge must not have a custom domain");
	}
	const image = value.image as { variant?: unknown } | undefined;
	return {
		origin: assertForgeOrigin(String(value.workersDev ?? "")),
		setupState: String(value.setupState ?? "fresh"),
		containers: image?.variant !== "none",
		accountId: String(value.accountId ?? ""),
		commit: typeof value.commit === "string" &&
				/^[0-9a-f]{40}$/.test(value.commit)
			? value.commit
			: null,
		deployedAt: typeof value.deployedAt === "string" &&
				Number.isFinite(Date.parse(value.deployedAt))
			? Date.parse(value.deployedAt)
			: null,
		switches: switchesOfRecord(value),
	};
};

export const readForgeRecord = async (
	fs: StateFs,
	paths: StatePaths,
): Promise<ForgeRecord | null> => {
	const text = await fs.readText(paths.record);
	return text === null ? null : parseForgeRecord(text);
};

/**
 * The setup token from deploy's URL file: the exact dev-e2e path, mode 0600,
 * and a URL on the guarded forge origin. Returns null when there is no file.
 */
export const readSetupToken = async (
	fs: StateFs,
	paths: StatePaths,
	forgeOrigin: string,
): Promise<string | null> => {
	const mode = await fs.mode(paths.setupUrl);
	if (mode === null) return null;
	if (mode !== 0o600) {
		throw new GuardError(
			`setup-url.${STAGE}.txt has mode ${mode.toString(8)}, not 600`,
		);
	}
	const text = (await fs.readText(paths.setupUrl) ?? "").trim();
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new GuardError(`setup-url.${STAGE}.txt is not a URL`);
	}
	if (url.origin !== assertForgeOrigin(forgeOrigin)) {
		throw new GuardError(
			`setup-url.${STAGE}.txt is not on the dev-e2e forge origin`,
		);
	}
	const m = /^#t=([^&]+)$/.exec(url.hash);
	if (url.pathname !== "/-/setup" || m === null) {
		throw new GuardError(`setup-url.${STAGE}.txt is not a setup URL`);
	}
	const token = decodeURIComponent(m[1]);
	if (token.length < 16 || token.length > 512) {
		throw new GuardError("the setup token has an unexpected length");
	}
	return token;
};

export type StageState = {
	readonly upAt: string;
	readonly expiresAt: string;
};

export const readStageState = async (
	fs: StateFs,
	paths: StatePaths,
): Promise<StageState | null> => {
	const text = await fs.readText(paths.stage);
	if (text === null) return null;
	try {
		const v = JSON.parse(text);
		return typeof v.upAt === "string" && typeof v.expiresAt === "string"
			? { upAt: v.upAt, expiresAt: v.expiresAt }
			: null;
	} catch {
		return null;
	}
};

export const writeStageState = (
	fs: StateFs,
	paths: StatePaths,
	now: number,
): Promise<void> =>
	fs.writePrivate(
		paths.stage,
		`${
			JSON.stringify(
				{
					upAt: new Date(now).toISOString(),
					expiresAt: new Date(now + STAGE_TTL_MS).toISOString(),
				},
				null,
				"\t",
			)
		}\n`,
	);

/** A reminder line once the stage outlived its expiry, else null. */
export const expiryWarning = (
	state: StageState | null,
	now: number,
): string | null => {
	if (state === null) return null;
	const expires = Date.parse(state.expiresAt);
	return Number.isFinite(expires) && now > expires
		? `the dev-e2e stage came up at ${state.upAt} and expired at ${state.expiresAt}: run \`deno task e2e -- stage down\` when you are done (a public test forge with containers costs money and is an exposure on the account it runs in)`
		: null;
};
