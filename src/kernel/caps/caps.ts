// `createKernelCaps` (K10, K12, K16): the one implementation of `KernelCaps`,
// used in-process for builtins and behind the `KernelCaps` entrypoint for
// js/wasm. Built per call from the call's `CapsProps`; every method re-checks,
// in order:
//
// 1. the stub is still live (a capability is valid only for the call it was
//    passed into: a stashed one fails afterwards);
// 2. `capsDenial`: the installation's approved grants, shadow mode and the
//    read-only context (render, context), from `CAPS_METHOD_POLICY`;
// 3. argument shapes (contract zod schemas), then K12: every target
//    (`RepoRef`, `NodeRef`, `GitSource`, `StreamRef`, lane id, `at`,
//    `authz.check` node, `notify.send` recipient) must resolve inside the
//    installation's subtree, else `denied("scope")`;
// 4. the actor: interactive calls need the user's or agent's role at the
//    target, bounded by its credential (`boundRole`, `scopesAllow`); the
//    installation's own background calls act at its `background_role` for
//    reads and interface tools, and on its approved grants for effects;
//    another installation acting through `interfaces.call` carries its
//    background role and subtree in `bounds`;
// 5. method rules: K10 `mayEmit`, depth ≤ 8 and payload schemas for
//    `events.emit`; event patterns within `events.read` grants; `land` refs
//    and `queue@1` for `land.submit`; CI-only graphs whose source is the
//    resolved repo for `runs.start`; the lane owner rule and no
//    background lane opens; the call chain for `interfaces.call`;
// 6. the per-installation effects token bucket.
//
// Lane mutations are enforced by RepoDO (K16) on the `LaneOpActor` built here;
// nothing here is the enforcement point for K16.

import {
	type Actor,
	type ActorBounds,
	CAPS_METHOD_POLICY,
	capsDenial,
	type CapsMethod,
	type CapsProps,
	ChangeIdSchema,
	CiJobGraphSchema,
	conflict,
	denied,
	EMPTY_FOOTPRINT,
	EntityRefSchema,
	type Envelope,
	EVENT_DATA_MAX_BYTES,
	EVENT_PATTERN_RE,
	eventIdemKey,
	EventTypeSchema,
	extPrincipalId,
	FootprintSchema,
	type GitSource,
	GitSourceSchema,
	InterfaceIdSchema,
	INTERFACES,
	invalid,
	isSha,
	isWithinPath,
	type KernelCaps,
	LandRequestSchema,
	LandVerdictSchema,
	type Lane,
	LaneIdSchema,
	LaneStateSchema,
	MAX_EVENT_DEPTH,
	mayEmit,
	MERGE3_MAX_PER_CALL,
	NodeRefSchema,
	NOTE_SECTION_MAX_BYTES,
	notFound,
	NoticeKindSchema,
	notImplemented,
	type Permission,
	PERMISSION_MIN_ROLE,
	PermissionSchema,
	PrincipalIdSchema,
	RefNameSchema,
	RepoPathSchema,
	type RepoRef,
	sanitizeNoticeText,
	scopesAllow,
	SeveritySchema,
	StreamRefSchema,
	TartanError,
	type ToolContext,
	unavailable,
	validateEventData,
} from "@tartan/contract";
import type { Clock, Ids, LaneOpActor } from "@tartan/contract/kernel.ts";
import { byteLength, type InterfaceDef } from "@tartan/contract";
import type { z } from "zod";
import type { KernelPorts, PortNode } from "./ports.ts";
import type { RateLimiter } from "./rate.ts";
import { createActorRoles } from "./roles.ts";

/** What the calling host lends a call's caps (in-process state). */
export type CapsLocal = {
	readonly clock: Clock;
	readonly ids: Ids;
	/** The calling installation's manifest `provides` (K10, `land.submit`). */
	readonly provides: () => Promise<readonly string[]>;
	/**
	 * The calling installation's manifest `config.repoPolicy` keys: the only
	 * keys `caps.repo.policy` returns to it (ADR repo config). Default: none.
	 */
	readonly repoPolicyKeys?: () => Promise<readonly string[]>;
	/** Host timers of the calling ExtensionDO; absent where the runtime buffers them. */
	readonly timers?: {
		set(key: string, atMs: number): void;
		clear(key: string): void;
	};
	/** The installation scope's effects bucket. */
	readonly rate?: RateLimiter;
	/** True once the host call this capability was minted for has settled. */
	readonly expired?: () => boolean;
	/**
	 * The installation's node as currently resolved, cached by the host across
	 * calls; default: one `ports.node` lookup per capability.
	 */
	readonly installationNode?: () => Promise<PortNode | null>;
};

const TIMER_KEY_RE = /^[A-Za-z0-9:._/-]{1,128}$/;
const READ_PAGE_MAX = 100;
const LOG_MAX = 1000;
const PROMPT_MAX_BYTES = 64 * 1024;

/** The fixed parts of an extension event's source. */
const sourceOf = (props: CapsProps) => ({
	kind: "installation" as const,
	id: props.inst,
	ext: `${props.extId}@${props.version}`,
});

/** True when the grant patterns of `events.read` cover `requested` (K12). */
export const patternCovered = (
	granted: readonly string[],
	requested: string,
): boolean =>
	granted.some((g) =>
		g === "*" || g === requested ||
		(g.endsWith(".*") && requested !== "*" &&
			requested.startsWith(g.slice(0, -1)))
	);

/** `refs/heads/*`-style grant patterns of `permissions.land`. */
export const refGranted = (
	patterns: readonly string[],
	ref: string,
): boolean =>
	patterns.some((p) => {
		const re = new RegExp(
			`^${
				p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(
					"[^/]*",
				)
			}$`,
		);
		return re.test(ref);
	});

const parse = <S extends z.ZodType>(
	schema: S,
	value: unknown,
	what: string,
): z.output<S> => {
	const r = schema.safeParse(value);
	if (r.success) return r.data;
	throw invalid(
		`${what}: ${
			r.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
				.join("; ")
		}`,
	);
};

const isInteractive = (actor: Actor): boolean =>
	actor.kind === "user" || actor.kind === "agent";

/** Runs a synchronous body as a promise (a throw becomes a rejection). */
const settle = <T>(fn: () => T): Promise<T> => {
	try {
		return Promise.resolve(fn());
	} catch (error) {
		return Promise.reject(error);
	}
};

/** Builds the `KernelCaps` of one call (see the header). */
export const createKernelCaps = (
	props: CapsProps,
	ports: KernelPorts,
	local: CapsLocal,
): KernelCaps => {
	const self = extPrincipalId(props.inst);
	const actor = props.actor;
	const nodes = new Map<string, Promise<PortNode | null>>();
	const emitCounts = new Map<string, number>();

	// -- 1, 2: liveness and the method policy --------------------------------

	const gate = (method: CapsMethod, mutatingTool?: boolean): void => {
		if (local.expired?.() === true) {
			throw unavailable(
				`${method}: this capability was minted for a call that has ended`,
			);
		}
		const reason = capsDenial(method, {
			grants: props.grants,
			mode: props.mode,
			readOnly: props.readOnly,
			mutatingTool,
		});
		if (reason !== null) throw denied(reason, `${method}: ${reason}`);
	};

	const takeEffect = (method: CapsMethod): void => {
		if (local.rate !== undefined && !local.rate.take()) {
			throw denied("rate", `${method}: effects_per_second exceeded`);
		}
	};

	// -- 3: resolution and K12 confinement ------------------------------------

	const resolve = (ref: { id: string } | { path: string }) => {
		const key = "id" in ref ? `id:${ref.id}` : `path:${ref.path}`;
		let found = nodes.get(key);
		if (found === undefined) {
			found = ports.node(ref);
			nodes.set(key, found);
		}
		return found;
	};

	const installationNode = async (): Promise<PortNode> => {
		const node = local.installationNode !== undefined
			? await local.installationNode()
			: await resolve({ id: props.node.id });
		if (node === null || node.id !== props.node.id) {
			throw notFound("installation node not found");
		}
		return node;
	};

	/** Resolves a NodeRef and requires it inside the installation subtree (K12). */
	const confine = async (
		ref: unknown,
		what: string,
		options: { readonly repo?: boolean } = {},
	): Promise<PortNode> => {
		const parsed = parse(NodeRefSchema, ref, what);
		const root = await installationNode();
		// A path outside the subtree is refused before any lookup.
		if ("path" in parsed && !isWithinPath(root.path, parsed.path)) {
			throw denied("scope", `${what} is outside the installation subtree`);
		}
		const node = await resolve(parsed);
		if (node === null) throw notFound(`${what} not found`);
		if (!isWithinPath(root.path, node.path)) {
			throw denied("scope", `${what} is outside the installation subtree`);
		}
		if (options.repo === true && node.kind !== "repo") {
			throw invalid(`${what} is not a repo`);
		}
		return node;
	};

	const confineRepo = (repo: unknown, what = "repo") =>
		confine(repo, what, { repo: true });

	/** Repo routing: an id-keyed call's repo: the argument, else the installation's repo. */
	const repoOf = (o: { readonly repo?: RepoRef } | undefined) => {
		const repo = o?.repo ?? (props.repo ? { id: props.repo } : undefined);
		if (repo === undefined) throw invalid("repo required");
		return confineRepo(repo);
	};

	/** A GitSource inside the subtree whose lane (if any) belongs to its repo. */
	const confineSource = async (
		value: unknown,
		what = "source",
	): Promise<{ readonly source: GitSource; readonly node: PortNode }> => {
		const source = parse(GitSourceSchema, value, what);
		const node = await confineRepo({ id: source.repoId }, `${what}.repoId`);
		if (source.laneId !== undefined) {
			await requireLane(node, source.laneId);
		}
		return { source, node };
	};

	const requireLane = async (node: PortNode, laneId: string): Promise<Lane> => {
		parse(LaneIdSchema, laneId, "laneId");
		const lane = await ports.repo(node.id).core.getLane(laneId);
		if (lane === null || lane.repoId !== node.id) {
			throw notFound(`lane ${laneId} not found in ${node.path}`);
		}
		return lane;
	};

	// -- 4: the actor ----------------------------------------------------------

	/** The actor's role at a node. */
	const actorRole = createActorRoles(ports, resolve, {
		self,
		backgroundRole: props.backgroundRole,
		actor,
		bounds: props.bounds,
	}).roleAt;

	const requireRoleAt = async (
		node: PortNode,
		min: number,
		what: string,
		laneId?: string,
	): Promise<void> => {
		const role = await actorRole(node, laneId);
		if (role < min) {
			throw denied("role", `${what} needs role ${min} at ${node.path}`);
		}
	};

	/**
	 * The actor check of one call: interactive actors (and installations
	 * acting through another's `interfaces.call`) need `perm` at the node,
	 * within their token scopes; the installation's own background calls need
	 * it only for reads (`background_role`), effects resting on the grant.
	 */
	const requirePermission = async (
		node: PortNode,
		perm: Permission,
		laneId?: string,
	): Promise<void> => {
		const background = actor.kind === "system" || actor.id === self;
		if (background && perm !== "read" && perm !== "read-metadata") return;
		await requireRoleAt(node, PERMISSION_MIN_ROLE[perm], perm, laneId);
		if (props.bounds !== null && !scopesAllow(props.bounds.scopes, perm)) {
			throw denied(
				"scopes",
				`${perm}: the credential's scopes do not allow it`,
			);
		}
	};

	/** K16 "background calls cannot open or adopt": owner = actor or onBehalfOf. */
	const requireOwnerIsActor = (owner: string, method: CapsMethod): void => {
		if (!isInteractive(actor)) {
			throw denied("actor", `${method}: not in a background call`);
		}
		if (owner !== actor.id && owner !== actor.onBehalfOf) {
			throw denied(
				"actor",
				`${method}: owner must be the acting principal or its on-behalf-of user`,
			);
		}
	};

	const laneActor = (): LaneOpActor => {
		// The credential bounds go along, so RepoDO's K16 role is the bounded
		// one checked here: the interactive actor's own, or
		// the installation's background role confined to its node.
		const bounds: ActorBounds = props.bounds ?? {
			maxRole: props.backgroundRole,
			scopes: null,
			nodeId: props.node.id,
			laneId: null,
		};
		return {
			kind: actor.kind,
			id: actor.id,
			...(actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {}),
			installation: props.inst,
			bounds,
		};
	};

	/** A ref, lane id or SHA → SHA through RepoDO (K15); null when unknown. */
	const resolveSha = async (
		repoId: string,
		ref: unknown,
	): Promise<string | null> => {
		if (typeof ref !== "string" || ref.length === 0 || ref.length > 1024) {
			throw invalid("ref: a branch, tag, lane id or SHA");
		}
		if (isSha(ref)) return ref;
		return await ports.repo(repoId).core.resolveRef(ref);
	};

	const requireSha = async (repoId: string, ref: unknown, what: string) => {
		const sha = await resolveSha(repoId, ref);
		if (sha === null) throw notFound(`${what}: unknown ref`);
		return sha;
	};

	const repoPath = (value: unknown, what: string, nonEmpty = false): string => {
		const path = parse(RepoPathSchema, value ?? "", what).replace(/\/+$/, "");
		if (nonEmpty && path.length === 0) throw invalid(`${what}: required`);
		return path;
	};

	/** The entries of the tree at `path` in the commit `sha`, read from `source`. */
	const treeAt = async (source: GitSource, sha: string, path: string) => {
		const reader = await ports.reader(source);
		const commit = await reader.commit(sha);
		if (commit === null) throw notFound("commit not found");
		let tree = commit.treeSha;
		const segments = path === "" ? [] : path.split("/");
		for (const segment of segments) {
			const entries = await reader.tree(tree);
			const next = entries?.find((e) =>
				e.name === segment && e.type === "tree"
			);
			if (next === undefined) return [];
			tree = next.hash;
		}
		const entries = await reader.tree(tree) ?? [];
		return entries.map((e) => ({
			name: e.name,
			path: path === "" ? e.name : `${path}/${e.name}`,
			mode: e.mode,
			hash: e.hash,
			type: e.type,
		}));
	};

	const sameRepo = (node: PortNode, source: GitSource, what: string) => {
		if (source.repoId !== node.id) {
			throw invalid(`${what}: source is in another repo`);
		}
	};

	// -- the capability surface ------------------------------------------------

	const caps: KernelCaps = {
		repo: {
			info: async (repo) => {
				gate("repo.info");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				return await ports.repo(node.id).core.info();
			},
			resolveRef: async (repo, ref) => {
				gate("repo.resolveRef");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				return await resolveSha(node.id, ref);
			},
			readFile: async (repo, ref, path, maxBytes) => {
				gate("repo.readFile");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				const file = repoPath(path, "path", true);
				// K13: canonical only.
				const sha = await resolveSha(node.id, ref);
				if (sha === null) return null;
				const bytes = await (await ports.reader({ repoId: node.id })).file(
					sha,
					file,
				);
				if (bytes === null) return null;
				const cap = maxBytes === undefined
					? bytes.length
					: Math.max(0, Math.floor(maxBytes));
				return bytes.length > cap ? bytes.slice(0, cap) : bytes;
			},
			readTree: async (repo, ref, path, source) => {
				gate("repo.readTree");
				const node = await confineRepo(repo);
				const src = source === undefined
					? { repoId: node.id }
					: (await confineSource(source)).source;
				sameRepo(node, src, "readTree");
				await requirePermission(node, "read", src.laneId);
				const sha = await requireSha(node.id, ref, "readTree");
				return await treeAt(src, sha, repoPath(path, "path"));
			},
			log: async (repo, ref, limit = 50) => {
				gate("repo.log");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				const sha = await resolveSha(node.id, ref);
				if (sha === null) return [];
				const n = Math.min(LOG_MAX, Math.max(1, Math.floor(limit)));
				return await (await ports.reader({ repoId: node.id })).log(sha, n);
			},
			diffPaths: async (source, base, head) => {
				gate("repo.diffPaths");
				const { source: src, node } = await confineSource(source);
				await requirePermission(node, "read", src.laneId);
				return await ports.probe.diffPaths(
					src,
					await requireSha(node.id, base, "base"),
					await requireSha(node.id, head, "head"),
				);
			},
			hunks: async (source, base, head, paths) => {
				gate("repo.hunks");
				const { source: src, node } = await confineSource(source);
				await requirePermission(node, "read", src.laneId);
				if (!Array.isArray(paths) || paths.length > 2000) {
					throw invalid("paths: at most 2,000");
				}
				return await ports.probe.hunks(
					src,
					await requireSha(node.id, base, "base"),
					await requireSha(node.id, head, "head"),
					paths.map((p, i) => repoPath(p, `paths.${i}`, true)),
				);
			},
			merge3: async (input) => {
				gate("repo.merge3");
				if (!Array.isArray(input) || input.length > MERGE3_MAX_PER_CALL) {
					throw invalid(`merge3: at most ${MERGE3_MAX_PER_CALL} inputs`);
				}
				for (const [i, m] of input.entries()) {
					const node = await confineRepo({ id: m.repoId }, `input.${i}.repoId`);
					await requirePermission(node, "read");
					for (const sha of [m.ours, m.theirs, ...(m.base ? [m.base] : [])]) {
						if (!isSha(sha)) throw invalid(`input.${i}: blob ids are SHAs`);
					}
				}
				return await ports.probe.merge3(input);
			},
			laneRange: async (laneId, o) => {
				gate("repo.laneRange");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requirePermission(node, "read", laneId);
				return await ports.repo(node.id).core.laneRange(laneId);
			},
			diff: async (a, b) => {
				gate("repo.diff");
				const left = await confineSource(
					{ repoId: a?.repoId, laneId: a?.laneId },
					"a",
				);
				const right = await confineSource(
					{ repoId: b?.repoId, laneId: b?.laneId },
					"b",
				);
				await requirePermission(left.node, "read", left.source.laneId);
				await requirePermission(right.node, "read", right.source.laneId);
				if (!isSha(a.sha) || !isSha(b.sha)) throw invalid("diff: SHAs");
				return await ports.probe.diff(
					{ ...left.source, sha: a.sha },
					{ ...right.source, sha: b.sha },
				);
			},
			projectGraph: async (repo, sha) => {
				gate("repo.projectGraph");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				return await ports.probe.projectGraph(
					node.id,
					await requireSha(node.id, sha, "sha"),
				);
			},
			affected: async (repo, base, head, source) => {
				gate("repo.affected");
				const node = await confineRepo(repo);
				const src = source === undefined
					? undefined
					: (await confineSource(source)).source;
				if (src !== undefined) sameRepo(node, src, "affected");
				await requirePermission(node, "read", src?.laneId);
				return await ports.probe.affected(
					node.id,
					await requireSha(node.id, base, "base"),
					await requireSha(node.id, head, "head"),
					src === undefined ? undefined : { source: src },
				);
			},
			treeHash: async (repo, sha, path, source) => {
				gate("repo.treeHash");
				const node = await confineRepo(repo);
				const src = source === undefined
					? { repoId: node.id }
					: (await confineSource(source)).source;
				sameRepo(node, src, "treeHash");
				await requirePermission(node, "read", src.laneId);
				return await ports.probe.treeHash(
					src,
					await requireSha(node.id, sha, "sha"),
					repoPath(path, "path"),
				);
			},
			blame: async () => {
				gate("repo.blame");
				return await Promise.reject(notImplemented("caps.repo.blame (M2)"));
			},
			policy: async (repo, at) => {
				gate("repo.policy");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				// K13: a trunk commit only; RepoDO refuses anything else
				// (`policy-not-trunk`). A ref name is never resolved here.
				if (typeof at !== "string" || !isSha(at)) {
					throw invalid("at: a trunk commit sha");
				}
				const keys = await (local.repoPolicyKeys?.() ?? Promise.resolve([]));
				return await ports.repo(node.id).repoconfig.policy(
					at,
					props.extId,
					[...keys],
				);
			},
		},

		lanes: {
			open: async (o) => {
				gate("lanes.open");
				const owner = parse(PrincipalIdSchema, o?.owner, "owner");
				requireOwnerIsActor(owner, "lanes.open");
				const node = await confineRepo(o.repo);
				await requirePermission(node, "claim");
				const entity = o.entity === undefined
					? undefined
					: parse(EntityRefSchema, o.entity, "entity");
				const footprint = o.footprint === undefined
					? EMPTY_FOOTPRINT
					: parse(FootprintSchema, o.footprint, "footprint");
				takeEffect("lanes.open");
				return await ports.repo(node.id).core.openLane({
					owner,
					...(owner === actor.id && actor.onBehalfOf
						? { onBehalfOf: actor.onBehalfOf }
						: {}),
					...(entity ? { entity } : {}),
					footprint,
					actor: laneActor(),
				});
			},
			adopt: async (o) => {
				gate("lanes.adopt");
				const owner = parse(PrincipalIdSchema, o?.owner, "owner");
				requireOwnerIsActor(owner, "lanes.adopt");
				const node = await confineRepo(o.repo);
				await requirePermission(node, "claim");
				const ref = parse(RefNameSchema, o.ref, "ref");
				const entity = o.entity === undefined
					? undefined
					: parse(EntityRefSchema, o.entity, "entity");
				takeEffect("lanes.adopt");
				return await ports.repo(node.id).core.adoptLane({
					ref,
					owner,
					...(entity ? { entity } : {}),
					actor: laneActor(),
				});
			},
			get: async (laneId, o) => {
				gate("lanes.get");
				const node = await repoOf(o);
				await requirePermission(node, "read", laneId);
				return await requireLane(node, laneId);
			},
			list: async (f) => {
				gate("lanes.list");
				const node = await confineRepo(f?.repo);
				await requirePermission(node, "read");
				const state = f.state === undefined
					? undefined
					: f.state.map((s, i) => parse(LaneStateSchema, s, `state.${i}`));
				const owner = f.owner === undefined
					? undefined
					: parse(PrincipalIdSchema, f.owner, "owner");
				const entity = f.entity === undefined
					? undefined
					: parse(EntityRefSchema, f.entity, "entity");
				const page = await ports.repo(node.id).core.listLanes({
					...(state ? { state } : {}),
					...(owner ? { owner } : {}),
					...(entity ? { entity } : {}),
					limit: READ_PAGE_MAX,
				});
				return page.lanes;
			},
			close: async (laneId, reason, o) => {
				gate("lanes.close");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requirePermission(node, "claim", laneId);
				if (typeof reason !== "string" || reason.length > 500) {
					throw invalid("reason: at most 500 characters");
				}
				takeEffect("lanes.close");
				await ports.repo(node.id).core.closeLane(
					laneId,
					reason,
					laneActor(),
				);
			},
			archive: async (laneId, o) => {
				gate("lanes.archive");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requirePermission(node, "claim", laneId);
				const atticRef = o?.atticRef === undefined
					? undefined
					: parse(RefNameSchema, o.atticRef, "atticRef");
				takeEffect("lanes.archive");
				return await ports.repo(node.id).core.archiveLane(
					laneId,
					atticRef === undefined ? {} : { atticRef },
					laneActor(),
				);
			},
			delegate: async (laneId, d, o) => {
				gate("lanes.delegate");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requirePermission(node, "claim", laneId);
				const ids = (list: unknown, what: string): string[] =>
					list === undefined
						? []
						: parse(PrincipalIdSchema.array().max(32), list, what);
				takeEffect("lanes.delegate");
				await ports.repo(node.id).core.delegateLane(
					laneId,
					ids(d?.add, "add"),
					ids(d?.remove, "remove"),
					laneActor(),
				);
			},
			sync: async (laneId, o) => {
				gate("lanes.sync");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requirePermission(node, "claim", laneId);
				takeEffect("lanes.sync");
				return await ports.repo(node.id).core.syncLane(
					laneId,
					laneActor(),
				);
			},
			restack: async (laneId, onto, o) => {
				gate("lanes.restack");
				const node = await repoOf(o);
				await requireLane(node, laneId);
				await requireLane(node, onto);
				await requirePermission(node, "claim", laneId);
				takeEffect("lanes.restack");
				return await ports.repo(node.id).core.restackLane(
					laneId,
					onto,
					laneActor(),
				);
			},
		},

		land: {
			submit: async (r) => {
				gate("land.submit");
				const request = parse(LandRequestSchema, r, "land.submit");
				if (!(await local.provides()).includes("queue@1")) {
					throw denied("grant", "land.submit: queue@1 providers only");
				}
				if (!refGranted(props.grants.land ?? [], request.ref)) {
					throw denied("grant", `land.submit: ${request.ref} is not granted`);
				}
				const node = await confineRepo(request.repo);
				await requirePermission(node, "submit");
				// Another installation is the queue@1 provider in force at the
				// repo (this one was replaced by a nearer install, or masked by a
				// nearer pack): it lands, this one hands over (WP7a resolution;
				// the queue engine releases its queue on this refusal).
				const provider = await ports.provider("queue@1", node.id);
				if (provider !== null && provider.installation.id !== props.inst) {
					throw denied(
						"grant",
						`land.submit: not the queue@1 provider in force at ${node.path}`,
					);
				}
				takeEffect("land.submit");
				const out = await ports.repo(node.id).land.submit(
					{ ...request, repo: { id: node.id } },
					actor.id,
				);
				return { batchId: out.batchId };
			},
			status: async (batchId, o) => {
				gate("land.status");
				const node = await repoOf(o);
				await requirePermission(node, "read");
				const status = await ports.repo(node.id).land.status(String(batchId));
				if (status === null) throw notFound(`batch ${batchId} not found`);
				return status;
			},
			report: async (batchId, v, o) => {
				gate("land.report");
				const verdict = parse(LandVerdictSchema, v, "verdict");
				const node = await repoOf(o);
				await requirePermission(node, "push");
				takeEffect("land.report");
				const out = await ports.repo(node.id).land.report(
					String(batchId),
					verdict,
					actor.id,
				);
				if (!out.accepted) {
					throw conflict(`land.report rejected: ${out.reason ?? "stale"}`);
				}
			},
		},

		runs: {
			start: async (g) => {
				gate("runs.start");
				const { idemKey, ...graphInput } = g ?? ({} as typeof g);
				if (typeof idemKey !== "string" || idemKey.length === 0) {
					throw invalid("runs.start: idemKey required");
				}
				const graph = parse(CiJobGraphSchema, graphInput, "runs.start");
				const node = await confineRepo(graph.repo);
				// CI only: the source is the resolved repo (a lane of it at most).
				const { source } = await confineSource(graph.source, "source");
				sameRepo(node, source, "runs.start");
				await requirePermission(node, "push");
				takeEffect("runs.start");
				return await ports.repo(node.id).runs.start({
					graph: { ...graph, repo: { id: node.id } },
					idemKey: `${props.inst}:${idemKey}`,
					requestedBy: actor.id,
				});
			},
			get: async (runId, o) => {
				gate("runs.get");
				const node = await repoOf(o);
				await requirePermission(node, "read");
				const run = await ports.repo(node.id).runs.get(String(runId));
				if (run === null) throw notFound(`run ${runId} not found`);
				return run;
			},
			cancel: async (runId, o) => {
				gate("runs.cancel");
				const node = await repoOf(o);
				await requirePermission(node, "push");
				takeEffect("runs.cancel");
				await ports.repo(node.id).runs.cancel(String(runId), actor.id);
			},
			logs: async (runId, jobId, o) => {
				gate("runs.logs");
				const node = await repoOf(o);
				await requirePermission(node, "read");
				return await ports.repo(node.id).runs.logs(
					String(runId),
					String(jobId),
					o?.tailBytes,
				);
			},
		},

		notes: {
			contribute: async (repo, changeId, section) => {
				gate("notes.contribute");
				const node = await confineRepo(repo);
				await requirePermission(node, "comment");
				const id = parse(ChangeIdSchema, changeId, "changeId");
				let text: string;
				try {
					text = JSON.stringify(section ?? null);
				} catch {
					throw invalid("section: not JSON");
				}
				if (byteLength(text) > NOTE_SECTION_MAX_BYTES) {
					throw invalid(`section: at most ${NOTE_SECTION_MAX_BYTES} bytes`);
				}
				takeEffect("notes.contribute");
				await ports.repo(node.id).land.contributeNote(
					id,
					props.extId,
					JSON.parse(text),
				);
			},
		},

		events: {
			emit: async (type, data, o) => {
				gate("events.emit");
				const eventType = parse(EventTypeSchema, type, "type");
				if (
					!mayEmit({
						kind: "installation",
						extId: props.extId,
						provides: await local.provides(),
					}, eventType)
				) {
					throw denied(
						"namespace",
						`events.emit: ${eventType} is outside x.${props.extId}.* and the provided interfaces (K10)`,
					);
				}
				const depth = props.causedBy === undefined
					? props.depth
					: props.depth + 1;
				if (depth > MAX_EVENT_DEPTH) {
					throw denied(
						"depth",
						`events.emit: depth ${depth} > ${MAX_EVENT_DEPTH}`,
					);
				}
				const checked = validateEventData(eventType, data);
				if (!checked.ok) {
					throw invalid(`events.emit: ${checked.errors.join("; ")}`);
				}
				const size = byteLength(JSON.stringify(checked.data ?? null));
				if (size > EVENT_DATA_MAX_BYTES) {
					throw invalid(
						`events.emit: data exceeds ${EVENT_DATA_MAX_BYTES} bytes`,
					);
				}
				const subject = o?.subject === undefined
					? undefined
					: parse(EntityRefSchema, o.subject, "subject");
				if (
					o?.correlation !== undefined &&
					(typeof o.correlation !== "string" || o.correlation.length > 256)
				) {
					throw invalid("correlation: at most 256 characters");
				}
				if (
					o?.idemKey !== undefined &&
					(typeof o.idemKey !== "string" || o.idemKey.length === 0 ||
						o.idemKey.length > 200)
				) {
					throw invalid("idemKey: 1–200 characters");
				}
				const node = await repoOf(o);
				await requireRoleAt(node, PERMISSION_MIN_ROLE["read-metadata"], "emit");
				const n = emitCounts.get(eventType) ?? 0;
				emitCounts.set(eventType, n + 1);
				const idemKey = o?.idemKey !== undefined
					? `${props.inst}:${o.idemKey}`
					: props.causedBy !== undefined
					? eventIdemKey(props.inst, props.causedBy, eventType, n)
					: `${props.inst}:${local.ids.ulid()}`;
				takeEffect("events.emit");
				const appended = await ports.repo(node.id).events.append({
					type: eventType,
					source: sourceOf(props),
					actor,
					node: node.id,
					repo: node.id,
					...(subject ? { subject } : {}),
					...(props.causedBy ? { causedBy: props.causedBy } : {}),
					...(o?.correlation ? { correlation: o.correlation } : {}),
					depth,
					shadow: props.mode === "shadow",
					data: checked.data,
					idemKey,
				});
				return appended.id;
			},
			read: async (stream, since, patterns, limit = READ_PAGE_MAX) => {
				gate("events.read");
				const ref = parse(StreamRefSchema, stream, "stream");
				if (!Number.isInteger(since) || since < 0) {
					throw invalid("since: a non-negative integer");
				}
				if (
					!Array.isArray(patterns) || patterns.length === 0 ||
					patterns.length > 32
				) {
					throw invalid("patterns: 1–32 event patterns");
				}
				const granted = props.grants["events.read"] ?? [];
				for (const p of patterns) {
					if (typeof p !== "string" || !EVENT_PATTERN_RE.test(p)) {
						throw invalid(`patterns: ${String(p)} is not an event pattern`);
					}
					if (!patternCovered(granted, p)) {
						throw denied("grant", `events.read: ${p} is not granted`);
					}
				}
				const n = Math.min(READ_PAGE_MAX, Math.max(1, Math.floor(limit)));
				if (ref === "forge") {
					// K12: node events only inside the subtree, principals with a role in it.
					return await ports.forgeEvents.read(since, [...patterns], {
						limit: n,
						subtreeNodeId: props.node.id,
					});
				}
				const node = await confineRepo(
					{ id: ref.slice("repo:".length) },
					"stream",
				);
				await requirePermission(node, "read");
				return await ports.repo(node.id).events.read({
					since,
					limit: n,
					patterns: [...patterns],
					includeShadow: props.mode === "shadow",
				}) as Envelope[];
			},
		},

		notify: {
			send: async (principal, n) => {
				gate("notify.send");
				const recipient = parse(PrincipalIdSchema, principal, "principal");
				const kind = parse(NoticeKindSchema, n?.kind, "kind");
				const severity = parse(SeveritySchema, n?.severity, "severity");
				if (
					typeof n.text !== "string" || n.text.length === 0 ||
					n.text.length > 4096
				) {
					throw invalid("text: 1–4096 characters");
				}
				if (
					n.dedupeKey !== undefined &&
					(typeof n.dedupeKey !== "string" || n.dedupeKey.length > 160)
				) {
					throw invalid("dedupeKey: at most 160 characters");
				}
				const node = n.repo !== undefined
					? await confineRepo(n.repo)
					: props.repo !== undefined
					? await confineRepo({ id: props.repo })
					: await installationNode();
				const laneId = n.laneId === undefined
					? undefined
					: parse(LaneIdSchema, n.laneId, "laneId");
				if (laneId !== undefined) {
					if (node.kind !== "repo") throw invalid("laneId needs a repo");
					await requireLane(node, laneId);
				}
				// K12: the recipient must hold a role inside the subtree.
				const recipientRole = await ports.effectiveRole([recipient], node.id);
				if (recipientRole < PERMISSION_MIN_ROLE["read-metadata"]) {
					throw denied(
						"scope",
						"notify.send: the recipient holds no role inside the installation subtree",
					);
				}
				await requireRoleAt(
					node,
					PERMISSION_MIN_ROLE["read-metadata"],
					"notify",
				);
				takeEffect("notify.send");
				await ports.deliverNotice(recipient, {
					...(node.kind === "repo" ? { repoId: node.id } : {}),
					...(laneId ? { laneId } : {}),
					kind,
					severity,
					text: sanitizeNoticeText(n.text),
					...(n.data === undefined ? {} : { data: n.data }),
					...(n.dedupeKey ? { dedupeKey: `${props.inst}:${n.dedupeKey}` } : {}),
					source: props.inst,
					sourceLabel: props.extId.split(".").pop() ?? props.extId,
				});
			},
		},

		authz: {
			check: async (principal, node, perm) => {
				gate("authz.check");
				const who = parse(PrincipalIdSchema, principal, "principal");
				const permission = parse(PermissionSchema, perm, "perm");
				const target = await confine(node, "node");
				const role = await ports.effectiveRole([who], target.id);
				return role >= PERMISSION_MIN_ROLE[permission];
			},
		},

		principals: {
			get: async (id) => {
				gate("principals.get");
				const who = parse(PrincipalIdSchema, id, "id");
				const info = await ports.principal(who);
				if (info === null) throw notFound(`principal ${who} not found`);
				// Never an email: copy the declared fields only.
				return {
					id: info.id,
					kind: info.kind,
					handle: info.handle,
					display: info.display,
					...(info.agentTool ? { agentTool: info.agentTool } : {}),
					...(info.agentModel ? { agentModel: info.agentModel } : {}),
					...(info.ownerUserId ? { ownerUserId: info.ownerUserId } : {}),
				};
			},
			presence: async (repo) => {
				gate("principals.presence");
				const node = await confineRepo(repo);
				await requirePermission(node, "read");
				return await ports.presence(node.id);
			},
		},

		interfaces: {
			provider: async (iface, at) => {
				gate("interfaces.provider");
				const id = parse(InterfaceIdSchema, iface, "iface");
				const target = await confine(
					at ?? (props.repo ? { id: props.repo } : { id: props.node.id }),
					"at",
				);
				await requirePermission(target, "read");
				const provider = await ports.provider(id, target.id);
				return provider === null ? null : {
					installation: provider.installation.id,
					extension: provider.installation.extId,
					self: provider.installation.id === props.inst,
				};
			},
			call: async (iface, tool, args, at) => {
				const id = parse(InterfaceIdSchema, iface, "iface");
				const definition = (INTERFACES as Readonly<
					Record<string, InterfaceDef | undefined>
				>)[id];
				const def = definition?.tools[String(tool)];
				// Unknown tools are treated as mutating for the policy check.
				gate("interfaces.call", def?.mutating ?? true);
				if (def === undefined) {
					throw invalid(`interfaces.call: ${id} has no tool ${String(tool)}`);
				}
				if (!(props.grants["interfaces.call"] ?? []).includes(id)) {
					throw denied("grant", `interfaces.call: ${id} is not granted`);
				}
				const target = await confine(
					at ?? (props.repo ? { id: props.repo } : { id: props.node.id }),
					"at",
				);
				await requireRoleAt(target, def.role, `${id} ${String(tool)}`);
				const input = parse(def.input, args, `${String(tool)} input`);
				const provider = await ports.provider(id, target.id);
				if (provider === null) {
					throw notFound(`no ${id} provider in force at ${target.path}`);
				}
				const chain = [...(props.callChain ?? []), props.inst];
				if (chain.includes(provider.installation.id)) {
					throw conflict("call cycle");
				}
				if (def.mutating) takeEffect("interfaces.call");
				if (
					provider.installation.storageScope === "repo" &&
					target.kind !== "repo"
				) {
					throw invalid(`${id} is provided per repo: name a repo with "at"`);
				}
				const toolCtx: ToolContext = {
					node: target.id,
					...(target.kind === "repo" ? { repo: target.id } : {}),
					scope: target.path,
					actor,
					mode: provider.installation.mode === "shadow" ? "shadow" : "enforce",
				};
				const bounds: ActorBounds = props.bounds ?? {
					maxRole: props.backgroundRole,
					scopes: null,
					nodeId: props.node.id,
					laneId: null,
				};
				const out = await ports.callTool(
					{
						installationId: provider.installation.id,
						scope: provider.installation.storageScope === "repo"
							? { kind: "repo", repoId: target.id }
							: { kind: "node" },
					},
					String(tool),
					input,
					toolCtx,
					bounds,
					chain,
				);
				const checked = def.output.safeParse(out);
				if (!checked.success) {
					throw new TartanError(
						"internal",
						`${id} ${String(tool)}: the provider returned an invalid result`,
					);
				}
				return checked.data;
			},
		},

		timers: {
			set: (key, atMs) =>
				settle(() => {
					gate("timers.set");
					if (typeof key !== "string" || !TIMER_KEY_RE.test(key)) {
						throw invalid("timers.set: key matches [A-Za-z0-9:._/-]{1,128}");
					}
					if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
						throw invalid("timers.set: atMs must be a finite number");
					}
					if (local.timers === undefined) {
						throw unavailable("timers are applied by the host");
					}
					takeEffect("timers.set");
					local.timers.set(key, atMs);
				}),
			clear: (key) =>
				settle(() => {
					gate("timers.clear");
					if (typeof key !== "string" || !TIMER_KEY_RE.test(key)) {
						throw invalid("timers.clear: key matches [A-Za-z0-9:._/-]{1,128}");
					}
					if (local.timers === undefined) {
						throw unavailable("timers are applied by the host");
					}
					local.timers.clear(key);
				}),
		},

		agents: {
			dispatch: async () => {
				gate("agents.dispatch");
				return await Promise.reject(
					unavailable("agents.dispatch is not part of v1"),
				);
			},
		},

		ai: {
			json: async <T>(modelVar: string, prompt: string, schema: object) => {
				gate("ai.json");
				const model = ports.modelVar(String(modelVar));
				if (model === undefined || model.length === 0) {
					throw invalid(`ai.json: unknown model var ${String(modelVar)}`);
				}
				if (
					typeof prompt !== "string" || byteLength(prompt) > PROMPT_MAX_BYTES
				) {
					throw invalid(`ai.json: prompt at most ${PROMPT_MAX_BYTES} bytes`);
				}
				if (schema === null || typeof schema !== "object") {
					throw invalid("ai.json: schema must be a JSON Schema object");
				}
				return await ports.ai(model, prompt, schema) as T;
			},
		},

		clock: {
			now: () => {
				gate("clock.now");
				return local.clock.now();
			},
		},

		ids: {
			ulid: () => {
				gate("ids.ulid");
				return local.ids.ulid();
			},
		},
	};

	// Every method of the policy table is implemented.
	for (const method of Object.keys(CAPS_METHOD_POLICY) as CapsMethod[]) {
		const [ns, name] = method.split(".") as [keyof KernelCaps, string];
		if (typeof (caps[ns] as Record<string, unknown>)[name] !== "function") {
			throw new TartanError("internal", `caps: ${method} is not implemented`);
		}
	}
	return caps;
};
