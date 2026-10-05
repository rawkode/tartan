// State shared by the tests of one run across e2e's worker processes, so a
// flow that spans several tests (the M1 loop, the changes group) can be
// built once and checked by independent tests: a failed check never skips
// the next one, and each test names the step it checks.
//
// - `once(key, work)`: the first caller (in any worker) runs `work` and
//   stores its JSON outcome; every other caller waits for that outcome and
//   gets the same value, or the same failure as a `StepFailed` naming the
//   step. The claim is an exclusive file create (`wx`), the outcome an atomic
//   rename, so two workers never both run a step.
// - `claimIndex(key)`: the n-th caller of a key gets n (0, 1, …). A test
//   claims its own title once per attempt, so with `--repeat-each` the r-th
//   repeat of every test of a flow works on flow instance r.
//
// Everything lives in `$TMPDIR/tartan-e2e-<runId>-shared/` (0700), outside
// the repository; the launcher removes it after the run. Values are ids and
// names only, never a token, cookie or password.
//
// Pure module (node:fs only): the Deno unit tests import it too.

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

export type Json =
	| string
	| number
	| boolean
	| null
	| { readonly [key: string]: Json }
	| readonly Json[];

/** The run's shared directory under the temp root `tmp`. */
export const sharedDirOf = (tmp: string, runId: string): string =>
	path.join(tmp, `tartan-e2e-${runId}-shared`);

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/** A file-safe key from free text (a test title): readable prefix + hash. */
export const keyOf = (text: string): string => {
	let h = 0x811c9dc5;
	for (const char of text) {
		h ^= char.codePointAt(0) ?? 0;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
		/^-+|-+$/g,
		"",
	).slice(0, 48) || "key";
	return `${slug}-${h.toString(16).padStart(8, "0")}`;
};

/** A step another test ran (or this one, earlier) failed; its message says which. */
export class StepFailed extends Error {
	override name = "StepFailed";
	constructor(readonly step: string, message: string) {
		super(`step "${step}" failed: ${message}`);
	}
}

type Outcome =
	| { readonly ok: true; readonly value: Json }
	| { readonly ok: false; readonly message: string };

const isExists = (error: unknown): boolean =>
	(error as { code?: unknown }).code === "EEXIST";
const isMissing = (error: unknown): boolean =>
	(error as { code?: unknown }).code === "ENOENT";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a waiter waits for another worker's outcome by default: longer
 * than any stage takes (the M1 loop's land waits up to 20 minutes after CI),
 * so the waiting test's own timeout is what bounds it.
 */
export const DEFAULT_WAIT_MS = 60 * 60_000;

export type Shared = {
	readonly once: <T extends Json>(
		key: string,
		work: () => Promise<T>,
		options?: { readonly waitMs?: number },
	) => Promise<T>;
	readonly claimIndex: (key: string) => Promise<number>;
	/** True once `once(key)` has an outcome (in any worker). */
	readonly settled: (key: string) => Promise<boolean>;
	/** Sets a flag (idempotent). */
	readonly mark: (key: string) => Promise<void>;
	/** True once `mark(key)` ran in any worker. */
	readonly has: (key: string) => Promise<boolean>;
};

/** A shared store in `dir` (created 0700 on first use). */
export const createShared = (
	dir: string,
	options: { readonly pollMs?: number; readonly now?: () => number } = {},
): Shared => {
	const pollMs = options.pollMs ?? 500;
	const now = options.now ?? Date.now;
	const local = new Map<string, Promise<Json>>();
	let made: Promise<void> | null = null;
	const ensureDir = () =>
		made ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {});
	const file = (key: string, ext: string) => {
		if (!KEY_RE.test(key)) throw new Error(`a bad shared key ${key}`);
		return path.join(dir, `${key}.${ext}`);
	};
	const createExclusive = async (target: string): Promise<boolean> => {
		try {
			const handle = await open(target, "wx", 0o600);
			await handle.close();
			return true;
		} catch (error) {
			if (isExists(error)) return false;
			throw error;
		}
	};
	const readOutcome = async (key: string): Promise<Outcome | null> => {
		try {
			return JSON.parse(await readFile(file(key, "json"), "utf8")) as Outcome;
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	};
	const writeOutcome = async (key: string, outcome: Outcome) => {
		const target = file(key, "json");
		const temp = `${target}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify(outcome), { mode: 0o600 });
		await rename(temp, target);
	};
	const settle = (key: string, outcome: Outcome): Json => {
		if (outcome.ok) return outcome.value;
		throw new StepFailed(key, outcome.message);
	};

	const run = async (
		key: string,
		work: () => Promise<Json>,
		waitMs: number,
	): Promise<Json> => {
		await ensureDir();
		if (await createExclusive(file(key, "lock"))) {
			let outcome: Outcome;
			try {
				outcome = { ok: true, value: await work() };
			} catch (error) {
				outcome = {
					ok: false,
					message: error instanceof StepFailed
						? error.message
						: (error as Error).message ?? String(error),
				};
			}
			await writeOutcome(key, outcome);
			return settle(key, outcome);
		}
		const deadline = now() + waitMs;
		for (;;) {
			const outcome = await readOutcome(key);
			if (outcome !== null) return settle(key, outcome);
			if (now() > deadline) {
				throw new StepFailed(
					key,
					`no outcome after ${
						Math.round(waitMs / 1000)
					} s (the test running it is still busy or died)`,
				);
			}
			await sleep(pollMs);
		}
	};

	return {
		once: <T extends Json>(
			key: string,
			work: () => Promise<T>,
			opts: { readonly waitMs?: number } = {},
		): Promise<T> => {
			let pending = local.get(key);
			if (pending === undefined) {
				pending = run(key, work, opts.waitMs ?? DEFAULT_WAIT_MS);
				local.set(key, pending);
			}
			return pending as Promise<T>;
		},
		claimIndex: async (key: string): Promise<number> => {
			await ensureDir();
			for (let i = 0; i < 1000; i++) {
				if (await createExclusive(file(key, `${i}.claim`))) return i;
			}
			throw new Error(`more than 1000 claims of ${key}`);
		},
		settled: async (key: string): Promise<boolean> =>
			(await readOutcome(key)) !== null,
		mark: async (key: string): Promise<void> => {
			await ensureDir();
			await createExclusive(file(key, "mark"));
		},
		has: async (key: string): Promise<boolean> => {
			try {
				await readFile(file(key, "mark"));
				return true;
			} catch (error) {
				if (isMissing(error)) return false;
				throw error;
			}
		},
	};
};
