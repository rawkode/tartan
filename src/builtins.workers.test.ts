// The builtin registry loads inside workerd: the JSON manifest imports
// (`with { type: "json" }`) and every extension module bundle under the vitest
// pool, and module-load validation passes.

import { describe, expect, it } from "vitest";
import { BUILTIN_SOURCES, builtins } from "./builtins.ts";

describe("builtin registry in workerd", () => {
	it("registers every bundled package by its manifest id", () => {
		expect(builtins.ids.length).toBe(BUILTIN_SOURCES.length);
		expect(new Set(builtins.ids).size).toBe(builtins.ids.length);
		for (const id of builtins.ids) {
			const pkg = builtins.get(id);
			expect(pkg?.manifest.id, id).toBe(id);
			expect(pkg?.manifest.runtime, id).toBe("builtin");
			expect(typeof pkg?.module, id).toBe("object");
		}
	});

	it("does not bundle the third-party WASM demo", () => {
		expect(builtins.has("acme.no-secrets")).toBe(false);
	});
});
