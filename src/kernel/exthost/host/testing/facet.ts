// An in-memory facet for the Deno tests (TEST FIXTURE; imports `node:sqlite`
// through `@tartan/ext-api/testing.ts`). It runs the facet core exactly as a
// Dynamic Worker receives it: `shippedCore()` imports `facetCore`'s source
// text as a module of its own, so a reference outside the function fails
// here as it would in the facet. What crosses the "RPC" is structured-cloned;
// `abort` rejects the pending calls and the next call gets a fresh module,
// as `facets.abort` does.

import type { ExtensionModule } from "@tartan/contract";
import {
	createMemoryStorage,
	type MemoryStorage,
} from "@tartan/ext-api/testing.ts";
import {
	type CoreStorage,
	type FacetCore,
	facetCore,
	type Program,
} from "../facet/core.ts";
import type { FacetCode, FacetPort, FacetStub } from "../facet/dynamic.ts";

/** `facetCore` loaded from its own source text (as the shim ships it). */
export const shippedCore = async (): Promise<FacetCore> => {
	const source =
		`const __name = (target) => target;\nexport const facetCore = ${facetCore.toString()};\n`;
	const mod = await import(
		`data:text/javascript,${encodeURIComponent(source)}`
	) as { facetCore: () => FacetCore };
	return mod.facetCore();
};

export type MemoryFacet = {
	readonly port: FacetPort;
	readonly storage: MemoryStorage;
	/** Loader ids the host asked for, in order. */
	readonly gets: string[];
	readonly aborts: string[];
	/** How many times the module was (re)loaded. */
	readonly loads: () => number;
	/** The Worker code, when the host built it. */
	readonly codes: FacetCode[];
	deleted: boolean;
};

export const createMemoryFacet = async (options: {
	readonly module?: () => ExtensionModule;
	readonly program?: () => Program;
	readonly storage?: MemoryStorage;
	/** Build the Worker code on start (exercises `facetCodeOf`). */
	readonly buildCode?: boolean;
}): Promise<MemoryFacet> => {
	const core = await shippedCore();
	const storage = options.storage ?? createMemoryStorage();
	let loads = 0;
	const program = (): Program => {
		loads += 1;
		if (options.program !== undefined) return options.program();
		const module = options.module?.();
		if (module === undefined) throw new Error("memory facet: no module");
		return { kind: "js", module: module as Record<string, unknown> };
	};
	const start = () =>
		core.facetRuntime(storage as unknown as CoreStorage, program);
	let runtime = start();
	let pending: ((error: Error) => void)[] = [];
	const settle = <T>(work: Promise<T>): Promise<T> => {
		let cancel: (error: Error) => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			cancel = reject;
		});
		pending = [...pending, cancel];
		return Promise.race([work, aborted])
			.then((value) => structuredClone(value))
			.finally(() => {
				pending = pending.filter((c) => c !== cancel);
			});
	};
	const stub: FacetStub = {
		hooks: () => settle(Promise.resolve().then(() => runtime.hooks())),
		migrate: (migrations, now) =>
			settle(
				Promise.resolve().then(() =>
					runtime.migrate(structuredClone(migrations), now)
				),
			),
		invoke: (hook, args, env, caps) =>
			settle(
				Promise.resolve().then(() =>
					runtime.invoke(
						hook,
						structuredClone(args),
						structuredClone(env),
						caps as never,
					)
				),
			),
		query: (sql, bindings) =>
			settle(
				Promise.resolve().then(() => runtime.query(sql, ...(bindings ?? []))),
			),
	};
	const facet: MemoryFacet = {
		storage,
		gets: [],
		aborts: [],
		codes: [],
		loads: () => loads,
		deleted: false,
		port: {
			get: (loaderId, code) => {
				facet.gets.push(loaderId);
				if (options.buildCode === true && facet.codes.length === 0) {
					void code().then((c) => facet.codes.push(c));
				}
				return stub;
			},
			abort: (reason) => {
				facet.aborts.push(reason);
				const cancel = pending;
				pending = [];
				for (const c of cancel) c(new Error(`facet aborted: ${reason}`));
				runtime = start();
			},
			delete: () => {
				facet.deleted = true;
				void storage.deleteAll();
				runtime = start();
			},
		},
	};
	return facet;
};

const dataUrl = (source: string): string =>
	`data:text/javascript,${encodeURIComponent(source)}`;

const base64 = (bytes: Uint8Array): string => {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(text);
};

type ShimFacetInstance = {
	hooks(): string[];
	migrate(migrations: unknown, now: number): number[];
	invoke(
		hook: string,
		args: unknown[],
		env: unknown,
		caps?: unknown,
	): Promise<unknown>;
	query(sql: string, bindings?: unknown[]): unknown[];
};

type ShimFacetClass = new (
	ctx: { storage: unknown },
	env: Record<string, never>,
) => ShimFacetInstance;

/**
 * Evaluates the Worker code the host built, as a facet would: the shim's
 * own text, its package modules as modules (a js module as code, a core
 * wasm as a compiled `WebAssembly.Module`), `cloudflare:workers` replaced by
 * a minimal `DurableObject`. Each evaluation is a fresh module graph.
 */
export const evaluateShim = async (
	code: FacetCode,
): Promise<ShimFacetClass> => {
	let shim = code.modules[code.mainModule];
	if (typeof shim !== "string") throw new Error("the shim is not a string");
	shim = shim.replace(
		'import { DurableObject } from "cloudflare:workers";',
		"class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
	);
	for (const [name, mod] of Object.entries(code.modules)) {
		if (name === code.mainModule) continue;
		let url: string;
		if (typeof mod === "string") url = dataUrl(mod);
		else if ("js" in mod) url = dataUrl(mod.js);
		else {
			const bytes = mod.wasm instanceof Uint8Array
				? mod.wasm
				: new Uint8Array(mod.wasm);
			url = dataUrl(
				`export default new WebAssembly.Module(Uint8Array.from(atob(${
					JSON.stringify(base64(bytes))
				}), (c) => c.charCodeAt(0)));`,
			);
		}
		shim = shim.replaceAll(JSON.stringify(`./${name}`), JSON.stringify(url));
	}
	// A fresh graph per evaluation (the module cache keys on the URL).
	const mod = await import(
		dataUrl(`${shim}\n// ${crypto.randomUUID()}\n`)
	) as { ExtFacet: ShimFacetClass };
	return mod.ExtFacet;
};

/** A facet port over the shim the host builds (the full Worker code path). */
export const createShimFacet = (
	options: { readonly storage?: MemoryStorage } = {},
): MemoryFacet => {
	const storage = options.storage ?? createMemoryStorage();
	let loads = 0;
	let instance: Promise<ShimFacetInstance> | null = null;
	let pending: ((error: Error) => void)[] = [];
	let current: (() => Promise<FacetCode>) | null = null;
	const facet = (): Promise<ShimFacetInstance> => {
		if (instance === null) {
			const code = current;
			if (code === null) throw new Error("shim facet: not started");
			instance = (async () => {
				const c = await code();
				state.codes.push(c);
				const ExtFacet = await evaluateShim(c);
				loads += 1;
				return new ExtFacet({ storage }, {});
			})();
		}
		return instance;
	};
	const settle = <T>(work: Promise<T>): Promise<T> => {
		let cancel: (error: Error) => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			cancel = reject;
		});
		pending = [...pending, cancel];
		return Promise.race([work, aborted])
			.then((value) => structuredClone(value))
			.finally(() => {
				pending = pending.filter((c) => c !== cancel);
			});
	};
	const stub: FacetStub = {
		hooks: () => settle(facet().then((f) => f.hooks())),
		migrate: (migrations, now) =>
			settle(facet().then((f) => f.migrate(structuredClone(migrations), now))),
		invoke: (hook, args, env, caps) =>
			settle(
				facet().then((f) =>
					f.invoke(hook, structuredClone(args), structuredClone(env), caps)
				),
			) as Promise<never>,
		query: (sql, bindings) =>
			settle(facet().then((f) => f.query(sql, bindings))),
	};
	const state: MemoryFacet = {
		storage,
		gets: [],
		aborts: [],
		codes: [],
		loads: () => loads,
		deleted: false,
		port: {
			get: (loaderId, code) => {
				state.gets.push(loaderId);
				current = code;
				return stub;
			},
			abort: (reason) => {
				state.aborts.push(reason);
				const cancel = pending;
				pending = [];
				for (const c of cancel) c(new Error(`facet aborted: ${reason}`));
				instance = null;
			},
			delete: () => {
				state.deleted = true;
				void storage.deleteAll();
				instance = null;
			},
		},
	};
	return state;
};
