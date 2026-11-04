// The forge shell's only data boundary: everything under `forge/` and the
// design system imports from here. The sample store behind it is what the kernel
// API replaces (`test/source-audit.spec.ts` keeps the boundary).

export * from "./model.ts";
export * from "./store.ts";
