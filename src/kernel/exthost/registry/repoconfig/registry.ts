// Repository config in the ForgeDO registry (WP23, reviewed by WP7a; ADR
// repo config, "Applying results"). The registry is the single authority:
//
// - approvals: an Owner approves a package version for repository config at
//   a node; it commits only once the package version passed its self-check
//   (`packages.config_checked`). The approval is a condition of
//   RESOLUTION, not only of apply: `isBoundSync` keeps a `repo-config`
//   installation out of force unless the nearest approval still names its
//   version and package sha256 and needs no re-approval, and its grants and
//   background role always come from the approval's snapshot.
// - self-checks are per package version: the first approval or install of a
//   version with a `config.cue` submits one; until it passes, the package
//   is absent from every generated schema. Bundled packages are checked at
//   registration (their `config.cue` is tested against the real CLI).
// - schema: `generateSchema` over the approvals (own installs) and the
//   installations in force here or above that declare repo policy or, above,
//   have repo overrides on (schemagen.ts; ADR repo config).
// - check and apply: `checkResolved` (check.ts) as a dry run, and
//   `applySync` in one transaction with the fence `(trunkSeq, epoch)` plus
//   the input key: an older fence is refused, an equal one with the
//   same key is a no-op, the schema key is re-checked, any denial writes
//   nothing, and the answer is the state RepoDO then stores.
// - registry changes bump `meta.config_epoch` and write `repo_config_dirty`
//   rows; the `repoconfig` timer pokes the RepoDOs.
//
// Runs inside the registry module, against its tables and helpers.

import {
	type Actor,
	type ConfigApprovalDto,
	type ConfigApprovalRequestDto,
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	type CueJobInput,
	type CueSubmitResult,
	DEFAULT_EVAL_LIMITS,
	denied,
	type EvalResponse,
	eventIdemKey,
	installationId as toInstallationId,
	type InstallationMode,
	invalid,
	isEvalOk,
	type Manifest,
	notFound,
	parseEvalResponse,
	principalKind,
	REPO_CONFIG_EXPORT_COMMAND,
	type RepoConfigApplyAnswer,
	type RepoConfigApplyInput,
	type RepoConfigCheckAnswer,
	type RepoConfigEffectiveRow,
	type RepoConfigForgeState,
	type RepoConfigSchemaDto,
	ROLE,
	SYS_KERNEL,
	tartanError,
} from "@tartan/contract";
import type {
	ForgeEventsInternal,
	InstallationInForce,
	InstallationRow,
	PackageRow,
	TreeInternal,
} from "@tartan/contract/kernel.ts";
import {
	canonicalJson,
	gitBlobOid,
	inputKeyOf,
	schemaKeyOf,
} from "../../../repoconfig/key.ts";
import {
	type AncestorInstall,
	type AppliedOverlay,
	type BindingApproval,
	type CheckContext,
	checkResolved,
	type HereInstall,
	repoPolicyKeysOf,
} from "./check.ts";
import {
	type GeneratedSchema,
	generateSchema,
	type SchemaInForce,
	type SchemaInput,
	SELF_CHECK_FILE,
	selfCheckInput,
} from "./schemagen.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoConfigPorts = {
	/** `cue:trunk`'s `cueSubmit` (approval self-checks). */
	submit(job: CueJobInput): Promise<CueSubmitResult>;
	/** RepoDO `repoconfig().registryChanged(epoch)`. */
	poke(repoNodeId: string, epoch: number): Promise<void>;
	waitUntil(work: Promise<unknown>): void;
	log(message: string, data: Record<string, unknown>): void;
};

export type RegistryRepoConfigDeps = {
	readonly sql: SqlStorage;
	readonly storage: DurableObjectStorage;
	readonly clock: { now(): number };
	readonly ulid: () => string;
	readonly tree: Pick<
		TreeInternal,
		"nodeSync" | "nodeByPathSync" | "ancestorPathsSync" | "isWithinSync"
	>;
	readonly events: Pick<ForgeEventsInternal, "appendSync" | "auditSync">;
	readonly packageRow: (extId: string, version: string) => PackageRow | null;
	readonly manifestFor: (extId: string, version: string) => Manifest;
	readonly insertInstallation: (row: InstallationRow, m: Manifest) => void;
	readonly deleteInstallation: (id: string) => void;
	readonly bumpExtVersion: () => number;
	readonly roleOf: (by: string, nodeId: string) => number;
	/** A package's `config.cue`: the bundled mirror or `packages.config_cue`. */
	readonly settingsCueOf: (extId: string, version: string) => string | null;
	readonly schedule: (atMs: number) => void;
	readonly ports: () => RepoConfigPorts;
	/** `TARTAN_REPO_CONFIG` is on (read at each deploy's builtin registration). */
	readonly switchOn?: () => boolean;
};

type ApprovalRow = {
	node_id: string;
	ext_id: string;
	version: string;
	package_sha256: string;
	grants_json: string;
	background_role: 10 | 20 | 30 | 40;
	needs_reapproval: 0 | 1;
	approved_by: string;
	approved_at: number;
};

type RequestRow = {
	id: string;
	/** `approval`: commits an approval on a pass; `check`: an install's self-check only. */
	kind: "approval" | "check";
	node_id: string;
	ext_id: string;
	version: string;
	background_role: number;
	requested_by: string;
	state: ConfigApprovalRequestDto["state"];
	input_key: string;
	result_json: string | null;
	at: number;
};

type StateRow = {
	node_id: string;
	applied_seq: number;
	applied_epoch: number;
	applied_key: string;
	applied_sha: string;
	hold_reason: string | null;
	/** The hold's generation (migration 314). */
	hold_id: number;
	principals_json: string;
	updated_at: number;
};

type OverlayRow = {
	installation_id: string;
	repo_node_id: string;
	settings_json: string;
	source_sha: string;
	source_key: string;
};

type FullRow = InstallationRow & {
	source: "manual" | "repo-config";
	source_sha: string | null;
	source_key: string | null;
	approval_node: string | null;
	owner_disabled: 0 | 1;
	repo_overrides: 0 | 1;
};

/** Registry-driven re-applies are staggered this far apart. */
export const DIRTY_STAGGER_MS = 2_000;
const DIRTY_BATCH = 20;
const DIRTY_BACKOFF_MAX_MS = 30 * 60 * 1000;
const REQUEST_ID_PREFIX = "car_";
/** An unanswered self-check is submitted again after this long. */
const SELF_CHECK_RETRY_MS = 10 * 60 * 1000;

const parse = <T>(text: string | null, fallback: T): T => {
	if (text === null) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const actorOf = (principal: string): Actor => ({
	kind: principalKind(principal) ?? "system",
	id: principal,
});

const stateOf = (row: StateRow | null): RepoConfigForgeState | null =>
	row === null ? null : {
		appliedSeq: row.applied_seq,
		appliedEpoch: row.applied_epoch,
		appliedKey: row.applied_key,
		appliedSha: row.applied_sha,
		holdReason: row.hold_reason,
		holdId: row.hold_id ?? 0,
		principals: parse<string[]>(row.principals_json, []),
		updatedAt: row.updated_at,
	};

const canonicalJsonEquals = (a: unknown, b: unknown): boolean =>
	canonicalJson(a ?? null) === canonicalJson(b ?? null);

const compareFence = (
	a: readonly [number, number],
	b: readonly [number, number],
): number => a[0] - b[0] || a[1] - b[1];

export const createRegistryRepoConfig = (deps: RegistryRepoConfigDeps) => {
	const { sql, storage, clock, tree } = deps;
	const now = () => clock.now();

	const rows = <T>(query: string, ...bindings: unknown[]): T[] =>
		sql.exec<T & Record<string, SqlStorageValue>>(query, ...bindings)
			.toArray() as T[];
	const one = <T>(query: string, ...bindings: unknown[]): T | null =>
		rows<T>(query, ...bindings)[0] ?? null;

	// -------------------------------------------------------------------------
	// Epoch and the dirty outbox
	// -------------------------------------------------------------------------

	const metaGet = (k: string): string | null =>
		one<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v ?? null;
	const metaSet = (k: string, v: string): void => {
		sql.exec(
			"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			k,
			v,
		);
	};

	const epochSync = (): number => Number(metaGet("config_epoch") ?? 0) || 0;

	/** The Owner (or kernel) whose change moved the epoch. */
	const epochBySync = (): string => metaGet("config_epoch_by") ?? SYS_KERNEL;

	/**
	 * Repo nodes that use repository config: applied state, rows, overlays,
	 * and every repo whose RepoDO evaluated trunk config (the watch set), so
	 * a repo whose first config was denied is poked once it may apply.
	 */
	const configuredRepos = (): string[] =>
		rows<{ id: string }>(
			`SELECT node_id AS id FROM repo_config_state
			 UNION SELECT node_id AS id FROM installations WHERE source = 'repo-config'
			 UNION SELECT repo_node_id AS id FROM repo_config_overlays
			 UNION SELECT node_id AS id FROM repo_config_watch`,
		).map((r) => r.id);

	/** RepoDO evaluated this repo's trunk config: later registry changes poke it. */
	const watchSync = (repoNodeId: string): void => {
		sql.exec(
			`INSERT INTO repo_config_watch (node_id, at) VALUES (?, ?)
			 ON CONFLICT (node_id) DO NOTHING`,
			repoNodeId,
			now(),
		);
	};

	/**
	 * A deploy that changes the evaluator id (a CUE upgrade, new file rules
	 * or job) changes every input key: configured repos re-evaluate (stale).
	 * Inside `registerBuiltinsSync`'s transaction.
	 */
	const onEvaluatorSync = (): void => {
		// The switch going on (again): every repo in the watch set is poked
		// once, so its RepoDO runs its switch-on transition and re-evaluates
		// what registry changes made while it was off (their pokes were
		// dropped) without waiting for its next touch.
		const on = deps.switchOn?.() ?? false;
		const seen = metaGet("config_switch");
		if (on !== (seen === "on")) metaSet("config_switch", on ? "on" : "off");
		const switchedOn = on && seen !== "on";
		const evaluator = metaGet("config_evaluator") !== CUE_EVALUATOR_ID;
		if (evaluator) {
			metaSet("config_evaluator", CUE_EVALUATOR_ID);
			// A published package's self-check ran on the old evaluator: it is
			// absent from every schema again until it passes on this one, so a
			// config.cue the new CUE rejects never fails other repositories.
			// Bundled ones are tested against the pinned CLI.
			sql.exec(
				"UPDATE packages SET config_checked = NULL WHERE config_checked IS NOT NULL AND config_checked <> 'builtin'",
			);
		}
		if (evaluator || switchedOn) bumpEpochSync(SYS_KERNEL, null);
	};

	/**
	 * Bumps `config_epoch` (inside the caller's transaction) and queues a
	 * poke for every configured repo inside `scope` (all when null).
	 */
	const bumpEpochSync = (by: string, scope: string | null): number => {
		const next = epochSync() + 1;
		metaSet("config_epoch", String(next));
		metaSet("config_epoch_by", by);
		const repos = configuredRepos().filter((id) =>
			scope === null || tree.isWithinSync(scope, id)
		);
		const t = now();
		repos.forEach((id, i) => {
			sql.exec(
				`INSERT INTO repo_config_dirty (node_id, epoch, due_at, attempts) VALUES (?, ?, ?, 0)
				 ON CONFLICT (node_id) DO UPDATE SET epoch = excluded.epoch, due_at = MIN(due_at, excluded.due_at), attempts = 0`,
				id,
				next,
				t + i * DIRTY_STAGGER_MS,
			);
		});
		if (repos.length > 0) deps.schedule(t);
		return next;
	};

	/** The `repoconfig` timer: pokes due RepoDOs, reschedules itself. */
	const drainDirty = async (): Promise<void> => {
		const t = now();
		const due = rows<{ node_id: string; epoch: number; attempts: number }>(
			"SELECT node_id, epoch, attempts FROM repo_config_dirty WHERE due_at <= ? ORDER BY due_at LIMIT ?",
			t,
			DIRTY_BATCH,
		);
		for (const row of due) {
			try {
				await deps.ports().poke(row.node_id, row.epoch);
				sql.exec(
					"DELETE FROM repo_config_dirty WHERE node_id = ? AND epoch = ?",
					row.node_id,
					row.epoch,
				);
			} catch (error) {
				const delay = Math.min(
					DIRTY_BACKOFF_MAX_MS,
					60_000 * 2 ** Math.min(row.attempts, 10),
				);
				sql.exec(
					"UPDATE repo_config_dirty SET attempts = attempts + 1, due_at = ? WHERE node_id = ?",
					now() + delay,
					row.node_id,
				);
				deps.ports().log("repo config poke failed", {
					node: row.node_id,
					error: error instanceof Error ? error.message.slice(0, 200) : "",
				});
			}
		}
		const next = one<{ at: number | null }>(
			"SELECT MIN(due_at) AS at FROM repo_config_dirty",
		)?.at;
		if (typeof next === "number") deps.schedule(Math.max(next, now() + 1000));
	};

	// -------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------

	type Lineage = {
		id: string;
		path: string;
		depth: number;
		archived: boolean;
	}[];
	const lineageOf = (nodeId: string): Lineage => {
		const node = tree.nodeSync(nodeId);
		if (node === null) throw notFound(`node ${nodeId}`);
		return tree.ancestorPathsSync(nodeId).flatMap((path) => {
			const row = path === node.path ? node : tree.nodeByPathSync(path);
			return row === null ? [] : [{
				id: row.id,
				path: row.path,
				depth: row.depth,
				archived: row.archived_at !== null,
			}];
		});
	};

	/**
	 * The nearest approval per extension id at an ancestor-or-self. An
	 * approval at an archived node binds nothing (WP3's archive revalidates).
	 */
	const approvalsAtSync = (nodeId: string): Map<string, BindingApproval> => {
		const lineage = lineageOf(nodeId).filter((n) => !n.archived);
		const byId = new Map(lineage.map((n) => [n.id, n]));
		const found = rows<ApprovalRow>(
			"SELECT * FROM config_approvals WHERE node_id IN (SELECT value FROM json_each(?))",
			JSON.stringify(lineage.map((n) => n.id)),
		);
		const out = new Map<string, BindingApproval & { depth: number }>();
		for (const a of found) {
			const node = byId.get(a.node_id);
			if (node === undefined) continue;
			const seen = out.get(a.ext_id);
			if (seen !== undefined && seen.depth >= node.depth) continue;
			out.set(a.ext_id, {
				nodeId: a.node_id,
				nodePath: node.path,
				extId: a.ext_id,
				version: a.version,
				packageSha256: a.package_sha256,
				grantsJson: a.grants_json,
				backgroundRole: a.background_role,
				needsReapproval: a.needs_reapproval === 1,
				depth: node.depth,
			});
		}
		return out;
	};

	/** A repo-config row is in force only while its approval binds. */
	const isBoundSync = (
		row: Pick<InstallationRow, "source" | "ext_id" | "version" | "node_id">,
		approvals = approvalsAtSync(row.node_id),
	): BindingApproval | null => {
		const approval = approvals.get(row.ext_id);
		if (approval === undefined || approval.needsReapproval) return null;
		if (approval.version !== row.version) return null;
		const pkg = deps.packageRow(row.ext_id, row.version);
		if (pkg === null || pkg.sha256 !== approval.packageSha256) return null;
		return approval;
	};

	/**
	 * The binding rule for `inForceSync`: drops unbound repo-config rows and
	 * gives the bound ones the approval's grants and background role.
	 */
	const bindInForceSync = (
		list: readonly InstallationInForce[],
		rowsById: ReadonlyMap<string, InstallationRow>,
	): InstallationInForce[] => {
		const cache = new Map<string, Map<string, BindingApproval>>();
		return list.flatMap((i) => {
			const row = rowsById.get(i.installation.id);
			if (row === undefined || row.source !== "repo-config") return [i];
			const approvals = cache.get(row.node_id) ?? approvalsAtSync(row.node_id);
			cache.set(row.node_id, approvals);
			const approval = isBoundSync(row, approvals);
			if (approval === null) return [];
			return [{
				...i,
				installation: {
					...i.installation,
					grants: parse(approval.grantsJson, i.installation.grants),
					backgroundRole: approval.backgroundRole,
				},
			}];
		});
	};

	const fullRowsAt = (nodeIds: readonly string[]): FullRow[] =>
		rows<FullRow>(
			"SELECT * FROM installations WHERE node_id IN (SELECT value FROM json_each(?))",
			JSON.stringify(nodeIds),
		);

	const configOf = (m: Manifest, configJson: string) => ({
		...(m.config?.default ?? {}),
		...(parse<Record<string, unknown>>(configJson, {})),
	});

	const ancestorsSync = (repoNodeId: string): AncestorInstall[] => {
		const lineage = lineageOf(repoNodeId).filter((n) => n.id !== repoNodeId);
		const byId = new Map(lineage.map((n) => [n.id, n]));
		return fullRowsAt(lineage.map((n) => n.id))
			.map((row) => {
				const node = byId.get(row.node_id)!;
				const manifest = deps.manifestFor(row.ext_id, row.version);
				return {
					id: row.id,
					extId: row.ext_id,
					version: row.version,
					nodeId: row.node_id,
					nodePath: node.path,
					depth: node.depth,
					mode: row.mode,
					locked: row.locked === 1,
					repoOverrides: row.repo_overrides === 1,
					storageScope: row.storage_scope,
					manifest,
					config: configOf(manifest, row.config_json),
					bundled: deps.packageRow(row.ext_id, row.version)?.r2_prefix ===
						null,
				};
			})
			.sort((a, b) =>
				b.depth - a.depth ||
				(a.mode === "disabled" ? 1 : 0) - (b.mode === "disabled" ? 1 : 0)
			);
	};

	/** The extensions an Owner disabled at this repo (the kill switch). */
	const ownerDisabledSync = (repoNodeId: string): Set<string> =>
		new Set(
			rows<{ ext_id: string }>(
				"SELECT ext_id FROM repo_config_disabled WHERE repo_node_id = ?",
				repoNodeId,
			).map((r) => r.ext_id),
		);

	/**
	 * An Owner's `setMode` on a repo-config row: `disabled` sets the kill
	 * switch for (repo, extension), anything else clears it. Reconcile, a
	 * version change and revalidation never touch it. Inside the caller's
	 * transaction.
	 */
	const setOwnerDisabledSync = (
		repoNodeId: string,
		extId: string,
		disabled: boolean,
		by: string,
	): void => {
		if (disabled) {
			sql.exec(
				`INSERT INTO repo_config_disabled (repo_node_id, ext_id, disabled_by, at) VALUES (?, ?, ?, ?)
				 ON CONFLICT (repo_node_id, ext_id) DO UPDATE SET disabled_by = excluded.disabled_by, at = excluded.at`,
				repoNodeId,
				extId,
				by,
				now(),
			);
		} else {
			sql.exec(
				"DELETE FROM repo_config_disabled WHERE repo_node_id = ? AND ext_id = ?",
				repoNodeId,
				extId,
			);
		}
		sql.exec(
			`UPDATE installations SET owner_disabled = ? WHERE node_id = ? AND ext_id = ?
			   AND source = 'repo-config'`,
			disabled ? 1 : 0,
			repoNodeId,
			extId,
		);
	};

	const hereSync = (repoNodeId: string): HereInstall[] => {
		const killed = ownerDisabledSync(repoNodeId);
		return fullRowsAt([repoNodeId]).map((row) => ({
			id: row.id,
			extId: row.ext_id,
			version: row.version,
			mode: row.mode,
			source: row.source,
			ownerDisabled: row.owner_disabled === 1 ||
				(row.source === "repo-config" && killed.has(row.ext_id)),
			locked: row.locked === 1,
			manifest: deps.manifestFor(row.ext_id, row.version),
			config: parse<Record<string, unknown>>(row.config_json, {}),
		}));
	};

	/** A package version's self-check passed (or it has no `config.cue`). */
	const checkedSync = (extId: string, version: string): boolean => {
		if (deps.settingsCueOf(extId, version) === null) return true;
		const row = deps.packageRow(extId, version);
		return row !== null && (row.config_checked ?? null) !== null;
	};

	const overlaysSync = (repoNodeId: string): AppliedOverlay[] =>
		rows<OverlayRow & { ext_id: string }>(
			`SELECT o.*, i.ext_id AS ext_id FROM repo_config_overlays o
			 JOIN installations i ON i.id = o.installation_id WHERE o.repo_node_id = ?`,
			repoNodeId,
		).map((o) => ({
			installationId: o.installation_id,
			extId: o.ext_id,
			settings: parse<Record<string, unknown>>(o.settings_json, {}),
		}));

	const packageInfo = (extId: string, version: string) => {
		const pkg = deps.packageRow(extId, version);
		if (pkg === null) return null;
		return {
			manifest: deps.manifestFor(extId, version),
			sha256: pkg.sha256,
			settingsCue: deps.settingsCueOf(extId, version),
		};
	};

	const requireRepo = (repoNodeId: string) => {
		const node = tree.nodeSync(repoNodeId);
		if (node === null || node.kind !== "repo") throw notFound("no such repo");
		return node;
	};

	const checkContextSync = (repoNodeId: string): CheckContext => {
		const node = requireRepo(repoNodeId);
		return {
			repo: { id: node.id, path: node.path },
			ancestors: ancestorsSync(repoNodeId),
			here: hereSync(repoNodeId),
			approvals: approvalsAtSync(repoNodeId),
			packageOf: packageInfo,
			packageAnyOf: (extId) => {
				const latest = one<{ version: string }>(
					"SELECT version FROM packages WHERE ext_id = ? ORDER BY published_at DESC LIMIT 1",
					extId,
				);
				return latest === null ? null : packageInfo(extId, latest.version);
			},
			overlays: overlaysSync(repoNodeId),
			ownerDisabled: ownerDisabledSync(repoNodeId),
		};
	};

	/**
	 * The packages a repository's schema could offer but whose self-check
	 * has not passed yet (they are left out until it does).
	 */
	const uncheckedSync = (
		repoNodeId: string,
	): { extId: string; version: string; nodeId: string }[] => {
		const ctx = checkContextSync(repoNodeId);
		const out = new Map<
			string,
			{ extId: string; version: string; nodeId: string }
		>();
		const add = (extId: string, version: string, nodeId: string) => {
			if (!checkedSync(extId, version)) {
				out.set(`${extId}@${version}`, { extId, version, nodeId });
			}
		};
		for (const h of ctx.here) {
			if (h.source === "manual") add(h.extId, h.version, repoNodeId);
		}
		for (const a of ctx.ancestors) add(a.extId, a.version, a.nodeId);
		// Approved for own installs: checked again after an evaluator upgrade.
		for (const a of ctx.approvals.values()) {
			add(a.extId, a.version, a.nodeId);
		}
		return [...out.values()];
	};

	const schemaInputSync = (repoNodeId: string): SchemaInput => {
		const ctx = checkContextSync(repoNodeId);
		const inherited = new Set(ctx.ancestors.map((a) => a.extId));
		const manualHere = ctx.here.filter((h) => h.source === "manual");
		const manualIds = new Set(manualHere.map((h) => h.extId));
		const installs = [...ctx.approvals.values()].flatMap((a) => {
			if (inherited.has(a.extId) || manualIds.has(a.extId)) return [];
			if (a.needsReapproval) return [];
			const pkg = packageInfo(a.extId, a.version);
			if (pkg === null || pkg.sha256 !== a.packageSha256) return [];
			if (!checkedSync(a.extId, a.version)) return [];
			const m = pkg.manifest;
			if (m.kind === "pack" || (m.provides?.length ?? 0) > 0) return [];
			return [{
				extId: a.extId,
				version: a.version,
				settingsCue: pkg.settingsCue,
				approvalNode: a.nodeId,
				hasGates: (m.gates?.length ?? 0) > 0,
				repoPolicy: m.config?.repoPolicy ?? [],
			}];
		});
		// Installations in force: a manual one here, else the nearest above.
		const seen = new Set<string>();
		const inForce: SchemaInForce[] = [];
		for (const h of manualHere) {
			if (seen.has(h.extId)) continue;
			seen.add(h.extId);
			const policy = h.manifest.config?.repoPolicy ?? [];
			if (policy.length === 0 || !checkedSync(h.extId, h.version)) continue;
			inForce.push({
				extId: h.extId,
				version: h.version,
				settingsCue: deps.settingsCueOf(h.extId, h.version),
				installationId: h.id,
				nodePath: ctx.repo.path,
				repoPolicy: policy,
				overridable: [],
			});
		}
		for (const a of ctx.ancestors) {
			if (seen.has(a.extId)) continue;
			seen.add(a.extId);
			if (a.manifest.kind === "pack") continue;
			// The same rule as the check: an unknown key is then a
			// positioned `field not allowed` before the registry denies it.
			const policy = repoPolicyKeysOf(a.extId, a.manifest, a);
			const repoOverridable = a.manifest.config?.repoOverridable ?? [];
			const opted = a.repoOverrides && a.mode !== "disabled" &&
				a.storageScope === "repo" && repoOverridable.length > 0;
			if (policy.length === 0 && !opted) continue;
			if (!checkedSync(a.extId, a.version)) continue;
			inForce.push({
				extId: a.extId,
				version: a.version,
				settingsCue: deps.settingsCueOf(a.extId, a.version),
				installationId: a.id,
				nodePath: a.nodePath,
				repoPolicy: policy,
				overridable: opted ? repoOverridable : [],
			});
		}
		return { installs, inForce };
	};

	const schemaCache = new Map<string, GeneratedSchema & { epoch: number }>();
	const schemaSync = (
		repoNodeId: string,
	): GeneratedSchema & { epoch: number } => {
		const epoch = epochSync();
		const key = `${repoNodeId}@${epoch}`;
		const cached = schemaCache.get(key);
		if (cached !== undefined) return cached;
		const generated = { ...generateSchema(schemaInputSync(repoNodeId)), epoch };
		if (schemaCache.size > 256) schemaCache.clear();
		schemaCache.set(key, generated);
		return generated;
	};

	const schemaDtoSync = (repoNodeId: string): RepoConfigSchemaDto => {
		const s = schemaSync(repoNodeId);
		return {
			repoId: repoNodeId,
			epoch: s.epoch,
			schemaKey: s.schemaKey,
			files: s.files,
			entries: s.entries,
			exportCommand: REPO_CONFIG_EXPORT_COMMAND,
			epochBy: epochBySync(),
		};
	};

	const checkSync = (
		repoNodeId: string,
		resolved: unknown,
	): RepoConfigCheckAnswer => {
		const result = checkResolved(resolved, checkContextSync(repoNodeId));
		const s = schemaSync(repoNodeId);
		return {
			denials: result.denials,
			plan: result.plan,
			epoch: s.epoch,
			schemaKey: s.schemaKey,
		};
	};

	const stateRowSync = (repoNodeId: string): StateRow | null =>
		one<StateRow>(
			"SELECT * FROM repo_config_state WHERE node_id = ?",
			repoNodeId,
		);

	// -------------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------------

	type ExtEventType =
		| "extension.installed"
		| "extension.uninstalled"
		| "extension.mode.changed"
		| "extension.configured";

	const appendExt = (
		type: ExtEventType,
		by: string,
		row: Pick<
			InstallationRow,
			"id" | "ext_id" | "version" | "node_id" | "mode"
		>,
		extra: Record<string, unknown>,
	): void => {
		deps.events.appendSync({
			type,
			actor: actorOf(by),
			node: row.node_id,
			data: {
				inst: row.id,
				ext: row.ext_id,
				version: row.version,
				node: row.node_id,
				mode: row.mode,
				source: "repo-config",
				...extra,
			},
			idemKey: eventIdemKey(
				"registry",
				`${row.id}:${String(extra.repoNode ?? "")}:${deps.ulid()}`,
				type,
			),
		});
	};

	// -------------------------------------------------------------------------
	// Apply
	// -------------------------------------------------------------------------

	/**
	 * A gate-bearing repo-config row lost its approval: lands of the repo
	 * hold. Every loss is a new generation, so a keep-last-good set
	 * for an earlier loss never masks this one.
	 */
	const holdIfGateLostSync = (repoNodeId: string): void => {
		sql.exec(
			"UPDATE repo_config_state SET hold_reason = 'gate-missing', hold_id = hold_id + 1, updated_at = ? WHERE node_id = ?",
			now(),
			repoNodeId,
		);
	};

	const applySync = (
		repoNodeId: string,
		input: RepoConfigApplyInput,
	): RepoConfigApplyAnswer =>
		storage.transactionSync(() => {
			const node = requireRepo(repoNodeId);
			if (node.archived_at !== null) {
				throw tartanError("invalid", "the repo is archived", {
					reason: "archived",
				});
			}
			const stored = stateRowSync(repoNodeId);
			const state = stateOf(stored);
			const fence = [input.trunkSeq, input.epoch] as const;
			if (state !== null) {
				const cmp = compareFence(fence, [state.appliedSeq, state.appliedEpoch]);
				if (cmp < 0) {
					return {
						kind: "refused",
						reason: "older",
						state,
						epoch: epochSync(),
					};
				}
				if (cmp === 0) {
					if (state.appliedKey === input.inputKey) {
						return {
							kind: "noop",
							state,
							changes: { installed: 0, updated: 0, removed: 0, overlays: 0 },
						};
					}
					return {
						kind: "refused",
						reason: "fence-conflict",
						state,
						epoch: epochSync(),
					};
				}
			}
			const epoch = epochSync();
			const schema = schemaSync(repoNodeId);
			if (input.epoch !== epoch || input.schemaKey !== schema.schemaKey) {
				return { kind: "refused", reason: "schema-changed", state, epoch };
			}
			const ctx = checkContextSync(repoNodeId);
			const result = checkResolved(input.resolved, ctx);
			if (result.denials.length > 0) {
				return { kind: "denied", denials: result.denials, state };
			}
			const by = input.principals[0] ?? SYS_KERNEL;
			const t = now();
			const provenance = {
				sha: input.sha,
				inputKey: input.inputKey,
				trunkSeq: input.trunkSeq,
				firstSha: input.provenance.firstSha,
				...(input.provenance.firstLane === undefined
					? {}
					: { firstLane: input.provenance.firstLane }),
				evaluator: input.provenance.evaluator,
				cueVersion: input.provenance.cueVersion,
			};
			const changes = { installed: 0, updated: 0, removed: 0, overlays: 0 };
			// The Owner's kill switch outlives every reconcile (only an Owner
			// clears it): a re-added or version-changed row comes back disabled.
			const killed = ownerDisabledSync(repoNodeId);
			const existing = new Map(
				fullRowsAt([repoNodeId]).filter((r) => r.source === "repo-config").map((
					r,
				) => [r.ext_id, r]),
			);
			const insert = (p: (typeof result.installs)[number]): FullRow => {
				const disabled = killed.has(p.extId);
				const row: FullRow = {
					id: toInstallationId(deps.ulid()),
					ext_id: p.extId,
					version: p.version,
					node_id: repoNodeId,
					mode: disabled ? "disabled" : p.mode,
					storage_scope: p.manifest.storage.scope,
					runtime_override: null,
					config_json: JSON.stringify(p.settings),
					grants_json: p.approval.grantsJson,
					background_role: p.approval.backgroundRole,
					locked: 0,
					backfill: "none",
					pack: null,
					installed_by: by,
					installed_at: t,
					mode_changed_at: null,
					source: "repo-config",
					source_sha: input.sha,
					source_key: input.inputKey,
					approval_node: p.approval.nodeId,
					owner_disabled: disabled ? 1 : 0,
					repo_overrides: 0,
				};
				deps.insertInstallation(row, p.manifest);
				sql.exec(
					`UPDATE installations SET source = 'repo-config', source_sha = ?, source_key = ?,
					   approval_node = ?, owner_disabled = ? WHERE id = ?`,
					row.source_sha,
					row.source_key,
					row.approval_node,
					row.owner_disabled,
					row.id,
				);
				appendExt("extension.installed", by, row, provenance);
				changes.installed += 1;
				return row;
			};
			const remove = (row: FullRow): void => {
				deps.deleteInstallation(row.id);
				appendExt("extension.uninstalled", by, row, provenance);
				changes.removed += 1;
			};
			for (const p of result.installs) {
				const have = existing.get(p.extId);
				existing.delete(p.extId);
				if (have === undefined) {
					insert(p);
					continue;
				}
				if (have.version !== p.version) {
					remove(have);
					changes.removed -= 1;
					insert(p);
					changes.installed -= 1;
					changes.updated += 1;
					continue;
				}
				const ownerDisabled = have.owner_disabled === 1 || killed.has(p.extId);
				const mode: InstallationMode = ownerDisabled ? "disabled" : p.mode;
				const config = JSON.stringify(p.settings);
				const modeChanged = mode !== have.mode;
				const configChanged = !canonicalJsonEquals(
					parse(have.config_json, {}),
					p.settings,
				);
				sql.exec(
					`UPDATE installations SET mode = ?, mode_changed_at = ?, config_json = ?, grants_json = ?,
					   background_role = ?, source_sha = ?, source_key = ?, approval_node = ?,
					   owner_disabled = ? WHERE id = ?`,
					mode,
					modeChanged ? t : have.mode_changed_at,
					config,
					p.approval.grantsJson,
					p.approval.backgroundRole,
					input.sha,
					input.inputKey,
					p.approval.nodeId,
					ownerDisabled ? 1 : 0,
					have.id,
				);
				const updated = { ...have, mode };
				if (modeChanged) {
					appendExt("extension.mode.changed", by, updated, provenance);
				}
				if (configChanged) {
					appendExt("extension.configured", by, updated, {
						...provenance,
						keys: [
							...new Set([
								...Object.keys(
									parse<Record<string, unknown>>(have.config_json, {}),
								),
								...Object.keys(p.settings),
							]),
						].filter((k) =>
							!canonicalJsonEquals(
								parse<Record<string, unknown>>(have.config_json, {})[k],
								p.settings[k],
							)
						).slice(0, 64),
					});
				}
				if (modeChanged || configChanged) changes.updated += 1;
			}
			for (const leftover of existing.values()) remove(leftover);
			// Overlays: one row per (inherited installation, this repo).
			const current = new Map(
				overlaysSync(repoNodeId).map((o) => [o.installationId, o]),
			);
			for (const o of result.overlays) {
				const have = current.get(o.installationId);
				current.delete(o.installationId);
				const empty = Object.keys(o.settings).length === 0;
				if (empty) {
					if (have !== undefined) {
						sql.exec(
							"DELETE FROM repo_config_overlays WHERE installation_id = ? AND repo_node_id = ?",
							o.installationId,
							repoNodeId,
						);
						changes.overlays += 1;
					}
					continue;
				}
				if (
					have !== undefined && canonicalJsonEquals(have.settings, o.settings)
				) {
					sql.exec(
						"UPDATE repo_config_overlays SET source_sha = ?, source_key = ? WHERE installation_id = ? AND repo_node_id = ?",
						input.sha,
						input.inputKey,
						o.installationId,
						repoNodeId,
					);
					continue;
				}
				sql.exec(
					`INSERT INTO repo_config_overlays (installation_id, repo_node_id, settings_json, source_sha, source_key)
					 VALUES (?, ?, ?, ?, ?) ON CONFLICT (installation_id, repo_node_id) DO UPDATE SET
					   settings_json = excluded.settings_json, source_sha = excluded.source_sha, source_key = excluded.source_key`,
					o.installationId,
					repoNodeId,
					JSON.stringify(o.settings),
					input.sha,
					input.inputKey,
				);
				const inst = one<FullRow>(
					"SELECT * FROM installations WHERE id = ?",
					o.installationId,
				);
				if (inst !== null) {
					appendExt("extension.configured", by, inst, {
						...provenance,
						repoNode: repoNodeId,
						keys: Object.keys(o.settings).slice(0, 64),
					});
				}
				changes.overlays += 1;
			}
			for (const leftover of current.values()) {
				sql.exec(
					"DELETE FROM repo_config_overlays WHERE installation_id = ? AND repo_node_id = ?",
					leftover.installationId,
					repoNodeId,
				);
				const inst = one<FullRow>(
					"SELECT * FROM installations WHERE id = ?",
					leftover.installationId,
				);
				if (inst !== null) {
					appendExt("extension.configured", by, inst, {
						...provenance,
						repoNode: repoNodeId,
						keys: Object.keys(leftover.settings).slice(0, 64),
					});
				}
				changes.overlays += 1;
			}
			const changed = changes.installed + changes.updated + changes.removed +
				changes.overlays;
			if (changed > 0) deps.bumpExtVersion();
			deps.events.auditSync({
				principal: by,
				action: "repo-config.apply",
				target: repoNodeId,
				data: {
					repo: node.path,
					sha: input.sha,
					inputKey: input.inputKey,
					trunkSeq: input.trunkSeq,
					epoch: input.epoch,
					principals: [...input.principals],
					explicit: input.explicit === true,
					removal: input.removal === true,
					...changes,
				},
			});
			sql.exec(
				`INSERT INTO repo_config_state (node_id, applied_seq, applied_epoch, applied_key, applied_sha,
				   hold_reason, principals_json, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
				 ON CONFLICT (node_id) DO UPDATE SET applied_seq = excluded.applied_seq,
				   applied_epoch = excluded.applied_epoch, applied_key = excluded.applied_key,
				   applied_sha = excluded.applied_sha, hold_reason = NULL,
				   principals_json = excluded.principals_json, updated_at = excluded.updated_at`,
				repoNodeId,
				input.trunkSeq,
				input.epoch,
				input.inputKey,
				input.sha,
				JSON.stringify(input.principals.slice(0, 32)),
				t,
			);
			sql.exec(
				"DELETE FROM repo_config_dirty WHERE node_id = ? AND epoch <= ?",
				repoNodeId,
				epoch,
			);
			return {
				kind: "applied",
				state: stateOf(stateRowSync(repoNodeId))!,
				changes,
			};
		});

	// -------------------------------------------------------------------------
	// Registry changes: revalidation, approvals, overrides, builtins
	// -------------------------------------------------------------------------

	/**
	 * Deletes every repo-config row inside `scope` (one extension or all)
	 * whose approval no longer binds; a lost gate holds that repo's lands
	 * until its re-apply commits. Inside the caller's transaction.
	 */
	const revalidateSync = (
		by: string,
		scope: string | null,
		extId?: string,
	): number => {
		const candidates = rows<FullRow>(
			extId === undefined
				? "SELECT * FROM installations WHERE source = 'repo-config'"
				: "SELECT * FROM installations WHERE source = 'repo-config' AND ext_id = ?",
			...(extId === undefined ? [] : [extId]),
		).filter((r) => scope === null || tree.isWithinSync(scope, r.node_id));
		let removed = 0;
		for (const row of candidates) {
			if (isBoundSync(row) !== null) continue;
			const m = deps.manifestFor(row.ext_id, row.version);
			deps.deleteInstallation(row.id);
			appendExt("extension.uninstalled", by, row, {});
			if ((m.gates?.length ?? 0) > 0) holdIfGateLostSync(row.node_id);
			removed += 1;
		}
		// An overlay binds only while its installation sits at a strict
		// ancestor of the repo: after a move it no longer does (WP3).
		const overlays = rows<
			{ installation_id: string; repo_node_id: string; node_id: string }
		>(
			`SELECT o.installation_id, o.repo_node_id, i.node_id FROM repo_config_overlays o
			 JOIN installations i ON i.id = o.installation_id`,
		).filter((o) =>
			(scope === null || tree.isWithinSync(scope, o.repo_node_id) ||
				tree.isWithinSync(scope, o.node_id)) &&
			(extId === undefined ||
				one<{ ext_id: string }>(
						"SELECT ext_id FROM installations WHERE id = ?",
						o.installation_id,
					)?.ext_id === extId)
		);
		for (const o of overlays) {
			const above = o.node_id !== o.repo_node_id &&
				tree.isWithinSync(o.node_id, o.repo_node_id);
			if (above) continue;
			sql.exec(
				"DELETE FROM repo_config_overlays WHERE installation_id = ? AND repo_node_id = ?",
				o.installation_id,
				o.repo_node_id,
			);
			removed += 1;
		}
		if (removed > 0) deps.bumpExtVersion();
		return removed;
	};

	const approvalDto = (a: ApprovalRow): ConfigApprovalDto => ({
		nodeId: a.node_id,
		nodePath: tree.nodeSync(a.node_id)?.path ?? "",
		extId: a.ext_id,
		version: a.version,
		packageSha256: a.package_sha256,
		backgroundRole: a.background_role,
		approvedBy: a.approved_by,
		approvedAt: a.approved_at,
		needsReapproval: a.needs_reapproval === 1,
	});

	const requestDto = (r: RequestRow): ConfigApprovalRequestDto => {
		const result = parse<{ message?: string }>(r.result_json, {});
		return {
			id: r.id,
			nodeId: r.node_id,
			extId: r.ext_id,
			version: r.version,
			state: r.state,
			...(result.message === undefined ? {} : { message: result.message }),
			at: r.at,
		};
	};

	const requireOwner = (by: string, nodeId: string): void => {
		if (by !== SYS_KERNEL && principalKind(by) !== "user") {
			throw denied("role", "only an Owner (a person) can do this");
		}
		if (deps.roleOf(by, nodeId) < ROLE.owner) {
			throw denied("role", "an Owner must do this");
		}
	};

	/** The self-check's expected entry: `settings` equals `config.default`. */
	const expectedSelfCheck = (m: Manifest) => ({
		enabled: true,
		mode: "enforce",
		settings: m.config?.default ?? {},
	});

	/** The self-check request of one package version: its files and input key. */
	const selfCheckRequest = (extId: string, version: string) => {
		const m = deps.manifestFor(extId, version);
		const files = selfCheckInput({
			extId,
			version,
			settingsCue: deps.settingsCueOf(extId, version),
			repoPolicy: m.config?.repoPolicy ?? [],
		});
		const forgeFiles = Object.fromEntries(
			Object.entries(files).filter(([p]) => p !== SELF_CHECK_FILE),
		);
		const inputKey = inputKeyOf({
			evaluator: CUE_EVALUATOR_ID,
			schemaKey: schemaKeyOf(forgeFiles),
			files: [{
				name: SELF_CHECK_FILE,
				oid: gitBlobOid(new TextEncoder().encode(files[SELF_CHECK_FILE])),
			}],
		});
		return { files, inputKey };
	};

	const requestRow = (id: string): RequestRow =>
		one<RequestRow>("SELECT * FROM config_approval_requests WHERE id = ?", id)!;

	/** Writes the approval (inside the caller's transaction) and its effects. */
	const commitApprovalSync = (req: RequestRow): void => {
		const pkg = deps.packageRow(req.ext_id, req.version)!;
		const m = deps.manifestFor(req.ext_id, req.version);
		const existing = one<ApprovalRow>(
			"SELECT * FROM config_approvals WHERE node_id = ? AND ext_id = ?",
			req.node_id,
			req.ext_id,
		);
		const t = now();
		const grants = canonicalJson(m.permissions);
		if (
			existing !== null && existing.version === req.version &&
			existing.package_sha256 === pkg.sha256
		) {
			sql.exec(
				`UPDATE config_approvals SET grants_json = ?, background_role = ?,
				   needs_reapproval = 0, approved_by = ?, approved_at = ? WHERE node_id = ? AND ext_id = ?`,
				grants,
				req.background_role,
				req.requested_by,
				t,
				req.node_id,
				req.ext_id,
			);
		} else {
			sql.exec(
				"DELETE FROM config_approvals WHERE node_id = ? AND ext_id = ?",
				req.node_id,
				req.ext_id,
			);
			sql.exec(
				`INSERT INTO config_approvals (node_id, ext_id, version, package_sha256, grants_json,
				   background_role, needs_reapproval, approved_by, approved_at)
				 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
				req.node_id,
				req.ext_id,
				req.version,
				pkg.sha256,
				grants,
				req.background_role,
				req.requested_by,
				t,
			);
		}
		// Same-version rows keep binding; a version change drops the old
		// rows, and the re-apply installs the approved version anew.
		revalidateSync(req.requested_by, req.node_id, req.ext_id);
		bumpEpochSync(req.requested_by, req.node_id);
		deps.events.auditSync({
			principal: req.requested_by,
			action: "repo-config.approve",
			target: `${req.ext_id}@${req.version}`,
			data: {
				node: tree.nodeSync(req.node_id)?.path ?? req.node_id,
				sha256: pkg.sha256,
				backgroundRole: req.background_role,
				request: req.id,
			},
		});
		sql.exec(
			"UPDATE config_approval_requests SET state = 'approved', result_json = NULL WHERE id = ?",
			req.id,
		);
	};

	/** Submits a request's self-check on `cue:trunk`; a refusal is recorded on the request. */
	const submitSelfCheck = async (
		req: RequestRow,
		files: Readonly<Record<string, string>>,
	): Promise<void> => {
		let message: string | undefined;
		try {
			const answer = await deps.ports().submit({
				class: "selfcheck",
				sink: { kind: "approval", requestId: req.id },
				request: {
					version: CUE_EVAL_CONTRACT,
					evaluator: CUE_EVALUATOR_ID,
					inputKey: req.input_key,
					files,
					limits: DEFAULT_EVAL_LIMITS,
				},
			});
			if (!answer.accepted) {
				message =
					`the self-check could not start (${answer.reason}): ${answer.message}; it is retried`;
			}
		} catch (error) {
			message = `the self-check could not start: ${
				error instanceof Error ? error.message.slice(0, 200) : "error"
			}; it is retried`;
		}
		if (message !== undefined) {
			sql.exec(
				"UPDATE config_approval_requests SET result_json = ? WHERE id = ?",
				JSON.stringify({ message }),
				req.id,
			);
		}
	};

	const requestApproval = async (
		by: string,
		nodeId: string,
		extId: string,
		input: {
			readonly version: string;
			readonly backgroundRole?: 10 | 20 | 30 | 40;
		},
	): Promise<ConfigApprovalRequestDto> => {
		const prepared = storage.transactionSync(() => {
			const node = tree.nodeSync(nodeId);
			if (node === null) throw notFound(`node ${nodeId}`);
			if (node.archived_at !== null) throw invalid("node is archived");
			requireOwner(by, nodeId);
			const pkg = deps.packageRow(extId, input.version);
			if (pkg === null) throw notFound(`package ${extId}@${input.version}`);
			const m = deps.manifestFor(extId, input.version);
			if (m.kind === "pack") {
				throw invalid("a pack cannot be approved for repository config");
			}
			if ((m.provides?.length ?? 0) > 0) {
				throw invalid(
					`${extId} provides ${
						m.provides!.join(", ")
					}: providers stay manual installs`,
				);
			}
			const { files, inputKey } = selfCheckRequest(extId, input.version);
			const id = `${REQUEST_ID_PREFIX}${deps.ulid()}`;
			sql.exec(
				"UPDATE config_approval_requests SET state = 'superseded' WHERE node_id = ? AND ext_id = ? AND kind = 'approval' AND state = 'checking'",
				nodeId,
				extId,
			);
			sql.exec(
				`INSERT INTO config_approval_requests (id, kind, node_id, ext_id, version, background_role,
				   requested_by, state, input_key, result_json, at) VALUES (?, 'approval', ?, ?, ?, ?, ?, 'checking', ?, NULL, ?)`,
				id,
				nodeId,
				extId,
				input.version,
				input.backgroundRole ?? 20,
				by,
				inputKey,
				now(),
			);
			// A package version that passed its self-check commits at once.
			if (checkedSync(extId, input.version)) {
				commitApprovalSync(requestRow(id));
				return { id, files: null };
			}
			return { id, files };
		});
		if (prepared.files !== null) {
			await submitSelfCheck(requestRow(prepared.id), prepared.files);
		}
		return requestDto(requestRow(prepared.id));
	};

	/**
	 * Self-checks for package versions in force at `repoNodeId` that have a
	 * `config.cue` and never passed one (installed before the switch went
	 * on, or a manual install): one `check` request each, deduplicated.
	 */
	const ensureChecks = async (repoNodeId: string): Promise<number> => {
		const queued = storage.transactionSync(() =>
			uncheckedSync(repoNodeId).flatMap((p) => {
				const pending = one<{ id: string }>(
					"SELECT id FROM config_approval_requests WHERE ext_id = ? AND version = ? AND state = 'checking' AND at > ?",
					p.extId,
					p.version,
					now() - SELF_CHECK_RETRY_MS,
				);
				if (pending !== null) return [];
				const { files, inputKey } = selfCheckRequest(p.extId, p.version);
				const id = `${REQUEST_ID_PREFIX}${deps.ulid()}`;
				sql.exec(
					`INSERT INTO config_approval_requests (id, kind, node_id, ext_id, version, background_role,
					   requested_by, state, input_key, result_json, at) VALUES (?, 'check', ?, ?, ?, 20, ?, 'checking', ?, NULL, ?)`,
					id,
					p.nodeId,
					p.extId,
					p.version,
					SYS_KERNEL,
					inputKey,
					now(),
				);
				return [{ id, files }];
			})
		);
		for (const q of queued) await submitSelfCheck(requestRow(q.id), q.files);
		return queued.length;
	};

	/**
	 * The self-check sink: marks the package version checked on a pass and,
	 * for an approval request, commits the approval.
	 */
	const selfCheckResult = (
		requestId: string,
		raw: unknown,
	): ConfigApprovalRequestDto =>
		storage.transactionSync(() => {
			const req = one<RequestRow>(
				"SELECT * FROM config_approval_requests WHERE id = ?",
				requestId,
			);
			if (req === null) throw notFound(`approval request ${requestId}`);
			if (req.state !== "checking") return requestDto(req);
			const refuse = (message: string) => {
				sql.exec(
					"UPDATE config_approval_requests SET state = 'refused', result_json = ? WHERE id = ?",
					JSON.stringify({ message: message.slice(0, 2000) }),
					requestId,
				);
				return requestDto(requestRow(requestId));
			};
			const envelope: EvalResponse = parseEvalResponse(raw);
			if (!isEvalOk(envelope)) {
				if (
					envelope.error.code === "EVALUATOR_UNAVAILABLE" ||
					envelope.error.code === "INTERNAL"
				) {
					sql.exec(
						"UPDATE config_approval_requests SET result_json = ? WHERE id = ?",
						JSON.stringify({
							message:
								`the self-check did not run (${envelope.error.code}); request it again`,
						}),
						requestId,
					);
					return requestDto(requestRow(requestId));
				}
				return refuse(
					`the package's config.cue failed its self-check (${envelope.error.code}): ${envelope.error.message}`,
				);
			}
			const pkg = deps.packageRow(req.ext_id, req.version);
			if (pkg === null) return refuse("the package is no longer registered");
			const m = deps.manifestFor(req.ext_id, req.version);
			const value = envelope.ok;
			const got = isRecord(value) && isRecord(value.extensions)
				? value.extensions[req.ext_id]
				: undefined;
			if (!canonicalJsonEquals(got, expectedSelfCheck(m))) {
				return refuse(
					"the defaults of config.cue do not equal config.default in the manifest, or #Policy has a required field",
				);
			}
			sql.exec(
				"UPDATE packages SET config_checked = ? WHERE ext_id = ? AND version = ? AND config_checked IS NULL",
				req.input_key,
				req.ext_id,
				req.version,
			);
			if (req.kind === "approval") {
				commitApprovalSync(req);
			} else {
				// The package joins generated schemas: every repo re-evaluates.
				bumpEpochSync(SYS_KERNEL, null);
				sql.exec(
					"UPDATE config_approval_requests SET state = 'approved', result_json = NULL WHERE id = ?",
					requestId,
				);
			}
			return requestDto(requestRow(requestId));
		});

	const revokeApproval = (by: string, nodeId: string, extId: string): void =>
		storage.transactionSync(() => {
			requireOwner(by, nodeId);
			const existing = one<ApprovalRow>(
				"SELECT * FROM config_approvals WHERE node_id = ? AND ext_id = ?",
				nodeId,
				extId,
			);
			if (existing === null) throw notFound(`no approval of ${extId} here`);
			sql.exec(
				"DELETE FROM config_approvals WHERE node_id = ? AND ext_id = ?",
				nodeId,
				extId,
			);
			revalidateSync(by, nodeId, extId);
			bumpEpochSync(by, nodeId);
			deps.events.auditSync({
				principal: by,
				action: "repo-config.revoke",
				target: `${extId}@${existing.version}`,
				data: { node: tree.nodeSync(nodeId)?.path ?? nodeId },
			});
		});

	const approvalsSync = (nodeId: string): ConfigApprovalDto[] =>
		[...approvalsAtSync(nodeId).values()].map((a) =>
			approvalDto(
				one<ApprovalRow>(
					"SELECT * FROM config_approvals WHERE node_id = ? AND ext_id = ?",
					a.nodeId,
					a.extId,
				)!,
			)
		);

	const setRepoOverrides = (
		by: string,
		installationId: string,
		on: boolean,
	): InstallationRow =>
		storage.transactionSync(() => {
			const row = one<FullRow>(
				"SELECT * FROM installations WHERE id = ?",
				installationId,
			);
			if (row === null) throw notFound(`installation ${installationId}`);
			requireOwner(by, row.node_id);
			const m = deps.manifestFor(row.ext_id, row.version);
			// The opt-in also lets repositories below author the repo policy of
			// a package that decides what lands; it means nothing for
			// one whose policy needs no opt-in.
			const bundled = deps.packageRow(row.ext_id, row.version)?.r2_prefix ===
				null;
			const policyOnly = (m.config?.repoOverridable?.length ?? 0) === 0 &&
				(m.config?.repoPolicy?.length ?? 0) > 0 &&
				repoPolicyKeysOf(row.ext_id, m, { repoOverrides: false, bundled })
						.length === 0;
			if (on && !policyOnly) {
				if ((m.config?.repoOverridable?.length ?? 0) === 0) {
					throw invalid(`${row.ext_id} declares no repo-overridable settings`);
				}
				if (row.storage_scope !== "repo") {
					throw invalid(
						"only an installation with per-repository storage takes overlays",
					);
				}
				if (row.source === "repo-config") {
					throw invalid("a repo-config installation takes no overlays");
				}
			}
			if ((row.repo_overrides === 1) === on) return row;
			sql.exec(
				"UPDATE installations SET repo_overrides = ? WHERE id = ?",
				on ? 1 : 0,
				installationId,
			);
			if (!on) {
				const gone = rows<{ repo_node_id: string }>(
					"SELECT repo_node_id FROM repo_config_overlays WHERE installation_id = ?",
					installationId,
				);
				sql.exec(
					"DELETE FROM repo_config_overlays WHERE installation_id = ?",
					installationId,
				);
				for (const g of gone) {
					appendExt("extension.configured", by, row, {
						repoNode: g.repo_node_id,
						keys: [],
					});
				}
			}
			deps.bumpExtVersion();
			bumpEpochSync(by, row.node_id);
			deps.events.auditSync({
				principal: by,
				action: "extension.repo-overrides",
				target: installationId,
				data: { on },
			});
			return { ...row, repo_overrides: on ? 1 : 0 };
		});

	/**
	 * A bundled package whose content changed under the same version: same
	 * permissions update the approvals' sha in place; anything else marks
	 * them for re-approval, so their rows drop out of force.
	 * Inside `registerBuiltinsSync`'s transaction.
	 */
	const onPackageChangedSync = (m: Manifest, sha256: string): void => {
		const approvals = rows<ApprovalRow>(
			"SELECT * FROM config_approvals WHERE ext_id = ? AND version = ?",
			m.id,
			m.version,
		);
		if (approvals.length === 0) return;
		const grants = canonicalJson(m.permissions);
		for (const a of approvals) {
			const same = canonicalJson(parse(a.grants_json, {})) === grants;
			sql.exec(
				`UPDATE config_approvals SET package_sha256 = ?, needs_reapproval = ? WHERE node_id = ? AND ext_id = ?`,
				sha256,
				same ? a.needs_reapproval : 1,
				a.node_id,
				a.ext_id,
			);
		}
		revalidateSync(SYS_KERNEL, null, m.id);
		bumpEpochSync(SYS_KERNEL, null);
	};

	/** Manual install rule: no manual install above repo-config rows of the id. */
	const reposBelowSync = (extId: string, nodeId: string): string[] =>
		rows<FullRow>(
			"SELECT * FROM installations WHERE source = 'repo-config' AND ext_id = ?",
			extId,
		).filter((r) => tree.isWithinSync(nodeId, r.node_id)).map((r) =>
			tree.nodeSync(r.node_id)?.path ?? r.node_id
		);

	/** The settings an overlay gives one installation in one repo (WP7b host). */
	const overlaySync = (
		installationId: string,
		repoNodeId: string,
	): Record<string, unknown> | null => {
		const row = one<FullRow>(
			"SELECT * FROM installations WHERE id = ?",
			installationId,
		);
		if (
			row === null || row.repo_overrides !== 1 || row.storage_scope !== "repo"
		) {
			return null;
		}
		const o = one<OverlayRow>(
			"SELECT * FROM repo_config_overlays WHERE installation_id = ? AND repo_node_id = ?",
			installationId,
			repoNodeId,
		);
		if (o === null) return null;
		const allowed = new Set(
			deps.manifestFor(row.ext_id, row.version).config?.repoOverridable ?? [],
		);
		const settings = parse<Record<string, unknown>>(o.settings_json, {});
		if (Object.keys(settings).some((k) => !allowed.has(k))) return null;
		return settings;
	};

	/** The settings page's rows: where each installation in force comes from. */
	const effectiveSync = (
		repoNodeId: string,
		inForce: readonly InstallationInForce[],
	): RepoConfigEffectiveRow[] => {
		const ids = inForce.map((i) => i.installation.id);
		const full = new Map(
			rows<FullRow>(
				"SELECT * FROM installations WHERE id IN (SELECT value FROM json_each(?))",
				JSON.stringify(ids),
			).map((r) => [r.id, r]),
		);
		const overlays = new Map(
			overlaysSync(repoNodeId).map((o) => [o.installationId, o]),
		);
		return inForce.map((i): RepoConfigEffectiveRow => {
			const row = full.get(i.installation.id);
			const here = i.installation.nodeId === repoNodeId;
			const overlay = overlays.get(i.installation.id);
			const opted = row?.repo_overrides === 1;
			const base = configOf(
				i.manifest,
				JSON.stringify(i.installation.config ?? {}),
			);
			return {
				extId: i.installation.extId,
				version: i.installation.version,
				mode: i.installation.mode,
				installationId: i.installation.id,
				nodePath: i.installation.nodePath,
				source: row?.source === "repo-config"
					? "repo-config"
					: overlay !== undefined
					? "overlay"
					: here
					? "manual"
					: "inherited",
				overridable: opted ? (i.manifest.config?.repoOverridable ?? []) : [],
				repoPolicy: i.manifest.config?.repoPolicy ?? [],
				settings: overlay === undefined
					? base
					: { ...base, ...overlay.settings },
				managed: row?.source === "repo-config" || overlay !== undefined,
				hasGates: (i.manifest.gates?.length ?? 0) > 0,
				...(row?.owner_disabled === 1 ? { ownerDisabled: true } : {}),
				...(row?.source_sha ? { sourceSha: row.source_sha } : {}),
			};
		});
	};

	return {
		epochSync,
		epochBySync,
		bumpEpochSync,
		watchSync,
		onEvaluatorSync,
		setOwnerDisabledSync,
		drainDirty,
		approvalsAtSync,
		isBoundSync,
		bindInForceSync,
		schemaSync,
		schemaDtoSync,
		checkSync,
		applySync,
		stateSync: (repoNodeId: string) => stateOf(stateRowSync(repoNodeId)),
		revalidateSync,
		requestApproval,
		ensureChecks,
		uncheckedSync,
		selfCheckResult,
		revokeApproval,
		approvalsSync,
		requestsSync: (nodeId: string) =>
			rows<RequestRow>(
				"SELECT * FROM config_approval_requests WHERE node_id = ? ORDER BY at DESC LIMIT 50",
				nodeId,
			).map(requestDto),
		setRepoOverrides,
		onPackageChangedSync,
		reposBelowSync,
		overlaySync,
		effectiveSync,
	};
};

export type RegistryRepoConfig = ReturnType<typeof createRegistryRepoConfig>;
