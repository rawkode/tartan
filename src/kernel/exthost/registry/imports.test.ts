// The publish-time WASM import check: the import section reader and the
// imports ⊆ permissions rule, on core modules built byte by byte.

import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { componentImports, importIssues, wasmImports } from "./imports.ts";

const NONE = { repo: "none" as const };

const uleb = (n: number): number[] => {
	const out: number[] = [];
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n !== 0) b |= 0x80;
		out.push(b);
	} while (n !== 0);
	return out;
};
const str = (s: string): number[] => {
	const bytes = [...new TextEncoder().encode(s)];
	return [...uleb(bytes.length), ...bytes];
};

type Imp = {
	module: string;
	name: string;
	kind?: "func" | "table" | "memory" | "global";
};

/** A core module with a type section (one func type) and an import section. */
const coreModule = (imports: readonly Imp[]): Uint8Array => {
	const type = [0x01, 0x60, 0x00, 0x00]; // one type: () -> ()
	const entries = imports.flatMap((i) => {
		const desc = i.kind === "table"
			? [0x01, 0x70, 0x00, 0x01]
			: i.kind === "memory"
			? [0x02, 0x01, 0x01, 0x02]
			: i.kind === "global"
			? [0x03, 0x7f, 0x00]
			: [0x00, 0x00];
		return [...str(i.module), ...str(i.name), ...desc];
	});
	const importSection = [...uleb(imports.length), ...entries];
	return new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		0x01,
		...uleb(type.length),
		...type,
		0x02,
		...uleb(importSection.length),
		...importSection,
	]);
};

Deno.test("the import section reader finds every import kind", () => {
	const bytes = coreModule([
		{ module: "tartan:ext/sql@0.1.0", name: "exec" },
		{ module: "", name: "$imports", kind: "table" },
		{ module: "env", name: "memory", kind: "memory" },
		{ module: "env", name: "g", kind: "global" },
	]);
	deepStrictEqual(wasmImports(bytes), [
		{ module: "tartan:ext/sql@0.1.0", name: "exec", kind: 0 },
		{ module: "", name: "$imports", kind: 1 },
		{ module: "env", name: "memory", kind: 2 },
		{ module: "env", name: "g", kind: 3 },
	]);
	deepStrictEqual(wasmImports(coreModule([])), []);
	throws(() =>
		wasmImports(new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]))
	);
	throws(() => wasmImports(bytes.subarray(0, bytes.length - 3)));
});

Deno.test("component imports: world functions recorded, jco plumbing skipped, the rest foreign", () => {
	const out = componentImports([
		coreModule([
			{ module: "tartan:ext/host@0.1.0", name: "log" },
			{ module: "tartan:ext/sql@0.1.0", name: "exec" },
			{ module: "tartan:ext/host@0.1.0", name: "log" },
		]),
		coreModule([{ module: "", name: "0" }]),
		coreModule([
			{ module: "wasi_snapshot_preview1", name: "fd_write" },
			{ module: "tartan:ext/sql@0.2.0", name: "exec" },
			{ module: "tartan:ext/host@0.1.0", name: "fetch" },
		]),
	]);
	deepStrictEqual(out.imports, [
		"tartan:ext/host@0.1.0#log",
		"tartan:ext/sql@0.1.0#exec",
	]);
	deepStrictEqual(out.foreign, [
		"tartan:ext/host@0.1.0#fetch",
		"tartan:ext/sql@0.2.0#exec",
		"wasi_snapshot_preview1#fd_write",
	]);
});

Deno.test("imports ⊆ permissions: notify and contribute-note need their grants", () => {
	const imports = [
		"tartan:ext/effects@0.1.0#emit",
		"tartan:ext/effects@0.1.0#notify",
		"tartan:ext/effects@0.1.0#contribute-note",
		"tartan:ext/kv@0.1.0#put",
	];
	deepStrictEqual(importIssues(imports, NONE), [
		"import tartan:ext/effects@0.1.0#notify needs the notify permission",
		"import tartan:ext/effects@0.1.0#contribute-note needs the notes permission",
	]);
	deepStrictEqual(
		importIssues(imports, { ...NONE, notify: true, notes: true }),
		[],
	);
	deepStrictEqual(importIssues(["tartan:ext/types@0.1.0"], NONE), []);
	strictEqual(
		importIssues(["tartan:ext/repo@0.1.0#read"], NONE)[0],
		"import tartan:ext/repo@0.1.0#read is not part of tartan:ext@0.1.0",
	);
	strictEqual(importIssues(["wasi:io/streams@0.2.0"], NONE).length, 1);
});
