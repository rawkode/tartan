// The single-provider interfaces (contract `PROVIDABLE_INTERFACES`):
// a copy, so zod stays out of the browser bundle; `contract-parity.spec.ts`
// fails when it drifts.

export const PROVIDABLE_INTERFACES = [
	"work@1",
	"changes@1",
	"conflicts@1",
	"checks@1",
	"review@1",
	"queue@1",
] as const;

export type ProvidableInterface = typeof PROVIDABLE_INTERFACES[number];
