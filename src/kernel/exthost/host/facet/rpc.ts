// The production capability bridge: an `RpcTarget` the ExtensionDO passes
// into the facet call, so the facet holds a stub valid for that call
// only. RPC exposes prototype members only, so `call` is a method.
// Imports `cloudflare:workers`: Worker code only (never a Deno test).

import { RpcTarget } from "cloudflare:workers";
import type { KernelCaps } from "@tartan/contract";
import { callCaps } from "./bridge.ts";

export class CapsBridgeTarget extends RpcTarget {
	#caps: KernelCaps;

	constructor(caps: KernelCaps) {
		super();
		this.#caps = caps;
	}

	call(path: string, args: unknown[]) {
		return callCaps(this.#caps, path, args);
	}
}

export const rpcBridge = (caps: KernelCaps): CapsBridgeTarget =>
	new CapsBridgeTarget(caps);
