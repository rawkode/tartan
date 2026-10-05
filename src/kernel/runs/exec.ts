// `GitExec` for the warm `git:<repoId>` sandboxes.
//
// Every exec of one sandbox runs under one in-memory FIFO mutex, blame
// included, so nothing that parses agent-controlled objects runs while a
// write token is present, and the `pkill -KILL -u tartan-git` that precedes
// a `tartan-push` exec can never kill a sibling exec's fetch (two pushes
// started together run one after the other). Content-parsing execs run as
// `tartan-git`; an exec with `uid: "tartan-push"` (it carries a write token
// in its env) runs after the kill. Output is redacted before it leaves the
// sandbox DO. Mirrors shared by both uids must be created group-shared
// (`git init --bare --shared=group` under `/srv`, which the runner image
// makes `root:tartan`, mode 2775).

import { invalid } from "@tartan/contract";
import type { GitExecOptions, GitExecResult } from "@tartan/contract/kernel.ts";
import { withStartRetries } from "./jobs.ts";
import { safeText } from "./joblog.ts";
import { asUid, KILL_CONTENT_UID, RUNNER_HOME, RUNNER_UIDS } from "./shell.ts";

/** Warm sandboxes sleep after 10 idle minutes. */
export const WARM_SLEEP_AFTER = "10m";
/** `stdin` travels base64-encoded in one env var (Linux caps one at 128 KiB). */
export const MAX_STDIN_BYTES = 96 * 1024;
const OUTPUT_MAX_BYTES = 1024 * 1024;

/** A FIFO async mutex: `run(fn)` starts `fn` after every earlier call settled. */
export const createMutex = () => {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(() => undefined, () => undefined);
		return run;
	};
};

export type WarmPort = {
	exec(
		command: string,
		options?: {
			env?: Readonly<Record<string, string>>;
			cwd?: string;
			timeoutMs?: number;
		},
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** `keepAlive: false`, `sleepAfter: 10m` (once per DO instance). */
	warm(): Promise<void>;
};

const base64Utf8 = (text: string): string => {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
};

export type SerializedGitExec = {
	exec(
		argv: readonly string[],
		options?: GitExecOptions,
	): Promise<GitExecResult>;
};

export const createSerializedGitExec = (deps: {
	readonly port: WarmPort;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}): SerializedGitExec => {
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const lock = createMutex();
	let warmed = false;

	const exec = (
		argv: readonly string[],
		options: GitExecOptions = {},
	): Promise<GitExecResult> => {
		if (!Array.isArray(argv) || argv.length === 0) {
			return Promise.reject(invalid("argv required"));
		}
		const uid = options.uid ?? "tartan-git";
		if (!(RUNNER_UIDS as readonly string[]).includes(uid)) {
			return Promise.reject(invalid(`unknown uid ${uid}`));
		}
		return lock(async () => {
			if (!warmed) {
				await withStartRetries(() => deps.port.warm(), sleep);
				warmed = true;
			}
			const started = now();
			if (uid === "tartan-push") {
				await deps.port.exec(KILL_CONTENT_UID);
			}
			const env: Record<string, string> = {
				HOME: RUNNER_HOME[uid],
				...(options.env ?? {}),
			};
			let command = asUid(uid, argv);
			if (options.stdin !== undefined) {
				const encoded = base64Utf8(options.stdin);
				if (encoded.length > MAX_STDIN_BYTES) throw invalid("stdin too large");
				env.TARTAN_STDIN_B64 = encoded;
				command = `printf %s "$TARTAN_STDIN_B64" | base64 -d | ${command}`;
			}
			const out = await deps.port.exec(command, {
				env,
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
				...(options.timeoutMs !== undefined
					? { timeoutMs: options.timeoutMs }
					: {}),
			});
			return {
				exitCode: out.exitCode,
				stdout: safeText(out.stdout, OUTPUT_MAX_BYTES),
				stderr: safeText(out.stderr, OUTPUT_MAX_BYTES),
				durationMs: now() - started,
			};
		});
	};

	return { exec };
};
