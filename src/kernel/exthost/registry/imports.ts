// The publish-time WASM import check: a `wasm`
// package's core modules may import only the `tartan:ext@0.1.0` world's
// functions (and jco's own plumbing, module ""), and a function that needs
// a manifest permission needs it granted (`effects.notify` → `notify`,
// `effects.contribute-note` → `notes`). The import record (`imports.json`,
// written by `deno task build:ext`) must equal what the core modules
// actually import, so editing the record cannot widen a package.
//
// The modules are read, never compiled (runtime compilation is forbidden in
// a Worker [E B2]): the import section of the WebAssembly binary format.

import type { ManifestPermissions } from "@tartan/contract";

export const WIT_VERSION = "0.1.0";

/** Every function the world imports, by interface. */
export const WORLD_IMPORTS: Readonly<Record<string, readonly string[]>> = {
	types: [],
	sql: ["exec"],
	kv: ["get", "put", "delete", "list-keys"],
	host: ["log", "config", "now-ms", "random", "ulid"],
	effects: ["emit", "notify", "contribute-note", "set-timer"],
};

/** Imports that need a manifest permission. */
const NEEDS: Readonly<
	Record<string, {
		readonly perm: string;
		readonly granted: (p: ManifestPermissions) => boolean;
	}>
> = {
	[`tartan:ext/effects@${WIT_VERSION}#notify`]: {
		perm: "notify",
		granted: (p) => p.notify === true,
	},
	[`tartan:ext/effects@${WIT_VERSION}#contribute-note`]: {
		perm: "notes",
		granted: (p) => p.notes === true,
	},
};

export type WasmImport = {
	readonly module: string;
	readonly name: string;
	/** 0 func, 1 table, 2 memory, 3 global, 4 tag. */
	readonly kind: number;
};

/** The import section of a core WebAssembly module (throws on a malformed one). */
export const wasmImports = (bytes: Uint8Array): WasmImport[] => {
	let at = 0;
	const fail = (what: string): never => {
		throw new Error(`not a core WebAssembly module: ${what} at byte ${at}`);
	};
	const byte = (): number => {
		if (at >= bytes.length) fail("unexpected end");
		return bytes[at++];
	};
	const uleb = (): number => {
		let result = 0;
		let shift = 0;
		for (;;) {
			const b = byte();
			result += (b & 0x7f) * 2 ** shift;
			if ((b & 0x80) === 0) return result;
			shift += 7;
			if (shift > 63) fail("LEB128 too long");
		}
	};
	const sleb = (): void => {
		for (;;) {
			if ((byte() & 0x80) === 0) return;
		}
	};
	const name = (): string => {
		const len = uleb();
		if (at + len > bytes.length) fail("name past the end");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(at, at + len),
		);
		at += len;
		return text;
	};
	const limits = (): void => {
		const flags = byte();
		uleb();
		if ((flags & 1) !== 0) uleb();
	};
	const refType = (): void => {
		const t = byte();
		if (t === 0x63 || t === 0x64) sleb();
	};
	const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
	for (const b of magic) if (byte() !== b) fail("bad header");
	const out: WasmImport[] = [];
	while (at < bytes.length) {
		const id = byte();
		const size = uleb();
		const end = at + size;
		if (end > bytes.length) fail("section past the end");
		if (id !== 2) {
			at = end;
			continue;
		}
		const count = uleb();
		for (let i = 0; i < count; i++) {
			const module = name();
			const field = name();
			const kind = byte();
			switch (kind) {
				case 0:
					uleb();
					break;
				case 1:
					refType();
					limits();
					break;
				case 2:
					limits();
					break;
				case 3:
					byte();
					byte();
					break;
				case 4:
					byte();
					uleb();
					break;
				default:
					fail(`import kind ${kind}`);
			}
			out.push({ module, name: field, kind });
		}
		at = end;
		break;
	}
	return out;
};

const WORLD_MODULE_RE = /^tartan:ext\/([a-z-]+)@(\d+\.\d+\.\d+)$/;

/**
 * The world imports of a component's core modules (`<interface>#<function>`,
 * sorted) and the imports that are outside the world.
 */
export const componentImports = (
	cores: readonly Uint8Array[],
): { readonly imports: string[]; readonly foreign: string[] } => {
	const imports = new Set<string>();
	const foreign = new Set<string>();
	for (const core of cores) {
		for (const i of wasmImports(core)) {
			// jco's own plumbing between its core modules.
			if (i.module === "") continue;
			const match = WORLD_MODULE_RE.exec(i.module);
			const known = match !== null && match[2] === WIT_VERSION &&
				(WORLD_IMPORTS[match[1]] ?? []).includes(i.name);
			if (known) imports.add(`${i.module}#${i.name}`);
			else foreign.add(`${i.module}#${i.name}`);
		}
	}
	return { imports: [...imports].sort(), foreign: [...foreign].sort() };
};

/** Problems with a package's import record against its manifest permissions. */
export const importIssues = (
	imports: readonly string[],
	permissions: ManifestPermissions,
): string[] =>
	imports.flatMap((entry) => {
		const [module, fn] = entry.split("#");
		const match = WORLD_MODULE_RE.exec(module ?? "");
		if (
			match === null || match[2] !== WIT_VERSION ||
			!(match[1] in WORLD_IMPORTS) ||
			(fn !== undefined && !WORLD_IMPORTS[match[1]].includes(fn))
		) {
			return [`import ${entry} is not part of tartan:ext@${WIT_VERSION}`];
		}
		const need = NEEDS[entry];
		return need !== undefined && !need.granted(permissions)
			? [`import ${entry} needs the ${need.perm} permission`]
			: [];
	});
