// Runtimes: the builtin loader on the removed first-party packages
// (testing/legacy-builtins.ts), and the refusal of js/wasm until the M2 facets land.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import { legacyBuiltins as builtins } from "./testing/legacy-builtins.ts";
import { builtinPackageLoader, createModuleRuntime } from "./runtime.ts";
import { createFakeInstallations } from "./testing/fakes.ts";
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
