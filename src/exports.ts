// Typed loopback bindings of the Worker's own entrypoints (`ctx.exports`).
// Integrator-owned. Kernel code reaches RepoProbe and KernelCaps through
// `loopback(ctx)` instead of an untyped `ctx.exports`; no global
// `Cloudflare.GlobalProps` augmentation is needed.
//
//   const probe = loopback(ctx).RepoProbe;        // RepoProbeApi over RPC
//   const caps = loopback(ctx).KernelCaps({ props }); // per-call caps (WP7b)

import type { KernelCaps } from "./kernel/caps/entrypoint.ts";
import type { RepoProbe } from "./kernel/probe/entrypoint.ts";

export type LoopbackExports = {
	readonly RepoProbe: LoopbackServiceStub<RepoProbe>;
	readonly KernelCaps: LoopbackServiceStub<KernelCaps>;
};

/** `ctx` is an `ExecutionContext` or a `DurableObjectState`. */
export const loopback = (
	ctx: { readonly exports: unknown },
): LoopbackExports => ctx.exports as LoopbackExports;
