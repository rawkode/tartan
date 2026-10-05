// How the launcher starts the e2e CLI (Node): the pinned `bin.js` under the
// shared node_modules, the one config, and the run's values passed as
// `TARTAN_E2E_*` variables for that child only. The config reads them,
// guards them (e2e/support/stage.ts) and registers every password and token
// as a static e2e credential or secret, so e2e redacts them from the first
// test on.

import { type PersonaName, PERSONAS } from "../../tools/mock-idp/src/users.ts";
import { GuardError } from "./guards.ts";
import { bins, type MaskedRun } from "./proc.ts";
import type { RunCredentials } from "./provision.ts";

export type E2eEnvInput = {
	readonly origin: string;
	readonly issuer: string;
	readonly runId: string;
	readonly containers: boolean;
	readonly passwords: Readonly<Record<PersonaName, string>>;
	readonly creds?: RunCredentials;
	/** Phase A (the claim) only. */
	readonly setupToken?: string;
};

/** The run's token variables, as `e2e/support/stage.ts` reads them. */
export const TOKEN_ENV = {
	ownerPat: "TARTAN_E2E_OWNER_PAT",
	reporterPat: "TARTAN_E2E_REPORTER_PAT",
	readPat: "TARTAN_E2E_READ_PAT",
	developerAgent: "TARTAN_E2E_DEVELOPER_AGENT",
	developerAgentB: "TARTAN_E2E_DEVELOPER_AGENT_B",
} as const satisfies Readonly<Record<keyof RunTokens, string>>;

type RunTokens = Pick<
	RunCredentials,
	"ownerPat" | "reporterPat" | "readPat" | "developerAgent" | "developerAgentB"
>;

export const e2eEnv = (input: E2eEnvInput): Record<string, string> => ({
	TARTAN_E2E_ORIGIN: input.origin,
	TARTAN_E2E_ISSUER: input.issuer,
	TARTAN_E2E_RUN_ID: input.runId,
	TARTAN_E2E_CONTAINERS: input.containers ? "1" : "0",
	...Object.fromEntries(
		PERSONAS.map((p) => [
			`TARTAN_E2E_PASSWORD_${p.toUpperCase()}`,
			input.passwords[p],
		]),
	),
	...(input.creds === undefined ? {} : Object.fromEntries(
		(Object.keys(TOKEN_ENV) as (keyof RunTokens)[]).map((
			k,
		) => [TOKEN_ENV[k], input.creds![k]]),
	)),
	...(input.setupToken === undefined
		? {}
		: { TARTAN_E2E_SETUP_TOKEN: input.setupToken }),
});

const SECRET_ENV_RE = new RegExp(
	`^(?:TARTAN_E2E_PASSWORD_[A-Z]+|TARTAN_E2E_SETUP_TOKEN|${
		Object.values(TOKEN_ENV).join("|")
	})$`,
);

/** Every secret value in an e2e env (for the masker and the leak scan). */
export const secretValues = (env: Readonly<Record<string, string>>): string[] =>
	Object.entries(env).filter(([k]) => SECRET_ENV_RE.test(k)).map(([, v]) => v);

/** The flags whose values are comma-separated lists the launcher merges. */
const LIST_FLAGS = ["--exclude-tag", "--reporter"] as const;
type ListFlag = typeof LIST_FLAGS[number];

const split = (value: string): string[] =>
	value.split(",").map((v) => v.trim()).filter((v) => v !== "");

/**
 * The values of a comma-separated, repeatable flag (`--x a,b`, `--x=c`,
 * `--x d`), and the arguments without it.
 */
export const takeListFlag = (
	args: readonly string[],
	flag: ListFlag,
): { values: string[]; rest: string[] } => {
	const values: string[] = [];
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === flag) {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) {
				throw new GuardError(`${flag} needs a value`);
			}
			values.push(...split(value));
			i++;
		} else if (a.startsWith(`${flag}=`)) {
			values.push(...split(a.slice(flag.length + 1)));
		} else {
			rest.push(a);
		}
	}
	return { values, rest };
};

const union = (base: readonly string[], extra: readonly string[]): string[] => [
	...new Set([...base, ...extra]),
];

/** The reporters every run needs: `evidence` and the summary read their files. */
export const REQUIRED_REPORTERS = ["list", "junit", "markdown"] as const;

/**
 * When a run stops early. A shared setup that fails fails every test waiting
 * on it at once (support/shared.ts): the S2-rem rows (35), the changes
 * suite (10) and the M1 loop (9). A low stop would let one transient error in
 * a shared setup end a run with most tests never started, so the stop leaves
 * room for the largest suite's whole group plus a few more and
 * still ends a broken deploy, whose tests then fail fast on their shared
 * steps, well before the whole run.
 */
export const MAX_FAILURES = 50;

/**
 * The caller's `run` flags merged with the defaults: the replay cache always
 * off; quarantined and claim tests always excluded (with `--repeat-each`,
 * tests tagged `rate-limited` too: setup unlock and IdP sign-in failures
 * allow a few attempts per 10 minutes per address), plus any tags the caller
 * excludes; a stop after `MAX_FAILURES` failures unless the caller sets one;
 * and the list, junit and markdown reporters plus any the caller adds.
 */
export const runArgs = (args: readonly string[]): string[] => {
	const excluded = takeListFlag(args, "--exclude-tag");
	const reporters = takeListFlag(excluded.rest, "--reporter");
	const rest = reporters.rest;
	const has = (flag: string) =>
		rest.some((a) => a === flag || a.startsWith(`${flag}=`));
	const defaults = [
		"quarantine",
		"claim",
		...(has("--repeat-each") ? ["rate-limited"] : []),
	];
	// Defaults first: `--trace` and `--video` take an optional, greedy value,
	// so nothing may follow a bare one the caller wrote last.
	return [
		...(has("--no-cache") ? [] : ["--no-cache"]),
		"--exclude-tag",
		union(defaults, excluded.values).join(","),
		...(has("--max-failures") ? [] : ["--max-failures", String(MAX_FAILURES)]),
		"--reporter",
		union(REQUIRED_REPORTERS, reporters.values).join(","),
		...rest,
	];
};

export const runE2e = (
	run: MaskedRun,
	root: string,
	command: "run" | "list",
	args: readonly string[],
	env: Readonly<Record<string, string>>,
): Promise<number> => {
	const b = bins(root);
	return run("node", [b.e2e, command, "--config", b.e2eConfig, ...args], {
		cwd: root,
		env,
	});
};
