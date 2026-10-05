// Composition root shared by the thin DO classes. A DO class
// constructs one host with its module map; the host
//   1. validates every module's migrations against its range (fail fast),
//   2. inside `blockConcurrencyWhile`: applies pending migrations (common
//      1–99 first, then each module's range, in ascending order), creates
//      every module with `create(deps)` (its `timers` bound to its own name),
//      builds the timer handler and WebSocket dispatch tables and loads the
//      alarm cache,
//   3. serves `facade(name)` (an RpcTarget for the DO getter), `alarm()`,
//      the `webSocket*` handlers and `fetch` (routed to the module named by
//      `DO_MODULE_HEADER`, for WebSocket upgrades).
// Modules reach siblings only through `deps.modules.<name>`, whose getters
// create a sibling on first use, so creation order never matters (a cycle in
// creation-time access is reported as an error).

import {
	createUlid,
	httpStatus,
	notFound,
	toWire,
	unavailable,
} from "@tartan/contract";
import {
	type Clock,
	DO_MODULE_HEADER,
	type DoModule,
	type Ids,
	type Migration,
	type ModuleInstance,
	systemClock,
	type TimerHandler,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../env.ts";
import {
	migrationSourceIssues,
	migrationSources,
	runMigrations,
} from "./migrations.ts";
import { type Facade, rpcFacade } from "./rpc.ts";
import { createSocketDispatch, type SocketDispatch } from "./sockets.ts";
import {
	bindTimers,
	createTimers,
	type TimerOutcome,
	type Timers,
} from "./timers.ts";

/** Any module of any DO (siblings are typed per DO by the module itself). */
export type AnyDoModule = DoModule<object, unknown, Env>;
export type ModuleMap = { readonly [name: string]: AnyDoModule };

type InstanceOf<M extends AnyDoModule> = ReturnType<M["create"]>;
export type FacadeOf<M extends AnyDoModule> = InstanceOf<M>["facade"];
export type InternalOf<M extends AnyDoModule> = InstanceOf<M>["internal"];

export type Logger = (message: string, data: Record<string, unknown>) => void;

export type DoHostConfig<M extends ModuleMap> = {
	/** DO kind for logs and errors (`forge`, `repo`, `inbox`). */
	readonly kind: string;
	readonly ctx: DurableObjectState;
	readonly env: Env;
	readonly modules: M;
	/** Common migrations (range 1–99) this DO applies. */
	readonly common: readonly Migration[];
	readonly clock?: Clock;
	readonly ids?: Ids;
	readonly log?: Logger;
};

export type DoHost<M extends ModuleMap> = {
	/** Settles when migrations ran and every module exists; rejects (and resets the DO) on failure. */
	readonly ready: Promise<void>;
	readonly timers: Timers;
	facade<K extends keyof M & string>(name: K): Facade<FacadeOf<M[K]>>;
	internal<K extends keyof M & string>(name: K): InternalOf<M[K]>;
	alarm(): Promise<TimerOutcome[]>;
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
	webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): Promise<void>;
	webSocketError(ws: WebSocket, error: unknown): Promise<void>;
	/** Routes to the `fetch` of the module named by `DO_MODULE_HEADER`; 404 otherwise. */
	fetch(req: Request): Promise<Response>;
};

const notFoundResponse = (text: string): Response => {
	const wire = toWire(notFound(text));
	return Response.json(wire, { status: httpStatus(wire.error) });
};

const defaultLog: Logger = (message, data) =>
	console.error(`[tartan] ${message}`, JSON.stringify(data));

/** Every problem with a module map; empty means valid. */
export const moduleMapIssues = (
	modules: ModuleMap,
	common: readonly Migration[],
): string[] => [
	...Object.entries(modules)
		.filter(([key, module]) => key !== module.name)
		.map(([key, module]) =>
			`module key "${key}" names module "${module.name}"`
		),
	...migrationSourceIssues(migrationSources(common, Object.values(modules))),
];

export const createDoHost = <M extends ModuleMap>(
	config: DoHostConfig<M>,
): DoHost<M> => {
	const { ctx, env, kind } = config;
	const sources = migrationSources(
		config.common,
		Object.values(config.modules),
	);
	const issues = moduleMapIssues(config.modules, config.common);
	if (issues.length > 0) {
		throw new Error(`${kind} DO: ${issues.join("; ")}`);
	}
	const names = Object.keys(config.modules);
	const log = config.log ?? defaultLog;
	const clock = config.clock ?? systemClock;
	const ulid = createUlid({ now: () => clock.now() });
	const ids = config.ids ?? { ulid };
	const storage = ctx.storage;
	const timers = createTimers({ storage, clock, modules: names, log });

	type Instance = ModuleInstance<object, unknown>;
	const instances = new Map<string, Instance>();
	const creating = new Set<string>();
	const siblings: Record<string, unknown> = {};

	const instance = (name: string): Instance => {
		const existing = instances.get(name);
		if (existing !== undefined) return existing;
		if (creating.has(name)) {
			throw new Error(
				`${kind} DO: module "${name}" used while it is being created`,
			);
		}
		const module = config.modules[name];
		if (module === undefined) {
			throw new Error(`${kind} DO: unknown module "${name}"`);
		}
		creating.add(name);
		try {
			const created = module.create({
				sql: storage.sql,
				storage,
				ctx,
				env,
				modules: siblings,
				timers: bindTimers(timers, name),
				clock,
				ids,
			});
			instances.set(name, created);
			return created;
		} finally {
			creating.delete(name);
		}
	};

	for (const name of names) {
		Object.defineProperty(siblings, name, {
			get: () => instance(name).internal,
			enumerable: true,
		});
	}

	let state: "starting" | "ready" | "failed" = "starting";
	let handlers: Record<string, TimerHandler | undefined> = {};
	let sockets: SocketDispatch | undefined;
	const facades = new Map<string, object>();

	const ready = ctx.blockConcurrencyWhile(async () => {
		try {
			runMigrations(storage, sources, clock);
			for (const name of names) instance(name);
			handlers = Object.fromEntries(
				names.map((name) => [name, instance(name).onTimer]),
			);
			sockets = createSocketDispatch({
				ctx,
				handlers: names.flatMap((name) => instance(name).sockets ?? []),
				log,
			});
			await timers.init();
			state = "ready";
		} catch (error) {
			state = "failed";
			log(`${kind} DO failed to start`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	// Observed here so a failed start is logged once, not reported as unhandled.
	ready.catch(() => {});

	const requireReady = (): void => {
		if (state !== "ready") {
			throw unavailable(`${kind} DO is ${state}`);
		}
	};

	const facade = <K extends keyof M & string>(
		name: K,
	): Facade<FacadeOf<M[K]>> => {
		requireReady();
		let target = facades.get(name);
		if (target === undefined) {
			target = rpcFacade(name, instance(name).facade);
			facades.set(name, target);
		}
		return target as Facade<FacadeOf<M[K]>>;
	};

	const internal = <K extends keyof M & string>(name: K): InternalOf<M[K]> => {
		requireReady();
		return instance(name).internal as InternalOf<M[K]>;
	};

	const withSockets = async (): Promise<SocketDispatch> => {
		await ready;
		if (sockets === undefined) throw unavailable(`${kind} DO has no sockets`);
		return sockets;
	};

	return {
		ready,
		timers,
		facade,
		internal,
		alarm: async () => {
			await ready;
			return timers.runDue(handlers);
		},
		webSocketMessage: async (ws, message) =>
			(await withSockets()).message(ws, message),
		webSocketClose: async (ws, code, reason, wasClean) =>
			(await withSockets()).close(ws, code, reason, wasClean),
		webSocketError: async (ws, error) => (await withSockets()).error(ws, error),
		fetch: async (req) => {
			await ready;
			const name = req.headers.get(DO_MODULE_HEADER);
			const handler = name !== null && Object.hasOwn(config.modules, name)
				? instance(name).fetch
				: undefined;
			if (handler === undefined) {
				return notFoundResponse(`${kind} DO: no module fetch for ${name}`);
			}
			return await handler(req);
		},
	};
};
