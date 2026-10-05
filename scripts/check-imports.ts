// Enforces the extension import boundary.
//
// Every source file under `extensions/<name>/` may import only:
//   - `@tartan/contract` and `@tartan/ext-api` (and their subpaths), except
//     the kernel-only contract entry points (`@tartan/contract/kernel`,
//     `/do/*`, `/ports`, `/security`, `/services`), or
//   - relative paths that stay inside the same `extensions/<name>/` directory.
// Test files (`*.test.ts`, which includes `*.workers.test.ts`) may also import
// the test tooling: `node:assert/strict`, `@tartan/testkit` (and subpaths),
// `vitest`, `cloudflare:test`, `cloudflare:workers` and the pool's
// `@cloudflare/vitest-pool-workers/types` reference. Production files never
// can, and test files keep every other rule.
// Anything else (npm packages, `node:*`, `cloudflare:*`, kernel paths, other
// extensions, URLs) fails. Static imports, re-exports, `import type`, string
// literal `import()` and `require()` calls, and triple-slash references are all
// checked, using the TypeScript scanner so comments and strings never count.
//
// Usage: deno run -A scripts/check-imports.ts [extensions-root]

import ts from "typescript";

const ALLOWED_PACKAGES = ["@tartan/contract", "@tartan/ext-api"];
/** Extra imports for test files only (`*.test.ts`, `*.workers.test.ts`). */
const TEST_PACKAGES = ["@tartan/testkit"];
const TEST_SPECIFIERS: ReadonlySet<string> = new Set([
	"node:assert/strict",
	"vitest",
	"cloudflare:test",
	"cloudflare:workers",
	"@cloudflare/vitest-pool-workers/types",
]);
const TEST_FILE = /\.test\.ts$/;
/** Kernel-only subpaths of `@tartan/contract`. */
const KERNEL_ONLY =
	/^@tartan\/contract\/(?:kernel|ports|security|services)(?:\.ts)?$|^@tartan\/contract\/do(?:\/|$)/;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".wrangler"]);

type Violation = {
	readonly file: string;
	readonly specifier: string;
	readonly reason: string;
};

const isDir = async (path: string): Promise<boolean> => {
	try {
		return (await Deno.stat(path)).isDirectory;
	} catch {
		return false;
	}
};

const walk = async (dir: string): Promise<string[]> => {
	const found: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await walk(path)));
		} else if (entry.isFile && SOURCE.test(entry.name)) {
			found.push(path);
		}
	}
	return found.sort();
};

// Resolves `specifier` against the directory of `file` without touching disk.
const resolveRelative = (file: string, specifier: string): string => {
	const parts = file.split("/").slice(0, -1);
	for (const segment of specifier.split("/")) {
		if (segment === "..") parts.pop();
		else if (segment !== "." && segment !== "") parts.push(segment);
	}
	return parts.join("/");
};

const isUnder = (packages: readonly string[], specifier: string): boolean =>
	packages.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));

const isAllowedPackage = (specifier: string): boolean =>
	isUnder(ALLOWED_PACKAGES, specifier);

const isTestTooling = (file: string, specifier: string): boolean =>
	TEST_FILE.test(file) &&
	(TEST_SPECIFIERS.has(specifier) || isUnder(TEST_PACKAGES, specifier));

/** Why `specifier` (imported by `file` in `extensionRoot`) is forbidden, or undefined. */
export const classify = (
	extensionRoot: string,
	file: string,
	specifier: string,
): string | undefined => {
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const target = resolveRelative(file, specifier);
		return target === extensionRoot || target.startsWith(`${extensionRoot}/`)
			? undefined
			: `relative import leaves ${extensionRoot}/`;
	}
	if (KERNEL_ONLY.test(specifier)) {
		return "kernel-only contract entry point (use @tartan/contract)";
	}
	if (isAllowedPackage(specifier)) return undefined;
	if (isTestTooling(file, specifier)) return undefined;
	return `only ${
		ALLOWED_PACKAGES.join(", ")
	} and relative imports within the extension are allowed`;
};

type Reference = { readonly raw: string; readonly specifier: string };

// `/// <reference path="x" />` is always file-relative, so it is checked as `./x`.
const asRelative = (path: string): string =>
	path.startsWith(".") ? path : `./${path}`;

const referencesOf = (text: string): Reference[] => {
	const info = ts.preProcessFile(text, true, true);
	return [
		...info.importedFiles.map((ref) => ({
			raw: ref.fileName,
			specifier: ref.fileName,
		})),
		...info.referencedFiles.map((ref) => ({
			raw: ref.fileName,
			specifier: asRelative(ref.fileName),
		})),
		...info.typeReferenceDirectives.map((ref) => ({
			raw: ref.fileName,
			specifier: ref.fileName,
		})),
		...info.libReferenceDirectives.map((ref) => ({
			raw: ref.fileName,
			specifier: `lib:${ref.fileName}`,
		})),
	];
};

const checkExtension = async (extensionRoot: string): Promise<Violation[]> => {
	const violations: Violation[] = [];
	for (const file of await walk(extensionRoot)) {
		const text = await Deno.readTextFile(file);
		for (const { raw, specifier } of referencesOf(text)) {
			const reason = classify(extensionRoot, file, specifier);
			if (reason) violations.push({ file, specifier: raw, reason });
		}
	}
	return violations;
};

const main = async (): Promise<number> => {
	const root = (Deno.args[0] ?? "extensions").replace(/\/+$/, "");
	if (!(await isDir(root))) {
		console.log(`check-imports: no ${root}/ directory, nothing to check`);
		return 0;
	}
	const extensions: string[] = [];
	for await (const entry of Deno.readDir(root)) {
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			extensions.push(`${root}/${entry.name}`);
		}
	}
	const violations = (await Promise.all(extensions.sort().map(checkExtension)))
		.flat();
	if (violations.length > 0) {
		for (const v of violations) {
			console.error(`${v.file}: "${v.specifier}" — ${v.reason}`);
		}
		console.error(`check-imports: ${violations.length} forbidden import(s)`);
		return 1;
	}
	console.log(`check-imports: ${extensions.length} extension(s) clean`);
	return 0;
};

if (import.meta.main) Deno.exit(await main());
