// The package clause of a `.cue` file, read textually (WP25 slice A′; Tier 0
// rule 10, ADR repo config): the first line that is not blank, not a `//`
// comment and not a file attribute (`@if(…)`, `@extern(…)`). The clause
// feeds `graph.packages` (stray `package tartan` reports, the Tier 1 bundle
// filter) and the `env.cue` candidate rule (cuenv's own: the first
// meaningful line is `package cuenv`). It never selects files for CUE
// evaluation: the CLI does that by its package qualifier.

import { CLAUSE_READ_CHARS } from "./limits.ts";

export type PackageClause = {
	/** The package name, or null when the first meaningful line is no clause. */
	readonly name: string | null;
	/** A file attribute came before the clause (cuenv's textual rule then rejects the file). */
	readonly attributeFirst: boolean;
	/** Names of the file attributes before the clause (`if`, `extern`, …). */
	readonly attributes: readonly string[];
};

const CLAUSE_RE = /^package\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\/\/.*)?$/;
const ATTRIBUTE_RE = /^@([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

/** Reads the clause from the first `CLAUSE_READ_CHARS` characters of `text`. */
export const packageClause = (text: string): PackageClause => {
	const head = text.replace(/^﻿/, "").slice(0, CLAUSE_READ_CHARS);
	const attributes: string[] = [];
	for (const raw of head.split(/\r?\n|\r/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("//")) continue;
		const attribute = ATTRIBUTE_RE.exec(line);
		if (attribute) {
			attributes.push(attribute[1]);
			continue;
		}
		const clause = CLAUSE_RE.exec(line);
		return {
			name: clause ? clause[1] : null,
			attributeFirst: attributes.length > 0,
			attributes,
		};
	}
	return { name: null, attributeFirst: attributes.length > 0, attributes };
};

/** cuenv's candidate rule: the first meaningful line is `package cuenv`. */
export const isCuenvClause = (clause: PackageClause): boolean =>
	clause.name === "cuenv" && !clause.attributeFirst;
