// The dynamic loader's pieces: published migrations, the Worker code, the
// CPU limit, the loader id, the disabled switch, the runtime choice
// (`packageLoader`), the tail lines, and a js package through the shim the
// host builds.

import {
	deepStrictEqual,
	match,
	ok,
	rejects,
	strictEqual,
} from "node:assert/strict";
import {
	createUlid,
	type ExtCtx,
	fromRpcError,
	type Manifest,
	parseManifest,
} from "@tartan/contract";
import { strikeKindOf } from "../breaker.ts";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import { createExtensionHost, type HostStorage } from "../host.ts";
import type { InstallationSnapshot } from "../installation.ts";
import { type PackageLoader, packageLoader } from "../runtime.ts";
import { tailLines } from "../tail-lines.ts";
import { viewer } from "../testing/conformance.ts";
import { createShimFacet } from "../testing/facet.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	NODES,
	PRINCIPALS,
} from "../testing/fakes.ts";
import { manualClock, repoScopeName } from "../testing/memory.ts";
import { localBridge } from "./bridge.ts";
import { generationLoaderId, platformFacetPort } from "./platform.ts";
import {
	cpuLimitOf,
	createDynamicLoader,
	createFacetRuntime,
	facetCodeOf,
	type FacetPort,
	loaderIdOf,
	packagePrefix,
	publishedMigrations,
} from "./dynamic.ts";

const manifestOf = (input: Record<string, unknown>): Manifest => {
	const parsed = parseManifest({
		schema: 1,
		id: "acme.demo",
		name: "Demo",
		version: "1.2.3",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "main.js" },
		storage: {
			scope: "repo",
			migrations: ["migrations/0002_more.sql", "migrations/0001_init.sql"],
		},
		permissions: {},
		...input,
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

const filesOf = (files: Record<string, string>) => (path: string) =>
	Promise.resolve(
		path in files ? new TextEncoder().encode(files[path]) : null,
	);

const snapshotOf = (m: Manifest): InstallationSnapshot => ({
	...createFakeInstallations(m).snapshot!,
	sha256: "d".repeat(64),
});

const reason = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (error) {
		return fromRpcError(error).code;
	}
};

Deno.test("published migrations: NNNN_name.sql files in number order", async () => {
	const m = manifestOf({});
	deepStrictEqual(
		await publishedMigrations(
			m,
			filesOf({
				"migrations/0001_init.sql": "CREATE TABLE a (x)",
				"migrations/0002_more.sql": "CREATE TABLE b (y)",
			}),
		),
		[
			{ n: 1, name: "init", sql: "CREATE TABLE a (x)" },
			{ n: 2, name: "more", sql: "CREATE TABLE b (y)" },
		],
	);
	strictEqual(
		await reason(publishedMigrations(m, filesOf({}))),
		"unavailable",
	);
});

Deno.test("the Worker code: shim main module, package modules, no network, no env, the tail", async () => {
	const js = await facetCodeOf(
		snapshotOf(manifestOf({})),
		filesOf({ "main.js": "export default {}" }),
		"TAIL",
	);
	strictEqual(js.mainModule, "shim.js");
	strictEqual(js.globalOutbound, null);
	deepStrictEqual(js.env, {});
	deepStrictEqual(js.tails, ["TAIL"]);
	deepStrictEqual(js.modules["main.js"], { js: "export default {}" });
	const shim = js.modules["shim.js"] as string;
	ok(shim.includes('import * as main from "./main.js";'));
	ok(shim.includes("export class ExtFacet extends DurableObject"));
	const wasm = await facetCodeOf(
		snapshotOf(manifestOf({
			runtime: "wasm",
			entry: { js: "ext.js", wasm: ["ext.core.wasm", "ext.core2.wasm"] },
		})),
		(path) =>
			Promise.resolve(
				path === "ext.js"
					? new TextEncoder().encode("export function instantiate() {}")
					: new Uint8Array([0, 0x61, 0x73, 0x6d]),
			),
	);
	deepStrictEqual(Object.keys(wasm.modules).sort(), [
		"ext.core.wasm",
		"ext.core2.wasm",
		"ext.js",
		"shim.js",
	]);
	ok("wasm" in (wasm.modules["ext.core.wasm"] as object));
	strictEqual(wasm.tails, undefined);
	strictEqual(
		await reason(facetCodeOf(snapshotOf(manifestOf({})), filesOf({}))),
		"unavailable",
	);
});

Deno.test("the facet CPU limit is the manifest's largest budget (defence in depth)", () => {
	strictEqual(cpuLimitOf(manifestOf({})), undefined);
	strictEqual(
		cpuLimitOf(manifestOf({ limits: { event_cpu_ms: 50, tool_cpu_ms: 500 } })),
		500,
	);
});

Deno.test("one loader id per installation and package", () => {
	const s = snapshotOf(manifestOf({}));
	match(loaderIdOf(s), /^x:acme\.demo@1\.2\.3#d{16}:i_[0-9a-z]{26}$/);
	strictEqual(
		packagePrefix("acme.demo", "1.2.3", "e".repeat(64)),
		`ext/acme.demo/1.2.3/${"e".repeat(64)}/`,
	);
});

Deno.test("the dynamic runtime off (EXT_DYNAMIC_ENABLED): js and wasm are refused with unavailable", async () => {
	const facet = createShimFacet();
	const loader = createDynamicLoader({
		enabled: false,
		facets: facet.port,
		files: () => filesOf({}),
		bridge: localBridge,
		clock: manualClock(),
	});
	strictEqual(await reason(loader(snapshotOf(manifestOf({})))), "unavailable");
	strictEqual(facet.gets.length, 0);
});

Deno.test("packageLoader: builtin, dynamic, and wasm-bundled only when dynamic is off and the package is bundled", async () => {
	const seen: string[] = [];
	const loader = (label: string): PackageLoader => () => {
		seen.push(label);
		return Promise.reject(new Error(label));
	};
	const bundled = Object.assign(loader("bundled"), {
		has: (s: InstallationSnapshot) => s.manifest.id === "acme.demo",
	});
	const wasm = snapshotOf(manifestOf({
		runtime: "wasm",
		entry: { js: "ext.js", wasm: ["ext.core.wasm"] },
	}));
	const js = snapshotOf(manifestOf({}));
	const on = packageLoader({
		builtin: loader("builtin"),
		dynamic: loader("dynamic"),
		wasmBundled: bundled,
		dynamicEnabled: true,
	});
	const off = packageLoader({
		builtin: loader("builtin"),
		dynamic: loader("dynamic"),
		wasmBundled: bundled,
		dynamicEnabled: false,
	});
	for (const p of [on(wasm), on(js), off(wasm), off(js)]) {
		await p.catch(() => {});
	}
	deepStrictEqual(seen, ["dynamic", "dynamic", "bundled", "dynamic"]);
});

Deno.test("tail lines: ordered by timestamp, tagged with the installation, outcomes and exceptions at error", () => {
	const lines = tailLines(
		{ inst: "i_1", extId: "acme.x", version: "0.1.0", scopeKey: "repo" },
		[
			{
				eventTimestamp: 2,
				outcome: "exception",
				event: { rpcMethod: "invoke" },
				exceptions: [{ name: "Error", message: "boom" }],
			},
			{
				eventTimestamp: 1,
				outcome: "ok",
				event: { rpcMethod: "invoke" },
				logs: [{ level: "log", message: ["hi", { a: 1 }] }],
			},
		],
	);
	deepStrictEqual(lines, [
		{
			level: "log",
			line: '[ext i_1 acme.x@0.1.0 repo] tail invoke log: hi {"a":1}',
		},
		{
			level: "error",
			line: "[ext i_1 acme.x@0.1.0 repo] tail invoke exception: Error: boom",
		},
		{
			level: "error",
			line: "[ext i_1 acme.x@0.1.0 repo] tail invoke outcome: exception",
		},
	]);
	deepStrictEqual(tailLines(undefined, []), []);
});

Deno.test("a published js package runs through the shim the host builds", async () => {
	const m = manifestOf({
		storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
		contributes: {
			slots: [{ slot: "repo.sidebar", id: "hi", dynamic: true, cache: "none" }],
		},
	});
	const source = `export default {
		async init(x) { x.sql.exec("INSERT INTO seen (k) VALUES ('init')"); },
		async render(slot, ctx, props, x) {
			const n = x.sql.exec("SELECT COUNT(*) AS n FROM seen").one().n;
			x.log.info("rendered " + slot);
			return { v: 1, root: { t: "text", text: "hi " + x.actor.id + " " + n } };
		},
	};`;
	const facet = createShimFacet();
	const clock = manualClock();
	const installations = createFakeInstallations(m);
	const loader = createDynamicLoader({
		enabled: true,
		facets: facet.port,
		files: () =>
			filesOf({
				"main.js": source,
				"migrations/0001_init.sql": "CREATE TABLE seen (k TEXT)",
			}),
		bridge: localBridge,
		clock,
	});
	const storage = createMemoryStorage();
	const host = createExtensionHost({
		name: repoScopeName(),
		storage: storage as unknown as HostStorage,
		clock,
		ids: { ulid: createUlid({ now: clock.now }) },
		kernel: createFakeKernel().ports,
		installations,
		packages: loader,
	});
	await host.ready();
	const doc = await host.render(
		"hi",
		{
			slot: "repo.sidebar",
			node: NODES.router.id,
			repo: NODES.router.id,
			mode: "enforce",
		},
		viewer(PRINCIPALS.dev),
	);
	deepStrictEqual(doc.root, { t: "text", text: `hi ${PRINCIPALS.dev} 1` });
	const consoleLines = (await host.console(0, 50)).map((r) => r.msg);
	ok(
		consoleLines.some((l) => l.endsWith("render hi: rendered hi")),
		consoleLines.join("\n"),
	);
	strictEqual(facet.loads(), 1);
	await host.deleteData();
	strictEqual(facet.deleted, true, "delete data purges the facet");
	await rejects(() => Promise.reject(new Error("x")));
	storage.close();
	facet.storage.close();
});

Deno.test("the platform port: synthetic facet id, CPU limit, and reset moves to a fresh Dynamic Worker", () => {
	const loads: string[] = [];
	const aborts: string[] = [];
	let startup: (() => { class: unknown; id: unknown }) | null = null;
	const facets = {
		get: (_name: string, opts: () => { class: unknown; id: unknown }) => {
			startup = opts;
			return {} as never;
		},
		abort: (_name: string, reason: Error) => {
			aborts.push(reason.message);
		},
		delete: () => {},
		clone: () => {},
	} as unknown as DurableObjectFacets;
	const loader = {
		get: (id: string) => {
			loads.push(id);
			return {
				getDurableObjectClass: (name: string, o?: unknown) => ({ name, o }),
			};
		},
	} as unknown as WorkerLoader;
	const kv = new Map<string, unknown>();
	const port = platformFacetPort(facets, loader, () => "i_1", {
		get: <T>(k: string) => kv.get(k) as T | undefined,
		put: (k: string, v: unknown) => {
			kv.set(k, v);
		},
	});
	port.get("x:a@1#abc:i_1", () => Promise.reject(new Error("unused")), 500);
	deepStrictEqual(startup!(), {
		class: { name: "ExtFacet", o: { limits: { cpuMs: 500 } } },
		id: "ext:i_1",
	});
	port.reset!("cpu");
	port.get(
		"x:a@1#abc:i_1",
		() => Promise.reject(new Error("unused")),
		undefined,
	);
	startup!();
	deepStrictEqual(loads, ["x:a@1#abc:i_1", "x:a@1#abc:i_1:g1"]);
	strictEqual(aborts.length, 1);
	strictEqual(generationLoaderId("x", 0), "x");
});

Deno.test("a facet the platform kills is aborted (restarted on the next call) and its errors are strikes", async () => {
	const m = manifestOf({
		storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
		contributes: {
			tools: [{ name: "spin", description: "spin", input: {}, role: 20 }],
		},
	});
	const aborts: string[] = [];
	let failure = "Worker exceeded CPU time limit.";
	const port = {
		get: () => ({
			hooks: () => Promise.resolve(["callTool"]),
			migrate: () => Promise.resolve([]),
			invoke: () => Promise.reject(new Error(failure)),
			query: () => Promise.resolve([]),
		}),
		abort: (reason: string) => {
			aborts.push(reason);
		},
		delete: () => {},
	};
	const clock = manualClock();
	const storage = createMemoryStorage();
	const host = createExtensionHost({
		name: repoScopeName(),
		storage: storage as unknown as HostStorage,
		clock,
		ids: { ulid: createUlid({ now: clock.now }) },
		kernel: createFakeKernel().ports,
		installations: createFakeInstallations(m),
		packages: createDynamicLoader({
			enabled: true,
			facets: port,
			files: () =>
				filesOf({ "migrations/0001_init.sql": "CREATE TABLE t (x)" }),
			bridge: localBridge,
			clock,
		}),
	});
	await host.ready();
	const ctx = {
		node: NODES.router.id,
		repo: NODES.router.id,
		scope: "acme/router",
		actor: { kind: "user" as const, id: PRINCIPALS.dev },
		mode: "enforce" as const,
	};
	const bounds = {
		maxRole: 30 as const,
		scopes: null,
		nodeId: NODES.router.id,
		laneId: null,
	};
	const call = () =>
		host.callTool("spin", {}, ctx, bounds).catch((e: unknown) => String(e));
	match(await call() as string, /exceeded CPU time limit/);
	failure = "internal error; reference = abc123";
	match(await call() as string, /internal error/);
	match(await call() as string, /internal error/);
	strictEqual(aborts.length, 3, "each platform failure aborts the facet");
	deepStrictEqual(
		storage.sql.exec("SELECT kind FROM _strikes ORDER BY seq").toArray(),
		[{ kind: "cpu" }, { kind: "reset" }, { kind: "reset" }],
	);
	// Three strikes in ten minutes: the breaker is open, calls short-circuit.
	match(await call() as string, /circuit breaker open/);
	strictEqual(aborts.length, 3, "an open breaker never reaches the facet");
	storage.close();
});

Deno.test("one platform kill with calls in flight is one restart and one strike", async () => {
	// The port rejects every pending call with the abort or reset reason, as
	// `facets.abort` and testing/facet.ts do.
	const pending: ((error: Error) => void)[] = [];
	const rejectAll = (reason: string) => {
		for (const reject of pending.splice(0)) reject(new Error(reason));
	};
	let resets = 0;
	const port: FacetPort = {
		get: () =>
			({
				hooks: () => Promise.resolve(["render"]),
				migrate: () => Promise.resolve([]),
				invoke: () =>
					new Promise((_, reject) => {
						pending.push(reject);
					}),
				query: () => Promise.resolve([]),
			}) as unknown as ReturnType<FacetPort["get"]>,
		abort: rejectAll,
		reset: (reason) => {
			resets += 1;
			rejectAll(reason);
		},
		delete: () => {},
	};
	const runtime = createFacetRuntime(
		snapshotOf(manifestOf({ limits: { render_cpu_ms: 100 } })),
		{
			enabled: true,
			facets: port,
			files: () => filesOf({}),
			bridge: localBridge,
			clock: manualClock(),
		},
		() => Promise.reject(new Error("not loaded in this test")),
		new Set(["render"]),
	);
	const x = {
		install: { scopeKey: "repo:01k6rrrrrrrrrrrrrrrrrrrrrr" },
		readOnly: true,
		actor: { kind: "user", id: PRINCIPALS.dev },
		config: {},
		caps: {},
	} as unknown as ExtCtx;
	const calls = [1, 2, 3].map(() =>
		(runtime.invoke as (hook: string, args: unknown[]) => Promise<unknown>)(
			"render",
			[{ slot: "repo.sidebar" }, x],
		).then(() => null, (error: unknown) => error)
	);
	while (pending.length < 3) await new Promise((r) => setTimeout(r, 1));
	// The platform kills the first call for CPU.
	pending.shift()!(new Error("Worker exceeded CPU time limit."));
	const errors = await Promise.all(calls);
	strictEqual(resets, 1, "one restart");
	deepStrictEqual(errors.map(strikeKindOf), ["cpu", null, null]);
	for (const error of errors.slice(1)) {
		strictEqual(fromRpcError(error).code, "unavailable");
	}
	// A call on the fresh generation that the platform kills strikes again.
	const later = (runtime.invoke as (
		hook: string,
		args: unknown[],
	) => Promise<unknown>)("render", [{ slot: "repo.sidebar" }, x]).then(
		() => null,
		(error: unknown) => error,
	);
	while (pending.length < 1) await new Promise((r) => setTimeout(r, 1));
	pending.shift()!(new Error("Worker exceeded CPU time limit."));
	strictEqual(strikeKindOf(await later), "cpu");
	strictEqual(resets, 2);
});
