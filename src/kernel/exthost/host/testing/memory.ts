// A host over in-memory storage for the Deno tests (TEST FIXTURE; imports
// `node:sqlite` through `@tartan/ext-api/testing.ts`, so never import it from
// Worker code or a `*.workers.test.ts`). The clock is manual; `restart()`
// builds a new host over the same storage, as a DO restart (or a host that
// died mid-call) would.

import {
	createUlid,
	type ExtensionModule,
	type ExtMigration,
	type InstallationDto,
	type Manifest,
} from "@tartan/contract";
import {
	createMemoryStorage,
	type MemoryStorage,
} from "@tartan/ext-api/testing.ts";
import {
	type CapsFactory,
	createExtensionHost,
	type ExtensionHost,
	type HostBudgets,
	type HostStorage,
} from "../host.ts";
import { localBridge } from "../facet/bridge.ts";
import { createDynamicLoader } from "../facet/dynamic.ts";
import type { InstallationSnapshot } from "../installation.ts";
import {
	createModuleRuntime,
	type PackageLoader,
	type Runtime,
} from "../runtime.ts";
import { createMemoryFacet, type MemoryFacet } from "./facet.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	type FakeInstallations,
	type FakeKernel,
	INSTALLATION_ID,
	NODES,
} from "./fakes.ts";
import {
	HELLO_MIGRATIONS_V1,
	HELLO_MIGRATIONS_V2,
	helloManifest,
	helloModule,
} from "./hello.ts";

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

export type ManualClock = {
	now(): number;
	advance(ms: number): void;
	set(at: number): void;
};

export const manualClock = (start = T0): ManualClock => {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
		set: (value) => {
			at = value;
		},
	};
};

export type TestHostOptions = {
	readonly manifest?: Manifest;
	readonly migrations?: readonly ExtMigration[];
	readonly module?: () => ExtensionModule;
	/** Run the module as an isolated in-process runtime (the breaker path). */
	readonly isolated?: boolean;
	/**
	 * Run the module as a published `js` package in an in-memory facet: the
	 * dynamic loader, the shipped core, its own database, the capability
	 * bridge with cloned arguments, `facets.abort` (testing/facet.ts).
	 */
	readonly facet?: boolean;
	readonly installation?: Partial<InstallationDto>;
	readonly budgets?: Partial<HostBudgets>;
	readonly name?: string;
	readonly caps?: CapsFactory;
	readonly kernel?: FakeKernel;
	readonly storage?: MemoryStorage;
};

export type TestHost = {
	host: ExtensionHost;
	readonly storage: MemoryStorage;
	readonly kernel: FakeKernel;
	readonly installations: FakeInstallations;
	readonly clock: ManualClock;
	readonly logs: string[];
	/** Every runtime the loader created (index 0 is the first). */
	readonly runtimes: Runtime[];
	/** The extension's own database: the host's, or the facet's. */
	readonly extStorage: MemoryStorage;
	/** The in-memory facet (with `facet: true`). */
	readonly facet?: MemoryFacet;
	/** A new host instance over the same storage (a DO restart). */
	restart(): Promise<ExtensionHost>;
	/** Runs every due timer (the DO alarm) at the current clock. */
	alarm(): Promise<void>;
	close(): void;
};

export const repoScopeName = (
	inst = INSTALLATION_ID,
	repoId: string = NODES.router.id,
) => `ext:${inst}:repo:${repoId}`;

export const createTestHost = async (
	options: TestHostOptions = {},
): Promise<TestHost> => {
	const manifest = options.manifest ?? helloManifest();
	const storage = options.storage ?? createMemoryStorage();
	const kernel = options.kernel ?? createFakeKernel();
	const installations = createFakeInstallations(manifest, options.installation);
	const clock = manualClock();
	const logs: string[] = [];
	const runtimes: Runtime[] = [];
	const migrationsOf = (version: string): readonly ExtMigration[] =>
		options.migrations ??
			(version === "0.2.0" ? HELLO_MIGRATIONS_V2 : HELLO_MIGRATIONS_V1);
	const load = options.module ?? (() => helloModule);
	const facet = options.facet === true
		? await createMemoryFacet({ module: load })
		: undefined;
	if (
		facet !== undefined && options.installation?.runtimeOverride === undefined
	) {
		installations.set((s) => ({
			...s,
			installation: { ...s.installation, runtimeOverride: "js" },
		}));
	}
	const inProcess: PackageLoader = (snapshot) => {
		const runtime = createModuleRuntime(load, {
			isolated: options.isolated ?? false,
			kind: options.isolated ? "js" : "builtin",
		});
		runtimes.push(runtime);
		return Promise.resolve({
			runtime,
			migrations: migrationsOf(snapshot.installation.version),
		});
	};
	const dynamic = facet === undefined ? undefined : createDynamicLoader({
		enabled: true,
		facets: facet.port,
		files: () => (path) => {
			const n = /(\d+)_[^/]*\.sql$/.exec(path)?.[1];
			const m = [...HELLO_MIGRATIONS_V2, ...(options.migrations ?? [])]
				.find((x) => n !== undefined && x.n === Number(n));
			return Promise.resolve(
				m === undefined ? null : new TextEncoder().encode(m.sql),
			);
		},
		bridge: localBridge,
		clock,
	});
	const packages: PackageLoader = dynamic === undefined
		? inProcess
		: Object.assign(async (snapshot: InstallationSnapshot) => {
			const pkg = await dynamic(snapshot);
			runtimes.push(pkg.runtime);
			return pkg;
		}, { purge: dynamic.purge });
	const build = () =>
		createExtensionHost({
			name: options.name ??
				(manifest.storage.scope === "repo"
					? repoScopeName()
					: `ext:${INSTALLATION_ID}:node`),
			storage: storage as unknown as HostStorage,
			clock,
			ids: { ulid: createUlid({ now: clock.now }) },
			kernel: kernel.ports,
			installations,
			packages,
			...(options.caps ? { caps: options.caps } : {}),
			budgets: { hold: 50, ...options.budgets },
			log: (level, line) => logs.push(`${level} ${line}`),
		});
	const state: { host: ExtensionHost } = { host: build() };
	await state.host.ready();
	const test: TestHost = {
		get host() {
			return state.host;
		},
		set host(value) {
			state.host = value;
		},
		storage,
		kernel,
		installations,
		clock,
		logs,
		runtimes,
		extStorage: facet?.storage ?? storage,
		...(facet === undefined ? {} : { facet }),
		restart: async () => {
			state.host = build();
			await state.host.ready();
			return state.host;
		},
		alarm: async () => {
			await state.host.alarm();
		},
		close: () => {
			storage.close();
			facet?.storage.close();
		},
	};
	return test;
};

/** Rows of a raw query (assertions). */
export const query = <T extends Record<string, unknown>>(
	t: Pick<TestHost, "storage">,
	sql: string,
	...bindings: (string | number | null)[]
): T[] => t.storage.sql.exec(sql, ...bindings).toArray() as unknown as T[];

/** Rows of the extension's own database (the host's, or the facet's). */
export const extQuery = <T extends Record<string, unknown>>(
	t: Pick<TestHost, "extStorage">,
	sql: string,
	...bindings: (string | number | null)[]
): T[] => query<T>({ storage: t.extStorage }, sql, ...bindings);
