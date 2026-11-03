// `tt auth git-credential`: a git credential helper. For any URL on a forge you
// logged in to (the repo's git URL and every lane remote
// `/<repo>/-/lanes/<id>.git` share the host), git gets the token as the Basic
// password; for any other host the helper answers nothing, so git asks the next
// helper. `store` and `erase` are no-ops: the token lives in the `tt` config
// (or `TARTAN_TOKEN`), never in git's stores.

import {
	type CliConfig,
	type CliEnv,
	originOf,
	resolveCredential,
	tokenKind,
} from "./config.ts";
import { type Git, gitOk } from "./git.ts";

/** Parses git's `key=value` credential description (up to a blank line). */
export const parseCredentialInput = (
	input: string,
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const line of input.split(/\r?\n/)) {
		if (line === "") break;
		const eq = line.indexOf("=");
		if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return out;
};

/** The helper's answer to `get` (empty when the host is not a known forge). */
export const credentialAnswer = (
	request: Record<string, string>,
	config: CliConfig,
	env: CliEnv,
): string => {
	const { protocol, host } = request;
	if (protocol !== "https" && protocol !== "http") return "";
	if (host === undefined || host === "") return "";
	let origin: string;
	try {
		origin = originOf(`${protocol}://${host}`);
	} catch {
		return "";
	}
	// `resolveCredential` answers only for a configured forge, or for the
	// forge `TARTAN_TOKEN` belongs to (`TARTAN_URL` / the default).
	const credential = resolveCredential(config, env, origin);
	if (credential === null) return "";
	const username = tokenKind(credential.token) === "agent" ? "agent" : "tartan";
	return `username=${username}\npassword=${credential.token}\n`;
};

/** How `tt` is invoked again (by git, as the credential helper). */
export const invocation = (): string[] => {
	const exec = Deno.execPath();
	const base = exec.slice(exec.lastIndexOf("/") + 1);
	if (base !== "deno" && base !== "deno.exe") return [exec];
	const main = new URL("./main.ts", import.meta.url);
	return [exec, "run", "-A", decodeURIComponent(main.pathname)];
};

/** POSIX single-quoting for a `!`-helper command line. */
export const shellQuote = (arg: string): string =>
	`'${arg.replaceAll("'", `'\\''`)}'`;

/** The `credential.<origin>.helper` value that runs `tt auth git-credential`. */
export const helperValue = (command: readonly string[] = invocation()) =>
	`!${command.map(shellQuote).join(" ")} auth git-credential`;

export const helperKey = (origin: string) => `credential.${origin}.helper`;

/** Whether git (any scope) already asks `tt` for this origin. */
export const helperConfigured = async (
	git: Git,
	origin: string,
): Promise<boolean> => {
	const out = await git(["config", "--get-all", helperKey(origin)]);
	return out.code === 0 &&
		out.stdout.split("\n").some((v) => v.endsWith(" auth git-credential"));
};

/**
 * `git config --global credential.<origin>.helper`: the helper list for that
 * origin is reset first (an empty value), so a keychain helper cannot answer
 * with a stale password before this one.
 */
export const installCredentialHelper = async (
	git: Git,
	origin: string,
): Promise<string> => {
	const key = helperKey(origin);
	const value = helperValue();
	await git(["config", "--global", "--unset-all", key]);
	await gitOk(git, ["config", "--global", "--add", key, ""]);
	await gitOk(git, ["config", "--global", "--add", key, value]);
	return value;
};
