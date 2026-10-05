// `tartan credential`: a git credential helper (WP11). For any URL on a forge
// you logged in to (the repo's git URL and every lane remote
// `/<repo>/-/lanes/<id>.git` share the host), git gets the token as the Basic
// password; for any other host the helper answers nothing, so git asks the next
// helper. `store` and `erase` are no-ops: the token lives in the CLI config (or
// `TARTAN_TOKEN`), never in git's stores.

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

/** How this CLI is invoked again (hooks, the credential helper). */
export const invocation = (): string[] => {
	const exec = Deno.execPath();
	const base = exec.slice(exec.lastIndexOf("/") + 1);
	if (base !== "deno" && base !== "deno.exe") return [exec];
	const main = new URL("./main.ts", import.meta.url);
	return [exec, "run", "-A", decodeURIComponent(main.pathname)];
};

/** POSIX single-quoting for a hook or a `!`-helper command line. */
export const shellQuote = (arg: string): string =>
	`'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * `git config [--global] credential.<origin>.helper`: the helper list for
 * that origin is reset first (an empty value), so a keychain helper cannot
 * answer with a stale password before this one.
 */
export const installCredentialHelper = async (
	git: Git,
	origin: string,
	options: { readonly global: boolean; readonly command?: string[] },
): Promise<string> => {
	const scope = options.global ? ["--global"] : [];
	const key = `credential.${origin}.helper`;
	const command = (options.command ?? invocation()).map(shellQuote).join(" ");
	const value = `!${command} credential`;
	await git(["config", ...scope, "--unset-all", key]);
	await gitOk(git, ["config", ...scope, "--add", key, ""]);
	await gitOk(git, ["config", ...scope, "--add", key, value]);
	return value;
};
