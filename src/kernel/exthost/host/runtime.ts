// Runtimes behind the extension host. The host
// talks to every runtime through `Runtime`: which hooks exist, how to invoke
// one, how to abort the running code, and whether the code is isolated
// (untrusted js/wasm in a facet: circuit breaker, write-ahead markers and
// abort on overrun apply) or trusted (builtin, in-process).
//
// `builtin`: a bundled module from `src/builtins.ts` (`entry.builtin`), run
// in-process in its own ExtensionDO. `js` and `wasm`: a published package in
// a Dynamic Worker facet of the ExtensionDO (facet/dynamic.ts,
// `EXT_DYNAMIC_ENABLED`), with its own SQLite. `wasm-bundled`: the schedule
// fallback for `wasm`, a component bundled into the Worker and instantiated
// in-process (facet/bundled.ts). `packageLoader` picks one per installation.

import {
	type ExtensionModule,
	type ExtMigration,
	type Manifest,
	unavailable,
} from "@tartan/contract";
import type { BuiltinRegistry } from "../../../builtins.ts";
import type { InstallationSnapshot } from "./installation.ts";

export type Hook = keyof ExtensionModule;
type HookFn<K extends Hook> = NonNullable<ExtensionModule[K]>;
export type HookArgs<K extends Hook> = Parameters<HookFn<K>>;
export type HookResult<K extends Hook> = Awaited<ReturnType<HookFn<K>>>;

export type RuntimeKind = "builtin" | "js" | "wasm";

export type Runtime = {
	readonly kind: RuntimeKind;
	/** Untrusted code (js/wasm): breaker, `_inflight` markers, abort on overrun. */
	readonly isolated: boolean;
	has(hook: Hook): boolean;
	invoke<K extends Hook>(hook: K, args: HookArgs<K>): Promise<HookResult<K>>;
	/**
	 * Stops the running code (`facets.abort`): pending invocations reject and
	 * the next call starts fresh code. A no-op for in-process builtins, which
	 * the host cannot interrupt.
	 */
	abort(reason: string): void;
	/**
	 * A runtime with a database of its own (a facet): the host runs the
	 * package's migrations there instead of in the ExtensionDO's database.
	 */
	readonly storage?: {
		migrate(migrations: readonly ExtMigration[]): Promise<number[]>;
	};
};

/** A package ready to run: its runtime and its forward-only migrations. */
export type LoadedPackage = {
	readonly runtime: Runtime;
	readonly migrations: readonly ExtMigration[];
};

export type PackageLoader =
	& ((snapshot: InstallationSnapshot) => Promise<LoadedPackage>)
	& {
		/** Deletes runtime-owned storage (a facet's database) on "delete data". */
		readonly purge?: () => Promise<void>;
	};

/** The runtime an installation runs on: its override, else the manifest's. */
export const runtimeOf = (snapshot: InstallationSnapshot): RuntimeKind =>
	snapshot.installation.runtimeOverride ?? snapshot.manifest.runtime;

/**
 * An in-process module runtime. `isolated: false` is the builtin runtime.
 * With `isolated: true` it behaves like a facet towards the host (aborts
 * reject the pending calls and reload the module), which is how the host's
 * breaker path is exercised before the js/wasm facets exist.
 */
export const createModuleRuntime = (
	load: () => ExtensionModule,
	options: { readonly kind?: RuntimeKind; readonly isolated?: boolean } = {},
): Runtime => {
	let module = load();
	let abortCurrent: ((reason: Error) => void)[] = [];
	return {
		kind: options.kind ?? "builtin",
		isolated: options.isolated ?? false,
		has: (hook) => typeof module[hook] === "function",
		invoke: <K extends Hook>(hook: K, args: HookArgs<K>) => {
			const fn = module[hook] as
				| ((...a: HookArgs<K>) => Promise<HookResult<K>>)
				| undefined;
			if (fn === undefined) {
				return Promise.reject(unavailable(`extension has no ${hook} hook`));
			}
			let cancel: (reason: Error) => void = () => {};
			const aborted = new Promise<never>((_, reject) => {
				cancel = reject;
			});
			abortCurrent = [...abortCurrent, cancel];
			const work = Promise.resolve().then(() => fn.apply(module, args));
			const forget = () => {
				abortCurrent = abortCurrent.filter((c) => c !== cancel);
			};
			return Promise.race([work, aborted]).finally(forget);
		},
		abort: (reason) => {
			if (!(options.isolated ?? false)) return;
			const pending = abortCurrent;
			abortCurrent = [];
			for (const cancel of pending) {
				cancel(unavailable(`extension code aborted: ${reason}`));
			}
			// A fresh instance on the next call (the facet restarts).
			module = load();
		},
	};
};

/**
 * The package loader for the bundled registry (`src/builtins.ts`): the
 * `builtin` runtime needs the bundled package at the installation's version.
 */
export const builtinPackageLoader = (
	registry: Pick<BuiltinRegistry, "get">,
): PackageLoader =>
(snapshot) => {
	const runtime = runtimeOf(snapshot);
	const manifest: Manifest = snapshot.manifest;
	if (runtime !== "builtin") {
		return Promise.reject(
			unavailable(`the builtin loader does not run ${runtime} packages`),
		);
	}
	const id = manifest.entry.builtin ?? manifest.id;
	const pkg = registry.get(id);
	if (pkg === undefined) {
		return Promise.reject(
			unavailable(`builtin ${id} is not bundled in this Worker`),
		);
	}
	if (pkg.manifest.version !== snapshot.installation.version) {
		return Promise.reject(
			unavailable(
				`builtin ${id} is bundled at ${pkg.manifest.version}, not ${snapshot.installation.version}`,
			),
		);
	}
	return Promise.resolve({
		runtime: createModuleRuntime(() => pkg.module, { kind: "builtin" }),
		migrations: pkg.migrations,
	});
};

/** A loader that knows which packages it holds (the `wasm-bundled` registry). */
export type BundledLoader = PackageLoader & {
	readonly has: (snapshot: InstallationSnapshot) => boolean;
};

/**
 * One loader per runtime: `builtin` from the bundle; `js` from the dynamic
 * loader; `wasm` from the dynamic loader, or from the `wasm-bundled`
 * registry (the schedule fallback) when the dynamic runtime is off and
 * that exact package (id, version, sha256) is bundled.
 */
export const packageLoader = (loaders: {
	readonly builtin: PackageLoader;
	readonly dynamic: PackageLoader;
	readonly wasmBundled?: BundledLoader;
	readonly dynamicEnabled: boolean;
}): PackageLoader => {
	const load = (snapshot: InstallationSnapshot): Promise<LoadedPackage> => {
		const runtime = runtimeOf(snapshot);
		if (runtime === "builtin") return loaders.builtin(snapshot);
		const bundled = loaders.wasmBundled;
		if (
			runtime === "wasm" && !loaders.dynamicEnabled && bundled !== undefined &&
			bundled.has(snapshot)
		) {
			return bundled(snapshot);
		}
		return loaders.dynamic(snapshot);
	};
	const purge = loaders.dynamic.purge;
	return purge === undefined ? load : Object.assign(load, { purge });
};
