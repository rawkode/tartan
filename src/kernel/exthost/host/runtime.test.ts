// Runtimes: the builtin loader on the real bundled
// registry, and the refusal of js/wasm until the M2 facets land.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import { builtins } from "../../../builtins.ts";
import { builtinPackageLoader, createModuleRuntime } from "./runtime.ts";
import { createFakeInstallations, NODES, PRINCIPALS } from "./testing/fakes.ts";
import { createTestHost } from "./testing/memory.ts";
import { viewer } from "./testing/conformance.ts";
import { helloModule } from "./testing/hello.ts";

const hud = builtins.get("tartan.hud")!;

const snapshot = (
	overrides: Parameters<typeof createFakeInstallations>[1] = {},
) => createFakeInstallations(hud.manifest, overrides).snapshot!;

const reason = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (error) {
		return fromRpcError(error).code;
	}
};

Deno.test("builtin loader: the bundled package at the installation's version", async () => {
	const load = builtinPackageLoader(builtins);
	const pkg = await load(snapshot());
	strictEqual(pkg.runtime.kind, "builtin");
	strictEqual(pkg.runtime.isolated, false);
	deepStrictEqual(pkg.migrations, hud.migrations);
	strictEqual(
		await reason(load(snapshot({ version: "9.9.9" }))),
		"unavailable",
	);
	strictEqual(
		await reason(load(snapshot({ runtimeOverride: "js" }))),
		"unavailable",
	);
	strictEqual(
		await reason(
			load({
				...snapshot(),
				manifest: { ...hud.manifest, entry: { builtin: "tartan.nope" } },
			}),
		),
		"unavailable",
	);
});

Deno.test("a bundled builtin (tartan.hud) runs through the host: migrations, init, render", async () => {
	const t = await createTestHost({
		manifest: hud.manifest,
		migrations: hud.migrations,
		module: () => hud.module,
		name: `ext:i_01k60000000000000000000201:node`,
	});
	try {
		const doc = await t.host.render(
			"active-lanes",
			{ node: NODES.acme.id, mode: "enforce" },
			viewer(PRINCIPALS.dev),
		);
		strictEqual(doc.root.t, "stack");
		strictEqual(
			t.storage.sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM _ext_migrations",
			).one().n,
			hud.migrations.length,
		);
	} finally {
		t.close();
	}
});

Deno.test("an in-process runtime aborts only when isolated; abort reloads the module", async () => {
	let loads = 0;
	const isolated = createModuleRuntime(() => {
		loads += 1;
		return { ...helloModule, onTimer: () => new Promise(() => {}) };
	}, { isolated: true, kind: "js" });
	const pending = isolated.invoke("onTimer", ["k", {} as never]);
	isolated.abort("test");
	strictEqual(await reason(pending), "unavailable");
	strictEqual(loads, 2);
	const builtin = createModuleRuntime(() => helloModule);
	builtin.abort("ignored");
	strictEqual(builtin.has("render"), true);
	strictEqual(
		await reason(
			builtin.invoke("init", [{} as never]).catch((e) => {
				throw e;
			}),
		),
		"internal",
	);
});
