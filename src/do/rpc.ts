// Turns a module's plain facade object (arrow functions, `createX(deps)`
// style) into an `RpcTarget`, so a thin DO getter such as `repo.core()` can
// return it over Workers RPC and callers can pipeline
// (`env.REPO.getByName(name).core().recordPush(…)`).
//
// Workers RPC only exposes prototype members (AGENTS.md), so every function
// of the facade is installed on the prototype of a one-off `RpcTarget`
// subclass, never as an own property of the instance.

import { RpcTarget } from "cloudflare:workers";

/** A facade as returned over RPC: the module's interface, branded as an RpcTarget. */
export type Facade<T extends object> = T & Rpc.RpcTargetBranded;

export const rpcFacade = <T extends object>(
	name: string,
	impl: T,
): Facade<T> => {
	const Target = class extends RpcTarget {};
	Object.defineProperty(Target, "name", { value: `${name}Facade` });
	for (const [key, value] of Object.entries(impl)) {
		if (typeof value !== "function") continue;
		const method = value as (...args: unknown[]) => unknown;
		Object.defineProperty(Target.prototype, key, {
			value: (...args: unknown[]) => method.apply(impl, args),
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}
	return new Target() as unknown as Facade<T>;
};
