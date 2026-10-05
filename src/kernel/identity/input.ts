// Request validation inside the identity module: the DO re-validates every
// facade input with the contract's zod schema, so a caller that skipped the
// HTTP layer cannot store an unchecked value.

import { invalid } from "@tartan/contract";
import type { z } from "zod";

/** Parses `value` with `schema`; throws `invalid` naming every issue. */
export const parseInput = <S extends z.ZodType>(
	schema: S,
	value: unknown,
): z.output<S> => {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw invalid(
			result.error.issues
				.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
				.join("; "),
		);
	}
	return result.data;
};
