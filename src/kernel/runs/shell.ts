// Command construction for TartanSandbox.
//
// The Sandbox SDK takes one shell string per exec, while the kernel's
// `GitExec` contract takes an argv. Every argv is quoted here, so no caller
// string is ever interpreted by the shell. Each command runs as one of the
// image's unprivileged users through `setpriv` (util-linux), which keeps the
// per-exec environment: `tartan-git` for anything that parses repository
// content or runs CI code (read tokens at most), `tartan-push` for an exec
// that carries a write token, always after `pkill -KILL -u tartan-git` so no
// earlier process can read the token from `/proc/<pid>/environ`.
// Credentials reach git only as `GIT_CONFIG_COUNT/KEY/VALUE`
// `http.<remote>.extraHeader` entries in that one exec's environment.

import { UPSTREAM_AUTH } from "../../constants.ts";

export const RUNNER_UIDS = ["tartan-git", "tartan-push"] as const;
export type RunnerUid = typeof RUNNER_UIDS[number];

/** Workspace root inside the runner image (owned per run by `tartan-git`). */
export const WORKSPACE_ROOT = "/workspace";
/** Home directories created by the runner image's Dockerfile. */
export const RUNNER_HOME: Readonly<Record<RunnerUid, string>> = {
	"tartan-git": "/home/tartan-git",
	"tartan-push": "/home/tartan-push",
};

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote quoting; safe words stay bare for readable logs. */
export const shellQuote = (word: string): string =>
	word !== "" && SAFE_WORD.test(word)
		? word
		: `'${word.replaceAll("'", `'"'"'`)}'`;

export const argvToCommand = (argv: readonly string[]): string => {
	if (argv.length === 0) throw new Error("empty argv");
	return argv.map(shellQuote).join(" ");
};

/** `setpriv` prefix that drops root to `uid` with its own groups, keeping env. */
export const asUid = (
	uid: RunnerUid,
	argv: readonly string[],
	options: { readonly noNewPrivs?: boolean } = {},
): string =>
	argvToCommand([
		"setpriv",
		`--reuid=${uid}`,
		`--regid=${uid}`,
		"--init-groups",
		// No setuid binary in the image can raise the job's privileges again.
		...(options.noNewPrivs === true ? ["--no-new-privs"] : []),
		"--",
		...argv,
	]);

/** A CI `run` string executed by bash as `uid` (the string is one argv word). */
export const shellAsUid = (uid: RunnerUid, script: string): string =>
	asUid(uid, ["bash", "-eo", "pipefail", "-c", script]);

/**
 * Kills every process of `tartan-git` before a write-token exec.
 * `pkill` exits 1 when nothing matched, which is success here.
 */
export const KILL_CONTENT_UID = "pkill -KILL -u tartan-git; true";

/** One credential for one remote. */
export type RemoteCredential = {
	readonly remote: string;
	readonly token: string;
};

/** The `Authorization` value git sends for an Artifacts token (`UPSTREAM_AUTH`). */
export const authHeader = (token: string): string =>
	UPSTREAM_AUTH === "bearer"
		? `Authorization: Bearer ${token}`
		: `Authorization: Basic ${
			btoa(`x:${token.replace(/\?expires=[0-9]+$/, "")}`)
		}`;

/**
 * `GIT_CONFIG_COUNT/KEY_n/VALUE_n` for one exec: an `extraHeader` per
 * remote, plus non-interactive defaults. Never written to argv or files.
 */
export const gitAuthEnv = (
	credentials: readonly RemoteCredential[],
): Record<string, string> => {
	const pairs: [string, string][] = [
		["credential.helper", ""],
		["protocol.version", "2"],
		...credentials.map((c): [string, string] => [
			`http.${c.remote}.extraHeader`,
			authHeader(c.token),
		]),
	];
	const env: Record<string, string> = {
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: String(pairs.length),
	};
	pairs.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key;
		env[`GIT_CONFIG_VALUE_${i}`] = value;
	});
	return env;
};

/** A relative path inside the checkout (no absolute paths, no `..`). */
export const safeRelativePath = (path: string): string | null => {
	const trimmed = path.replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (trimmed === "" || trimmed === ".") return "";
	if (trimmed.startsWith("/") || trimmed.includes("\0")) return null;
	const parts = trimmed.split("/");
	return parts.some((p) => p === ".." || p === "") ? null : parts.join("/");
};
