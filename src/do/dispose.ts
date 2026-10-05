// Disposing RPC facade stubs. A DO getter such as
// `env.FORGE.getByName(FORGE_DO_NAME).registry()` returns an RpcTarget stub
// (a pipelined `JsRpcPromise` until awaited). workerd keeps the callee's call
// context open until that stub is disposed or garbage-collected: the DO event
// ends `canceled`, the runtime warns "An RPC stub was not disposed properly",
// and a caller that is itself a DO (ExtensionDO pokes) stays busy. Callers
// open a facade per call and dispose it when the call settles:
//
//   withRpc(() => forge().registry(), (r) => r.inForce(nodeId))
//
// or bind a disposing view once (`disposingFacade`) and call it like the
// facade. Both work on stubs, pipelined promises and plain fakes (no
// `Symbol.dispose`, nothing to do). This module imports no `cloudflare:*`
// module, so Deno tests and pure wiring can use it.

/** Disposes a stub, pipelined RPC promise or RPC result; a no-op for anything else. */
export const disposeRpc = (value: unknown): void => {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return;
	}
	const dispose = (value as { [Symbol.dispose]?: unknown })[Symbol.dispose];
	if (typeof dispose === "function") dispose.call(value);
};

/**
 * Opens a facade, runs `use` on it and disposes it once `use` settles
 * (resolved or rejected). Pipelining is kept: `open` is not awaited.
 */
export const withRpc = async <F, R>(
	open: () => F,
	use: (facade: F) => R | Promise<R>,
): Promise<Awaited<R>> => {
	const facade = open();
	try {
		return await use(facade);
	} finally {
		disposeRpc(facade);
	}
};

type AsyncMethods<T, K extends keyof T> = {
	readonly [P in K]: T[P] extends (...args: infer A) => infer R
		? (...args: A) => Promise<Awaited<R>>
		: never;
};

/**
 * A view of a facade with only `methods`: each call opens the facade, calls
 * the method and disposes the stub when the call settles. The view itself
 * holds no stub, so it can be built once and kept.
 */
export const disposingFacade = <T extends object, K extends keyof T & string>(
	open: () => T,
	methods: readonly K[],
): AsyncMethods<T, K> =>
	Object.freeze(Object.fromEntries(
		methods.map((name) => [
			name,
			// A direct method call: on an RPC stub, `.apply`/`.call` would be
			// remote property names, not Function.prototype.
			(...args: unknown[]) =>
				withRpc(
					open,
					(facade) =>
						(facade as Record<string, (...a: unknown[]) => unknown>)[name](
							...args,
						),
				),
		]),
	)) as AsyncMethods<T, K>;
