// Assertions for the queue tests. Extensions import only `@tartan/contract`
// and `@tartan/ext-api`, so no std assert module here.
// Shared verbatim with `extensions/fifo/test/assert.ts` (drift-checked).

const show = (v: unknown): string => JSON.stringify(v, null, 1);

export const equal = (actual: unknown, expected: unknown, msg = ""): void => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(
			`${msg || "values differ"}\nactual:   ${show(actual)}\nexpected: ${
				show(expected)
			}`,
		);
	}
};

export function ok(
	cond: unknown,
	msg = "expected a truthy value",
): asserts cond {
	if (!cond) throw new Error(msg);
}

export const rejects = async (
	fn: () => Promise<unknown>,
	pattern: RegExp,
	msg = "",
): Promise<Error> => {
	try {
		await fn();
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e);
		if (!pattern.test(text)) {
			throw new Error(`${msg || "wrong error"}: ${text} !~ ${pattern}`);
		}
		return e as Error;
	}
	throw new Error(`${msg || "expected a rejection"} (${pattern})`);
};
