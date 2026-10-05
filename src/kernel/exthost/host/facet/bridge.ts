// The capability bridge of a `js` call:
// the host passes, as an argument of the facet RPC, an object whose
// one method `call("<namespace>.<method>", args)` runs that method on the
// host's `KernelCaps` for this call only (grants, mode, read-only, K12, the
// actor, the rate limit, the per-call expiry). Errors come back as data, so
// the extension sees the code and reason whatever RPC does to an Error.
//
// Production wraps it in an `RpcTarget` (rpc.ts); the Deno tests use
// `localBridge`, which structured-clones what crosses, as RPC would.

import { CAPS_METHODS, fromRpcError, type KernelCaps } from "@tartan/contract";
import type { CapsBridge, ErrorData } from "./core.ts";

const METHODS: ReadonlySet<string> = new Set(CAPS_METHODS);

type Answer =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: ErrorData };

export const errorDataOf = (error: unknown): ErrorData => {
	const e = fromRpcError(error);
	return {
		code: e.code,
		text: e.text,
		...(e.reason === undefined ? {} : { reason: e.reason }),
		...(e.details === undefined
			? {}
			: { details: e.details as Record<string, unknown> }),
	};
};

/** Runs one capability method; never throws. */
export const callCaps = async (
	caps: KernelCaps,
	path: string,
	args: unknown,
): Promise<Answer> => {
	if (typeof path !== "string" || !METHODS.has(path)) {
		return {
			ok: false,
			error: { code: "invalid", text: `no capability ${String(path)}` },
		};
	}
	const [ns, method] = path.split(".");
	try {
		const target = (caps as unknown as Record<
			string,
			Record<string, (...a: unknown[]) => unknown>
		>)[ns];
		const value = await target[method](...(Array.isArray(args) ? args : []));
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error: errorDataOf(error) };
	}
};

/** The bridge without RPC (tests): arguments and answers are cloned. */
export const localBridge = (caps: KernelCaps): CapsBridge => ({
	call: async (path, args) =>
		structuredClone(await callCaps(caps, path, structuredClone(args))),
});
