// M0 stub helpers. Every cross-boundary item exists as a
// stub before the work packages start: route handlers answer 501
// `not_implemented`, DO modules have `migrations: []` and methods that throw
// `not_implemented`. A stub file belongs to its owning WP after M0; this file
// goes away when the last stub does.
//
// `Methods<T>` makes a stub list every member of its contract interface and
// nothing else, so a contract change shows up as a type error here.

import type {
	DoModule,
	LaneBackend,
	MigrationRange,
	ModuleInstance,
	TimerHandler,
} from "@tartan/contract/kernel.ts";
import {
	httpStatus,
	type LaneBackendName,
	notImplemented,
	tartanError,
	toWire,
} from "@tartan/contract";
import type { Env } from "../env.ts";
import type { RouteHandler, RouteOwner } from "../router.ts";

/** Exactly the member names of `T` (each mapped to `true`). */
export type Methods<T> = { readonly [K in keyof T]-?: true };

/** Async facade whose every method rejects with `not_implemented`. */
export const stubFacade = <T extends object>(
	module: string,
	methods: Methods<T>,
): T =>
	Object.fromEntries(
		Object.keys(methods).map((name) => [
			name,
			() => Promise.reject(notImplemented(`${module}.${name}`)),
		]),
	) as T;

/** Synchronous internal API whose every method throws `not_implemented`. */
export const stubInternal = <T extends object>(
	module: string,
	methods: Methods<T>,
): T =>
	Object.fromEntries(
		Object.keys(methods).map((name) => [
			name,
			() => {
				throw notImplemented(`${module}.${name}`);
			},
		]),
	) as T;

/** A rejected `not_implemented` promise, for stub RPC methods on classes. */
export const notImplementedAsync = <T = never>(what: string): Promise<T> =>
	Promise.reject(notImplemented(what));

/** Timer handler of a stub module (the multiplexer backs it off). */
export const stubTimer = (module: string): TimerHandler => (key) => {
	throw notImplemented(`${module}.onTimer(${key})`);
};

export type StubModuleSpec<F, I> = {
	readonly name: string;
	readonly range: MigrationRange;
	readonly facade: Methods<F>;
	readonly internal: Methods<I>;
	/** Modules that own timers in the design get a stub handler. */
	readonly timers?: boolean;
};

/** A DO module with no migrations whose facade and internal API throw. */
export const stubModule = <F extends object, I extends object, Siblings>(
	spec: StubModuleSpec<F, I>,
): DoModule<F, I, Env, Siblings> => ({
	name: spec.name,
	range: spec.range,
	migrations: [],
	create: (): ModuleInstance<F, I> => ({
		facade: stubFacade<F>(spec.name, spec.facade),
		internal: stubInternal<I>(spec.name, spec.internal),
		...(spec.timers ? { onTimer: stubTimer(spec.name) } : {}),
	}),
});

/**
 * A `LaneBackend` (contract services.ts) whose async members reject and whose
 * synchronous `fetchSpec` throws `not_implemented`.
 */
export const stubLaneBackend = (name: LaneBackendName): LaneBackend => ({
	name,
	remoteFor: () => notImplementedAsync(`lanes.${name}.remoteFor`),
	readTip: () => notImplementedAsync(`lanes.${name}.readTip`),
	fetchSpec: () => {
		throw notImplemented(`lanes.${name}.fetchSpec`);
	},
	gc: () => notImplementedAsync(`lanes.${name}.gc`),
});

/** A 501 JSON response naming the route and its owning WP. */
export const notImplementedResponse = (
	route: string,
	owner: RouteOwner,
): Response => {
	const error = tartanError("not_implemented", `${route} is not implemented`, {
		details: { route, owner },
	});
	return Response.json(toWire(error), {
		status: httpStatus(error.code),
		headers: { "cache-control": "no-store" },
	});
};

/** Route handler stub: always 501 naming the matched route. */
export const notImplementedRoute: RouteHandler = ({ route }) =>
	notImplementedResponse(route.id, route.owner);
