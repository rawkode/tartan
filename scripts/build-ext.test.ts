// build-ext: the Cargo.toml name, jco's core module order, the bundled
// module, and the whole wasm build with the tools faked (each writes what
// the real one would), which covers the assembly, the import check and the
// publish body.

import {
	deepStrictEqual,
	match,
	ok,
	rejects,
	strictEqual,
} from "node:assert/strict";
import * as path from "node:path";
import { parseManifest } from "@tartan/contract";
import {
	buildExtension,
	bundledModule,
	coreOrder,
	crateName,
} from "./build-ext.ts";
import type { Run } from "./preflight.ts";

Deno.test("crateName reads [package] name only", () => {
	strictEqual(
		crateName(
			'[package]\nname = "acme-no-secrets"\nversion = "0.1.0"\n\n[dependencies]\nname = "x"\n',
		),
		"acme-no-secrets",
	);
	let threw = false;
	try {
		crateName('[dependencies]\nname = "x"\n');
	} catch {
		threw = true;
	}
	ok(threw);
});

Deno.test("coreOrder follows jco's numbering", () => {
	deepStrictEqual(
		coreOrder([
			"ext.core3.wasm",
			"ext.js",
			"ext.core.wasm",
			"ext.core10.wasm",
			"ext.core2.wasm",
			"interfaces",
		]),
		["ext.core.wasm", "ext.core2.wasm", "ext.core3.wasm", "ext.core10.wasm"],
	);
});

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
const str = (s: string) => {
	const b = [...new TextEncoder().encode(s)];
	return [...uleb(b.length), ...b];
};
const core = (imports: readonly [string, string][]): Uint8Array => {
	const entries = imports.flatMap(([m, n]) => [...str(m), ...str(n), 0, 0]);
	const section = [...uleb(imports.length), ...entries];
	return new Uint8Array([
		0,
		0x61,
		0x73,
		0x6d,
		1,
		0,
		0,
		0,
		1,
		4,
		1,
		0x60,
		0,
		0,
		2,
		...uleb(section.length),
		...section,
	]);
};

const MANIFEST = {
	schema: 1,
	id: "acme.demo",
	name: "Demo",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "wasm",
	entry: { js: "ext.js", wasm: ["ext.core.wasm"] },
	storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
	permissions: {},
};

const fakeRoot = async (manifest: Record<string, unknown>) => {
	const root = await Deno.makeTempDir({ prefix: "build-ext-test-" });
	const dir = path.join(root, "extensions", "demo");
	await Deno.mkdir(path.join(dir, "migrations"), { recursive: true });
	await Deno.writeTextFile(
		path.join(dir, "tartan.json"),
		JSON.stringify(manifest),
	);
	await Deno.writeTextFile(
		path.join(dir, "Cargo.toml"),
		'[package]\nname = "acme-demo"\n',
	);
	await Deno.writeTextFile(
		path.join(dir, "migrations", "0001_init.sql"),
		"CREATE TABLE t (x)",
	);
	return { root, dir };
};

/** Fakes cargo, wasm-tools and jco: each writes the file the next step reads. */
const fakeTools = (
	imports: readonly [string, string][],
	calls: string[],
): Run =>
async (cmd, args) => {
	calls.push(`${path.basename(cmd)} ${args[0]}`);
	if (cmd === "cargo") {
		return { code: 0, stdout: "", stderr: "" };
	}
	if (cmd === "wasm-tools") {
		await Deno.writeFile(args[args.indexOf("-o") + 1], new Uint8Array([0]));
		return { code: 0, stdout: "", stderr: "" };
	}
	const out = args[args.indexOf("-o") + 1];
	await Deno.mkdir(out, { recursive: true });
	await Deno.writeTextFile(
		path.join(out, "ext.js"),
		"export function instantiate() {}",
	);
	await Deno.writeFile(path.join(out, "ext.core.wasm"), core(imports));
	await Deno.writeFile(
		path.join(out, "ext.core2.wasm"),
		core([["", "0"]]),
	);
	return { code: 0, stdout: "", stderr: "" };
};

Deno.test("a wasm build: assembled, import record from the core modules, publish body, bundled module", async () => {
	const { root, dir } = await fakeRoot(MANIFEST);
	try {
		const calls: string[] = [];
		const result = await buildExtension({
			name: "demo",
			root,
			targetDir: path.join(root, "target"),
			run: fakeTools([
				["tartan:ext/sql@0.1.0", "exec"],
				["tartan:ext/host@0.1.0", "log"],
			], calls),
			env: { JCO: "jco" },
			log: () => {},
		});
		deepStrictEqual(calls, [
			"cargo build",
			"wasm-tools component",
			"jco transpile",
		]);
		deepStrictEqual(result.imports, [
			"tartan:ext/host@0.1.0#log",
			"tartan:ext/sql@0.1.0#exec",
		]);
		deepStrictEqual(result.manifest.entry, {
			js: "ext.js",
			wasm: ["ext.core.wasm", "ext.core2.wasm"],
		});
		match(result.sha256, /^[0-9a-f]{64}$/);
		const out = path.join(dir, "dist");
		const written: string[] = [];
		for await (const e of Deno.readDir(out)) written.push(e.name);
		deepStrictEqual(written.sort(), [
			"bundled.js",
			"ext.core.wasm",
			"ext.core2.wasm",
			"ext.js",
			"imports.json",
			"migrations",
			"publish.json",
			"tartan.json",
		]);
		const body = JSON.parse(
			await Deno.readTextFile(path.join(out, "publish.json")),
		);
		ok(parseManifest(body.manifest).ok);
		ok("ext.core2.wasm" in body.files);
		const bundled = await Deno.readTextFile(path.join(out, "bundled.js"));
		ok(bundled.includes('import core1 from "./ext.core2.wasm";'));
		ok(bundled.includes(result.sha256));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("a wasm build refuses imports outside the world or beyond the permissions", async () => {
	const { root } = await fakeRoot(MANIFEST);
	try {
		await rejects(
			() =>
				buildExtension({
					name: "demo",
					root,
					targetDir: path.join(root, "target"),
					run: fakeTools([["tartan:ext/effects@0.1.0", "notify"]], []),
					env: { JCO: "jco" },
					log: () => {},
				}),
			/needs the notify permission/,
		);
		await rejects(
			() =>
				buildExtension({
					name: "demo",
					root,
					targetDir: path.join(root, "target"),
					run: fakeTools([["wasi_snapshot_preview1", "fd_write"]], []),
					env: { JCO: "jco" },
					log: () => {},
				}),
			/outside tartan:ext/,
		);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("bundledModule lists the cores and the migrations", () => {
	const parsed = parseManifest({
		...MANIFEST,
		entry: { js: "ext.js", wasm: ["ext.core.wasm", "ext.core2.wasm"] },
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	const text = bundledModule(
		parsed.manifest,
		"f".repeat(64),
		new Map([[
			"migrations/0001_init.sql",
			new TextEncoder().encode("CREATE TABLE t (x)"),
		]]),
	);
	ok(text.includes('import { instantiate } from "./ext.js";'));
	ok(text.includes('"ext.core2.wasm": core1'));
	ok(text.includes('{"n":1,"name":"init","sql":"CREATE TABLE t (x)"}'));
});
