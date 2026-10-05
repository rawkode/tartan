// The `wasm-bundled` runtime: the schedule fallback for
// `wasm` when Dynamic Workers are off (`EXT_DYNAMIC_ENABLED`). A component
// built into the Worker bundle (jco glue as code, core modules as
// `WebAssembly.Module`s; runtime compilation is forbidden [E B2]) is
// instantiated in-process by its installation's ExtensionDO, one fresh
// instance per call, through the same core as a facet (core.ts), against
// the host's guarded `sql` and `kv` (so the host tables stay unreachable).
// It is labelled bundled: WASM memory is its only isolation, so it is only
// for packages bundled by the forge's own build, and only when the
// published package is byte-identical (same sha256).

import type { ExtCtx, ExtMigration, Manifest } from "@tartan/contract";
import { unavailable } from "@tartan/contract";
import type { Clock } from "@tartan/contract/kernel.ts";
import type { InstallationSnapshot } from "../installation.ts";
import type {
	BundledLoader,
	Hook,
	HookArgs,
	HookResult,
	LoadedPackage,
	Runtime,
} from "../runtime.ts";
import { callEnvOf, settleOutcome } from "./apply.ts";
import { facetCore, type WasmProgram } from "./core.ts";

/** A component bundled into the Worker by the build (`build-ext`). */
export type BundledWasm = {
	readonly manifest: Manifest;
	/** The published package's sha256 this build matches. */
	readonly sha256: string;
	readonly instantiate: WasmProgram["instantiate"];
	readonly cores: Readonly<Record<string, WebAssembly.Module>>;
	readonly migrations: readonly ExtMigration[];
};

const core = facetCore();

const WASM_HOOKS: ReadonlySet<string> = new Set([
	"init",
	"onEvent",
	"onTimer",
	"gate",
	"echo",
	"render",
	"onAction",
	"callTool",
	"context",
]);

const matches = (b: BundledWasm, s: InstallationSnapshot): boolean =>
	b.manifest.id === s.manifest.id &&
	b.manifest.version === s.installation.version && b.sha256 === s.sha256;

/** The in-process runtime of one bundled component. */
export const createBundledWasmRuntime = (
	bundle: BundledWasm,
	clock: Clock,
): Runtime => {
	const program: WasmProgram = {
		kind: "wasm",
		instantiate: bundle.instantiate,
		getCoreModule: (path) => {
			const module = bundle.cores[path];
			if (module === undefined) throw unavailable(`no core module ${path}`);
			return module;
		},
	};
	return {
		kind: "wasm",
		isolated: false,
		has: (hook) => WASM_HOOKS.has(hook),
		invoke: <K extends Hook>(hook: K, args: HookArgs<K>) => {
			const all = args as unknown as unknown[];
			const x = all[all.length - 1] as ExtCtx;
			const env = callEnvOf(bundle.manifest, hook, x, clock.now());
			const outcome = core.callWasm(program, hook, all.slice(0, -1), env, {
				sql: x.sql,
				kv: x.kv,
			});
			return settleOutcome(outcome, x) as Promise<HookResult<K>>;
		},
		// In-process code cannot be interrupted.
		abort: () => {},
	};
};

/** The registry of bundled components, as a package loader. */
export const createBundledWasmLoader = (
	bundles: readonly BundledWasm[],
	clock: Clock,
): BundledLoader => {
	const find = (s: InstallationSnapshot) => bundles.find((b) => matches(b, s));
	const load = (snapshot: InstallationSnapshot): Promise<LoadedPackage> => {
		const bundle = find(snapshot);
		if (bundle === undefined) {
			return Promise.reject(
				unavailable(
					`${snapshot.manifest.id}@${snapshot.installation.version} is not bundled in this Worker`,
				),
			);
		}
		return Promise.resolve({
			runtime: createBundledWasmRuntime(bundle, clock),
			migrations: bundle.migrations,
		});
	};
	return Object.assign(load, {
		has: (snapshot: InstallationSnapshot) => find(snapshot) !== undefined,
	});
};
