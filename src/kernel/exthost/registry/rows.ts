// Typed row mappers for the registry tables and the
// contribution rows a manifest yields at install time. Pure.

import {
	type InstallationDto,
	type Manifest,
	type PackageDto,
	parseManifest,
	SYS_KERNEL,
} from "@tartan/contract";
import type {
	ContributionKind,
	ContributionRow,
	InstallationRow,
	PackageRow,
} from "@tartan/contract/kernel.ts";

const parseJson = (text: string | null, fallback: unknown): unknown => {
	if (text === null) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
};

/** A stored manifest, re-parsed so defaults and types hold even for old rows. */
export const manifestOf = (
	row: Pick<PackageRow, "manifest_json">,
): Manifest => {
	const parsed = parseManifest(parseJson(row.manifest_json, null));
	if (!parsed.ok) {
		throw new Error(`stored manifest invalid: ${parsed.errors.join("; ")}`);
	}
	return parsed.manifest;
};

/** Bundled packages are registered by the kernel and have no R2 bundle. */
export const isBundledRow = (
	row: Pick<PackageRow, "published_by" | "r2_prefix">,
): boolean => row.published_by === SYS_KERNEL && row.r2_prefix === null;

export const packageDto = (row: PackageRow): PackageDto => ({
	extId: row.ext_id,
	version: row.version,
	runtime: row.runtime,
	manifest: manifestOf(row),
	sha256: row.sha256,
	publishedBy: row.published_by,
	publishedAt: row.published_at,
	bundled: isBundledRow(row),
});

export const installationDto = (
	row: InstallationRow,
	nodePath: string,
): InstallationDto => ({
	id: row.id,
	extId: row.ext_id,
	version: row.version,
	nodeId: row.node_id,
	nodePath,
	mode: row.mode,
	storageScope: row.storage_scope,
	...(row.runtime_override === null
		? {}
		: { runtimeOverride: row.runtime_override }),
	config: parseJson(row.config_json, {}),
	grants: parseJson(row.grants_json, {}) as InstallationDto["grants"],
	backgroundRole: row.background_role,
	locked: row.locked === 1,
	backfill: row.backfill,
	...(row.pack === null ? {} : { pack: row.pack }),
	installedBy: row.installed_by,
	installedAt: row.installed_at,
	...(row.mode_changed_at === null
		? {}
		: { modeChangedAt: row.mode_changed_at }),
	// Repository config (WP23): only present when set, so manual rows keep
	// their exact earlier shape.
	...(row.source === "repo-config"
		? {
			source: "repo-config" as const,
			...(row.source_sha ? { sourceSha: row.source_sha } : {}),
		}
		: {}),
	...(row.owner_disabled === 1 ? { ownerDisabled: true } : {}),
	...(row.repo_overrides === 1 ? { repoOverrides: true } : {}),
});

/**
 * The `contributions` rows of one installation: `key` is the
 * interface, slot contribution id (unique per manifest), tool name, gate
 * point, echo event, subscribed event pattern (suffixed `#<n>` when a
 * manifest subscribes to one pattern twice), context id, protocol card path
 * or `settings`.
 */
export const contributionRows = (
	installationId: string,
	m: Manifest,
): ContributionRow[] => {
	const rows: ContributionRow[] = [];
	const add = (kind: ContributionKind, key: string, data: unknown) =>
		rows.push({
			installation_id: installationId,
			kind,
			key,
			data_json: JSON.stringify(data),
		});
	for (const iface of m.provides ?? []) add("provides", iface, {});
	for (const slot of m.contributes?.slots ?? []) add("slot", slot.id, slot);
	for (const tool of m.contributes?.tools ?? []) add("tool", tool.name, tool);
	for (const gate of m.gates ?? []) add("gate", gate.point, gate);
	for (const echo of m.echo ?? []) add("echo", echo.event, echo);
	const seen = new Map<string, number>();
	for (const sub of m.subscribe ?? []) {
		const n = seen.get(sub.event) ?? 0;
		seen.set(sub.event, n + 1);
		add("subscribe", n === 0 ? sub.event : `${sub.event}#${n}`, sub);
	}
	for (const context of m.contributes?.context ?? []) {
		add("context", context.id, context);
	}
	if (m.contributes?.protocol !== undefined) {
		add("protocol", m.contributes.protocol, { path: m.contributes.protocol });
	}
	if (m.contributes?.settings !== undefined) {
		add("settings", "settings", m.contributes.settings);
	}
	return rows;
};
