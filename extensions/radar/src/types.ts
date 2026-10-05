// Types derived from the conflicts@1 schemas in `@tartan/contract` (the
// contract exports the schemas and `Conflict`; the enum types are inferred
// here so the extension never re-declares their values).

import type {
	CONFLICT_SEVERITIES,
	ConflictResolutionSchema,
	SUGGESTIONS,
} from "@tartan/contract";

export type ConflictSeverity = typeof CONFLICT_SEVERITIES[number];
export type Suggestion = typeof SUGGESTIONS[number];
export type ConflictResolution = typeof ConflictResolutionSchema._output;
