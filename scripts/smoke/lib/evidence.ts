// Smoke results: every check prints PASS/FAIL with its numbers and is kept
// as JSON evidence under `scripts/smoke/evidence/<date>/<suite>.json`
// (redacted with the contract's `redactSecrets` before it is written; run
// the leak scan before sharing).

import { redactSecrets } from "@tartan/contract";

export type CheckResult = {
	/** Smoke id (A1, U45, S3-raw, …) plus a short case name. */
	readonly id: string;
	readonly title: string;
	readonly pass: boolean;
	/** Measured values (latencies, counts, codes). */
	readonly numbers: Readonly<Record<string, number | string | boolean | null>>;
	/** The switch or design fact this check decides, if any. */
	readonly decides?: string;
	readonly detail?: unknown;
};

export type Recorder = {
	check(result: CheckResult): CheckResult;
	/** Free-form evidence (raw responses, traces) kept with the suite. */
	note(key: string, value: unknown): void;
	readonly results: readonly CheckResult[];
	write(): Promise<string | null>;
};

const redactDeep = (value: unknown): unknown =>
	JSON.parse(redactSecrets(JSON.stringify(value ?? null)));

export const createRecorder = (
	suite: string,
	options: {
		readonly stage: string;
		/** Directory for evidence; null keeps results in memory only (tests). */
		readonly dir: string | null;
		readonly print?: (line: string) => void;
	},
): Recorder => {
	const results: CheckResult[] = [];
	const notes: Record<string, unknown> = {};
	const print = options.print ?? console.log;
	return {
		results,
		check: (result) => {
			results.push(result);
			const nums = Object.entries(result.numbers)
				.map(([k, v]) => `${k}=${v}`)
				.join(" ");
			print(
				redactSecrets(
					`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.title}${
						nums ? ` [${nums}]` : ""
					}${result.decides ? ` → ${result.decides}` : ""}`,
				),
			);
			return result;
		},
		note: (key, value) => {
			notes[key] = value;
		},
		write: async () => {
			if (options.dir === null) return null;
			const day = new Date().toISOString().slice(0, 10);
			const dir = `${options.dir}/${day}`;
			await Deno.mkdir(dir, { recursive: true });
			const file = `${dir}/${suite}-${options.stage}.json`;
			await Deno.writeTextFile(
				file,
				`${
					JSON.stringify(
						redactDeep({
							suite,
							stage: options.stage,
							at: new Date().toISOString(),
							results,
							notes,
						}),
						null,
						"\t",
					)
				}\n`,
			);
			return file;
		},
	};
};

/** p-th percentile (nearest rank) of `xs`, or null. */
export const pct = (xs: readonly number[], p: number): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export const timed = async <T>(
	fn: () => Promise<T>,
): Promise<
	{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string }
> => {
	const t0 = performance.now();
	try {
		const value = await fn();
		return { ok: true, ms: Math.round(performance.now() - t0), value };
	} catch (e) {
		const x = e as { code?: string; message?: string };
		return {
			ok: false,
			ms: Math.round(performance.now() - t0),
			error: redactSecrets(
				`${x.code ?? ""}${x.code ? ": " : ""}${x.message ?? e}`,
			),
		};
	}
};
