// `/-/api/packages[/*]`:
//
//   GET /-/api/packages            every registered package (signed-in callers)
//   GET /-/api/packages/<extId>    the versions of one package
//   PUT /-/api/packages            publish (forge admin; a token needs `admin`)
//
// Publish body (`PublishRequestSchema`, local until the contract carries it):
// `{manifest, files: {<package path>: <base64>}}`. Validation, in order: the
// manifest parses (zod mirror of `manifest-1.json`) and passes the third-party
// policy (`manifestPolicyIssues`); the bundle is ≤ 10 MiB with safe relative
// paths; every file the manifest names is present (the js entry, wasm modules,
// `storage.migrations`, the protocol card ≤ 2 KB, string tool input schemas and
// the config schema, each JSON schema parsing); wasm packages carry
// `imports.json` (a string array), which must equal what the core modules
// import, all of it inside the `tartan:ext` world and granted by the manifest
// (`wasmImportIssues`, the imports ⊆ permissions check). The files go to R2
// under `ext/<extId>/<version>/<sha256>/` (content-addressed: the sha256 is
// over the sorted `path\0sha256(file)` lines), then the registry row is
// inserted (versions are immutable). Migrations are applied, and so checked, in
// the installation's facet on its first call.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
	conflict,
	denied,
	invalid,
	type Manifest,
	manifestPolicyIssues,
	notFound,
	notImplemented,
	parseManifest,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { componentImports, importIssues } from "../registry/imports.ts";
import type { ApiDeps } from "./deps.ts";
import { guard, json, readJson, requireAuth } from "./http.ts";

/** A package bundle is at most 10 MiB. */
export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
/** The protocol card is at most 2 KB. */
export const MAX_PROTOCOL_BYTES = 2048;
const MAX_FILES = 256;
const PACKAGE_PATH_RE =
	/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

export const PublishRequestSchema = z.strictObject({
	manifest: z.record(z.string(), z.unknown()),
	files: z.record(z.string().regex(PACKAGE_PATH_RE), z.base64()),
});

const sha256Hex = (data: Uint8Array | string): string =>
	createHash("sha256").update(data).digest("hex");

const decodeB64 = (b64: string): Uint8Array =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Every file the manifest refers to. */
export const requiredFiles = (m: Manifest): string[] => [
	...(m.entry.js !== undefined ? [m.entry.js] : []),
	...(m.entry.wasm ?? []),
	...(m.storage.migrations ?? []),
	...(m.contributes?.protocol !== undefined ? [m.contributes.protocol] : []),
	...(m.contributes?.tools ?? []).flatMap((t) =>
		typeof t.input === "string" ? [t.input] : []
	),
	...(m.config?.schema !== undefined ? [m.config.schema] : []),
	...(m.runtime === "wasm" ? ["imports.json"] : []),
];

/**
 * The import ⊆ permissions check of a wasm package: what its core
 * modules import, read from the binaries, must be in the world, granted by
 * the manifest, and equal to its `imports.json` record.
 */
export const wasmImportIssues = (
	m: Manifest,
	files: ReadonlyMap<string, Uint8Array>,
	recorded: readonly string[],
): string[] => {
	const cores = (m.entry.wasm ?? []).flatMap((path) => {
		const bytes = files.get(path);
		return bytes === undefined ? [] : [{ path, bytes }];
	});
	let actual: { imports: string[]; foreign: string[] };
	try {
		actual = componentImports(cores.map((c) => c.bytes));
	} catch (error) {
		return [
			`entry.wasm: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
	const issues = [
		...actual.foreign.map((i) => `import ${i} is outside tartan:ext`),
		...importIssues(actual.imports, m.permissions),
	];
	const record = [...new Set(recorded)].sort();
	if (record.join("\n") !== actual.imports.join("\n")) {
		issues.push(
			`imports.json does not match the component's imports (${
				actual.imports.join(", ") || "none"
			})`,
		);
	}
	return issues;
};

export type CheckedBundle = {
	readonly manifest: Manifest;
	readonly files: ReadonlyMap<string, Uint8Array>;
	readonly sha256: string;
	readonly imports?: string[];
};

/** Validates a publish request (pure); throws `invalid` with every issue found. */
export const checkBundle = (input: unknown): CheckedBundle => {
	const body = PublishRequestSchema.safeParse(input);
	if (!body.success) {
		throw invalid("invalid publish request", {
			issues: body.error.issues.map((i) =>
				`${i.path.join(".") || "(root)"}: ${i.message}`
			),
		});
	}
	const parsed = parseManifest(body.data.manifest);
	if (!parsed.ok) throw invalid("invalid manifest", { issues: parsed.errors });
	const m = parsed.manifest;
	const issues = manifestPolicyIssues(m, { bundled: false });
	const entries = Object.entries(body.data.files);
	if (entries.length > MAX_FILES) issues.push(`more than ${MAX_FILES} files`);
	const files = new Map<string, Uint8Array>();
	let total = 0;
	for (const [path, b64] of entries) {
		const bytes = decodeB64(b64);
		total += bytes.byteLength;
		files.set(path, bytes);
	}
	if (total > MAX_PACKAGE_BYTES) {
		issues.push(`bundle exceeds ${MAX_PACKAGE_BYTES} bytes`);
	}
	for (const path of requiredFiles(m)) {
		if (!files.has(path)) issues.push(`missing file ${path}`);
	}
	const text = (path: string): string | undefined => {
		const bytes = files.get(path);
		return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
	};
	const protocol = m.contributes?.protocol;
	if (
		protocol !== undefined &&
		(files.get(protocol)?.byteLength ?? 0) > MAX_PROTOCOL_BYTES
	) {
		issues.push(`${protocol} exceeds ${MAX_PROTOCOL_BYTES} bytes`);
	}
	const schemas = [
		...(m.contributes?.tools ?? []).flatMap((t) =>
			typeof t.input === "string" ? [t.input] : []
		),
		...(m.config?.schema !== undefined ? [m.config.schema] : []),
	];
	for (const path of schemas) {
		const source = text(path);
		if (source === undefined) continue;
		try {
			const value: unknown = JSON.parse(source);
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				issues.push(`${path} is not a JSON Schema object`);
			}
		} catch {
			issues.push(`${path} is not JSON`);
		}
	}
	let imports: string[] | undefined;
	if (m.runtime === "wasm" && files.has("imports.json")) {
		try {
			const value: unknown = JSON.parse(text("imports.json")!);
			if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
				throw new Error();
			}
			imports = value;
		} catch {
			issues.push("imports.json must be a JSON array of strings");
		}
	}
	if (m.runtime === "wasm" && imports !== undefined) {
		issues.push(...wasmImportIssues(m, files, imports));
	}
	if (issues.length > 0) throw invalid("package rejected", { issues });
	files.set("tartan.json", new TextEncoder().encode(JSON.stringify(m)));
	const sha256 = sha256Hex(
		[...files.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, bytes]) => `${path}\u0000${sha256Hex(bytes)}\n`)
			.join(""),
	);
	return { manifest: m, files, sha256, ...(imports ? { imports } : {}) };
};

/** Publishing is a forge-admin action; a token also needs the `admin` scope. */
const requirePublisher = (auth: AuthContext): void => {
	if (!auth.isAdmin) throw denied("role", "forge admin required");
	if (auth.via !== "session" && !auth.scopes.includes("admin")) {
		throw denied("scopes", "the token needs the admin scope");
	}
};

export const handlePackagesRequest = (
	deps: ApiDeps,
	req: Request,
	rest: string | undefined,
	authIn: AuthContext | null,
): Promise<Response> =>
	guard(async () => {
		const auth = requireAuth(authIn);
		const method = req.method === "HEAD" ? "GET" : req.method;
		const parts = (rest ?? "").split("/").filter((p) => p !== "");
		if (method === "GET" && parts.length <= 1) {
			const list = await deps.registry().packages(parts[0]);
			if (parts.length === 1 && list.length === 0) throw notFound("package");
			return json({ packages: list });
		}
		if (method === "PUT" && parts.length === 0) {
			requirePublisher(auth);
			const bundle = checkBundle(
				await readJson(req, Math.ceil(MAX_PACKAGE_BYTES * 1.4)),
			);
			const m = bundle.manifest;
			const existing = await deps.registry().packages(m.id);
			if (existing.some((p) => p.version === m.version)) {
				throw conflict(`${m.id}@${m.version} is already published`);
			}
			const prefix = `ext/${m.id}/${m.version}/${bundle.sha256}/`;
			const blobs = deps.blobs();
			for (const [path, bytes] of bundle.files) {
				await blobs.put(`${prefix}${path}`, bytes);
			}
			const pkg = await deps.registry().publish(auth.principal, m, {
				sha256: bundle.sha256,
				r2Prefix: prefix,
				...(bundle.imports ? { imports: bundle.imports } : {}),
			});
			return json(pkg, 201);
		}
		if (method === "DELETE") {
			throw notImplemented("unpublishing packages");
		}
		throw notFound("route");
	});
