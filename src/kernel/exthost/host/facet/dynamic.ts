// The `js` and `wasm` runtimes: a published package runs as a Dynamic Worker
// facet of its installation's own ExtensionDO.
//
// Activation: the package files are read from R2
// (`ext/<extId>/<version>/<sha256>/`), the Worker code is the host's shim
// (shim.ts) plus the package's js module, or its jco glue and core modules
// passed as bytes (runtime compilation is forbidden in parent and
// child); one loader id per installation and package
// (`x:<extId>@<ver>#<sha16>:<instId>`), `globalOutbound: null` (no
// network), an empty `env` (capabilities are per call), the tail sink
// named for the installation, and the manifest's largest CPU budget as
// the facet limit (defence in depth only). The facet `main`
// starts with the synthetic id `ext:<instId>`, so the extension never learns
// the host's DO name. The package's migrations run in the facet's
// own SQLite.
//
// A call: the host's `ExtCtx` for the call is reduced to its data (the
// install, the actor, config, read-only) and, for js, the capability bridge
// (bridge.ts); the facet answers with an outcome the host settles (apply.ts).
// At most `concurrency` facet calls of one host are in flight. `abort`
// is `facets.abort("main")`: pending calls reject and the next call starts
// fresh code; the host's breaker counts the overrun.

import {
	COMPAT_DATE,
	type ExtCtx,
	type ExtMigration,
	type Manifest,
	unavailable,
} from "@tartan/contract";
import type { Clock } from "@tartan/contract/kernel.ts";
import { strikeKindOf } from "../breaker.ts";
import type { InstallationSnapshot } from "../installation.ts";
import {
	type Hook,
	type HookArgs,
	type HookResult,
	type LoadedPackage,
	type PackageLoader,
	type Runtime,
	runtimeOf,
} from "../runtime.ts";
import { callEnvOf, settleOutcome } from "./apply.ts";
import type { CallEnv, CallOutcome, CapsBridge } from "./core.ts";
import { facetShimSource, SHIM_MODULE, type ShimSpec } from "./shim.ts";

/** The facet's RPC surface (`ExtFacet` in the shim). */
export type FacetStub = {
	hooks(): Promise<string[]>;
	migrate(
		migrations: readonly ExtMigration[],
		now: number,
	): Promise<number[]>;
	invoke(
		hook: string,
		args: unknown[],
		env: CallEnv,
		caps?: unknown,
	): Promise<CallOutcome>;
	query(sql: string, bindings?: unknown[]): Promise<unknown[]>;
};

/** Worker code as the loader takes it (`WorkerLoaderWorkerCode`). */
export type FacetCode = {
	readonly compatibilityDate: string;
	readonly mainModule: string;
	readonly modules: Record<
		string,
		string | { js: string } | { wasm: ArrayBuffer | Uint8Array }
	>;
	readonly globalOutbound: null;
	readonly env: Record<string, never>;
	readonly tails?: unknown[];
};

/** The ExtensionDO's facet `main` (production: `ctx.facets` + `env.LOADER`). */
export type FacetPort = {
	/** The running facet, started from `code` under `loaderId` when it is not. */
	get(
		loaderId: string,
		code: () => Promise<FacetCode>,
		cpuMs: number | undefined,
	): FacetStub;
	/** `facets.abort("main")`: pending calls reject, the next starts fresh. */
	abort(reason: string): void;
	/**
	 * The facet's Dynamic Worker failed at the platform level (for example a
	 * CPU kill) and may keep failing: abort it and start the next call in a
	 * fresh Dynamic Worker (a new loader id generation).
	 */
	reset?(reason: string): void;
	/** `facets.delete("main")`: the facet's storage is gone (uninstall). */
	delete(): void;
};

export type PackageFiles = (path: string) => Promise<Uint8Array | null>;

export type DynamicDeps = {
	/** `EXT_DYNAMIC_ENABLED`. */
	readonly enabled: boolean;
	readonly facets: FacetPort;
	/** The package's files under its R2 prefix. */
	readonly files: (prefix: string) => PackageFiles;
	/** The per-call capability bridge (an RpcTarget in production). */
	readonly bridge: (caps: ExtCtx["caps"]) => CapsBridge;
	/** The tail sink for this installation's Dynamic Worker, if wired. */
	readonly tail?: (snapshot: InstallationSnapshot) => unknown;
	readonly clock: Clock;
	/** Facet calls in flight per host (≤ 4). */
	readonly concurrency?: number;
};

export const FACET_CONCURRENCY = 4;

/** R2 prefix of a published package. */
export const packagePrefix = (
	extId: string,
	version: string,
	sha256: string,
): string => `ext/${extId}/${version}/${sha256}/`;

/** One loader id per installation and package. */
export const loaderIdOf = (snapshot: InstallationSnapshot): string =>
	`x:${snapshot.manifest.id}@${snapshot.installation.version}#${
		snapshot.sha256.slice(0, 16)
	}:${snapshot.installation.id}`;

const MIGRATION_FILE_RE = /(?:^|\/)(\d{1,4})_([A-Za-z0-9_-]{1,64})\.sql$/;

/** A published package's migrations: `NNNN_name.sql` files, in number order. */
export const publishedMigrations = async (
	manifest: Manifest,
	read: PackageFiles,
): Promise<ExtMigration[]> => {
	const out: ExtMigration[] = [];
	for (const path of manifest.storage.migrations ?? []) {
		const match = MIGRATION_FILE_RE.exec(path);
		if (match === null) {
			throw unavailable(
				`${manifest.id}: migration ${path} is not NNNN_name.sql`,
			);
		}
		const bytes = await read(path);
		if (bytes === null) {
			throw unavailable(`${manifest.id}: migration ${path} is missing`);
		}
		out.push({
			n: Number(match[1]),
			name: match[2],
			sql: new TextDecoder().decode(bytes),
		});
	}
	return out.sort((a, b) => a.n - b.n);
};

const requireFile = async (
	read: PackageFiles,
	path: string,
	what: string,
): Promise<Uint8Array> => {
	const bytes = await read(path);
	if (bytes === null) throw unavailable(`${what} ${path} is missing`);
	return bytes;
};

/** The shim and the package modules. */
export const facetCodeOf = async (
	snapshot: InstallationSnapshot,
	read: PackageFiles,
	tail?: unknown,
): Promise<FacetCode> => {
	const m = snapshot.manifest;
	const kind = runtimeOf(snapshot);
	const entry = m.entry.js;
	if (entry === undefined) throw unavailable(`${m.id}: no entry.js`);
	const text = new TextDecoder().decode(
		await requireFile(read, entry, `${m.id}:`),
	);
	const modules: FacetCode["modules"] = { [entry]: { js: text } };
	let spec: ShimSpec;
	if (kind === "wasm") {
		const cores = m.entry.wasm ?? [];
		for (const path of cores) {
			modules[path] = { wasm: await requireFile(read, path, `${m.id}:`) };
		}
		spec = { kind: "wasm", glue: entry, cores };
	} else {
		spec = { kind: "js", entry };
	}
	modules[SHIM_MODULE] = facetShimSource(spec);
	return {
		compatibilityDate: COMPAT_DATE,
		mainModule: SHIM_MODULE,
		modules,
		globalOutbound: null,
		env: {},
		...(tail === undefined ? {} : { tails: [tail] }),
	};
};

/** The manifest's largest declared CPU budget, as the facet limit. */
export const cpuLimitOf = (m: Manifest): number | undefined => {
	const limits = m.limits;
	if (limits === undefined) return undefined;
	const budgets = [
		limits.event_cpu_ms,
		limits.render_cpu_ms,
		limits.action_cpu_ms,
		limits.tool_cpu_ms,
	].filter((v): v is number => typeof v === "number");
	return budgets.length === 0 ? undefined : Math.max(...budgets);
};

const createSemaphore = (size: number) => {
	let running = 0;
	const waiting: (() => void)[] = [];
	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (running >= size) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		running += 1;
		try {
			return await work();
		} finally {
			running -= 1;
			waiting.shift()?.();
		}
	};
};

/** The runtime over one installation's facet. */
export const createFacetRuntime = (
	snapshot: InstallationSnapshot,
	deps: DynamicDeps,
	code: () => Promise<FacetCode>,
	hooks: ReadonlySet<string>,
): Runtime => {
	const kind = runtimeOf(snapshot);
	const loaderId = loaderIdOf(snapshot);
	const cpuMs = cpuLimitOf(snapshot.manifest);
	const limit = createSemaphore(deps.concurrency ?? FACET_CONCURRENCY);
	const facet = () => deps.facets.get(loaderId, code, cpuMs);
	/** Bumped by every host abort: a call it rejected is not a platform failure. */
	let aborts = 0;
	return {
		kind,
		isolated: true,
		has: (hook) => hooks.has(hook),
		invoke: <K extends Hook>(hook: K, args: HookArgs<K>) => {
			const all = args as unknown as unknown[];
			const x = all[all.length - 1] as ExtCtx;
			const plain = all.slice(0, -1);
			const env = callEnvOf(snapshot.manifest, hook, x, deps.clock.now());
			const bridge = kind === "js" ? deps.bridge(x.caps) : undefined;
			const abortsAtStart = aborts;
			return limit(() =>
				facet().invoke(hook, plain, env, bridge).catch((error: unknown) => {
					// The facet never rejects for the extension's own errors (they
					// come back as an outcome): a rejection the host did not cause
					// with `abort` is the platform's (a CPU or memory kill, a reset,
					// an internal error). A Dynamic Worker that failed that way may
					// keep failing, so the next call starts a fresh one; the host
					// counts the strike.
					if (aborts !== abortsAtStart) {
						// The host ended this call (an abort, or the restart another
						// call's platform failure caused): one fault is one strike
						// and one restart, however many calls were in flight.
						if (strikeKindOf(error) === null) throw error;
						throw unavailable(
							`${snapshot.manifest.id}: the facet was restarted while this call ran`,
						);
					}
					// Counted before the restart, so the calls it rejects see it.
					aborts += 1;
					const reason = `facet failed: ${String(error)}`;
					if (deps.facets.reset !== undefined) deps.facets.reset(reason);
					else deps.facets.abort(reason);
					throw error;
				})
			).then((outcome) => settleOutcome(outcome, x)) as Promise<
				HookResult<K>
			>;
		},
		abort: (reason) => {
			aborts += 1;
			deps.facets.abort(reason);
		},
		storage: {
			migrate: (migrations) => facet().migrate(migrations, deps.clock.now()),
		},
	};
};

/** The loader of `js`/`wasm` packages. */
export const createDynamicLoader = (deps: DynamicDeps): PackageLoader => {
	const load = async (
		snapshot: InstallationSnapshot,
	): Promise<LoadedPackage> => {
		const kind = runtimeOf(snapshot);
		const m = snapshot.manifest;
		if (kind !== "js" && kind !== "wasm") {
			throw unavailable(`${m.id}: not a js or wasm package`);
		}
		if (!deps.enabled) {
			throw unavailable(
				`${m.id}: the ${kind} runtime is disabled on this forge (EXT_DYNAMIC_ENABLED)`,
			);
		}
		const read = deps.files(
			packagePrefix(m.id, snapshot.installation.version, snapshot.sha256),
		);
		const migrations = await publishedMigrations(m, read);
		let code: Promise<FacetCode> | null = null;
		const getCode = () => (code ??= facetCodeOf(
			snapshot,
			read,
			deps.tail?.(snapshot),
		));
		const hooks = kind === "wasm"
			? new Set<string>([
				"init",
				"onEvent",
				"onTimer",
				"gate",
				"echo",
				"render",
				"onAction",
				"callTool",
				"context",
			])
			: new Set(
				await deps.facets.get(loaderIdOf(snapshot), getCode, cpuLimitOf(m))
					.hooks(),
			);
		return {
			runtime: createFacetRuntime(snapshot, deps, getCode, hooks),
			migrations,
		};
	};
	return Object.assign(load, {
		purge: () => {
			deps.facets.delete();
			return Promise.resolve();
		},
	});
};
