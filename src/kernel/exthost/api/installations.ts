// `/-/api/installations[/*]`:
//
//   GET    /-/api/installations?node=<path>   installations in force at a node (Reporter);
//                                             without `node`, at the caller's start node
//                                             (`startNode`: never a node that does not exist)
//   GET    /-/api/installations/<id>          one installation (Reporter at its node)
//   POST   /-/api/installations/sheet         the install sheet for an `InstallRequest` (Maintainer)
//   POST   /-/api/installations               install (Maintainer; Owner for some interfaces)
//   POST   /-/api/installations/replace       swap the provider of one interface at a
//                                             node (`{node, iface, extId, version,
//                                             dryRun?}`; Owner for checks/review/queue)
//   PUT    /-/api/installations/<id>/mode     `{mode}` (same role as installing it)
//   DELETE /-/api/installations/<id>          uninstall (a pack removes its members)
//   GET    /-/api/installations/<id>/console?since=&limit=&repo=
//   GET    /-/api/installations/<id>/dead-letters?limit=&repo=
//                                             an ExtensionDO's console ring and
//                                             dead letters (Maintainer)
//
// Uninstalling also deletes the removed installations' ExtensionDO data: after
// the registry commits, each installation it removed (its own answer, so a
// pack's disabled members are included) gets `deleteData()` on its node scope,
// or on every repo scope under its node (which aborts the runtime, drops
// storage, timers and alarm). Best effort, after the response when the Worker
// can defer it; failures are logged. A host the cleanup misses stops its own
// timers once the registry no longer knows its installation (host.ts).
//
// The admin reads name the scope: a node-scoped installation has one, a
// repo-scoped one needs `?repo=<path or id>` of a repo inside the
// installation's node (else 404, as for any node outside it, K12).
//
// Authorization uses WP3's `authorize` with the caller's credential bounds:
// `install` (Maintainer, `admin` token scope) or `install-privileged`
// (Owner) when `needsOwnerApproval` holds for the package and the request
// (land, `land.report`, checks/review/queue providers, a background role
// above Reporter, `locked`, a root node). The registry re-checks the role
// from grants inside its transaction (defence in depth).
//
// Shadow mode:
//
//   POST   /-/api/installations/<id>/promote  shadow → enforce, the old enforce
//                                             copy → disabled (same role as installing)
//   POST   /-/api/installations/<id>/replay   `{repo, n?}`: replay the
//                                             `ref.advance` gate over the repo's last
//                                             n ≤ 50 advances (Maintainer); answers
//                                             the finished replay with its summary
//   GET    /-/api/installations/<id>/replay/<replayId>?repo=<path or id>
//
//   GET    /-/api/installations/<id>/breaker?repo=   the circuit breaker
//                                             (Maintainer)
//   POST   /-/api/installations/<id>/breaker?repo=   reset it (Owner, a person)
//
// Not in this slice: compare (501).

import { z } from "zod";
import {
	denied,
	type ExtScope,
	fromRpcError,
	type InstallationDto,
	type InstallRequest,
	InstallRequestSchema,
	invalid,
	isIdOf,
	isWithinPath,
	type Manifest,
	ModeChangeRequestSchema,
	type NodeDto,
	NodePathSchema,
	notFound,
	notImplemented,
	type PackageDto,
	type PermissionSheet,
	type ReplaceProviderRequest,
	ReplaceProviderRequestSchema,
	ROLE,
	ULID_RE,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { GATE_REPLAY_MAX } from "../registry/module.ts";
import { resolve } from "../registry/resolve.ts";
import {
	candidateIssues,
	type InstallCandidate,
	permissionLines,
	requiredRole,
	requiresWarnings,
} from "../registry/rules.ts";
import type { ApiDeps } from "./deps.ts";
import { guard, json, readJson, requireAuth } from "./http.ts";
import { replayResponse, runGateReplay } from "./replay.ts";

const nodeByPath = async (deps: ApiDeps, path: string): Promise<NodeDto> => {
	if (!NodePathSchema.safeParse(path).success) {
		throw invalid("node is a node path, for example acme/platform");
	}
	const resolved = await deps.tree().resolvePath(path);
	if (resolved === null || resolved.rest !== "" || resolved.redirectTo) {
		throw notFound(`no node at ${path}`);
	}
	return resolved.node;
};

/** `childrenAccess` pages plus `authorize` calls the start-node search makes at most. */
export const START_NODE_SEARCH_MAX = 32;

/**
 * Where "in force at" starts when the caller names no node (the Extensions
 * page's first answer, which must never point at a node that does not
 * exist): a token's own node; else, breadth first from the roots, the first
 * node the caller holds a grant on and may read (an invited user has a
 * grant but no namespace of their own); else the first root the caller may
 * read (public or internal). Null when there is none within the budget.
 */
const startNode = async (
	deps: ApiDeps,
	auth: AuthContext,
): Promise<NodeDto | null> => {
	let budget = START_NODE_SEARCH_MAX;
	const readable = async (node: NodeDto): Promise<boolean> => {
		if (budget-- <= 0) return false;
		try {
			await deps.authorize(auth, { node }, "read");
			return true;
		} catch (error) {
			// A refusal moves on; a failure is the caller's, not "nothing here".
			const code = fromRpcError(error).code;
			if (
				code === "denied" || code === "unauthenticated" || code === "not_found"
			) return false;
			throw error;
		}
	};
	if (auth.nodeId !== null) {
		const own = await deps.tree().node(auth.nodeId);
		if (own !== null && await readable(own)) return own;
	}
	const principals = auth.onBehalfOf
		? [auth.principal, auth.onBehalfOf]
		: [auth.principal];
	const roots: NodeDto[] = [];
	let level: (string | null)[] = [null];
	while (level.length > 0 && budget > 0) {
		const below: string[] = [];
		for (const parent of level) {
			let cursor: string | undefined;
			do {
				if (budget-- <= 0) break;
				const page = await deps.tree().childrenAccess(
					parent,
					principals,
					cursor,
				);
				for (const child of page.nodes) {
					if (parent === null) roots.push(child.node);
					if (child.granted > ROLE.none && await readable(child.node)) {
						return child.node;
					}
					if (child.below) below.push(child.node.id);
				}
				cursor = page.cursor;
			} while (cursor !== undefined);
		}
		level = below;
	}
	for (const root of roots) {
		if (await readable(root)) return root;
	}
	return null;
};

const packageOf = async (
	deps: ApiDeps,
	extId: string,
	version: string,
): Promise<PackageDto> => {
	const pkg = (await deps.registry().packages(extId)).find((p) =>
		p.version === version
	);
	if (pkg === undefined) throw notFound(`package ${extId}@${version}`);
	return pkg;
};

/** The candidates an install request creates (a pack expands to its members). */
const candidatesOf = async (
	deps: ApiDeps,
	input: InstallRequest,
	pkg: PackageDto,
): Promise<InstallCandidate[]> => {
	const top: InstallCandidate = {
		extId: pkg.extId,
		version: pkg.version,
		manifest: pkg.manifest,
		bundled: pkg.bundled,
		mode: input.mode,
		locked: input.locked ?? false,
		backgroundRole: input.backgroundRole ?? 20,
		...(input.runtimeOverride
			? { runtimeOverride: input.runtimeOverride }
			: {}),
	};
	if (pkg.manifest.kind !== "pack") return [top];
	const members = await Promise.all(
		(pkg.manifest.members ?? []).map(async (member) => {
			const m = await packageOf(deps, member.id, member.version);
			return {
				extId: m.extId,
				version: m.version,
				manifest: m.manifest,
				bundled: m.bundled,
				mode: member.mode ?? input.mode,
				locked: false,
				backgroundRole: member.backgroundRole ?? 20,
			} satisfies InstallCandidate;
		}),
	);
	return [top, ...members];
};

const parseInstall = async (req: Request): Promise<InstallRequest> => {
	const parsed = InstallRequestSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		throw invalid("invalid install request", {
			issues: parsed.error.issues.map((i) =>
				`${i.path.join(".") || "(root)"}: ${i.message}`
			),
		});
	}
	return parsed.data;
};

const parseReplace = (body: unknown): ReplaceProviderRequest => {
	const parsed = ReplaceProviderRequestSchema.safeParse(body);
	if (!parsed.success) {
		throw invalid("invalid replace request", {
			issues: parsed.error.issues.map((i) =>
				`${i.path.join(".") || "(root)"}: ${i.message}`
			),
		});
	}
	return parsed.data;
};

const authorizeInstall = async (
	deps: ApiDeps,
	auth: AuthContext,
	node: NodeDto,
	candidates: readonly Pick<
		InstallCandidate,
		"manifest" | "locked" | "backgroundRole"
	>[],
): Promise<void> => {
	const needed = requiredRole(candidates, {
		nodeId: node.id,
		depth: node.depth,
	});
	await deps.authorize(
		auth,
		{ node },
		needed === 50 ? "install-privileged" : "install",
	);
};

/** The install sheet: permissions, interface replacement, Owner need, warnings. */
export const installSheet = async (
	deps: ApiDeps,
	input: InstallRequest,
	node: NodeDto,
	pkg: PackageDto,
): Promise<PermissionSheet> => {
	const candidates = await candidatesOf(deps, input, pkg);
	// The install rules read the unresolved lineage (a locked ancestor, the
	// providers at this node), as the registry's own install does.
	const inForce = await deps.registry().installed(node.id);
	const providers = resolve(inForce).providers;
	const lines = candidates.flatMap((c) =>
		candidates.length === 1 || c.manifest.kind === "pack"
			? (c.manifest.kind === "pack" ? [] : permissionLines(c.manifest))
			: permissionLines(c.manifest).map((l) => `${c.extId}: ${l}`)
	);
	const replaced = candidates.flatMap((c) =>
		(c.manifest.provides ?? []).flatMap((iface) => {
			const current = providers.get(iface);
			return current === undefined || current.installation.extId === c.extId
				? []
				: [{
					iface,
					installation: current.installation.id,
					ext: current.installation.extId,
					node: current.installation.nodePath,
				}];
		})
	);
	const here = inForce
		.filter((i) => i.installation.nodeId === node.id)
		.map((i) => ({ extId: i.installation.extId, mode: i.installation.mode }));
	const target = { nodeId: node.id, depth: node.depth };
	const blocked = candidates.flatMap((c) =>
		candidateIssues(c, target, inForce, here).map((i) => `blocked: ${i.text}`)
	);
	const provided = candidates.flatMap((c) => c.manifest.provides ?? []);
	const warnings = [
		...blocked,
		...candidates.flatMap((c) =>
			requiresWarnings(c.manifest as Manifest, inForce, provided)
		),
	];
	return {
		lines,
		...(replaced.length > 0 ? { replaces: replaced[0] } : {}),
		needsOwner: requiredRole(candidates, target) === 50,
		warnings: [...new Set(warnings)],
	};
};

const loadInstallation = async (deps: ApiDeps, id: string) => {
	if (!isIdOf("installation", id)) throw notFound("installation");
	const installation = await deps.registry().installation(id);
	if (installation === null) throw notFound("installation");
	const node = await deps.tree().node(installation.nodeId);
	if (node === null) throw notFound("installation");
	return { installation, node };
};

/**
 * The hosted installations among those an uninstall removed (the registry's
 * answer, disabled pack members included): all but a pack's own row, which
 * has no host.
 */
const hostsAmong = (
	removed: readonly InstallationDto[],
	installation: InstallationDto,
	manifest: Manifest,
): InstallationDto[] =>
	manifest.kind === "pack"
		? removed.filter((i) => i.id !== installation.id)
		: [...removed];

/** Every repo under `root` (paged `listRepos`). */
const reposUnder = async (
	deps: ApiDeps,
	root: string,
): Promise<{ id: string; path: string }[]> => {
	const found: { id: string; path: string }[] = [];
	let cursor: string | undefined;
	do {
		const page = await deps.tree().listRepos(
			cursor === undefined ? {} : { cursor },
		);
		found.push(...page.repos.filter((r) => isWithinPath(root, r.path)));
		cursor = page.cursor;
	} while (cursor !== undefined);
	return found;
};

/** ExtensionDO calls in flight at once during a cleanup. */
export const CLEANUP_BATCH = 25;

/**
 * Deletes the data of removed installations' ExtensionDOs: the node
 * scope, or each repo scope under `node`. Never throws; failures are logged
 * with ids and codes only.
 */
export const cleanUpHosts = async (
	deps: ApiDeps,
	removed: readonly InstallationDto[],
	node: NodeDto,
): Promise<void> => {
	const fail = (
		installation: string,
		error: unknown,
		scope?: ExtScope,
	): void =>
		deps.log({
			level: "error",
			event: "uninstall.cleanup_failed",
			installation,
			...(scope === undefined ? {} : { scope: scope.kind }),
			...(scope?.kind === "repo" ? { repo: scope.repoId } : {}),
			code: fromRpcError(error).code,
		});
	let repos: { id: string; path: string }[] = [];
	if (removed.some((i) => i.storageScope === "repo")) {
		try {
			repos = await reposUnder(deps, node.path);
		} catch (error) {
			for (const i of removed) {
				if (i.storageScope === "repo") fail(i.id, error);
			}
		}
	}
	const targets = removed.flatMap((i): { id: string; scope: ExtScope }[] =>
		i.storageScope === "node"
			? [{ id: i.id, scope: { kind: "node" } }]
			: repos.map((r) => ({ id: i.id, scope: { kind: "repo", repoId: r.id } }))
	);
	for (let k = 0; k < targets.length; k += CLEANUP_BATCH) {
		const batch = targets.slice(k, k + CLEANUP_BATCH);
		const results = await Promise.allSettled(
			batch.map((t) => deps.ext(t.id, t.scope).deleteData()),
		);
		results.forEach((r, n) => {
			if (r.status === "rejected") fail(batch[n].id, r.reason, batch[n].scope);
		});
	}
};

const intParam = (
	value: string | null,
	fallback: number,
	min: number,
	max: number,
): number => {
	const n = value === null || value === "" ? NaN : Number(value);
	return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** The scope an admin read names (see the header). */
const adminScope = async (
	deps: ApiDeps,
	installation: InstallationDto,
	node: NodeDto,
	repoHint: string | null,
): Promise<ExtScope> => {
	if (installation.storageScope === "node") {
		if (repoHint !== null) {
			throw invalid("a node-scoped installation takes no repo");
		}
		return { kind: "node" };
	}
	if (repoHint === null || repoHint === "") {
		throw invalid("repo is required for a repo-scoped installation");
	}
	let repo: NodeDto | null;
	if (ULID_RE.test(repoHint)) {
		repo = await deps.tree().node(repoHint);
	} else {
		const resolved = await deps.tree().resolvePath(repoHint);
		repo = resolved === null || resolved.rest !== "" || resolved.redirectTo
			? null
			: resolved.node;
	}
	if (
		repo === null || repo.kind !== "repo" ||
		!isWithinPath(node.path, repo.path)
	) {
		throw notFound("repo");
	}
	return { kind: "repo", repoId: repo.id };
};

/**
 * Installing, removing and switching an installation's mode are a person's
 * acts (ADR repo config): an agent token is refused even with the
 * role and scopes for it.
 */
const refuseAgent = (auth: AuthContext, what: string): void => {
	if (auth.kind === "agent") throw denied("role", `agents cannot ${what}`);
};

const ReplayRequestSchema = z.strictObject({
	/** The repo whose advances are replayed: a path or an id inside the installation's node. */
	repo: z.string().min(1).max(512),
	n: z.number().int().min(1).max(GATE_REPLAY_MAX).optional(),
});

/** A repo by path or id, inside `node`'s subtree (K12), else not found. */
const repoWithin = async (
	deps: ApiDeps,
	node: NodeDto,
	hint: string,
): Promise<NodeDto> => {
	let repo: NodeDto | null = null;
	if (ULID_RE.test(hint)) {
		repo = await deps.tree().node(hint);
	} else if (hint !== "") {
		const resolved = await deps.tree().resolvePath(hint);
		repo = resolved === null || resolved.rest !== "" || resolved.redirectTo
			? null
			: resolved.node;
	}
	if (
		repo === null || repo.kind !== "repo" ||
		!isWithinPath(node.path, repo.path)
	) {
		throw notFound("repo");
	}
	return repo;
};

/** `defer` runs work after the response (`ctx.waitUntil`); without it the work is awaited. */
export type Defer = (work: Promise<void>) => void;

export const handleInstallationsRequest = (
	deps: ApiDeps,
	req: Request,
	rest: string | undefined,
	authIn: AuthContext | null,
	defer?: Defer,
): Promise<Response> =>
	guard(async () => {
		const auth = requireAuth(authIn);
		const parts = (rest ?? "").split("/").filter((p) => p !== "");
		const method = req.method === "HEAD" ? "GET" : req.method;

		if (parts.length === 0 && method === "GET") {
			const path = new URL(req.url).searchParams.get("node");
			let node: NodeDto;
			if (path === null || path === "") {
				const start = await startNode(deps, auth);
				if (start === null) {
					throw notFound("no namespace you can read yet: name a node");
				}
				node = start;
			} else {
				node = await nodeByPath(deps, path);
			}
			await deps.authorize(auth, { node }, "read");
			const inForce = await deps.registry().inForce(node.id);
			return json({ node, installations: inForce });
		}
		if (parts.length === 0 && method === "POST") {
			const input = await parseInstall(req);
			const node = await nodeByPath(deps, input.node);
			const pkg = await packageOf(deps, input.extId, input.version);
			await authorizeInstall(
				deps,
				auth,
				node,
				await candidatesOf(deps, input, pkg),
			);
			refuseAgent(auth, "install extensions");
			const created = await deps.registry().install(auth.principal, input);
			return json(created, 201);
		}
		if (parts.length === 1 && parts[0] === "replace" && method === "POST") {
			const input = parseReplace(await readJson(req));
			const node = await nodeByPath(deps, input.node);
			// Maintainer first (no existence oracle for packages), then the
			// role the swap needs: the registry's dry run computes it.
			await deps.authorize(auth, { node }, "install");
			const plan = await deps.registry().replaceProvider(auth.principal, {
				...input,
				dryRun: true,
			});
			// The sheet is a Maintainer's; it says whether an Owner must approve.
			if (input.dryRun === true) return json(plan);
			refuseAgent(auth, "swap an interface provider");
			if (plan.needsOwner) {
				await deps.authorize(auth, { node }, "install-privileged");
			}
			return json(
				await deps.registry().replaceProvider(auth.principal, input),
			);
		}
		if (parts.length === 1 && parts[0] === "sheet" && method === "POST") {
			const input = await parseInstall(req);
			const node = await nodeByPath(deps, input.node);
			await deps.authorize(auth, { node }, "install");
			const pkg = await packageOf(deps, input.extId, input.version);
			return json(await installSheet(deps, input, node, pkg));
		}
		if (parts.length === 1 && method === "GET") {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			await deps.authorize(auth, { node }, "read");
			return json(installation);
		}
		if (parts.length === 1 && method === "DELETE") {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			const pkg = await packageOf(
				deps,
				installation.extId,
				installation.version,
			);
			await authorizeInstall(deps, auth, node, [{
				manifest: pkg.manifest,
				locked: installation.locked,
				backgroundRole: installation.backgroundRole,
			}]);
			refuseAgent(auth, "uninstall extensions");
			const removed = hostsAmong(
				await deps.registry().uninstall(auth.principal, installation.id),
				installation,
				pkg.manifest,
			);
			const cleanup = cleanUpHosts(deps, removed, node);
			if (defer === undefined) await cleanup;
			else defer(cleanup);
			return new Response(null, {
				status: 204,
				headers: { "cache-control": "private, no-store" },
			});
		}
		if (
			parts.length === 2 && parts[1] === "mode" &&
			(method === "PUT" || method === "PATCH")
		) {
			const body = ModeChangeRequestSchema.safeParse(await readJson(req));
			if (!body.success) throw invalid("invalid mode");
			const { installation, node } = await loadInstallation(deps, parts[0]);
			const pkg = await packageOf(
				deps,
				installation.extId,
				installation.version,
			);
			await authorizeInstall(deps, auth, node, [{
				manifest: pkg.manifest,
				locked: installation.locked,
				backgroundRole: installation.backgroundRole,
			}]);
			refuseAgent(auth, "change an installation's mode");
			return json(
				await deps.registry().setMode(
					auth.principal,
					installation.id,
					body.data.mode,
				),
			);
		}
		if (
			parts.length === 2 &&
			(parts[1] === "console" || parts[1] === "dead-letters") &&
			method === "GET"
		) {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			// Maintainer (and an `admin`-scoped token) at the installation's node.
			await deps.authorize(auth, { node }, "install");
			const params = new URL(req.url).searchParams;
			const scope = await adminScope(
				deps,
				installation,
				node,
				params.get("repo"),
			);
			const host = deps.ext(installation.id, scope);
			const limit = intParam(params.get("limit"), 100, 1, 500);
			if (parts[1] === "console") {
				const since = intParam(
					params.get("since"),
					0,
					0,
					Number.MAX_SAFE_INTEGER,
				);
				return json({
					installation: installation.id,
					scope,
					lines: await host.console(since, limit),
				});
			}
			return json({
				installation: installation.id,
				scope,
				deadLetters: await host.deadLetters(limit),
			});
		}
		if (parts.length === 2 && parts[1] === "promote" && method === "POST") {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			const pkg = await packageOf(
				deps,
				installation.extId,
				installation.version,
			);
			await authorizeInstall(deps, auth, node, [{
				manifest: pkg.manifest,
				locked: installation.locked,
				backgroundRole: installation.backgroundRole,
			}]);
			refuseAgent(auth, "promote an installation");
			return json(
				await deps.registry().promote(auth.principal, installation.id),
			);
		}
		if (parts.length === 2 && parts[1] === "replay" && method === "POST") {
			const body = ReplayRequestSchema.safeParse(await readJson(req));
			if (!body.success) throw invalid("replay: {repo, n?}");
			const { installation, node } = await loadInstallation(deps, parts[0]);
			// Maintainer (and an `admin`-scoped token) at the installation's node.
			await deps.authorize(auth, { node }, "install");
			const repo = await repoWithin(deps, node, body.data.repo);
			const pkg = await packageOf(
				deps,
				installation.extId,
				installation.version,
			);
			const n = body.data.n ?? GATE_REPLAY_MAX;
			const { replayId } = await deps.registry().replayGate(
				installation.id,
				n,
				repo.id,
			);
			return json(
				await runGateReplay(deps, {
					installation,
					manifest: pkg.manifest,
					repoId: repo.id,
					n,
					replayId,
				}),
			);
		}
		if (parts.length === 3 && parts[1] === "replay" && method === "GET") {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			await deps.authorize(auth, { node }, "install");
			const repo = await repoWithin(
				deps,
				node,
				new URL(req.url).searchParams.get("repo") ?? "",
			);
			const row = await deps.land(repo.id).replay(parts[2]);
			if (row === null || row.installation_id !== installation.id) {
				throw notFound("replay");
			}
			return json(replayResponse(row));
		}
		if (parts.length === 2 && parts[1] === "breaker") {
			const { installation, node } = await loadInstallation(deps, parts[0]);
			if (method !== "GET" && method !== "POST") throw notFound("route");
			// Reading is a Maintainer's (with an `admin` token scope); the reset
			// is an Owner's, and a person's act.
			await deps.authorize(
				auth,
				{ node },
				method === "GET" ? "install" : "install-privileged",
			);
			if (method === "POST") refuseAgent(auth, "reset a circuit breaker");
			const scope = await adminScope(
				deps,
				installation,
				node,
				new URL(req.url).searchParams.get("repo"),
			);
			const host = deps.ext(installation.id, scope);
			return json({
				installation: installation.id,
				scope,
				breaker: method === "GET"
					? await host.breaker()
					: await host.resetBreaker(auth.principal),
			});
		}
		if (parts.length === 2 && parts[1] === "compare") {
			throw notImplemented("installations compare");
		}
		throw notFound("route");
	});
