// Fails when any npm or Cargo dependency is licensed only under GPL, AGPL or
// LGPL. Tartan itself is MIT.
//
// npm: every entry of package-lock.json (prod, dev and optional), falling back
// to node_modules/<pkg>/package.json when the lockfile has no license field.
// Cargo: `cargo metadata` for every Cargo.toml in the repo (skipped when there
// are none; when cargo is missing it fails under CI=true and warns otherwise).
//
// SPDX expressions are evaluated: `MIT OR GPL-2.0` passes (MIT can be chosen),
// `MIT AND GPL-2.0` fails. Cargo's legacy `MIT/Apache-2.0` is read as OR.
// Packages with no declared license are reported; `--strict` makes them fail.
//
// DEV_EXCEPTIONS lists reviewed GPL-family packages that are tolerated only
// while they stay dev-only (lockfile `dev: true`): local tooling that is never
// bundled into the Worker or the SPA. Anything not listed, or a listed package
// that becomes a runtime dependency, still fails.
//
// Usage: deno task license:check [--strict]

type Finding = {
	readonly ecosystem: "npm" | "cargo";
	readonly name: string;
	readonly version: string;
	readonly license: string | undefined;
	readonly devOnly: boolean;
};

type DevException = { readonly name: RegExp; readonly reason: string };

const DEV_EXCEPTIONS: readonly DevException[] = [
	{
		name: /^@img\/sharp-(libvips-|wasm32$|win32-)/,
		reason:
			"libvips (LGPL-3.0) prebuilt binaries pulled in optionally by miniflare (wrangler, vitest-pool-workers) for local Images emulation; dev tooling only, never bundled",
	},
];

const exceptionFor = (f: Finding): DevException | undefined =>
	f.ecosystem === "npm" && f.devOnly
		? DEV_EXCEPTIONS.find((e) => e.name.test(f.name))
		: undefined;

type Verdict = "allowed" | "denied" | "unknown";

const COPYLEFT = /^(A|L)?GPL/i;
const SKIP_DIRS = new Set([
	"node_modules",
	"target",
	".git",
	".wrangler",
	"dist",
]);

// --- SPDX evaluation -------------------------------------------------------

const tokenize = (expression: string): string[] =>
	expression
		.replace(/\//g, " OR ")
		.replace(/([()])/g, " $1 ")
		.split(/\s+/)
		.filter((token) => token.length > 0);

// Grammar: or := and ("OR" and)* ; and := term ("AND" term)* ;
// term := "(" or ")" | id ("WITH" id)?   Returns whether a non-copyleft choice exists.
const permits = (expression: string): boolean => {
	const tokens = tokenize(expression);
	let position = 0;
	const peek = (): string | undefined => tokens[position]?.toUpperCase();

	const term = (): boolean => {
		if (tokens[position] === "(") {
			position += 1;
			const inner = or();
			if (tokens[position] === ")") position += 1;
			return inner;
		}
		const id = tokens[position] ?? "";
		position += 1;
		if (peek() === "WITH") position += 2;
		return !COPYLEFT.test(id);
	};
	const and = (): boolean => {
		let result = term();
		while (peek() === "AND") {
			position += 1;
			result = term() && result;
		}
		return result;
	};
	const or = (): boolean => {
		let result = and();
		while (peek() === "OR") {
			position += 1;
			result = and() || result;
		}
		return result;
	};
	return or();
};

const verdictOf = (license: string | undefined): Verdict => {
	if (
		!license || license.trim() === "" ||
		/^(UNLICENSED|SEE LICENSE)/i.test(license.trim())
	) {
		return "unknown";
	}
	return permits(license) ? "allowed" : "denied";
};

// --- npm ---------------------------------------------------------------------

type LockEntry = {
	version?: string;
	license?: string;
	name?: string;
	link?: boolean;
	dev?: boolean;
};

type ManifestLicense =
	| string
	| { type?: string }
	| Array<{ type?: string }>
	| undefined;

const licenseFromManifest = (
	manifest: { license?: ManifestLicense; licenses?: ManifestLicense },
): string | undefined => {
	const value = manifest.license ?? manifest.licenses;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const types = value.map((item) => item.type).filter((t): t is string =>
			!!t
		);
		return types.length > 0 ? types.join(" OR ") : undefined;
	}
	return value?.type;
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
	try {
		return JSON.parse(await Deno.readTextFile(path)) as T;
	} catch {
		return undefined;
	}
};

const npmFindings = async (): Promise<Finding[]> => {
	const lock = await readJson<{ packages?: Record<string, LockEntry> }>(
		"package-lock.json",
	);
	if (!lock?.packages) {
		throw new Error(
			"package-lock.json is missing or has no `packages` map (lockfileVersion >= 2 required)",
		);
	}
	const findings: Finding[] = [];
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "" || entry.link) continue;
		const name = entry.name ??
			path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
		const license = entry.license ??
			licenseFromManifest(
				(await readJson<{ license?: ManifestLicense }>(
					`${path}/package.json`,
				)) ?? {},
			);
		findings.push({
			ecosystem: "npm",
			name,
			version: entry.version ?? "?",
			license,
			devOnly: entry.dev === true,
		});
	}
	return findings;
};

// --- Cargo -------------------------------------------------------------------

const findCargoManifests = async (dir: string): Promise<string[]> => {
	const found: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await findCargoManifests(path)));
		} else if (entry.isFile && entry.name === "Cargo.toml") {
			found.push(path);
		}
	}
	return found.sort();
};

type CargoPackage = {
	id: string;
	name: string;
	version: string;
	license: string | null;
};

const cargoMetadata = async (manifest: string): Promise<CargoPackage[]> => {
	const { code, stdout, stderr } = await new Deno.Command("cargo", {
		args: ["metadata", "--format-version", "1", "--manifest-path", manifest],
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (code !== 0) {
		throw new Error(
			`cargo metadata failed for ${manifest}:\n${
				new TextDecoder().decode(stderr)
			}`,
		);
	}
	return (JSON.parse(new TextDecoder().decode(stdout)) as {
		packages: CargoPackage[];
	}).packages;
};

const cargoAvailable = async (): Promise<boolean> => {
	try {
		const { code } = await new Deno.Command("cargo", {
			args: ["--version"],
			stdout: "null",
			stderr: "null",
		})
			.output();
		return code === 0;
	} catch {
		return false;
	}
};

const cargoFindings = async (): Promise<
	{ findings: Finding[]; problem?: string }
> => {
	const manifests = await findCargoManifests(".");
	if (manifests.length === 0) return { findings: [] };
	if (!(await cargoAvailable())) {
		return {
			findings: [],
			problem:
				`cargo not found; ${manifests.length} Cargo.toml file(s) not checked`,
		};
	}
	const byId = new Map<string, Finding>();
	for (const manifest of manifests) {
		for (const pkg of await cargoMetadata(manifest)) {
			byId.set(pkg.id, {
				ecosystem: "cargo",
				name: pkg.name,
				version: pkg.version,
				license: pkg.license ?? undefined,
				devOnly: false,
			});
		}
	}
	return { findings: [...byId.values()] };
};

// --- report ------------------------------------------------------------------

const label = (f: Finding): string =>
	`${f.ecosystem} ${f.name}@${f.version} (${f.license ?? "no license field"})`;

const main = async (): Promise<number> => {
	const strict = Deno.args.includes("--strict");
	const inCi = Deno.env.get("CI") === "true";
	const npm = await npmFindings();
	const cargo = await cargoFindings();
	const all = [...npm, ...cargo.findings];

	const copyleft = all.filter((f) => verdictOf(f.license) === "denied");
	const excepted = copyleft.filter((f) => exceptionFor(f));
	const denied = copyleft.filter((f) => !exceptionFor(f));
	const unknown = all.filter((f) => verdictOf(f.license) === "unknown");
	const counts = new Map<string, number>();
	for (const f of all) {
		counts.set(
			f.license ?? "(none)",
			(counts.get(f.license ?? "(none)") ?? 0) + 1,
		);
	}

	console.log(
		`license-check: ${npm.length} npm and ${cargo.findings.length} cargo package(s)`,
	);
	for (
		const [license, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])
	) {
		console.log(`  ${String(count).padStart(4)}  ${license}`);
	}
	for (const f of unknown) console.warn(`unknown license: ${label(f)}`);
	for (const f of excepted) {
		console.warn(
			`excepted (dev-only): ${label(f)} — ${exceptionFor(f)?.reason}`,
		);
	}
	for (const f of denied) console.error(`DENIED (GPL family): ${label(f)}`);

	const failures: string[] = [];
	if (denied.length > 0) {
		failures.push(`${denied.length} GPL/AGPL/LGPL-only package(s)`);
	}
	if (strict && unknown.length > 0) {
		failures.push(`${unknown.length} package(s) without a license (--strict)`);
	}
	if (cargo.problem) {
		if (inCi) failures.push(cargo.problem);
		else console.warn(`warning: ${cargo.problem}`);
	}
	if (failures.length > 0) {
		console.error(`license-check: FAIL — ${failures.join("; ")}`);
		return 1;
	}
	console.log(
		`license-check: PASS (no GPL/AGPL/LGPL-only dependencies; ${excepted.length} reviewed dev-only exception(s))`,
	);
	return 0;
};

Deno.exit(await main());
