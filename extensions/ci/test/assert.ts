// Minimal assertions for this extension's Deno tests: extensions import only
// `@tartan/contract`, `@tartan/ext-api` and their own files
// (`scripts/check-imports.ts`), so no assertion library. Flow tests with
// fixture repos live in `packages/pipeline/test/`.

export const ok = (value: unknown, message = "assertion failed"): void => {
	if (!value) throw new Error(message);
};

/** Deep equality by canonical JSON (plain data only). */
export const equal = (
	actual: unknown,
	expected: unknown,
	message = "not equal",
): void => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${message}: ${a} !== ${b}`);
};

export const throwsWith = (fn: () => unknown, pattern: RegExp): void => {
	try {
		fn();
	} catch (e) {
		ok(pattern.test(String(e)), `${String(e)} !~ ${pattern}`);
		return;
	}
	throw new Error(`expected a throw matching ${pattern}`);
};
