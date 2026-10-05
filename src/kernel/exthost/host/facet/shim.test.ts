// The shim ships `facetCore` as source text. Wrangler bundles with esbuild
// `keepNames`, which wraps the function's inner arrows in `__name(…)` calls
// and renames its locals: the shipped text must still run on its own (the
// shim defines `__name`). Also: module paths are refused outside the package.

import { ok, strictEqual, throws } from "node:assert/strict";
import * as esbuild from "esbuild";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import type { CoreStorage, FacetCore } from "./core.ts";
import { facetShimSource } from "./shim.ts";

const dataUrl = (source: string) =>
	`data:text/javascript,${encodeURIComponent(source)}`;

Deno.test("the core as wrangler bundles it (keepNames) still runs from its own text", async () => {
	const out = await esbuild.build({
		entryPoints: [new URL("./core.ts", import.meta.url).pathname],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		target: "es2022",
		keepNames: true,
		logLevel: "silent",
	});
	await esbuild.stop();
	const bundled = await import(dataUrl(out.outputFiles[0].text)) as {
		facetCore: () => FacetCore;
	};
	const text = bundled.facetCore.toString();
	ok(text.includes("__name("), "keepNames wrapped the inner functions");
	// What the shim does: its own `__name`, then the function's text.
	const shipped = await import(
		dataUrl(
			`const __name = (target) => target;\nexport const facetCore = ${text};\n`,
		)
	) as { facetCore: () => FacetCore };
	const core = shipped.facetCore();
	const mem = createMemoryStorage();
	const sql = core.facetSql(mem as unknown as CoreStorage, {
		readOnly: false,
		quotaBytes: 1e9,
	});
	sql.exec("CREATE TABLE t (k TEXT)");
	sql.exec("INSERT INTO t VALUES (?)", "a");
	strictEqual(sql.exec("SELECT COUNT(*) AS n FROM t").toArray()[0].n, 1);
	strictEqual(core.ulidFactory(() => 1)().length, 26);
	mem.close();
});

Deno.test("the shim refuses module paths outside the package", () => {
	throws(() => facetShimSource({ kind: "js", entry: "../main.js" }));
	throws(() => facetShimSource({ kind: "js", entry: "/abs.js" }));
	throws(() =>
		facetShimSource({ kind: "wasm", glue: "ext.js", cores: ['x".wasm'] })
	);
	const wasm = facetShimSource({
		kind: "wasm",
		glue: "ext.js",
		cores: ["ext.core.wasm", "ext.core2.wasm"],
	});
	ok(wasm.includes('import core1 from "./ext.core2.wasm";'));
	ok(wasm.includes('"ext.core2.wasm": core1'));
	ok(wasm.startsWith("// Tartan extension facet"));
});
