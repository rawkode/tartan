// Minimal assertions for this extension's Deno tests. Extensions import only
// `@tartan/contract`, `@tartan/ext-api` and their own files
// (`scripts/check-imports.ts`), so `node:assert` is out of reach here.

const show = (v: unknown): string => {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
};

const fail = (message: string | undefined, detail: string): never => {
	throw new Error(message ? `${message}: ${detail}` : detail);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

/** Structural equality: same keys (any order), same array order, `Object.is` leaves. */
export const deepEqualValues = (a: unknown, b: unknown): boolean => {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
			a.every((v, i) => deepEqualValues(v, b[i]));
	}
	if (!isObject(a) || !isObject(b)) return false;
	const ka = Object.keys(a).filter((k) => a[k] !== undefined).sort();
	const kb = Object.keys(b).filter((k) => b[k] !== undefined).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i]) &&
		ka.every((k) => deepEqualValues(a[k], b[k]));
};

export function ok(value: unknown, message?: string): asserts value {
	if (!value) fail(message, `expected a truthy value, got ${show(value)}`);
}

export const equal = (actual: unknown, expected: unknown, message?: string) => {
	if (!Object.is(actual, expected)) {
		fail(message, `${show(actual)} !== ${show(expected)}`);
	}
};

export const strictEqual = equal;

export const deepStrictEqual = (
	actual: unknown,
	expected: unknown,
	message?: string,
) => {
	if (!deepEqualValues(actual, expected)) {
		fail(
			message,
			`\n  actual:   ${show(actual)}\n  expected: ${show(expected)}`,
		);
	}
};

export const rejects = async (p: Promise<unknown>, message?: string) => {
	try {
		await p;
	} catch {
		return;
	}
	fail(message, "expected the promise to reject");
};
