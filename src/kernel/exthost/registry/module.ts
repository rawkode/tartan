// ForgeDO `registry` module (WP7a, migrations 300–399): packages,
// installations, contributions, nearest-provider resolution with locked
// providers, monotonic gates (K8), pack installs and the Owner-approval
// rules.
//
// Every write runs in one `transactionSync` together with its forge event
// (K3: `extension.installed`, `.mode.changed`, `.uninstalled`), its audit
// row and the `meta.ext_version` bump. Siblings are reached only through
// their synchronous internal APIs (`tree`, `events`), so the module runs
// unchanged against fakes.
//
// Repository config (WP23; ADR repo config) lives in `repoconfig/`:
// approvals, the binding rule `inForceSync` applies, schemagen, the fenced
// apply, overlays and the `repoconfig` timer that pokes RepoDOs after a
// registry change. Every install, mode change and uninstall bumps
// `meta.config_epoch`, and a manual install above repo-config rows of the
// same extension is refused (`conflict`), so gates are never doubled.
//
// "In force" (`inForce`) is the resolved set that acts at a node (`acting`
// in resolve.ts): event subscribers, echo, context, extension tools and the
// exthost cron read it, so a replaced or masked installation keeps only its
// gates (K8) there. `installed` is the unresolved registry query the install
// rules and sheets need.
//
// `replaceProvider` (M2) swaps the provider of one interface at a node in
// one transaction (replace.ts).
//
// Shadow mode: `promote` flips shadow → enforce and the old enforce
// installation → disabled atomically; `replayGate` validates a replay and
// mints its id (the installations API runs it). Not in this slice: the
// R2-backed protocol cards of published packages.

import { createHash } from "node:crypto";
import {
	type Actor,
	type BuiltinPackage,
	ConfigApprovalRequestSchema,
	conflict,
	CUE_TRUNK_SANDBOX,
	type CueJobInput,
	cueSid,
	type CueSubmitResult,
	denied,
	eventIdemKey,
	type InstallationDto,
	installationId as toInstallationId,
	type InstallationMode,
	InstallRequestSchema,
	internal as internalError,
	invalid,
	isWithinPath,
	type Manifest,
	manifestPolicyIssues,
	notFound,
	type PackageDto,
	parseManifest,
	principalKind,
	type ReplaceProviderRequest,
	ReplaceProviderRequestSchema,
	type ReplaceProviderResponse,
	type ReplaceStep,
	repoDoName,
	ROLE,
	SYS_KERNEL,
	type TartanError,
} from "@tartan/contract";
import {
	type ContributionKind,
	type ContributionRow,
	type DoModule,
	type ForgeInternals,
	type InstallationInForce,
	type InstallationRow,
	MIGRATION_RANGES,
	type ModuleDeps,
	type PackageRow,
	type RegistryFacade,
	type RegistryInternal,
	type TimerHandler,
} from "@tartan/contract/kernel.ts";
import { builtins as bundledBuiltins } from "../../../builtins.ts";
import type { Env } from "../../../env.ts";
import { type HereRow, planReplacement } from "./replace.ts";
import { acting, installationsFor, providerOf, resolve } from "./resolve.ts";
import {
	contributionRows,
	installationDto,
	isBundledRow,
	manifestOf,
	packageDto,
} from "./rows.ts";
import {
	candidateIssues,
	type InstallCandidate,
	type InstallIssue,
	monotonicGateIssues,
	permissionLines,
	requiredRole,
	sameNodeProviderIssues,
	shadowIssues,
} from "./rules.ts";
import {
	createRegistryRepoConfig,
	type RepoConfigPorts,
} from "./repoconfig/registry.ts";
import { settingsCueIssue } from "./repoconfig/schemagen.ts";
import { REGISTRY_MIGRATIONS } from "./schema.ts";

export type RegistryDeps = ModuleDeps<Env, ForgeInternals>;

/** A gate replay covers at most this many advances. */
export const GATE_REPLAY_MAX = 50;

/**
 * Builtins a deploy no longer ships: what a forge installed before their
 * removal is dropped at boot (tournaments were removed in contract 0.3.0).
 */
export const RETIRED_BUILTINS: readonly string[] = ["tartan.tournament"];

export type RegistryOptions = {
	/** Bundled packages, registered at module creation. */
	readonly builtins?: () => readonly BuiltinPackage[];
	/** Repository config's side effects (tests inject fakes). */
	readonly repoConfigPorts?: (deps: RegistryDeps) => RepoConfigPorts;
};

/** The production ports: `cue:trunk` for self-checks, RepoDO pokes. */
export const envRepoConfigPorts = (deps: RegistryDeps): RepoConfigPorts => ({
	submit: async (job: CueJobInput): Promise<CueSubmitResult> =>
		await deps.env.SANDBOX.getByName(CUE_TRUNK_SANDBOX).cueSubmit(job),
	poke: async (repoNodeId, epoch) => {
		await deps.env.REPO.getByName(repoDoName(repoNodeId)).repoconfig()
			.registryChanged(epoch);
	},
	waitUntil: (work) => deps.ctx.waitUntil(work),
	log: (message, data) =>
		console.error(`[tartan] registry: ${message}`, JSON.stringify(data)),
});

type Sql = RegistryDeps["sql"];

const sha256Hex = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Content hash of a bundled package: manifest, migrations, protocol card and `config.cue`. */
export const builtinSha256 = (pkg: BuiltinPackage): string =>
	sha256Hex(JSON.stringify({
		manifest: pkg.manifest,
		migrations: pkg.migrations,
		protocol: pkg.protocol ?? null,
		...(pkg.settingsCue === undefined ? {} : { settingsCue: pkg.settingsCue }),
	}));

const toError = (i: InstallIssue): TartanError =>
	i.code === "conflict"
		? conflict(i.text, { rule: i.rule })
		: invalid(i.text, { rule: i.rule });

const actorOf = (principal: string): Actor => {
	const kind = principalKind(principal);
	return { kind: kind ?? "user", id: principal };
};

export const createRegistry = (
	deps: RegistryDeps,
	options: RegistryOptions = {},
) => {
	const { sql, storage, modules, clock, ids } = deps;
	const builtinList = options.builtins ?? (() => []);

	// -------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------

	const packageRow = (extId: string, version: string): PackageRow | null =>
		sql.exec<PackageRow>(
			"SELECT * FROM packages WHERE ext_id = ? AND version = ?",
			extId,
			version,
		).toArray()[0] ?? null;

	const installationRow = (id: string): InstallationRow | null =>
		sql.exec<InstallationRow>(
			"SELECT * FROM installations WHERE id = ?",
			id,
		).toArray()[0] ?? null;

	const nodePathOf = (nodeId: string): string =>
		modules.tree.nodeSync(nodeId)?.path ?? "";

	const dtoOf = (row: InstallationRow): InstallationDto =>
		installationDto(row, nodePathOf(row.node_id));

	const manifestCache = new Map<string, Manifest>();
	const manifestFor = (extId: string, version: string): Manifest => {
		const key = `${extId}@${version}`;
		const cached = manifestCache.get(key);
		if (cached !== undefined) return cached;
		const row = packageRow(extId, version);
		if (row === null) throw notFound(`package ${key}`);
		const m = manifestOf(row);
		manifestCache.set(key, m);
		return m;
	};

	/** Ancestor-or-self node ids and depths of a node, root first. */
	const lineage = (nodeId: string): { id: string; depth: number }[] => {
		const node = modules.tree.nodeSync(nodeId);
		if (node === null) throw notFound(`node ${nodeId}`);
		return modules.tree.ancestorPathsSync(nodeId).flatMap((path) => {
			const row = path === node.path ? node : modules.tree.nodeByPathSync(path);
			return row === null ? [] : [{ id: row.id, depth: row.depth }];
		});
	};

	/** Every non-disabled installation at the node or an ancestor, nearest first. */
	const inForceSync = (nodeId: string): InstallationInForce[] => {
		const nodes = lineage(nodeId);
		const depthOf = new Map(nodes.map((n) => [n.id, n.depth]));
		const rows = sql.exec<InstallationRow>(
			`SELECT * FROM installations
			 WHERE node_id IN (SELECT value FROM json_each(?)) AND mode <> 'disabled'`,
			JSON.stringify(nodes.map((n) => n.id)),
		).toArray();
		const list = rows.map((row) => ({
			installation: dtoOf(row),
			manifest: manifestFor(row.ext_id, row.version),
			depth: depthOf.get(row.node_id) ?? 0,
		}));
		// An unbound repo-config row is never in force.
		const bound = rows.some((r) => r.source === "repo-config")
			? repoConfig.bindInForceSync(
				list,
				new Map(rows.map((r) => [r.id, r])),
			)
			: list;
		return bound
			.sort((a, b) =>
				b.depth - a.depth ||
				b.installation.installedAt - a.installation.installedAt ||
				(a.installation.id < b.installation.id ? -1 : 1)
			);
	};

	const extVersionSync = (): number => {
		const row = sql.exec<{ v: string }>(
			"SELECT v FROM meta WHERE k = 'ext_version'",
		).toArray()[0];
		return row === undefined ? 0 : Number(row.v) || 0;
	};

	const bumpExtVersion = (): number => {
		const next = extVersionSync() + 1;
		sql.exec(
			"INSERT INTO meta (k, v) VALUES ('ext_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			String(next),
		);
		return next;
	};

	const contributionsSync = (
		kind: ContributionKind,
		nodeId: string,
	): ContributionRow[] => {
		const r = resolve(inForceSync(nodeId));
		const installs = installationsFor(kind, r);
		if (installs.length === 0) return [];
		const rows = sql.exec<ContributionRow>(
			`SELECT * FROM contributions
			 WHERE kind = ? AND installation_id IN (SELECT value FROM json_each(?))`,
			kind,
			JSON.stringify(installs.map((i) => i.installation.id)),
		).toArray();
		const order = new Map(installs.map((i, n) => [i.installation.id, n]));
		return rows
			.filter((row) =>
				kind !== "provides" ||
				r.providers.get(row.key)?.installation.id === row.installation_id
			)
			.sort((a, b) =>
				(order.get(a.installation_id) ?? 0) -
					(order.get(b.installation_id) ?? 0) ||
				(a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
			);
	};

	// -------------------------------------------------------------------------
	// Writes
	// -------------------------------------------------------------------------

	const appendEvent = (
		type:
			| "extension.installed"
			| "extension.mode.changed"
			| "extension.uninstalled",
		by: string,
		row: Pick<InstallationRow, "id" | "ext_id" | "version" | "node_id">,
		mode: InstallationMode,
	): void => {
		modules.events.appendSync({
			type,
			actor: actorOf(by),
			node: row.node_id,
			data: {
				inst: row.id,
				ext: row.ext_id,
				version: row.version,
				node: row.node_id,
				mode,
			},
			idemKey: eventIdemKey("registry", `${row.id}:${clock.now()}`, type),
		});
	};

	const roleOf = (by: string, nodeId: string): number =>
		by === SYS_KERNEL
			? ROLE.owner
			: modules.tree.effectiveRoleSync([by], nodeId, clock.now());

	const requireRole = (by: string, nodeId: string, needed: number): void => {
		if (roleOf(by, nodeId) < needed) {
			throw denied(
				"role",
				needed >= ROLE.owner
					? "an Owner must approve this install"
					: "Maintainer required",
			);
		}
	};

	const insertInstallation = (row: InstallationRow, m: Manifest): void => {
		sql.exec(
			`INSERT INTO installations (id, ext_id, version, node_id, mode, storage_scope,
			   runtime_override, config_json, grants_json, background_role, locked, backfill,
			   pack, installed_by, installed_at, mode_changed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.id,
			row.ext_id,
			row.version,
			row.node_id,
			row.mode,
			row.storage_scope,
			row.runtime_override,
			row.config_json,
			row.grants_json,
			row.background_role,
			row.locked,
			row.backfill,
			row.pack,
			row.installed_by,
			row.installed_at,
			row.mode_changed_at,
		);
		for (const c of contributionRows(row.id, m)) {
			sql.exec(
				"INSERT INTO contributions (installation_id, kind, key, data_json) VALUES (?, ?, ?, ?)",
				c.installation_id,
				c.kind,
				c.key,
				c.data_json,
			);
		}
	};

	type Planned = InstallCandidate & {
		readonly config: Record<string, unknown>;
		readonly pack: string | null;
		readonly backfill: "none" | "30d" | "all";
	};

	/** The installations an install request creates: one, or a pack and its members. */
	const plan = (
		input: ReturnType<typeof InstallRequestSchema.parse>,
	): Planned[] => {
		const pkg = packageRow(input.extId, input.version);
		if (pkg === null) {
			throw notFound(`package ${input.extId}@${input.version}`);
		}
		const m = manifestOf(pkg);
		const bundled = isBundledRow(pkg);
		const top: Planned = {
			extId: m.id,
			version: m.version,
			manifest: m,
			bundled,
			mode: input.mode,
			locked: input.locked ?? false,
			backgroundRole: input.backgroundRole ?? 20,
			...(input.runtimeOverride === undefined
				? {}
				: { runtimeOverride: input.runtimeOverride }),
			config: { ...(m.config?.default ?? {}), ...(input.config ?? {}) },
			pack: m.kind === "pack" ? m.id : null,
			backfill: input.backfill ?? m.backfill,
		};
		if (m.kind !== "pack") return [top];
		if (input.locked) throw invalid("a pack cannot be locked; lock a member");
		const members = (m.members ?? []).map((member): Planned => {
			const row = packageRow(member.id, member.version);
			if (row === null) {
				throw invalid(
					`pack ${m.id}: member ${member.id}@${member.version} is not registered`,
				);
			}
			const mm = manifestOf(row);
			if (mm.kind === "pack") {
				throw invalid(`pack ${m.id}: member ${member.id} is a pack`);
			}
			return {
				extId: mm.id,
				version: mm.version,
				manifest: mm,
				bundled: isBundledRow(row),
				mode: member.mode ?? input.mode,
				locked: false,
				backgroundRole: member.backgroundRole ?? 20,
				config: {
					...(mm.config?.default ?? {}),
					...(member.config ?? {}),
				},
				pack: m.id,
				backfill: mm.backfill,
			};
		});
		return [top, ...members];
	};

	const install = (by: string, raw: unknown): InstallationDto => {
		const parsed = InstallRequestSchema.safeParse(raw);
		if (!parsed.success) {
			throw invalid("invalid install request", {
				issues: parsed.error.issues.map((i) => i.message),
			});
		}
		const input = parsed.data;
		return storage.transactionSync(() => {
			const node = modules.tree.nodeByPathSync(input.node);
			if (node === null) throw notFound(`node ${input.node}`);
			if (node.archived_at !== null) throw invalid("node is archived");
			const target = { nodeId: node.id, depth: node.depth };
			const planned = plan(input);
			requireRole(by, node.id, requiredRole(planned, target));
			for (const p of planned) {
				const below = repoConfig.reposBelowSync(p.extId, node.id);
				if (below.length > 0) {
					throw conflict(
						`${p.extId} is installed by repository config at ${
							below.slice(0, 5).join(", ")
						}; remove it there first`,
						{ rule: "repo-config" },
					);
				}
			}
			const now = clock.now();
			const created: InstallationRow[] = [];
			for (const p of planned) {
				const inForce = inForceSync(node.id);
				const here = sql.exec<{ ext_id: string; mode: InstallationMode }>(
					"SELECT ext_id, mode FROM installations WHERE node_id = ?",
					node.id,
				).toArray().map((r) => ({ extId: r.ext_id, mode: r.mode }));
				const issues = candidateIssues(p, target, inForce, here);
				if (issues.length > 0) throw toError(issues[0]);
				const row: InstallationRow = {
					id: toInstallationId(ids.ulid()),
					ext_id: p.extId,
					version: p.version,
					node_id: node.id,
					mode: p.mode,
					storage_scope: p.manifest.storage.scope,
					runtime_override: p.runtimeOverride ?? null,
					config_json: JSON.stringify(p.config),
					grants_json: JSON.stringify(p.manifest.permissions),
					background_role: p.backgroundRole,
					locked: p.locked ? 1 : 0,
					backfill: p.backfill,
					pack: p.pack,
					installed_by: by,
					installed_at: now,
					mode_changed_at: null,
				};
				insertInstallation(row, p.manifest);
				created.push(row);
			}
			for (const row of created) {
				appendEvent("extension.installed", by, row, row.mode);
			}
			modules.events.auditSync({
				principal: by,
				action: "extension.install",
				target: created[0].id,
				data: {
					ext: created[0].ext_id,
					version: created[0].version,
					node: node.path,
					mode: created[0].mode,
					members: created.slice(1).map((r) => r.ext_id),
				},
			});
			bumpExtVersion();
			repoConfig.bumpEpochSync(by, node.id);
			return dtoOf(created[0]);
		});
	};

	const requireInstallation = (id: string): InstallationRow => {
		const row = installationRow(id);
		if (row === null) throw notFound(`installation ${id}`);
		return row;
	};

	const installRoleNeeded = (row: InstallationRow): number => {
		const node = modules.tree.nodeSync(row.node_id);
		return requiredRole([{
			manifest: manifestFor(row.ext_id, row.version),
			locked: row.locked === 1,
			backgroundRole: row.background_role,
		}], { nodeId: row.node_id, depth: node?.depth ?? 0 });
	};

	const setMode = (
		by: string,
		id: string,
		mode: InstallationMode,
	): InstallationDto =>
		storage.transactionSync(() => {
			const row = requireInstallation(id);
			requireRole(
				by,
				row.node_id,
				row.source === "repo-config" ? ROLE.owner : installRoleNeeded(row),
			);
			if (row.source === "repo-config") {
				// An Owner's kill switch sticks: reconcile, a version change and
				// a revalidation never re-enable the extension at this repo.
				repoConfig.setOwnerDisabledSync(
					row.node_id,
					row.ext_id,
					mode === "disabled",
					by,
				);
			}
			if (row.mode === mode) return dtoOf(installationRow(id) ?? row);
			const m = manifestFor(row.ext_id, row.version);
			if (m.kind === "pack") {
				throw invalid("set the mode of a pack's members, not the pack");
			}
			if (mode === "shadow") {
				const shadow = shadowIssues(m);
				if (row.locked === 1) {
					throw invalid("a locked installation cannot run in shadow mode");
				}
				if (shadow.length > 0) throw toError(shadow[0]);
			}
			const monotonic = monotonicGateIssues(
				row.ext_id,
				m,
				mode,
				{ nodeId: row.node_id },
				inForceSync(row.node_id),
			);
			if (monotonic.length > 0) throw toError(monotonic[0]);
			const clash = sql.exec<{ id: string }>(
				"SELECT id FROM installations WHERE ext_id = ? AND node_id = ? AND mode = ? AND id <> ?",
				row.ext_id,
				row.node_id,
				mode,
				row.id,
			).toArray()[0];
			if (clash !== undefined) {
				throw conflict(
					`${row.ext_id} already has a ${mode} installation at this node (${clash.id})`,
				);
			}
			const now = clock.now();
			sql.exec(
				"UPDATE installations SET mode = ?, mode_changed_at = ? WHERE id = ?",
				mode,
				now,
				id,
			);
			const updated = { ...row, mode, mode_changed_at: now };
			appendEvent("extension.mode.changed", by, updated, mode);
			modules.events.auditSync({
				principal: by,
				action: "extension.mode",
				target: id,
				data: { from: row.mode, to: mode },
			});
			bumpExtVersion();
			repoConfig.bumpEpochSync(by, row.node_id);
			return dtoOf(installationRow(id) ?? updated);
		});

	/** UPDATE one installation's mode with its event (inside a transaction). */
	const writeMode = (
		by: string,
		row: InstallationRow,
		mode: InstallationMode,
	): InstallationRow => {
		const now = clock.now();
		sql.exec(
			"UPDATE installations SET mode = ?, mode_changed_at = ? WHERE id = ?",
			mode,
			now,
			row.id,
		);
		const updated = { ...row, mode, mode_changed_at: now };
		appendEvent("extension.mode.changed", by, updated, mode);
		return updated;
	};

	/**
	 * Swaps the provider of `iface` at a node (replace.ts): disables the
	 * node's own provider, then inherits an ancestor's, re-enables a disabled
	 * installation of the target here, or installs it here (outside any
	 * pack). One transaction with its events, one `extension.replace` audit
	 * row and one `ext_version` bump. The role is the higher of installing
	 * the target and changing the current provider's mode (Owner for
	 * `checks@1`, `review@1` and `queue@1`).
	 */
	const replaceProvider = (
		by: string,
		raw: unknown,
	): ReplaceProviderResponse => {
		const parsed = ReplaceProviderRequestSchema.safeParse(raw);
		if (!parsed.success) {
			throw invalid("invalid replace request", {
				issues: parsed.error.issues.map((i) =>
					`${i.path.join(".") || "(root)"}: ${i.message}`
				),
			});
		}
		const input: ReplaceProviderRequest = parsed.data;
		const dryRun = input.dryRun === true;
		const run = (): ReplaceProviderResponse => {
			const node = modules.tree.nodeByPathSync(input.node);
			if (node === null) throw notFound(`node ${input.node}`);
			if (node.archived_at !== null) throw invalid("node is archived");
			const pkg = packageRow(input.extId, input.version);
			if (pkg === null) {
				throw notFound(`package ${input.extId}@${input.version}`);
			}
			const m = manifestOf(pkg);
			const target = { nodeId: node.id, depth: node.depth };
			const inForce = inForceSync(node.id);
			const here: HereRow[] = sql.exec<InstallationRow>(
				"SELECT * FROM installations WHERE node_id = ? AND ext_id = ?",
				node.id,
				input.extId,
			).toArray().map((row) => ({ installation: dtoOf(row), mode: row.mode }));
			const decided = planReplacement(
				{
					nodeId: node.id,
					iface: input.iface,
					extId: input.extId,
					version: input.version,
					manifest: m,
				},
				inForce,
				here,
			);
			if (!decided.ok) throw toError(decided.issue);
			const plan = decided.plan;
			const backgroundRole = input.backgroundRole ?? 20;
			const candidate: Planned = {
				extId: m.id,
				version: m.version,
				manifest: m,
				bundled: isBundledRow(pkg),
				mode: "enforce",
				locked: false,
				backgroundRole,
				config: { ...(m.config?.default ?? {}), ...(input.config ?? {}) },
				pack: null,
				backfill: m.backfill,
			};
			const needed = Math.max(
				requiredRole([candidate], target),
				plan.kind === "swap" && plan.disable !== null
					? installRoleNeeded(
						requireInstallation(plan.disable.installation.id),
					)
					: ROLE.maintainer,
			);
			// The sheet (a dry run) answers `needsOwner` instead of refusing.
			if (!dryRun) requireRole(by, node.id, needed);
			const answer = (
				from: InstallationDto | null,
				provider: InstallationDto | null,
				steps: readonly ReplaceStep[],
			): ReplaceProviderResponse => ({
				iface: input.iface,
				node: node.path,
				dryRun,
				from,
				provider,
				steps,
				lines: permissionLines(m),
				needsOwner: needed >= ROLE.owner,
			});
			if (plan.kind === "noop") {
				return answer(plan.current.installation, plan.current.installation, []);
			}
			const steps: ReplaceStep[] = [];
			const disabledId = plan.disable?.installation.id;
			if (plan.disable !== null) {
				steps.push({
					kind: "disable",
					installation: plan.disable.installation,
				});
			}
			if (plan.then.kind === "install") {
				const after = inForce.filter((i) => i.installation.id !== disabledId);
				const installedHere = sql.exec<
					{ id: string; ext_id: string; mode: InstallationMode }
				>(
					"SELECT id, ext_id, mode FROM installations WHERE node_id = ?",
					node.id,
				).toArray()
					.filter((r) => r.id !== disabledId)
					.map((r) => ({ extId: r.ext_id, mode: r.mode }));
				const issues = candidateIssues(
					candidate,
					target,
					after,
					installedHere,
				);
				if (issues.length > 0) throw toError(issues[0]);
				steps.push({
					kind: "install",
					extId: m.id,
					version: m.version,
					nodeId: node.id,
				});
			} else if (plan.then.kind === "enable") {
				steps.push({ kind: "enable", installation: plan.then.installation });
			} else {
				steps.push({
					kind: "inherit",
					installation: plan.then.provider.installation,
				});
			}
			const from = plan.current?.installation ?? null;
			if (
				plan.disable !== null &&
				requireInstallation(plan.disable.installation.id).source ===
					"repo-config"
			) {
				throw conflict(
					`${plan.disable.installation.extId} is installed by repository config; change it there`,
					{ rule: "repo-config" },
				);
			}
			if (plan.then.kind === "install") {
				const below = repoConfig.reposBelowSync(m.id, node.id);
				if (below.length > 0) {
					throw conflict(
						`${m.id} is installed by repository config at ${
							below.slice(0, 5).join(", ")
						}; remove it there first`,
						{ rule: "repo-config" },
					);
				}
			}
			if (dryRun) {
				return answer(
					from,
					plan.then.kind === "inherit"
						? plan.then.provider.installation
						: plan.then.kind === "enable"
						? plan.then.installation
						: null,
					steps,
				);
			}
			if (plan.disable !== null) {
				writeMode(
					by,
					requireInstallation(plan.disable.installation.id),
					"disabled",
				);
			}
			if (plan.then.kind === "enable") {
				writeMode(
					by,
					requireInstallation(plan.then.installation.id),
					"enforce",
				);
			} else if (plan.then.kind === "install") {
				const row: InstallationRow = {
					id: toInstallationId(ids.ulid()),
					ext_id: m.id,
					version: m.version,
					node_id: node.id,
					mode: "enforce",
					storage_scope: m.storage.scope,
					runtime_override: null,
					config_json: JSON.stringify(candidate.config),
					grants_json: JSON.stringify(m.permissions),
					background_role: backgroundRole,
					locked: 0,
					backfill: m.backfill,
					pack: null,
					installed_by: by,
					installed_at: clock.now(),
					mode_changed_at: null,
				};
				insertInstallation(row, m);
				appendEvent("extension.installed", by, row, "enforce");
			}
			const provider = providerOf(input.iface, inForceSync(node.id));
			if (provider === null || provider.installation.extId !== m.id) {
				throw internalError(
					`replace: ${input.iface} is not provided by ${m.id} afterwards`,
				);
			}
			modules.events.auditSync({
				principal: by,
				action: "extension.replace",
				target: provider.installation.id,
				data: {
					iface: input.iface,
					node: node.path,
					from: from?.id ?? null,
					fromExt: from?.extId ?? null,
					to: provider.installation.id,
					toExt: m.id,
					steps: steps.map((s) => s.kind),
				},
			});
			bumpExtVersion();
			repoConfig.bumpEpochSync(by, node.id);
			return answer(from, provider.installation, steps);
		};
		return dryRun ? run() : storage.transactionSync(run);
	};

	/**
	 * Promote: the shadow installation becomes the enforce one and the
	 * enforce installation of the same extension at the same node, if any,
	 * is disabled, in one transaction (both `extension.mode.changed`, one
	 * audit row, one `ext_version` bump). The caller needs the role that
	 * installing either would need.
	 */
	const promote = (by: string, id: string): InstallationDto =>
		storage.transactionSync(() => {
			const row = requireInstallation(id);
			requireRole(by, row.node_id, installRoleNeeded(row));
			if (row.mode !== "shadow") {
				throw invalid("only a shadow installation can be promoted");
			}
			if (row.source === "repo-config") {
				throw conflict(
					`${row.ext_id} is installed by repository config; change its mode there`,
					{ rule: "repo-config" },
				);
			}
			const byMode = (mode: InstallationMode) =>
				sql.exec<InstallationRow>(
					"SELECT * FROM installations WHERE ext_id = ? AND node_id = ? AND mode = ?",
					row.ext_id,
					row.node_id,
					mode,
				).toArray()[0];
			// One enforce provider per interface per node: a shadow copy
			// may sit beside another extension's provider; promoting it may not.
			const node = modules.tree.nodeSync(row.node_id);
			const providers = sameNodeProviderIssues(
				{
					extId: row.ext_id,
					manifest: manifestFor(row.ext_id, row.version),
					mode: "enforce",
				},
				{ nodeId: row.node_id, depth: node?.depth ?? 0 },
				inForceSync(row.node_id),
			);
			if (providers.length > 0) {
				throw conflict(
					`${providers[0].text}; replace that provider instead of promoting`,
					{ rule: providers[0].rule },
				);
			}
			const live = byMode("enforce");
			if (live !== undefined) {
				requireRole(by, live.node_id, installRoleNeeded(live));
				const parked = byMode("disabled");
				if (parked !== undefined) {
					throw conflict(
						`${row.ext_id} already has a disabled installation at this node (${parked.id}); uninstall it before promoting`,
					);
				}
			}
			const now = clock.now();
			if (live !== undefined) {
				sql.exec(
					"UPDATE installations SET mode = 'disabled', mode_changed_at = ? WHERE id = ?",
					now,
					live.id,
				);
				appendEvent(
					"extension.mode.changed",
					by,
					live,
					"disabled",
				);
			}
			sql.exec(
				"UPDATE installations SET mode = 'enforce', mode_changed_at = ? WHERE id = ?",
				now,
				row.id,
			);
			const promoted = {
				...row,
				mode: "enforce" as const,
				mode_changed_at: now,
			};
			appendEvent("extension.mode.changed", by, promoted, "enforce");
			modules.events.auditSync({
				principal: by,
				action: "extension.promote",
				target: row.id,
				data: {
					ext: row.ext_id,
					version: row.version,
					...(live === undefined
						? {}
						: { disabled: live.id, disabledVersion: live.version }),
				},
			});
			bumpExtVersion();
			repoConfig.bumpEpochSync(by, row.node_id);
			return dtoOf(promoted);
		});

	/**
	 * Starts a gate replay: checks that the installation has a
	 * `ref.advance` gate, is not disabled, that `n` is 1–50 and that the repo
	 * is inside its subtree (K12), and mints the replay id. The replay itself
	 * (inputs rebuilt from the repo's last advances, the gate called with
	 * `advisory`, results in the repo's `gate_replays`) is run by the
	 * installations API, outside ForgeDO.
	 */
	const replayGate = (
		installationId: string,
		n: number,
		repoId: string,
	): { replayId: string } => {
		const row = requireInstallation(installationId);
		const m = manifestFor(row.ext_id, row.version);
		if (!(m.gates ?? []).some((g) => g.point === "ref.advance")) {
			throw invalid(`${row.ext_id} declares no ref.advance gate`);
		}
		if (row.mode === "disabled") {
			throw invalid("a disabled installation is not replayed");
		}
		if (!Number.isInteger(n) || n < 1 || n > GATE_REPLAY_MAX) {
			throw invalid(`a replay covers 1–${GATE_REPLAY_MAX} advances`);
		}
		const repo = modules.tree.nodeSync(repoId);
		if (repo === null || repo.kind !== "repo") {
			throw notFound(`repo ${repoId}`);
		}
		const home = nodePathOf(row.node_id);
		if (!isWithinPath(home, repo.path)) {
			throw denied("scope", "the repo is outside the installation subtree");
		}
		return { replayId: `gr_${ids.ulid()}` };
	};

	const uninstall = (by: string, id: string): InstallationDto[] =>
		storage.transactionSync(() => {
			const row = requireInstallation(id);
			requireRole(by, row.node_id, installRoleNeeded(row));
			const m = manifestFor(row.ext_id, row.version);
			const rows = m.kind === "pack"
				? [
					row,
					...sql.exec<InstallationRow>(
						"SELECT * FROM installations WHERE node_id = ? AND pack = ? AND id <> ?",
						row.node_id,
						row.ext_id,
						row.id,
					).toArray(),
				]
				: [row];
			for (const r of rows) {
				sql.exec("DELETE FROM contributions WHERE installation_id = ?", r.id);
				sql.exec("DELETE FROM installations WHERE id = ?", r.id);
				appendEvent("extension.uninstalled", by, r, r.mode);
			}
			modules.events.auditSync({
				principal: by,
				action: "extension.uninstall",
				target: id,
				data: { ext: row.ext_id, removed: rows.map((r) => r.id) },
			});
			bumpExtVersion();
			repoConfig.bumpEpochSync(by, row.node_id);
			return rows.map(dtoOf);
		});

	const publish = (
		by: string,
		manifestInput: unknown,
		artifact: {
			sha256: string;
			r2Prefix: string | null;
			imports?: string[];
			configCue?: string;
		},
	): PackageDto => {
		const parsed = parseManifest(manifestInput);
		if (!parsed.ok) {
			throw invalid("invalid manifest", { issues: parsed.errors });
		}
		const m = parsed.manifest;
		const policy = manifestPolicyIssuesFor(m);
		if (policy.length > 0) {
			throw invalid("manifest policy", { issues: policy });
		}
		if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
			throw invalid("sha256 must be 64 lowercase hex chars");
		}
		if (artifact.r2Prefix === null && m.kind !== "pack") {
			throw invalid("a published package needs its R2 bundle");
		}
		if (m.runtime === "wasm" && artifact.imports === undefined) {
			throw invalid("a wasm package records its component imports");
		}
		if ((m.config?.cue !== undefined) !== (artifact.configCue !== undefined)) {
			throw invalid(
				m.config?.cue !== undefined
					? "the manifest declares config.cue: publish its text"
					: "config.cue text given but the manifest declares no config.cue",
			);
		}
		if (artifact.configCue !== undefined) {
			const issue = settingsCueIssue(artifact.configCue, {
				repoPolicy: m.config?.repoPolicy ?? [],
			});
			if (issue !== null) throw invalid(issue);
		}
		return storage.transactionSync(() => {
			if (packageRow(m.id, m.version) !== null) {
				throw conflict(`${m.id}@${m.version} is already published`);
			}
			// Repository config names each extension's schema package by its
			// sid; two ids sharing one (`acme.no-secrets`, `acme.no.secrets`)
			// would collide in every generated schema.
			const sid = cueSid(m.id);
			const clash = sql.exec<{ ext_id: string }>(
				"SELECT DISTINCT ext_id FROM packages WHERE ext_id <> ?",
				m.id,
			).toArray().find((r) => cueSid(r.ext_id) === sid);
			if (clash !== undefined) {
				throw conflict(
					`${m.id} and ${clash.ext_id} would share the CUE schema name ${sid}; publish under another id`,
				);
			}
			const row: PackageRow = {
				ext_id: m.id,
				version: m.version,
				runtime: m.runtime,
				manifest_json: JSON.stringify(m),
				sha256: artifact.sha256,
				r2_prefix: artifact.r2Prefix,
				imports_json: artifact.imports === undefined
					? null
					: JSON.stringify(artifact.imports),
				published_by: by,
				published_at: clock.now(),
				config_cue: artifact.configCue ?? null,
			};
			insertPackage(row);
			modules.events.auditSync({
				principal: by,
				action: "extension.publish",
				target: `${m.id}@${m.version}`,
				data: { sha256: artifact.sha256 },
			});
			return packageDto(row);
		});
	};

	/** Publish-time rules: the third-party policy; no `tartan.*`, no `builtin`. */
	const manifestPolicyIssuesFor = (m: Manifest): string[] =>
		manifestPolicyIssues(m, { bundled: false });

	const insertPackage = (row: PackageRow): void => {
		sql.exec(
			`INSERT INTO packages (ext_id, version, runtime, manifest_json, sha256, r2_prefix,
			   imports_json, published_by, published_at, config_cue, config_checked)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (ext_id, version) DO UPDATE SET runtime = excluded.runtime,
			   manifest_json = excluded.manifest_json, sha256 = excluded.sha256,
			   r2_prefix = excluded.r2_prefix, imports_json = excluded.imports_json,
			   published_by = excluded.published_by, published_at = excluded.published_at,
			   config_cue = excluded.config_cue, config_checked = excluded.config_checked`,
			row.ext_id,
			row.version,
			row.runtime,
			row.manifest_json,
			row.sha256,
			row.r2_prefix,
			row.imports_json,
			row.published_by,
			row.published_at,
			row.config_cue ?? null,
			row.config_checked ?? null,
		);
		manifestCache.delete(`${row.ext_id}@${row.version}`);
	};

	/**
	 * A bundled package whose content changed under the same version (a new
	 * Worker deploy): its installations' `contributions` rows follow the new
	 * manifest, so `contributions()` and the manifest-based resolution agree.
	 */
	const refreshContributions = (m: Manifest): void => {
		const rows = sql.exec<{ id: string }>(
			"SELECT id FROM installations WHERE ext_id = ? AND version = ?",
			m.id,
			m.version,
		).toArray();
		for (const { id } of rows) {
			sql.exec("DELETE FROM contributions WHERE installation_id = ?", id);
			for (const c of contributionRows(id, m)) {
				sql.exec(
					"INSERT INTO contributions (installation_id, kind, key, data_json) VALUES (?, ?, ?, ?)",
					c.installation_id,
					c.kind,
					c.key,
					c.data_json,
				);
			}
		}
	};

	/**
	 * A bundled package's installations hold the permissions of the bundled
	 * manifest (an install grants exactly the manifest's, and bundled code
	 * ships with the forge's own deploy). When a deploy changes the bundled
	 * manifest under the same version, the grants follow it, wider or
	 * narrower (audited `extension.grants`, reason `bundled-manifest`):
	 * without this, a Weave installed before a deploy changed what it asks
	 * for kept the old grants and was refused a call it needed on every tick.
	 */
	const refreshBundledGrants = (m: Manifest): number => {
		const grants = JSON.stringify(m.permissions);
		const stale = sql.exec<{ id: string }>(
			`SELECT id FROM installations WHERE ext_id = ? AND version = ?
			 AND grants_json <> ?`,
			m.id,
			m.version,
			grants,
		).toArray();
		if (stale.length === 0) return 0;
		sql.exec(
			`UPDATE installations SET grants_json = ? WHERE ext_id = ? AND version = ?`,
			grants,
			m.id,
			m.version,
		);
		for (const { id } of stale) {
			modules.events.auditSync({
				principal: SYS_KERNEL,
				action: "extension.grants",
				target: id,
				data: { ext: m.id, version: m.version, reason: "bundled-manifest" },
			});
		}
		return stale.length;
	};

	/**
	 * Drops what a retired builtin left behind (`RETIRED_BUILTINS`, not in
	 * this deploy's bundle): every installation of it (pack members
	 * included), its contributions and its bundled package rows, with one
	 * `extension.uninstalled` event per installation and an audit row.
	 */
	const retireBuiltinsSync = (bundled: ReadonlySet<string>): number => {
		let retired = 0;
		for (const extId of RETIRED_BUILTINS) {
			if (bundled.has(extId)) continue;
			const rows = sql.exec<InstallationRow>(
				"SELECT * FROM installations WHERE ext_id = ?",
				extId,
			).toArray();
			for (const r of rows) {
				sql.exec(
					"DELETE FROM repo_config_overlays WHERE installation_id = ?",
					r.id,
				);
				sql.exec("DELETE FROM contributions WHERE installation_id = ?", r.id);
				sql.exec("DELETE FROM installations WHERE id = ?", r.id);
				appendEvent("extension.uninstalled", SYS_KERNEL, r, r.mode);
			}
			const versions = sql.exec<{ version: string }>(
				`DELETE FROM packages WHERE ext_id = ? AND published_by = ? AND r2_prefix IS NULL
				 RETURNING version`,
				extId,
				SYS_KERNEL,
			).toArray().map((v) => v.version);
			for (const version of versions) {
				manifestCache.delete(`${extId}@${version}`);
			}
			if (rows.length === 0 && versions.length === 0) continue;
			modules.events.auditSync({
				principal: SYS_KERNEL,
				action: "extension.retired",
				target: extId,
				data: { removed: rows.map((r) => r.id), versions },
			});
			retired += 1;
		}
		return retired;
	};

	/**
	 * Boot-time registration of bundled packages (`published_by = sys_kernel`,
	 * `r2_prefix NULL`). Idempotent: rows are rewritten only when the bundled
	 * content hash changed. A published (non-bundled) row of the same id and
	 * version is never overwritten. Retired builtins are cleaned up.
	 */
	const registerBuiltinsSync = (pkgs: readonly BuiltinPackage[]): number => {
		let changed = 0;
		storage.transactionSync(() => {
			changed += retireBuiltinsSync(
				new Set(pkgs.map((pkg) => pkg.manifest.id)),
			);
			for (const pkg of pkgs) {
				const m = pkg.manifest;
				const sha = builtinSha256(pkg);
				const existing = packageRow(m.id, m.version);
				if (existing !== null && !isBundledRow(existing)) {
					throw conflict(`${m.id}@${m.version} is published, not bundled`);
				}
				if (existing?.sha256 === sha) {
					// Content unchanged; installations made before an earlier
					// deploy changed it may still hold the old grants.
					if (refreshBundledGrants(m) > 0) changed += 1;
					continue;
				}
				insertPackage({
					ext_id: m.id,
					version: m.version,
					runtime: m.runtime,
					manifest_json: JSON.stringify(m),
					sha256: sha,
					r2_prefix: null,
					imports_json: null,
					published_by: SYS_KERNEL,
					published_at: clock.now(),
					// A bundled `config.cue` is checked against the real CLI in the
					// repo's own tests, so it joins schemas at once.
					config_checked: pkg.settingsCue === undefined ? null : "builtin",
				});
				if (existing !== null) {
					refreshContributions(m);
					repoConfig.onPackageChangedSync(m, sha);
				}
				refreshBundledGrants(m);
				if (pkg.settingsCue !== undefined && existing !== null) {
					// A new bundled schema: configured repos re-evaluate (stale).
					repoConfig.bumpEpochSync(SYS_KERNEL, null);
				}
				changed += 1;
			}
			if (changed > 0) bumpExtVersion();
			repoConfig.onEvaluatorSync();
		});
		return changed;
	};

	const packages = (extId?: string): PackageDto[] =>
		(extId === undefined
			? sql.exec<PackageRow>(
				"SELECT * FROM packages ORDER BY ext_id, published_at",
			)
			: sql.exec<PackageRow>(
				"SELECT * FROM packages WHERE ext_id = ? ORDER BY published_at",
				extId,
			)).toArray().map(packageDto);

	const protocolCards = (
		nodeId: string,
	): { installation: string; ext: string; md: string }[] => {
		const bundled = new Map(builtinList().map((p) => [p.manifest.id, p]));
		return resolve(inForceSync(nodeId)).effective.flatMap((i) => {
			if (i.manifest.contributes?.protocol === undefined) return [];
			const md = bundled.get(i.installation.extId)?.protocol;
			return md === undefined
				? []
				: [{ installation: i.installation.id, ext: i.installation.extId, md }];
		});
	};

	const provider = (iface: string, nodeId: string) =>
		resolve(inForceSync(nodeId)).providers.get(iface) ?? null;

	// -------------------------------------------------------------------------
	// Repository config (WP23)
	// -------------------------------------------------------------------------

	const deleteInstallation = (id: string): void => {
		sql.exec("DELETE FROM repo_config_overlays WHERE installation_id = ?", id);
		sql.exec("DELETE FROM contributions WHERE installation_id = ?", id);
		sql.exec("DELETE FROM installations WHERE id = ?", id);
	};

	const settingsCueOf = (extId: string, version: string): string | null => {
		const row = packageRow(extId, version);
		if (row === null) return null;
		if (isBundledRow(row)) {
			const pkg = builtinList().find((p) =>
				p.manifest.id === extId && p.manifest.version === version
			);
			return pkg?.settingsCue ?? null;
		}
		return row.config_cue ?? null;
	};

	let portsCache: RepoConfigPorts | null = null;
	const repoConfig = createRegistryRepoConfig({
		sql,
		storage,
		clock,
		ulid: () => ids.ulid(),
		tree: modules.tree,
		events: modules.events,
		packageRow,
		manifestFor,
		insertInstallation,
		deleteInstallation,
		bumpExtVersion,
		roleOf,
		settingsCueOf,
		schedule: (at) => deps.timers.schedule("repoconfig", at),
		ports: () =>
			portsCache ??= (options.repoConfigPorts ?? envRepoConfigPorts)(deps),
		switchOn: () => deps.env?.TARTAN_REPO_CONFIG === "on",
	});

	const requireSessionOwner = (by: string): void => {
		if (principalKind(by) !== "user") {
			throw denied("role", "only an Owner (a person) can do this");
		}
	};

	const internal: RegistryInternal = {
		inForceSync,
		extVersionSync,
		repoConfigEpochSync: () => repoConfig.epochSync(),
		revalidateRepoConfigSync: (by, scopeNodeId) => {
			const removed = repoConfig.revalidateSync(by, scopeNodeId);
			repoConfig.bumpEpochSync(by, scopeNodeId);
			return removed;
		},
	};

	const facade: RegistryFacade = {
		installed: (nodeId) => Promise.resolve().then(() => inForceSync(nodeId)),
		replaceProvider: (by, input) =>
			Promise.resolve().then(() => replaceProvider(by, input)),
		publish: (by, manifest, artifact) =>
			Promise.resolve().then(() => publish(by, manifest, artifact)),
		packages: (extId) => Promise.resolve().then(() => packages(extId)),
		install: (by, input) => Promise.resolve().then(() => install(by, input)),
		setMode: (by, id, mode) =>
			Promise.resolve().then(() => setMode(by, id, mode)),
		promote: (by, id) => Promise.resolve().then(() => promote(by, id)),
		uninstall: (by, id) => Promise.resolve().then(() => uninstall(by, id)),
		installation: (id) =>
			Promise.resolve().then(() => {
				const row = installationRow(id);
				return row === null ? null : dtoOf(row);
			}),
		inForce: (nodeId) =>
			Promise.resolve().then(() => acting(inForceSync(nodeId))),
		provider: (iface, nodeId) =>
			Promise.resolve().then(() => provider(iface, nodeId)),
		contributions: (kind, nodeId) =>
			Promise.resolve().then(() => contributionsSync(kind, nodeId)),
		replayGate: (installationId, n, repoId) =>
			Promise.resolve().then(() => replayGate(installationId, n, repoId)),
		protocolCards: (nodeId) =>
			Promise.resolve().then(() => protocolCards(nodeId)),
		registerBuiltins: (manifests) =>
			Promise.resolve().then(() => {
				const known = new Map(builtinList().map((p) => [p.manifest.id, p]));
				const pkgs = manifests.map((m) => {
					const pkg = known.get(m.id);
					if (pkg === undefined || pkg.manifest.version !== m.version) {
						throw invalid(`${m.id}@${m.version} is not bundled in this Worker`);
					}
					return pkg;
				});
				registerBuiltinsSync(pkgs);
			}),
		extVersion: () => Promise.resolve().then(extVersionSync),
		repoConfigSchema: (repoNodeId, read) =>
			Promise.resolve().then(() => {
				const dto = repoConfig.schemaDtoSync(repoNodeId);
				if (read?.watch === true) repoConfig.watchSync(repoNodeId);
				// Packages in force that never passed a self-check (installed
				// before the switch went on, or a manual install) start one; they
				// join the schema once it passes.
				if (
					deps.env.TARTAN_REPO_CONFIG === "on" &&
					repoConfig.uncheckedSync(repoNodeId).length > 0
				) {
					const ports =
						(portsCache ??= (options.repoConfigPorts ?? envRepoConfigPorts)(
							deps,
						));
					ports.waitUntil(
						repoConfig.ensureChecks(repoNodeId).catch((error) =>
							ports.log("self-check submission failed", {
								error: error instanceof Error
									? error.message.slice(0, 200)
									: "",
							})
						),
					);
				}
				return dto;
			}),
		checkRepoConfig: (repoNodeId, resolved) =>
			Promise.resolve().then(() => repoConfig.checkSync(repoNodeId, resolved)),
		applyRepoConfig: (repoNodeId, input) =>
			Promise.resolve().then(() => repoConfig.applySync(repoNodeId, input)),
		repoConfigState: (repoNodeId) =>
			Promise.resolve().then(() => repoConfig.stateSync(repoNodeId)),
		repoConfigEffective: (repoNodeId) =>
			Promise.resolve().then(() => ({
				effective: repoConfig.effectiveSync(
					repoNodeId,
					inForceSync(repoNodeId),
				),
				approvals: repoConfig.approvalsSync(repoNodeId),
				epoch: repoConfig.epochSync(),
			})),
		landContext: (repoNodeId) =>
			Promise.resolve().then(() => ({
				reviewProvider: provider("review@1", repoNodeId)?.installation.id ??
					null,
				...((state) => ({
					configHold: state?.holdReason ?? null,
					...(state?.holdReason ? { configHoldId: state.holdId ?? 1 } : {}),
				}))(repoConfig.stateSync(repoNodeId)),
			})),
		requestConfigApproval: (by, nodeId, extId, input) =>
			Promise.resolve().then(() => {
				requireSessionOwner(by);
				const parsed = ConfigApprovalRequestSchema.safeParse(input);
				if (!parsed.success) throw invalid("invalid approval request");
				return repoConfig.requestApproval(by, nodeId, extId, parsed.data);
			}),
		selfCheckResult: (requestId, envelope) =>
			Promise.resolve().then(() =>
				repoConfig.selfCheckResult(requestId, envelope)
			),
		revokeConfigApproval: (by, nodeId, extId) =>
			Promise.resolve().then(() => {
				requireSessionOwner(by);
				repoConfig.revokeApproval(by, nodeId, extId);
			}),
		configApprovals: (nodeId) =>
			Promise.resolve().then(() => ({
				approvals: repoConfig.approvalsSync(nodeId),
				requests: repoConfig.requestsSync(nodeId),
			})),
		setRepoOverrides: (by, installationId, on) =>
			Promise.resolve().then(() => {
				requireSessionOwner(by);
				return dtoOf(repoConfig.setRepoOverrides(by, installationId, on));
			}),
		installationAt: (installationId, repoNodeId) =>
			Promise.resolve().then(() => {
				const row = installationRow(installationId);
				if (row === null) return null;
				const dto = dtoOf(row);
				const overlay = repoConfig.overlaySync(installationId, repoNodeId);
				if (overlay === null) return dto;
				const base = typeof dto.config === "object" && dto.config !== null
					? dto.config as Record<string, unknown>
					: {};
				return { ...dto, config: { ...base, ...overlay } };
			}),
	};

	const onTimer: TimerHandler = async (key) => {
		if (key === "repoconfig") {
			await repoConfig.drainDirty();
			return;
		}
		throw invalid(`unknown registry timer: ${key}`);
	};

	return {
		facade,
		internal,
		onTimer,
		registerBuiltinsSync,
		repoConfig,
	};
};

/** The module factory; `registryModule` binds the Worker's bundled packages. */
export const createRegistryModule = (
	options: RegistryOptions = {},
): DoModule<RegistryFacade, RegistryInternal, Env, ForgeInternals> => ({
	name: "registry",
	range: MIGRATION_RANGES.forge.registry,
	migrations: REGISTRY_MIGRATIONS,
	create: (deps) => {
		const registry = createRegistry(deps, options);
		const bundled = options.builtins?.() ?? [];
		if (bundled.length > 0) registry.registerBuiltinsSync(bundled);
		return {
			facade: registry.facade,
			internal: registry.internal,
			onTimer: registry.onTimer,
		};
	},
});

export const registryModule = createRegistryModule({
	builtins: () => bundledBuiltins.all(),
});
