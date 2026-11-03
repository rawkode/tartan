// Registry of bundled builtin packages. Integrator-owned.
//
// Every first-party package in the Worker bundle is listed once in
// `BUILTIN_SOURCES`: its manifest (`extensions/<name>/tartan.json`), module,
// migrations and protocol card, all taken from the extension's own files. Each
// `extensions/<name>/src/index.ts` exports `extension`, `migrations` and
// `protocol`, so an owning WP changes behaviour, migrations or its card
// without touching this file. Consumers: WP7a registers each package as a
// `packages` row (`published_by = 'sys_kernel'`, `r2_prefix NULL`) at boot;
// WP7b's ExtensionDO resolves `entry.builtin` through `builtins.get`.
//
// The third-party Rust/WASM demo `acme.no-secrets` is deliberately absent: it
// is published and installed like any other package.
//
// The registry is built at module load and throws on any invalid package, so
// a broken manifest fails `wrangler deploy` (startup validation) and the unit
// tests instead of surfacing at install time.

import {
	type BuiltinPackage,
	type ExtensionModule,
	type ExtMigration,
	internal,
	type Manifest,
	manifestPolicyIssues,
	parseManifest,
} from "@tartan/contract";

/** The exports every `extensions/<name>/src/index.ts` provides. */
export type BuiltinExports = {
	readonly extension: ExtensionModule;
	readonly migrations: readonly ExtMigration[];
	readonly protocol: string | undefined;
	/** `config.cue` (repository config), when the manifest declares one. */
	readonly settingsCue?: string;
};

/** One bundled package before validation: the raw `tartan.json` plus its exports. */
export type BuiltinSource = BuiltinExports & {
	/** `extensions/<dir>` the package lives in (diagnostics and tests). */
	readonly dir: string;
	readonly manifest: unknown;
};

/** Every bundled package, in registration order (packs after their members). */
export const BUILTIN_SOURCES: readonly BuiltinSource[] = [];

/** Package path of a migration: `migrations/0001_init.sql` for `{n: 1, name: "init"}`. */
export const migrationPath = (m: ExtMigration): string =>
	`migrations/${String(m.n).padStart(4, "0")}_${m.name}.sql`;

export type BuiltinCheck =
	| { readonly ok: true; readonly pkg: BuiltinPackage }
	| { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validates one bundled package: the manifest parses (zod mirror of
 * `manifest-1.json`), passes the bundled policy rules, runs `builtin` with
 * `entry.builtin` equal to its id, names exactly the embedded migrations (in
 * order, numbered 1–999 and increasing) and declares a protocol card iff one
 * is embedded.
 */
export const checkBuiltin = (src: BuiltinSource): BuiltinCheck => {
	const parsed = parseManifest(src.manifest);
	if (!parsed.ok) {
		return { ok: false, issues: parsed.errors.map((e) => `manifest ${e}`) };
	}
	const m: Manifest = parsed.manifest;
	const issues = manifestPolicyIssues(m, { bundled: true });
	if (m.runtime !== "builtin") {
		issues.push(`runtime: ${m.runtime}, not builtin`);
	}
	if (m.entry.builtin !== m.id) {
		issues.push(`entry.builtin: ${m.entry.builtin} does not match id ${m.id}`);
	}
	const declared = m.storage.migrations ?? [];
	const embedded = src.migrations.map(migrationPath);
	if (declared.join("\n") !== embedded.join("\n")) {
		issues.push(
			`storage.migrations: manifest [${declared.join(", ")}] != embedded [${
				embedded.join(", ")
			}]`,
		);
	}
	src.migrations.forEach((mig, i) => {
		const previous = i === 0 ? 0 : src.migrations[i - 1].n;
		if (!Number.isInteger(mig.n) || mig.n <= previous || mig.n > 999) {
			issues.push(`migrations: ${migrationPath(mig)} is out of order`);
		}
	});
	const declaresCard = m.contributes?.protocol !== undefined;
	if (declaresCard !== (src.protocol !== undefined)) {
		issues.push(
			declaresCard
				? "contributes.protocol: declared but no card is embedded"
				: "protocol: card embedded but not declared in contributes.protocol",
		);
	}
	const declaresCue = m.config?.cue !== undefined;
	if (declaresCue !== (src.settingsCue !== undefined)) {
		issues.push(
			declaresCue
				? "config.cue: declared but no settings file is embedded"
				: "settingsCue: embedded but not declared in config.cue",
		);
	}
	return issues.length > 0 ? { ok: false, issues } : {
		ok: true,
		pkg: {
			manifest: m,
			module: src.extension,
			migrations: src.migrations,
			protocol: src.protocol,
			...(src.settingsCue === undefined
				? {}
				: { settingsCue: src.settingsCue }),
		},
	};
};

export type BuiltinRegistry = {
	/** Builtin ids (`entry.builtin`), in registration order. */
	readonly ids: readonly string[];
	get(id: string): BuiltinPackage | undefined;
	has(id: string): boolean;
	all(): readonly BuiltinPackage[];
};

/**
 * Builds the registry, throwing `internal` with every issue if any package is
 * invalid, an id repeats, or a pack names a member that is not a registered
 * non-pack builtin at the same version.
 */
export const createBuiltinRegistry = (
	sources: readonly BuiltinSource[],
): BuiltinRegistry => {
	const byId = new Map<string, BuiltinPackage>();
	const issues: string[] = [];
	for (const src of sources) {
		const checked = checkBuiltin(src);
		if (!checked.ok) {
			issues.push(...checked.issues.map((i) => `extensions/${src.dir}: ${i}`));
			continue;
		}
		const id = checked.pkg.manifest.id;
		if (byId.has(id)) issues.push(`extensions/${src.dir}: duplicate id ${id}`);
		byId.set(id, checked.pkg);
	}
	for (const pkg of byId.values()) {
		for (const member of pkg.manifest.members ?? []) {
			const target = byId.get(member.id);
			if (target === undefined || target.manifest.kind !== "extension") {
				issues.push(
					`${pkg.manifest.id}: member ${member.id} is not a bundled extension`,
				);
			} else if (target.manifest.version !== member.version) {
				issues.push(
					`${pkg.manifest.id}: member ${member.id}@${member.version} is bundled at ${target.manifest.version}`,
				);
			}
		}
	}
	if (issues.length > 0) {
		throw internal(`invalid builtin packages: ${issues.join("; ")}`);
	}
	const all = [...byId.values()];
	return {
		ids: [...byId.keys()],
		get: (id) => byId.get(id),
		has: (id) => byId.has(id),
		all: () => all,
	};
};

/** The bundled packages of this Worker. */
export const builtins: BuiltinRegistry = createBuiltinRegistry(
	BUILTIN_SOURCES,
);
