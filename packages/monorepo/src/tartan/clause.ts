// The package clause of a `.cue` file, read textually: the first line that is
// not blank, not a `//` comment and not a file attribute (`@if(…)`,
// `@extern(…)`). The whole text is read, so a long licence header above the
// clause does not hide it. It decides project membership only: it never selects
// files for CUE evaluation (the CLI does that by its package qualifier) and it
// never decides policy (ADR repo config).

export type PackageClause = {
	/** The package name, or null when the first meaningful line is no clause. */
	readonly name: string | null;
	/** Names of the file attributes before the clause (`if`, `extern`, …). */
	readonly attributes: readonly string[];
};

const CLAUSE_RE = /^package\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\/\/.*)?$/;
const ATTRIBUTE_RE = /^@([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

export const packageClause = (text: string): PackageClause => {
	const attributes: string[] = [];
	for (const raw of text.replace(/^﻿/, "").split(/\r?\n|\r/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("//")) continue;
		const attribute = ATTRIBUTE_RE.exec(line);
		if (attribute) {
			attributes.push(attribute[1]);
			continue;
		}
		const clause = CLAUSE_RE.exec(line);
		return { name: clause ? clause[1] : null, attributes };
	}
	return { name: null, attributes };
};
