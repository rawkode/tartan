// schemagen: the CUE module overlay the evaluator sees for one repository
// (ADR repo config, "Schema from extension manifests"). Pure
// TypeScript, run by the registry at evaluation time; nothing generated is
// ever committed.
//
//   cue.mod/pkg/tartan.dev/ext/ext.cue               #Mode, #Project, #Own, the closed #Extensions
//   cue.mod/pkg/tartan.dev/ext/x/<sid>/settings.cue  each extension's own config file, verbatim
//   ~tartan.cue                                      package tartan; binds extensions, projects, global
//
// The job adds `cue.mod/module.cue` with a module path fresh for each job;
// it is not part of the schema (nor of `schemaKey`). The repository's root
// `*.cue` files sit beside `~tartan.cue` in the module root, so positions
// are the repository's own root paths (`tartan.cue:3:8`).
//
// `~tartan.cue` binds BY FIELD (`extensions?: ext.#Extensions`): embedding a
// definition at file level does not close the package, binding by field
// makes an unknown id or key a positioned `field not allowed`. CUE does not
// close a package's top level, so an unknown top-level field exports and the
// registry denies it (`shape`, check.ts).
//
// `#Extensions` lists, sorted by id:
//   - `"<id>"?: #Own & {settings: {x_<sid>.#Settings, x_<sid>.#Policy}}` for
//     each package approved for an own install here (`#Policy` only when the
//     manifest declares `config.repoPolicy`; `settings: close({})` without a
//     `config.cue`);
//   - `"<id>"?: {settings: close({<k>?: x_<sid>.#Settings.<k>, …,
//     x_<sid>.#Policy})}` for each installation in force (here or above)
//     that declares repo policy or, at a strict ancestor, has repo overrides
//     on: one optional field per `repoOverridable` key (with the opt-in only;
//     an unset optional field is not exported, so it never overwrites the
//     ancestor's value) and the `#Policy` keys;
//   - nothing else. An unapproved id, an in-force id with neither, `enabled`
//     or `mode` on an in-force id (the K8 case) and a provider as an own
//     install are each a positioned `field not allowed` before the registry
//     denies them too.
//
// CUE is never the security boundary; the registry's checks are (check.ts).

import {
	cueSid,
	FORGE_BINDING_FILE,
	FORGE_SCHEMA_IMPORT,
	REPO_CONFIG_LIMITS,
	REPO_CONFIG_PACKAGE,
	type RepoConfigSchemaEntry,
} from "@tartan/contract";
import { schemaKeyOf } from "../../../repoconfig/key.ts";

export type SchemaInstall = {
	readonly extId: string;
	readonly version: string;
	readonly settingsCue: string | null;
	readonly approvalNode: string;
	readonly hasGates: boolean;
	readonly repoPolicy: readonly string[];
};

export type SchemaInForce = {
	readonly extId: string;
	readonly version: string;
	readonly settingsCue: string | null;
	readonly installationId: string;
	readonly nodePath: string;
	readonly repoPolicy: readonly string[];
	/** `repoOverridable` keys, only with the Owner's opt-in at a strict ancestor. */
	readonly overridable: readonly string[];
};

export type SchemaInput = {
	readonly installs: readonly SchemaInstall[];
	readonly inForce: readonly SchemaInForce[];
};

export type GeneratedSchema = {
	readonly files: Readonly<Record<string, string>>;
	readonly schemaKey: string;
	readonly entries: readonly RepoConfigSchemaEntry[];
};

const SETTINGS_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The first token after comments and blank lines: a package clause's name, or null. */
export const packageClause = (text: string): string | null => {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (line === "" || line.startsWith("//")) continue;
		const m = /^package\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\/\/.*)?$/.exec(line);
		return m === null ? null : m[1];
	}
	return null;
};

/**
 * Why a PACKAGE's `config.cue` (an extension's own file, not repository
 * content) cannot be used, or null: `package settings`, a `#Settings`
 * definition (and `#Policy` when the manifest declares repo policy), at
 * most 64 KiB, no `@if(` attribute and no import of a forge path (only the
 * standard library resolves with `CUE_REGISTRY=none`). The self-check then
 * evaluates it for real.
 */
export const settingsCueIssue = (
	text: string,
	options: { readonly repoPolicy?: readonly string[] } = {},
): string | null => {
	if (
		new TextEncoder().encode(text).byteLength >
			REPO_CONFIG_LIMITS.configCueBytes
	) {
		return `config.cue is larger than ${REPO_CONFIG_LIMITS.configCueBytes} bytes`;
	}
	if (packageClause(text) !== "settings") {
		return "config.cue must start with package settings";
	}
	if (!/^#Settings\s*:/m.test(text)) {
		return "config.cue must define #Settings";
	}
	if ((options.repoPolicy?.length ?? 0) > 0 && !/^#Policy\s*:/m.test(text)) {
		return "config.cue must define #Policy (the manifest declares config.repoPolicy)";
	}
	if (/@if\(/.test(text)) return "config.cue may not use @if( attributes";
	for (const m of text.matchAll(/"([^"\n]+)"/g)) {
		const path = m[1];
		if (/^tartan\.(dev|local)\//.test(path)) {
			return `config.cue may not import ${path}`;
		}
	}
	return null;
};

const quoted = (id: string): string => JSON.stringify(id);
const alias = (sid: string): string => `x_${sid}`;
const importPath = (sid: string): string =>
	`${FORGE_SCHEMA_IMPORT}/x/${sid}:settings`;
const byId = <T extends { readonly extId: string }>(a: T, b: T) =>
	a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0;
const keysOf = (keys: readonly string[]): string[] =>
	[...new Set(keys)].filter((k) => SETTINGS_KEY_RE.test(k)).sort();

/** The binding file: the same for every repository (it only names the schema). */
export const BINDING_FILE_TEXT = [
	`package ${REPO_CONFIG_PACKAGE}`,
	"",
	`import ${quoted(FORGE_SCHEMA_IMPORT)}`,
	"",
	"// Generated by the forge: binds this repository's package tartan to its",
	"// schema. Unknown extensions or settings keys are positioned errors.",
	"extensions?: ext.#Extensions",
	"projects?: [string]: ext.#Project",
	"global?: [...string]",
	"",
].join("\n");

/** Generates the forge files for one repository and registry epoch. Deterministic. */
export const generateSchema = (input: SchemaInput): GeneratedSchema => {
	const ids = new Set<string>();
	for (const e of [...input.installs, ...input.inForce]) {
		if (ids.has(e.extId)) {
			throw new Error(
				`schemagen: ${e.extId} is both installable and in force`,
			);
		}
		ids.add(e.extId);
	}
	// Two ids that share a sid (`acme.no-secrets`, `acme.no.secrets`) would
	// share a schema package: publish refuses the second one, and any pair
	// that exists anyway keeps only the first id by sort order (the other is
	// then a positioned `field not allowed`), never failing the whole schema.
	const sids = new Map<string, string>();
	for (const id of [...ids].sort()) {
		if (!sids.has(cueSid(id))) sids.set(cueSid(id), id);
	}
	const kept = (e: { readonly extId: string }) =>
		sids.get(cueSid(e.extId)) === e.extId;
	const installs = [...input.installs].filter(kept).sort(byId);
	const inForce = [...input.inForce].filter(kept).sort(byId);
	const files: Record<string, string> = {};
	const imports: string[] = [];
	const settingsFile = (extId: string, text: string | null): boolean => {
		if (text === null) return false;
		const sid = cueSid(extId);
		files[`cue.mod/pkg/${FORGE_SCHEMA_IMPORT}/x/${sid}/settings.cue`] = text;
		imports.push(`\t${alias(sid)} ${quoted(importPath(sid))}`);
		return true;
	};
	const fields: string[] = [];
	const entries: RepoConfigSchemaEntry[] = [];
	for (const i of installs) {
		const sid = cueSid(i.extId);
		const policy = keysOf(i.repoPolicy);
		const has = settingsFile(i.extId, i.settingsCue);
		const settings = !has
			? "close({})"
			: policy.length > 0
			? `{${alias(sid)}.#Settings, ${alias(sid)}.#Policy}`
			: `${alias(sid)}.#Settings`;
		fields.push(`\t${quoted(i.extId)}?: #Own & {settings: ${settings}}`);
		entries.push({
			kind: "install",
			extId: i.extId,
			version: i.version,
			sid,
			approvalNode: i.approvalNode,
			hasGates: i.hasGates,
			repoPolicy: has ? policy : [],
		});
	}
	for (const f of inForce) {
		const sid = cueSid(f.extId);
		const overridable = keysOf(f.overridable);
		const policy = keysOf(f.repoPolicy);
		if (f.settingsCue === null || (overridable.length + policy.length) === 0) {
			continue;
		}
		settingsFile(f.extId, f.settingsCue);
		const body = [
			...overridable.map((k) => `\t\t${k}?: ${alias(sid)}.#Settings.${k}`),
			...(policy.length > 0 ? [`\t\t${alias(sid)}.#Policy`] : []),
		];
		fields.push(
			`\t${quoted(f.extId)}?: {settings: close({\n${body.join("\n")}\n\t})}`,
		);
		entries.push({
			kind: "in-force",
			extId: f.extId,
			version: f.version,
			sid,
			installationId: f.installationId,
			nodePath: f.nodePath,
			repoPolicy: policy,
			overridable,
		});
	}
	const ext = [
		"package ext",
		"",
		...(imports.length > 0 ? ["import (", ...imports, ")", ""] : []),
		"// Generated by the forge for this repository; do not edit.",
		'#Mode: *"enforce" | "shadow"',
		"",
		"// A project of the repository (the project graph's configured projects).",
		"#Project: {",
		"\troot:       string",
		"\tdeps?:      [...string]",
		"\tsensitive?: bool",
		"\towners?:    [...string]",
		"\ttest?:      string",
		"}",
		"",
		"// An extension this repository installs itself (an Owner approved it).",
		"#Own: {",
		"\tenabled:  bool | *true",
		"\tmode:     #Mode",
		"\tsettings: _",
		"}",
		"",
		"#Extensions: {",
		...fields,
		"}",
		"",
	].join("\n");
	files[`cue.mod/pkg/${FORGE_SCHEMA_IMPORT}/ext.cue`] = ext;
	files[FORGE_BINDING_FILE] = BINDING_FILE_TEXT;
	return { files, schemaKey: schemaKeyOf(files), entries };
};

/** The root file name the self-check's entry is written in. */
export const SELF_CHECK_FILE = "selfcheck.cue" as const;

/**
 * The package self-check's request files (ADR repo config): the
 * package alone as an own install, its entry left empty, plus one hidden
 * probe per `repoPolicy` key that `#Policy` must accept. A pass exports
 * `{extensions: {<id>: {enabled: true, mode: "enforce", settings:
 * config.default}}}` exactly (a required `#Policy` field would show up in
 * `settings` and fail the comparison).
 */
export const selfCheckInput = (pkg: {
	readonly extId: string;
	readonly version: string;
	readonly settingsCue: string | null;
	readonly repoPolicy: readonly string[];
}): Readonly<Record<string, string>> => {
	const schema = generateSchema({
		installs: [{
			extId: pkg.extId,
			version: pkg.version,
			settingsCue: pkg.settingsCue,
			approvalNode: "",
			hasGates: false,
			repoPolicy: pkg.repoPolicy,
		}],
		inForce: [],
	});
	const sid = cueSid(pkg.extId);
	const policy = pkg.settingsCue === null ? [] : keysOf(pkg.repoPolicy);
	return {
		...schema.files,
		[SELF_CHECK_FILE]: [
			`package ${REPO_CONFIG_PACKAGE}`,
			"",
			...(policy.length > 0
				? [`import ${alias(sid)} ${quoted(importPath(sid))}`, ""]
				: []),
			`extensions: ${quoted(pkg.extId)}: {}`,
			...policy.map((k) => `_accepts_${k}: ${alias(sid)}.#Policy & {${k}: _}`),
			"",
		].join("\n"),
	};
};
