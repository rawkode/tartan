// Event-type patterns (`refreshOn`): an exact type, `ns.*` (any depth below
// `ns`), or `*`. Same semantics as `matchesEventPattern` in
// `@tartan/contract/events.ts` (copied so zod stays out of the bundle;
// `contract-parity.spec.ts` checks they agree).

export const matchesEventPattern = (pattern: string, type: string): boolean => {
	if (pattern === "*") return true;
	if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
	return pattern === type;
};

export const matchesAnyPattern = (
	patterns: readonly string[],
	type: string,
): boolean => patterns.some((p) => matchesEventPattern(p, type));
