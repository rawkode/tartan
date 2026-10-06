// git for the suites, hermetic and with the token out of sight:
//
// - The token is never in argv, a remote URL or `.git/config`. It reaches git
//   through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` as an `Authorization: Bearer`
//   header scoped to the forge origin (`http.<origin>/.extraHeader`), so git
//   sends it nowhere else.
// - The environment is built from scratch: `HOME` is the test's temporary
//   directory, no system or global config, no credential helper, no prompt,
//   a fixed author and committer, and only `PATH` and the temp variables
//   from the parent. `GIT_TRACE*`, `GIT_CURL_VERBOSE` and `GIT_ASKPASS` are
//   never set.
// - stdout and stderr are scrubbed (the token, `Bearer` values and Tartan
//   token shapes) before anything sees them; assertions and errors use the
//   scrubbed text only.
//
// `parseGitCommands` turns a lane handle's `git.start`/`git.push` text into
// argv lists without a shell: only `git fetch|switch|checkout|push` with
// plain arguments are accepted, so a command from the forge cannot run
// anything else.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { devNull } from "node:os";
import process from "node:process";

export const AUTHOR = {
	name: "Tartan e2e",
	email: "e2e@tartan.invalid",
} as const;

export type GitAuth = {
	readonly origin: string;
	readonly token: string;
};

/** A git timestamp (`@<seconds> +0000`) for author and committer dates. */
export const gitDate = (seconds: number): string => `@${seconds} +0000`;

export const gitEnv = (input: {
	readonly home: string;
	readonly auth?: GitAuth;
	/** Author and committer date (`gitDate`); git's clock otherwise. */
	readonly date?: string;
	readonly parent?: Readonly<Record<string, string | undefined>>;
}): Record<string, string> => {
	const parent = input.parent ?? process.env;
	const config: [string, string][] = [
		["credential.helper", ""],
		["commit.gpgsign", "false"],
		["tag.gpgsign", "false"],
		["init.defaultBranch", "main"],
		["core.autocrlf", "false"],
		["advice.detachedHead", "false"],
		...(input.auth === undefined ? [] : [[
			`http.${input.auth.origin}/.extraHeader`,
			`Authorization: Bearer ${input.auth.token}`,
		] as [string, string]]),
	];
	const env: Record<string, string> = {
		HOME: input.home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: devNull,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: AUTHOR.name,
		GIT_AUTHOR_EMAIL: AUTHOR.email,
		GIT_COMMITTER_NAME: AUTHOR.name,
		GIT_COMMITTER_EMAIL: AUTHOR.email,
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_COUNT: String(config.length),
	};
	config.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key;
		env[`GIT_CONFIG_VALUE_${i}`] = value;
	});
	for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
		const value = parent[name];
		if (value !== undefined) env[name] = value;
	}
	if (input.date !== undefined) {
		env.GIT_AUTHOR_DATE = input.date;
		env.GIT_COMMITTER_DATE = input.date;
	}
	return env;
};

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes the token (and anything shaped like a Tartan credential) from git output. */
export const scrubber = (token?: string) => {
	const exact = token === undefined || token.length < 6
		? []
		: [token, encodeURIComponent(token)].map((t) =>
			new RegExp(escapeRegExp(t), "g")
		);
	return (text: string): string => {
		let out = text;
		for (const re of exact) out = out.replace(re, "<token>");
		return out
			.replace(/t(?:pat|agt)_[A-Za-z0-9_-]{43}/g, "<token>")
			.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<token>")
			.replace(/(__Host-tartan-[a-z0-9-]+=)[^;\s"']+/g, "$1<cookie>");
	};
};

/**
 * How long one git command may run: well inside a test's own timeout, so a
 * git call that never ends fails the test with a reason instead of
 * timing it out.
 */
export const GIT_TIMEOUT_MS = 60_000;

export type GitResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

/** Runs git with `env` (from `gitEnv`); the output is scrubbed of `token`. */
export const git = (
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
		readonly token?: string;
		readonly timeoutMs?: number;
	},
): Promise<GitResult> =>
	new Promise((resolve, reject) => {
		const scrub = scrubber(options.token);
		// Its own process group: a timeout kills git and its transport
		// helper (git-remote-https), which otherwise holds the pipes open,
		// so `close` never comes and the call hangs past its limit.
		const child = spawn("git", [...args], {
			cwd: options.cwd,
			env: { ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		const limit = options.timeoutMs ?? GIT_TIMEOUT_MS;
		let killed = false;
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stderr = scrub(Buffer.concat(err).toString("utf8"));
			resolve({
				code: code ?? 1,
				stdout: scrub(Buffer.concat(out).toString("utf8")),
				stderr: killed
					? `${stderr}\n(git ${args[0] ?? ""} was killed after ${
						limit / 1000
					} s)`
					: stderr,
			});
		};
		const timer = setTimeout(() => {
			killed = true;
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, limit);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new Error(`git ${args[0] ?? ""} could not start: ${error.message}`),
			);
		});
		// After a kill, a helper that escaped the group may still hold the
		// pipes: settle on exit, a moment later, whatever they do.
		child.on("exit", (code) => {
			if (!killed) return;
			setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				finish(code);
			}, 2_000);
		});
		child.on("close", (code) => finish(code));
	});

/** `git` that must succeed; the error carries the scrubbed stderr only. */
export const gitOk = async (
	args: readonly string[],
	options: Parameters<typeof git>[1],
): Promise<string> => {
	const result = await git(args, options);
	if (result.code !== 0) {
		throw new Error(
			`git ${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim()}`,
		);
	}
	return result.stdout;
};

const SUBCOMMANDS: ReadonlySet<string> = new Set([
	"fetch",
	"switch",
	"checkout",
	"push",
]);
const ARG_RE = /^[A-Za-z0-9_./:@=+%,~^-]+$/;

/**
 * A lane handle command (`git fetch origin && git switch -c lanes/x <sha>`)
 * as argv lists, without a shell. Throws on anything but plain
 * `git fetch|switch|checkout|push` invocations.
 */
export const parseGitCommands = (text: string): string[][] =>
	text.split("&&").map((part) => {
		const words = part.trim().split(/\s+/).filter((w) => w !== "");
		if (words[0] !== "git" || !SUBCOMMANDS.has(words[1] ?? "")) {
			throw new Error("a lane command that is not git fetch, switch or push");
		}
		for (const word of words) {
			if (!ARG_RE.test(word)) {
				throw new Error("a lane command with an unexpected character");
			}
		}
		return words.slice(1);
	});
