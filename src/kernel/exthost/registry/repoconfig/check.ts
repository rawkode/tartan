// The registry's checks of a resolved repository config (ADR repo config,
// "What repository config may do", "Applying results"). Pure:
// the registry reads the rows and hands them in; `applyRepoConfig` runs this
// inside its transaction, `checkRepoConfig` as a dry run for previews.
//
// CUE accepted the input already; none of that is trusted here. Every rule
// is the kernel's: the strict envelope `{extensions?, projects?, global?}`
// (CUE does not close a package's top level), size and depth, Owner
// approval, the entry kinds (own install, repo policy, overlay), policy and
// overlay keys, K8 (inherited gates are monotonic), locked providers,
// shadow scope, the same-node manual install and K12 (settings that name
// nodes stay inside the repository). Any denial means nothing is written.
//
// Repo policy (`config.repoPolicy` keys such as `tartan.ci`'s `pipeline`
// and `tartan.review`'s `owners`) is allowed for any installation in force
// (here or above), providers and gates included: it installs and changes
// nothing; the extension reads it at each change's base through
// `caps.repo.policy`. An own install's repo-policy keys are read the same
// way and never merged into its installation settings. The projects and
// global files are the kernel's (the project graph).

import {
	EXT_ID_RE,
	type InstallationMode,
	type Manifest,
	NODE_PATH_RE,
	REPO_CONFIG_LIMITS,
	REPO_CONFIG_MAX_GLOBAL,
	REPO_CONFIG_MAX_PROJECTS,
	REPO_CONFIG_TOP_LEVEL,
	REPO_CONFIG_TOP_LEVEL_HINT,
	REPO_PATH_RE,
	type RepoConfigDenial,
	type RepoConfigDenialCode,
	type RepoConfigPlanLine,
} from "@tartan/contract";
import { canonicalJson } from "../../../repoconfig/key.ts";
import {
	configureLine,
	installLine,
	keyChanges,
	overlayLine,
	overlayRemoveLine,
	removeLine,
} from "../../../repoconfig/plan.ts";

/** An installation at a strict ancestor of the repo node (any mode). */
export type AncestorInstall = {
	readonly id: string;
	readonly extId: string;
	readonly version: string;
	readonly nodeId: string;
	readonly nodePath: string;
	readonly depth: number;
	readonly mode: InstallationMode;
	readonly locked: boolean;
	readonly repoOverrides: boolean;
	readonly storageScope: "node" | "repo";
	readonly manifest: Manifest;
	/** `config.default ⊕ installation.config`. */
	readonly config: Readonly<Record<string, unknown>>;
	/** A package bundled with the forge (a builtin), not a published one. */
	readonly bundled?: boolean;
};

/** Interfaces whose provider decides what lands (an overlay or policy must not steer them). */
const DECIDING_INTERFACES: readonly string[] = [
	"review@1",
	"checks@1",
	"queue@1",
];

/**
 * Builtins whose repo policy is what the retired YAML pipeline and owners
 * files were (the pipeline, the owners): repositories author it without an
 * Owner's opt-in, as before.
 */
const POLICY_WITHOUT_OPT_IN: ReadonlySet<string> = new Set([
	"tartan.ci",
	"tartan.review",
]);

/**
 * The repo-policy keys a repository may set for an installation in force
 * above it: a package whose gates or `review@1`,
 * `checks@1` or `queue@1` provider decide what lands reads repo policy only
 * with the installing Owner's opt-in (repo overrides on that installation),
 * so a Maintainer below an enforced gate cannot steer what it decides
 * (K8). The bundled CI and review keep their policy without it.
 */
export const repoPolicyKeysOf = (
	extId: string,
	m: Manifest,
	above: Pick<AncestorInstall, "repoOverrides" | "bundled"> | null,
): readonly string[] => {
	const declared = m.config?.repoPolicy ?? [];
	if (above === null || declared.length === 0) return declared;
	const decides = (m.gates?.length ?? 0) > 0 ||
		(m.provides ?? []).some((p) => DECIDING_INTERFACES.includes(p));
	if (!decides) return declared;
	if (above.bundled === true && POLICY_WITHOUT_OPT_IN.has(extId)) {
		return declared;
	}
	return above.repoOverrides ? declared : [];
};

/** An installation at the repo node itself. */
export type HereInstall = {
	readonly id: string;
	readonly extId: string;
	readonly version: string;
	readonly mode: InstallationMode;
	readonly source: "manual" | "repo-config";
	readonly ownerDisabled: boolean;
	readonly locked: boolean;
	readonly manifest: Manifest;
	readonly config: Readonly<Record<string, unknown>>;
};

/** The nearest approval at an ancestor-or-self of the repo node. */
export type BindingApproval = {
	readonly nodeId: string;
	readonly nodePath: string;
	readonly extId: string;
	readonly version: string;
	readonly packageSha256: string;
	readonly grantsJson: string;
	readonly backgroundRole: 10 | 20 | 30 | 40;
	readonly needsReapproval: boolean;
};

export type PackageInfo = {
	readonly manifest: Manifest;
	readonly sha256: string;
	readonly settingsCue: string | null;
};

export type AppliedOverlay = {
	readonly installationId: string;
	readonly extId: string;
	readonly settings: Readonly<Record<string, unknown>>;
};

export type CheckContext = {
	readonly repo: { readonly id: string; readonly path: string };
	/** Strict ancestors' installations, nearest first. */
	readonly ancestors: readonly AncestorInstall[];
	readonly here: readonly HereInstall[];
	readonly approvals: ReadonlyMap<string, BindingApproval>;
	packageOf(extId: string, version: string): PackageInfo | null;
	/** Any registered version (newest first): a provider or pack is refused even unapproved. */
	packageAnyOf(extId: string): PackageInfo | null;
	readonly overlays: readonly AppliedOverlay[];
	/** Extensions an Owner disabled at this repo (kept across reconciles). */
	readonly ownerDisabled?: ReadonlySet<string>;
};

export type PlannedInstall = {
	readonly extId: string;
	readonly version: string;
	readonly mode: InstallationMode;
	/** The installation's settings: the entry's settings without its repo-policy keys. */
	readonly settings: Readonly<Record<string, unknown>>;
	readonly approval: BindingApproval;
	readonly manifest: Manifest;
};

export type PlannedOverlay = {
	readonly installationId: string;
	readonly extId: string;
	readonly nodePath: string;
	readonly settings: Readonly<Record<string, unknown>>;
};

export type CheckResult = {
	readonly denials: readonly RepoConfigDenial[];
	/** Installation and overlay lines (RepoDO adds the repo-policy lines). */
	readonly plan: readonly RepoConfigPlanLine[];
	/** The own installs the config asks for (empty when denied). */
	readonly installs: readonly PlannedInstall[];
	readonly overlays: readonly PlannedOverlay[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const pathOf = (extId: string, ...rest: string[]): string =>
	[`extensions.${JSON.stringify(extId)}`, ...rest].join(".");

const depthOf = (value: unknown): number => {
	let max = 0;
	const stack: [unknown, number][] = [[value, 0]];
	while (stack.length > 0) {
		const [v, d] = stack.pop()!;
		max = Math.max(max, d);
		if (max > REPO_CONFIG_LIMITS.jsonDepth) return max;
		if (typeof v === "object" && v !== null) {
			for (const child of Object.values(v)) stack.push([child, d + 1]);
		}
	}
	return max;
};

/**
 * Every value at a dotted settings path, walking into arrays at each segment
 * (`mirrors.repo` over `mirrors: [{repo: …}, …]` names each repo);
 * the leaves are flattened, so a list of targets yields each one.
 */
const valuesAt = (
	settings: Readonly<Record<string, unknown>>,
	path: string,
): unknown[] => {
	const spread = (vs: readonly unknown[]): unknown[] =>
		vs.flatMap((v) => (Array.isArray(v) ? v : [v]));
	let current: unknown[] = [settings];
	for (const key of path.split(".")) {
		current = spread(current).flatMap((v) =>
			isRecord(v) && Object.hasOwn(v, key) ? [v[key]] : []
		);
		if (current.length === 0) return [];
	}
	return spread(current);
};

const within = (repoPath: string, target: string): boolean =>
	target === repoPath || target.startsWith(`${repoPath}/`);

const omit = (
	settings: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(settings).filter(([k]) => !keys.includes(k)),
	);

const pick = (
	settings: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(settings).filter(([k]) => keys.includes(k)),
	);

type Entry = {
	readonly enabled?: boolean;
	readonly mode?: "enforce" | "shadow";
	readonly settings?: Record<string, unknown>;
	readonly keys: readonly string[];
};

type Deny = (
	code: RepoConfigDenialCode,
	path: string,
	message: string,
	extId?: string,
) => void;

/** A project name the graph can key by (npm scopes and paths allowed). */
const PROJECT_NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,127}$/;
const PROJECT_KEYS = ["root", "deps", "sensitive", "owners", "test"];

const stringList = (
	v: unknown,
	max: number,
	itemMax: number,
): readonly string[] | null =>
	Array.isArray(v) && v.length <= max &&
		v.every((x) => typeof x === "string" && x.length <= itemMax)
		? v as string[]
		: null;

/** The kernel fields `projects` and `global` (ADR repo config): strict, repo-relative. */
const checkKernelFields = (
	resolved: Record<string, unknown>,
	deny: Deny,
): void => {
	if (resolved.projects !== undefined) {
		const projects = resolved.projects;
		if (!isRecord(projects)) {
			deny("shape", "projects", "projects is a struct of name: {root, …}");
		} else {
			const names = Object.keys(projects);
			if (names.length > REPO_CONFIG_MAX_PROJECTS) {
				deny(
					"shape",
					"projects",
					`at most ${REPO_CONFIG_MAX_PROJECTS} projects`,
				);
			}
			for (const name of names.slice(0, REPO_CONFIG_MAX_PROJECTS)) {
				const path = `projects.${JSON.stringify(name)}`;
				const spec = projects[name];
				if (!PROJECT_NAME_RE.test(name)) {
					deny("shape", path, "a project name is ASCII, at most 128 chars");
					continue;
				}
				if (!isRecord(spec)) {
					deny("shape", path, "a project is {root, deps?, …}");
					continue;
				}
				for (const key of Object.keys(spec)) {
					if (!PROJECT_KEYS.includes(key)) {
						deny("shape", `${path}.${key}`, `unknown project field ${key}`);
					}
				}
				const root = spec.root;
				if (
					typeof root !== "string" || root.length === 0 ||
					root.length > 512 || !REPO_PATH_RE.test(root)
				) {
					deny(
						"shape",
						`${path}.root`,
						"root is a repo-relative path without .. or a leading /",
					);
				}
				if (
					spec.deps !== undefined && stringList(spec.deps, 500, 128) === null
				) {
					deny("shape", `${path}.deps`, "deps is a list of project names");
				}
				if (
					spec.owners !== undefined &&
					stringList(spec.owners, 64, 128) === null
				) {
					deny("shape", `${path}.owners`, "owners is a list of strings");
				}
				if (
					spec.sensitive !== undefined && typeof spec.sensitive !== "boolean"
				) {
					deny("shape", `${path}.sensitive`, "sensitive is true or false");
				}
				if (
					spec.test !== undefined &&
					(typeof spec.test !== "string" || spec.test.length > 8192)
				) {
					deny("shape", `${path}.test`, "test is a command");
				}
			}
		}
	}
	if (resolved.global !== undefined) {
		const global = stringList(resolved.global, REPO_CONFIG_MAX_GLOBAL, 512);
		if (global === null) {
			deny(
				"shape",
				"global",
				`global is a list of at most ${REPO_CONFIG_MAX_GLOBAL} globs`,
			);
		} else {
			global.forEach((glob, i) => {
				const body = glob.startsWith("!") ? glob.slice(1) : glob;
				if (body.length === 0 || !REPO_PATH_RE.test(body)) {
					deny(
						"shape",
						`global.${i}`,
						"a glob is repo-relative, without .. or a leading /",
					);
				}
			});
		}
	}
};

/** Strict shape: `{extensions?: {<extId>: {enabled?, mode?, settings?}}, projects?, global?}`. */
const shapeOf = (
	resolved: unknown,
	deny: Deny,
): Map<string, Entry> | null => {
	const text = canonicalJson(resolved ?? null);
	if (text.length > REPO_CONFIG_LIMITS.jsonBytes) {
		deny(
			"too_large",
			"",
			`the resolved config is larger than ${REPO_CONFIG_LIMITS.jsonBytes} bytes`,
		);
		return null;
	}
	if (depthOf(resolved) > REPO_CONFIG_LIMITS.jsonDepth) {
		deny(
			"too_large",
			"",
			`the resolved config is deeper than ${REPO_CONFIG_LIMITS.jsonDepth}`,
		);
		return null;
	}
	if (!isRecord(resolved)) {
		deny("shape", "", "the resolved config must be an object");
		return null;
	}
	for (const key of Object.keys(resolved)) {
		if (!(REPO_CONFIG_TOP_LEVEL as readonly string[]).includes(key)) {
			deny(
				"shape",
				key,
				`${JSON.stringify(key)} is not read: ${REPO_CONFIG_TOP_LEVEL_HINT}`,
			);
		}
	}
	checkKernelFields(resolved, deny);
	const raw = resolved.extensions ?? {};
	if (!isRecord(raw)) {
		deny("shape", "extensions", "extensions must be an object");
		return null;
	}
	const out = new Map<string, Entry>();
	for (const [extId, value] of Object.entries(raw)) {
		if (extId.length > 64 || !EXT_ID_RE.test(extId)) {
			deny("shape", pathOf(extId), "not an extension id");
			continue;
		}
		if (!isRecord(value)) {
			deny("shape", pathOf(extId), "an entry must be an object", extId);
			continue;
		}
		let ok = true;
		for (const key of Object.keys(value)) {
			if (key !== "enabled" && key !== "mode" && key !== "settings") {
				deny(
					"shape",
					pathOf(extId, key),
					`${key} cannot be set from a repository`,
					extId,
				);
				ok = false;
			}
		}
		if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
			deny("shape", pathOf(extId, "enabled"), "enabled is a boolean", extId);
			ok = false;
		}
		if (
			value.mode !== undefined && value.mode !== "enforce" &&
			value.mode !== "shadow"
		) {
			deny("shape", pathOf(extId, "mode"), "mode is enforce or shadow", extId);
			ok = false;
		}
		if (value.settings !== undefined && !isRecord(value.settings)) {
			deny("shape", pathOf(extId, "settings"), "settings is an object", extId);
			ok = false;
		}
		if (!ok) continue;
		out.set(extId, {
			...(value.enabled === undefined
				? {}
				: { enabled: value.enabled as boolean }),
			...(value.mode === undefined
				? {}
				: { mode: value.mode as "enforce" | "shadow" }),
			...(value.settings === undefined
				? {}
				: { settings: value.settings as Record<string, unknown> }),
			keys: Object.keys(value),
		});
	}
	return out;
};

/** The installation in force for an extension: a manual one here, else the nearest above. */
type InForce =
	| { readonly where: "here"; readonly here: HereInstall }
	| { readonly where: "above"; readonly ancestor: AncestorInstall };

const inForceOf = (ctx: CheckContext, extId: string): InForce | null => {
	const here = ctx.here.find((h) => h.extId === extId && h.source === "manual");
	if (here !== undefined) return { where: "here", here };
	const ancestor = ctx.ancestors.find((a) => a.extId === extId);
	return ancestor === undefined ? null : { where: "above", ancestor };
};

/** Every denial and the plan of one resolved config at one repository. */
export const checkResolved = (
	resolved: unknown,
	ctx: CheckContext,
): CheckResult => {
	const denials: RepoConfigDenial[] = [];
	const deny: Deny = (code, path, message, extId) =>
		denials.push({ code, path, message, ...(extId ? { extId } : {}) });
	const entries = shapeOf(resolved, deny);
	if (entries === null) {
		return { denials, plan: [], installs: [], overlays: [] };
	}

	const installs: PlannedInstall[] = [];
	const overlays: PlannedOverlay[] = [];
	for (const [extId, entry] of entries) {
		const inForce = inForceOf(ctx, extId);
		if (inForce !== null) {
			const overlay = checkInForce(extId, entry, inForce, deny);
			if (overlay !== null) overlays.push(overlay);
			continue;
		}
		const install = checkOwnInstall(extId, entry, ctx, deny);
		if (install !== null) installs.push(install);
	}
	if (denials.length > 0) {
		return { denials, plan: [], installs: [], overlays: [] };
	}
	return { denials, plan: planOf(installs, overlays, ctx), installs, overlays };
};

/**
 * An entry for an installation in force (here or above): repo policy, and
 * with the Owner's opt-in at a strict ancestor an overlay. Returns the
 * overlay the entry asks for (possibly empty), or null.
 */
const checkInForce = (
	extId: string,
	entry: Entry,
	inForce: InForce,
	deny: Deny,
): PlannedOverlay | null => {
	const above = inForce.where === "above" ? inForce.ancestor : null;
	const m = above?.manifest ??
		(inForce.where === "here" ? inForce.here.manifest : null)!;
	const locked = above?.locked ??
		(inForce.where === "here" ? inForce.here.locked : false);
	const mode = above?.mode ??
		(inForce.where === "here" ? inForce.here.mode : "enforce");
	const from = above !== null
		? `inherited from /${above.nodePath}; change it there`
		: "installed manually at this repository; change it there";
	if (m.kind === "pack") {
		deny("pack", pathOf(extId), `${extId} is a pack; ${from}`, extId);
		return null;
	}
	const modeKeys = entry.keys.filter((k) => k !== "settings");
	if (modeKeys.length > 0) {
		const changesMode = entry.enabled === false || entry.mode === "shadow";
		if (locked && (m.provides?.length ?? 0) > 0) {
			deny(
				"locked_provider",
				pathOf(extId, modeKeys[0]),
				`${extId} is a locked provider${
					above !== null ? ` at /${above.nodePath}` : ""
				}`,
				extId,
			);
		} else if (
			above !== null && (m.gates?.length ?? 0) > 0 && changesMode &&
			mode === "enforce"
		) {
			deny(
				"locked_gate",
				pathOf(extId, entry.enabled === false ? "enabled" : "mode"),
				`K8: the gates of ${extId} are enforced from /${above.nodePath} and cannot be disabled or shadowed below it`,
				extId,
			);
		} else {
			deny(
				above !== null ? "inherited" : "conflict",
				pathOf(extId, modeKeys[0]),
				`${extId} is ${from}; a repository may set only its repo policy${
					above !== null ? " and overridable settings" : ""
				}`,
				extId,
			);
		}
		return null;
	}
	const declaredPolicy = m.config?.repoPolicy ?? [];
	const policyKeys = repoPolicyKeysOf(extId, m, above);
	const repoOverridable = m.config?.repoOverridable ?? [];
	const opted = above !== null && above.repoOverrides &&
		above.mode !== "disabled" && above.storageScope === "repo" &&
		repoOverridable.length > 0;
	const overridable = opted ? repoOverridable : [];
	if (declaredPolicy.length > 0 && policyKeys.length === 0 && !opted) {
		deny(
			"policy_key",
			pathOf(extId, "settings"),
			`${extId} decides what lands (its gates or provider); a repository sets its repo policy only once an Owner turns on repo overrides for it at /${above?.nodePath}`,
			extId,
		);
		return null;
	}
	if (policyKeys.length === 0 && !opted) {
		deny(
			above !== null ? "inherited" : "conflict",
			pathOf(extId),
			`${extId} is ${from}`,
			extId,
		);
		return null;
	}
	const targets = m.config?.targets ?? [];
	const settings = entry.settings ?? {};
	let ok = true;
	for (const key of Object.keys(settings)) {
		if (policyKeys.includes(key)) continue;
		const isTarget = targets.some((t) => t === key || t.startsWith(`${key}.`));
		if (overridable.includes(key) && !isTarget) continue;
		ok = false;
		if (opted) {
			deny(
				"overlay_key",
				pathOf(extId, "settings", key),
				`${key} is not overridable by a repository (repoOverridable: ${
					repoOverridable.join(", ") || "none"
				}${
					policyKeys.length > 0 ? `; repo policy: ${policyKeys.join(", ")}` : ""
				})`,
				extId,
			);
		} else {
			deny(
				"policy_key",
				pathOf(extId, "settings", key),
				`${key} is not repo policy of ${extId} (repoPolicy: ${
					policyKeys.join(", ")
				}); its other settings are ${from}`,
				extId,
			);
		}
	}
	if (!ok || above === null || !opted) return null;
	return {
		installationId: above.id,
		extId,
		nodePath: above.nodePath,
		settings: pick(settings, overridable),
	};
};

/** An entry for an extension installed nowhere in force here: an own install. */
const checkOwnInstall = (
	extId: string,
	entry: Entry,
	ctx: CheckContext,
	deny: Deny,
): PlannedInstall | null => {
	const approval = ctx.approvals.get(extId);
	const pkg = approval === undefined
		? null
		: ctx.packageOf(extId, approval.version);
	const known = pkg ?? ctx.packageAnyOf(extId);
	if (known?.manifest.kind === "pack") {
		deny(
			"pack",
			pathOf(extId),
			`${extId} is a pack; packs are installed manually`,
			extId,
		);
		return null;
	}
	if ((known?.manifest.provides?.length ?? 0) > 0) {
		deny(
			"provider_floor",
			pathOf(extId),
			`${extId} provides ${
				known!.manifest.provides!.join(", ")
			}; providers are installed manually`,
			extId,
		);
		return null;
	}
	if (approval === undefined || pkg === null) {
		deny(
			"unapproved",
			pathOf(extId),
			`needs Owner approval: ${extId} is not approved for /${ctx.repo.path}`,
			extId,
		);
		return null;
	}
	if (approval.needsReapproval || pkg.sha256 !== approval.packageSha256) {
		deny(
			"unapproved",
			pathOf(extId),
			`needs Owner re-approval: ${extId}@${approval.version} changed since /${approval.nodePath} approved it`,
			extId,
		);
		return null;
	}
	const m = pkg.manifest;
	const mode = entry.mode ?? "enforce";
	if (mode === "shadow" && (m.gates?.length ?? 0) === 0) {
		deny(
			"invalid",
			pathOf(extId, "mode"),
			"shadow mode is only for extensions with gates",
			extId,
		);
		return null;
	}
	// Repo-policy keys are read at each change's base, never installed.
	const settings = omit(entry.settings ?? {}, m.config?.repoPolicy ?? []);
	for (const target of m.config?.targets ?? []) {
		for (const value of valuesAt(settings, target)) {
			if (
				typeof value !== "string" || !NODE_PATH_RE.test(value) ||
				!within(ctx.repo.path, value)
			) {
				deny(
					"scope",
					pathOf(extId, "settings", target),
					`K12: ${target} must name /${ctx.repo.path} or a node inside it`,
					extId,
				);
				return null;
			}
		}
	}
	return {
		extId,
		version: approval.version,
		mode: entry.enabled === false ? "disabled" : mode,
		settings,
		approval,
		manifest: m,
	};
};

const planOf = (
	installs: readonly PlannedInstall[],
	overlays: readonly PlannedOverlay[],
	ctx: CheckContext,
): RepoConfigPlanLine[] => {
	const lines: RepoConfigPlanLine[] = [];
	const applied = new Map(
		ctx.here.filter((h) => h.source === "repo-config").map((h) => [h.extId, h]),
	);
	for (
		const want of [...installs].sort((a, b) => (a.extId < b.extId ? -1 : 1))
	) {
		const have = applied.get(want.extId);
		const killed = ctx.ownerDisabled?.has(want.extId) === true;
		if (have === undefined) {
			lines.push(installLine({
				extId: want.extId,
				version: want.version,
				mode: want.mode === "shadow" ? "shadow" : "enforce",
				enabled: want.mode !== "disabled" && !killed,
				settings: want.settings,
			}));
			continue;
		}
		const changes = [
			...(have.version !== want.version
				? [{ key: "version", from: have.version, to: want.version }]
				: []),
			...(have.ownerDisabled || have.mode === want.mode
				? []
				: [{ key: "mode", from: have.mode, to: want.mode }]),
			...keyChanges(have.config, want.settings),
		];
		if (have.ownerDisabled && want.mode !== "disabled") {
			lines.push(configureLine({
				extId: want.extId,
				version: want.version,
				changes,
				note: changes.length > 0
					? `disabled by an Owner (kept); ${
						changes.map((c) => c.key).join(", ")
					} updated`
					: "disabled by an Owner (kept)",
			}));
		} else if (changes.length > 0) {
			lines.push(configureLine({
				extId: want.extId,
				version: want.version,
				changes,
			}));
		}
	}
	const wanted = new Set(installs.map((i) => i.extId));
	for (
		const have of [...applied.values()].sort((
			a,
			b,
		) => (a.extId < b.extId ? -1 : 1))
	) {
		if (!wanted.has(have.extId)) {
			lines.push(removeLine(have.extId, have.version));
		}
	}
	const current = new Map(ctx.overlays.map((o) => [o.installationId, o]));
	for (
		const want of [...overlays].sort((a, b) => (a.extId < b.extId ? -1 : 1))
	) {
		const ancestor = ctx.ancestors.find((a) => a.id === want.installationId);
		const base = {
			...(ancestor?.config ?? {}),
			...(current.get(want.installationId)?.settings ?? {}),
		};
		const target = { ...(ancestor?.config ?? {}), ...want.settings };
		const changes = keyChanges(base, target, [
			...new Set([
				...Object.keys(want.settings),
				...Object.keys(current.get(want.installationId)?.settings ?? {}),
			]),
		]);
		if (changes.length > 0) {
			lines.push(overlayLine({
				extId: want.extId,
				installationId: want.installationId,
				nodePath: want.nodePath,
				changes,
			}));
		}
	}
	const wantedOverlays = new Set(
		overlays.filter((o) => Object.keys(o.settings).length > 0).map((o) =>
			o.installationId
		),
	);
	for (const have of ctx.overlays) {
		if (wantedOverlays.has(have.installationId)) continue;
		if (overlays.some((o) => o.installationId === have.installationId)) {
			continue; // an empty overlay: its keys appear as changes above
		}
		const ancestor = ctx.ancestors.find((a) => a.id === have.installationId);
		lines.push(overlayRemoveLine({
			extId: have.extId,
			installationId: have.installationId,
			nodePath: ancestor?.nodePath ?? "",
		}));
	}
	return lines;
};
