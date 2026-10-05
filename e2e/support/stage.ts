// The run's values, as the launcher (`scripts/e2e/main.ts`, `e2e-cli.ts`)
// passes them to the e2e process: `TARTAN_E2E_*` variables, read and checked
// here before the config registers anything. Anything that does not name the
// dev-e2e forge and the mock IdP on workers.dev, or a malformed password or
// token, stops the config load, so `npx e2e run` from a shell without the
// launcher fails closed instead of reaching some other host.
//
// Pure module (no e2e runtime import): the Deno unit tests import it too.
// The patterns match `scripts/e2e/guards.ts` and `tools/mock-idp/src/config.ts`
// (`scripts/e2e/support.test.ts` keeps them equal).

import process from "node:process";

export const FORGE_ORIGIN_RE =
	/^https:\/\/tartan-dev-e2e\.[a-z0-9-]+\.workers\.dev$/;
export const ISSUER_RE =
	/^https:\/\/tartan-e2e--idp\.[a-z0-9-]+\.workers\.dev$/;
export const RUN_ID_RE = /^r\d{12}[0-9a-f]{4}$/;
/** `base64url(HMAC-SHA256(seed, …))`: 43 characters (tools/mock-idp/src/password.ts). */
export const PASSWORD_RE = /^[A-Za-z0-9_-]{43}$/;
export const PAT_RE = /^tpat_[A-Za-z0-9_-]{43}$/;
export const AGENT_TOKEN_RE = /^tagt_[A-Za-z0-9_-]{43}$/;

export const PERSONAS = ["owner", "developer", "reporter", "outsider"] as const;
export type Persona = (typeof PERSONAS)[number];
/** The personas with a saved browser session (`tests/auth.setup.e2e.ts`). */
export const SIGNED_IN = ["owner", "developer", "reporter"] as const;
export type SignedIn = (typeof SIGNED_IN)[number];

export const usernameOf = (persona: Persona): string => `e2e-${persona}`;

export type RunTokens = {
	/** `api`, `repo:read`, `repo:write`, `admin` on `e2e` (the forge owner; `admin` for `import-complete`). */
	readonly ownerPat: string;
	/** `repo:read`, `repo:write` on `e2e`; the Reporter role refuses its pushes. */
	readonly reporterPat: string;
	/** The Developer's `repo:read`-only PAT on `e2e`; the scope refuses its pushes. */
	readonly readPat: string;
	/** Agent A, `tagt_`: `repo:read`, `repo:write`, `lanes`, `mcp` on `e2e`, Developer. */
	readonly developerAgent: string;
	/** Agent B: a second agent of the same Developer, with the same grants. */
	readonly developerAgentB: string;
};

/**
 * The run's token variables (`scripts/e2e/e2e-cli.ts` `TOKEN_ENV` writes
 * them; `scripts/e2e/support.test.ts` keeps the two equal) and their shapes.
 */
export const TOKEN_VARS: Readonly<
	Record<keyof RunTokens, { readonly name: string; readonly re: RegExp }>
> = {
	ownerPat: { name: "TARTAN_E2E_OWNER_PAT", re: PAT_RE },
	reporterPat: { name: "TARTAN_E2E_REPORTER_PAT", re: PAT_RE },
	readPat: { name: "TARTAN_E2E_READ_PAT", re: PAT_RE },
	developerAgent: { name: "TARTAN_E2E_DEVELOPER_AGENT", re: AGENT_TOKEN_RE },
	developerAgentB: {
		name: "TARTAN_E2E_DEVELOPER_AGENT_B",
		re: AGENT_TOKEN_RE,
	},
};

export type Stage = {
	readonly origin: string;
	readonly issuer: string;
	readonly runId: string;
	/** False when the stage was deployed with `--no-containers`. */
	readonly containers: boolean;
	readonly passwords: Readonly<Record<Persona, string>>;
	/** Absent for `e2e list` and the claim run (phase A). */
	readonly tokens?: RunTokens;
	/** Phase A only. */
	readonly setupToken?: string;
};

export class StageError extends Error {
	override name = "StageError";
}

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
	const value = env[name];
	if (value === undefined || value === "") {
		throw new StageError(
			`${name} is not set: run the suites with \`deno task e2e\`, which sets the run's values`,
		);
	}
	return value;
};

const checked = (env: Env, name: string, re: RegExp, what: string): string => {
	const value = required(env, name);
	if (!re.test(value)) throw new StageError(`${name} is not ${what}`);
	return value;
};

const optionalToken = (env: Env, name: string, re: RegExp): string | null => {
	const value = env[name];
	if (value === undefined || value === "") return null;
	if (!re.test(value)) throw new StageError(`${name} is malformed`);
	return value;
};

/** Reads and checks the run's values; throws `StageError` naming the variable, never its value. */
export const readStage = (env: Env = process.env): Stage => {
	const origin = checked(
		env,
		"TARTAN_E2E_ORIGIN",
		FORGE_ORIGIN_RE,
		"https://tartan-dev-e2e.<subdomain>.workers.dev",
	);
	const issuer = checked(
		env,
		"TARTAN_E2E_ISSUER",
		ISSUER_RE,
		"https://tartan-e2e--idp.<subdomain>.workers.dev",
	);
	if (
		new URL(origin).hostname.split(".")[1] !==
			new URL(issuer).hostname.split(".")[1]
	) {
		throw new StageError(
			"the forge and the mock IdP are not on the same workers.dev subdomain",
		);
	}
	const runId = checked(env, "TARTAN_E2E_RUN_ID", RUN_ID_RE, "a run id");
	const containers = required(env, "TARTAN_E2E_CONTAINERS");
	if (containers !== "0" && containers !== "1") {
		throw new StageError("TARTAN_E2E_CONTAINERS is not 0 or 1");
	}
	const passwords = Object.fromEntries(
		PERSONAS.map((p) => [
			p,
			checked(
				env,
				`TARTAN_E2E_PASSWORD_${p.toUpperCase()}`,
				PASSWORD_RE,
				"a derived IdP password",
			),
		]),
	) as Record<Persona, string>;
	const keys = Object.keys(TOKEN_VARS) as (keyof RunTokens)[];
	const values = keys.map((k) =>
		[k, optionalToken(env, TOKEN_VARS[k].name, TOKEN_VARS[k].re)] as const
	);
	const present = values.filter(([, v]) => v !== null);
	if (present.length !== 0 && present.length !== keys.length) {
		throw new StageError("the run's tokens are incomplete");
	}
	const tokens = present.length === 0
		? null
		: Object.fromEntries(values) as unknown as RunTokens;
	const setupToken = env["TARTAN_E2E_SETUP_TOKEN"];
	if (
		setupToken !== undefined && setupToken !== "" &&
		(setupToken.length < 16 || setupToken.length > 512)
	) {
		throw new StageError("TARTAN_E2E_SETUP_TOKEN has an unexpected length");
	}
	return {
		origin,
		issuer,
		runId,
		containers: containers === "1",
		passwords,
		...(tokens === null ? {} : { tokens }),
		...(setupToken !== undefined && setupToken !== "" ? { setupToken } : {}),
	};
};

/** The run's tokens; a test that needs them fails clearly without them. */
export const tokensOf = (stage: Stage): RunTokens => {
	if (stage.tokens === undefined) {
		throw new StageError(
			"this test needs the run's tokens: run it with `deno task e2e -- run`",
		);
	}
	return stage.tokens;
};

let cached: Stage | null = null;

/** The stage of this process (read once). */
export const stage = (): Stage => (cached ??= readStage());
