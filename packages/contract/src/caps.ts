// KernelCaps: the capability surface every extension uses.
// v0.2; additive only from here on.
//
// Every RepoRef / NodeRef / GitSource / StreamRef / LaneId argument is
// confined to the installation subtree (K12); violations throw
// `denied("scope")`. `CAPS_METHOD_POLICY` (below) is the single table of
// which manifest permission grants each method and which methods are effects
// (denied in a read-only ExtCtx) or denied in shadow mode; WP7b's
// `createKernelCaps` and WP1's `FakeKernelCaps` both enforce it. Builtins get
// the in-process implementation (`createKernelCaps(props, env)`), js/wasm get
// a `KernelCaps` WorkerEntrypoint stub minted per call with these props.
//
// Id-keyed methods (lanes, runs, land batches) take an optional `{repo}`: a
// repo-scoped installation defaults to its own repo (`CapsProps.repo`); a
// node-scoped installation must name the repo, else `invalid("repo required")`.
// The repo is confined like any RepoRef.

import type {
	Actor,
	ActorBounds,
	EntityRef,
	EventId,
	Footprint,
	GitSource,
	InstallMode,
	InterfaceId,
	LaneId,
	NodeRef,
	Permission,
	PrincipalId,
	ProvidableInterface,
	RepoRef,
	StreamRef,
} from "./common.ts";
import type { DeniedReason } from "./errors.ts";
import type { Envelope } from "./events.ts";
import type {
	Affected,
	BlameRange,
	CommitMeta,
	FileDiff,
	FileHunks,
	LaneRange,
	Merge3Input,
	Merge3Result,
	PathDiff,
	ProjectGraph,
	RepoInfo,
	TreeEntry,
} from "./git.ts";
import type { LandRequest, LandStatus, LandVerdict } from "./land.ts";
import type { ArchiveResult, Lane, LaneState, SyncResult } from "./lanes.ts";
import type { ManifestPermissions } from "./manifest.ts";
import type { NoticeKind, Presence } from "./notices.ts";
import type { CiJobGraphInput, RunStatus } from "./pipeline.ts";
import type { RepoPolicyAnswer } from "./repoconfig.ts";

export const MERGE3_MAX_PER_CALL = 40;
export const NOTE_SECTION_MAX_BYTES = 8 * 1024;

export type PrincipalInfo = {
	readonly id: PrincipalId;
	readonly kind: "user" | "agent" | "ext" | "system";
	readonly handle: string;
	readonly display: string;
	/** Self-asserted agent labels, shown as such. Never an email. */
	readonly agentTool?: string;
	readonly agentModel?: string;
	readonly ownerUserId?: PrincipalId;
};

export type NotifyInput = {
	readonly repo?: RepoRef;
	readonly laneId?: LaneId;
	readonly kind: NoticeKind;
	readonly severity: "info" | "warn" | "critical";
	readonly text: string;
	readonly data?: unknown;
	readonly dedupeKey?: string;
};

export type EmitOptions = {
	readonly subject?: EntityRef;
	readonly correlation?: string;
	readonly repo?: RepoRef;
	/**
	 * Caller idempotency key. The host prefixes it with the installation
	 * id, so a retried tool call or timer tick appends at most one event per
	 * key. Without it, events from `callTool`/`onTimer` (no `causedBy`)
	 * get a fresh key.
	 */
	readonly idemKey?: string;
};

/** The repo of an id-keyed call: optional for repo-scoped installations. */
export type RepoTarget = { readonly repo?: RepoRef };

/** Stretch (not in v1). */
export type DispatchRequest = {
	readonly kind: "resolver" | "worker";
	readonly repo: RepoRef;
	readonly laneId?: LaneId;
	readonly prompt: string;
	readonly tool: string;
	readonly model?: string;
	readonly budget?: {
		readonly wallMs?: number;
		readonly turns?: number;
		readonly tokens?: number;
	};
};

export interface KernelCaps {
	repo: {
		info(repo: RepoRef): Promise<RepoInfo>;
		resolveRef(repo: RepoRef, ref: string): Promise<string | null>;
		/** Canonical only (K13: policy is read from trunk, never from a lane). */
		readFile(
			repo: RepoRef,
			ref: string,
			path: string,
			maxBytes?: number,
		): Promise<Uint8Array | null>;
		/**
		 * `source` reads a lane's tree: its lane repo on the `repo`
		 * backend, the canonical repo on `branch`; default canonical.
		 */
		readTree(
			repo: RepoRef,
			ref: string,
			path: string,
			source?: GitSource,
		): Promise<TreeEntry[]>;
		log(repo: RepoRef, ref: string, limit?: number): Promise<CommitMeta[]>;
		diffPaths(source: GitSource, base: string, head: string): Promise<PathDiff>;
		hunks(
			source: GitSource,
			base: string,
			head: string,
			paths: string[],
		): Promise<FileHunks[]>;
		/** ≤ 40 per call. */
		merge3(input: Merge3Input[]): Promise<Merge3Result[]>;
		/**
		 * The lane's current range (K17): `rangeBase` = the merge base of its
		 * head with trunk, walked in the repo that holds the head. Runs or
		 * awaits phase 2 of push recording for the current head (idempotent).
		 */
		laneRange(laneId: LaneId, o?: RepoTarget): Promise<LaneRange>;
		/** Diff-of-diffs between two sources. */
		diff(
			a: GitSource & { sha: string },
			b: GitSource & { sha: string },
		): Promise<FileDiff[]>;
		projectGraph(repo: RepoRef, sha: string): Promise<ProjectGraph>;
		affected(
			repo: RepoRef,
			base: string,
			head: string,
			source?: GitSource,
		): Promise<Affected>;
		/** `source` hashes a lane's subtree (CI input hashes of a revision); default canonical. */
		treeHash(
			repo: RepoRef,
			sha: string,
			path: string,
			source?: GitSource,
		): Promise<string | null>;
		/** M2: container job + R2 cache. */
		blame(repo: RepoRef, sha: string, path: string): Promise<BlameRange[]>;
		/**
		 * Repo policy (ADR repo config, K13): the calling extension's own
		 * `config.repoPolicy` keys from the repository's package `tartan` in
		 * force at `at`, which must be a trunk commit (a lane head, revision or
		 * candidate is `denied("policy-not-trunk")`). Never runs CUE, never
		 * waits: `pending` means retry on `repo.config.resolved`. The values
		 * are repository-controlled; the caller validates them.
		 */
		policy(repo: RepoRef, at: string): Promise<RepoPolicyAnswer>;
	};
	/**
	 * Every mutating method is enforced by K16 inside the RepoDO operation's
	 * own transaction (`denied("lane-op")`, ⇒ `lane.denied`). The caps host
	 * (WP7b) passes the `LaneOpActor` it builds from `CapsProps` (the acting
	 * principal and the calling installation); these signatures carry no
	 * actor.
	 * A caller-side pre-check (`authorizeLaneOp`) is never the enforcement
	 * point.
	 */
	lanes: {
		/**
		 * `owner` must be the acting principal or its `onBehalfOf`: an
		 * installation never opens or adopts a lane for someone else, else
		 * `denied("actor")`. A background call (installation actor) is denied.
		 * Lane caps apply (`denied("lane-cap")`). The kernel picks the backend.
		 * Resolves **at once** with the lane `opening` (`repo` backend) or
		 * `open` (`branch`): it never waits for a seed inside an extension
		 * call; react to `lane.opened` (or `lane.closed`) instead.
		 */
		open(
			o: {
				repo: RepoRef;
				entity?: EntityRef;
				owner: PrincipalId;
				footprint?: Footprint;
			},
		): Promise<Lane>;
		/** Same owner rule as `open`. */
		adopt(
			o: { repo: RepoRef; ref: string; owner: PrincipalId; entity?: EntityRef },
		): Promise<Lane>;
		get(laneId: LaneId, o?: RepoTarget): Promise<Lane>;
		list(
			f: {
				repo: RepoRef;
				state?: LaneState[];
				owner?: PrincipalId;
				entity?: EntityRef;
			},
		): Promise<Lane[]>;
		/** Owner, delegate or Maintainer+. Closing an `opening` lane fences its seed. */
		close(laneId: LaneId, reason: string, o?: RepoTarget): Promise<void>;
		/**
		 * Owner or Maintainer+. The `ref.advance` gates run advisory
		 * first; a veto keeps only the summary. `repo` backend: the lane repo
		 * itself is the attic until the repo's attic retention ends (`atticRef`
		 * is ignored); `branch`: the attic ref `atticRef` (below
		 * `refs/tartan/attic/`) is written.
		 */
		archive(
			laneId: LaneId,
			o?: RepoTarget & { atticRef?: string },
		): Promise<ArchiveResult>;
		/** Owner only (K16): add or remove delegates. */
		delegate(
			laneId: LaneId,
			d: { add?: PrincipalId[]; remove?: PrincipalId[] },
			o?: RepoTarget,
		): Promise<void>;
		/** M2. Owner or delegate; refused while `landing`. */
		sync(laneId: LaneId, o?: RepoTarget): Promise<SyncResult>;
		/** M2. The lane's owner; `onto` an active lane of the same repo. */
		restack(
			laneId: LaneId,
			onto: LaneId,
			o?: RepoTarget,
		): Promise<SyncResult>;
	};
	land: {
		/**
		 * queue@1 only; idempotent on the caller-minted batchId. Caps
		 * checks that the installation's `land` grant covers `r.ref` before
		 * calling RepoDO (RepoDO validates K1–K5, not grants).
		 */
		submit(r: LandRequest): Promise<{ batchId: string }>;
		status(batchId: string, o?: RepoTarget): Promise<LandStatus>;
		/** checks@1 with `land.report`; rejected unless attempt + candidateSha match (K14). */
		report(batchId: string, v: LandVerdict, o?: RepoTarget): Promise<void>;
	};
	runs: {
		/**
		 * CI only: `kind: "ci"`, jobs with `run`, `source.repoId` = the
		 * resolved `repo`. Kernel git jobs are unreachable from extensions.
		 * Idempotent on idemKey.
		 */
		start(
			g: CiJobGraphInput & { idemKey: string },
		): Promise<{ runId: string }>;
		get(runId: string, o?: RepoTarget): Promise<RunStatus>;
		cancel(runId: string, o?: RepoTarget): Promise<void>;
		logs(
			runId: string,
			jobId: string,
			o?: RepoTarget & { tailBytes?: number },
		): Promise<string>;
	};
	notes: {
		/** ≤ 8 KB, merged into the why note at Advance. */
		contribute(
			repo: RepoRef,
			changeId: string,
			section: unknown,
		): Promise<void>;
	};
	events: {
		/** Caps checks K10 `mayEmit` before appending; RepoDO re-checks the type namespace. */
		emit(type: string, data: unknown, o?: EmitOptions): Promise<EventId>;
		read(
			stream: StreamRef,
			since: number,
			patterns: string[],
			limit?: number,
		): Promise<Envelope[]>;
	};
	notify: {
		/** Recipient needs a role in the subtree; text sanitized. */
		send(principal: PrincipalId, n: NotifyInput): Promise<void>;
	};
	authz: {
		/** Node confined (K12). */
		check(
			principal: PrincipalId,
			node: NodeRef,
			perm: Permission,
		): Promise<boolean>;
	};
	principals: {
		/** No email, ever. */
		get(id: PrincipalId): Promise<PrincipalInfo>;
		presence(repo: RepoRef): Promise<Presence[]>;
	};
	interfaces: {
		/**
		 * Background: as `x_<inst>` at `background_role`. Interactive: as the
		 * actor, bounded by `CapsProps.bounds`. In a read-only ExtCtx only
		 * tools with `mutating: false` may be called.
		 */
		call(
			iface: InterfaceId,
			tool: string,
			args: unknown,
			at?: NodeRef,
		): Promise<unknown>;
		/**
		 * The provider of `iface` in force at `at` (default: the installation's
		 * repo, else its node), or null when none is; `self` says whether it is the
		 * calling installation (a queue@1 provider that was replaced or masked
		 * hands over). Needs `read` at `at`, no grant.
		 */
		provider(
			iface: InterfaceId,
			at?: NodeRef,
		): Promise<InterfaceProvider | null>;
	};
	timers: {
		set(key: string, atMs: number): Promise<void>;
		clear(key: string): Promise<void>;
	};
	/** Stretch; not in v1. */
	agents: { dispatch(d: DispatchRequest): Promise<{ runId: string }> };
	/** Builtin-only. */
	ai: { json<T>(modelVar: string, prompt: string, schema: object): Promise<T> };
	clock: { now(): number };
	ids: { ulid(): string };
}

/** `caps.interfaces.provider`: who provides an interface at a node. */
export type InterfaceProvider = {
	readonly installation: string;
	/** The provider's extension id, e.g. `tartan.fifo`. */
	readonly extension: string;
	/** The calling installation is the provider. */
	readonly self: boolean;
};

export type CapsNamespace = keyof KernelCaps;

/** `<namespace>.<method>` for every KernelCaps method. */
export type CapsMethod = {
	[N in CapsNamespace]: `${N}.${keyof KernelCaps[N] & string}`;
}[CapsNamespace];

/**
 * Per-method policy:
 * - `grant(perms)`: the installation's approved permissions allow the method
 *   at all (fine-grained arguments, such as event patterns, `land` refs or
 *   `interfaces.call` ids, are checked per call as well);
 * - `effect`: denied with `denied("read-only")` in a read-only ExtCtx (render
 *   and context); `"tool"` = an effect when the called tool is mutating;
 * - `shadowDenied`: denied with `denied("shadow")` for a shadow installation.
 */
export type CapsMethodPolicy = {
	readonly grant: (perms: ManifestPermissions) => boolean;
	readonly effect: boolean | "tool";
	readonly shadowDenied: boolean;
};

const always = (): boolean => true;
const repoRead = (p: ManifestPermissions): boolean => p.repo === "read";
const laneGrant =
	(perm: NonNullable<ManifestPermissions["lanes"]>[number]) =>
	(p: ManifestPermissions): boolean => (p.lanes ?? []).includes(perm);
const anyRuns = (p: ManifestPermissions): boolean => (p.runs ?? []).length > 0;

const read = (grant: CapsMethodPolicy["grant"]): CapsMethodPolicy => ({
	grant,
	effect: false,
	shadowDenied: false,
});
const effect = (
	grant: CapsMethodPolicy["grant"],
	shadowDenied: boolean,
): CapsMethodPolicy => ({ grant, effect: true, shadowDenied });

export const CAPS_METHOD_POLICY: Readonly<
	Record<CapsMethod, CapsMethodPolicy>
> = {
	"repo.info": read(repoRead),
	"repo.resolveRef": read(repoRead),
	"repo.readFile": read(repoRead),
	"repo.readTree": read(repoRead),
	"repo.log": read(repoRead),
	"repo.diffPaths": read(repoRead),
	"repo.hunks": read(repoRead),
	"repo.merge3": read(repoRead),
	"repo.laneRange": read(repoRead),
	"repo.diff": read(repoRead),
	"repo.projectGraph": read(repoRead),
	"repo.affected": read(repoRead),
	"repo.treeHash": read(repoRead),
	"repo.blame": read(repoRead),
	"repo.policy": read(repoRead),
	"lanes.open": effect(laneGrant("open"), true),
	"lanes.adopt": effect(laneGrant("adopt"), true),
	// Reading lanes needs repo read or any lane permission (tartan.changes
	// holds only `lanes: ["adopt"]` and reads lane base/head on submit).
	"lanes.get": read((p) => repoRead(p) || (p.lanes ?? []).length > 0),
	"lanes.list": read((p) => repoRead(p) || (p.lanes ?? []).length > 0),
	"lanes.close": effect(laneGrant("close"), true),
	"lanes.archive": effect(laneGrant("archive"), true),
	"lanes.delegate": effect(laneGrant("delegate"), true),
	"lanes.sync": effect(laneGrant("sync"), true),
	"lanes.restack": effect(laneGrant("restack"), true),
	"land.submit": effect((p) => (p.land ?? []).length > 0, true),
	"land.status": read((p) =>
		(p.land ?? []).length > 0 || p["land.report"] === true
	),
	"land.report": effect((p) => p["land.report"] === true, true),
	"runs.start": effect((p) => (p.runs ?? []).includes("start"), true),
	"runs.get": read(anyRuns),
	"runs.cancel": effect((p) => (p.runs ?? []).includes("cancel"), true),
	"runs.logs": read(anyRuns),
	"notes.contribute": effect((p) => p.notes === true, false),
	"events.emit": effect(always, false),
	"events.read": read((p) => (p["events.read"] ?? []).length > 0),
	"notify.send": effect((p) => p.notify === true, true),
	"authz.check": read(always),
	"principals.get": read(always),
	"principals.presence": read(always),
	"interfaces.call": {
		grant: (p) => (p["interfaces.call"] ?? []).length > 0,
		effect: "tool",
		shadowDenied: false,
	},
	"interfaces.provider": read(always),
	"timers.set": effect(always, false),
	"timers.clear": effect(always, false),
	"agents.dispatch": effect(
		(p) => (p["agents.dispatch"] ?? []).length > 0,
		true,
	),
	"ai.json": read((p) => p.ai === true),
	"clock.now": read(always),
	"ids.ulid": read(always),
};

export const CAPS_METHODS = Object.keys(CAPS_METHOD_POLICY) as CapsMethod[];

/**
 * The namespace-level gate of a call, or null when allowed: `grant` first,
 * then shadow mode, then read-only (`mutatingTool` decides `interfaces.call`).
 * Per-argument checks (K12 confinement, event patterns, land refs, interface
 * ids, actor rules) come after this.
 */
export const capsDenial = (
	method: CapsMethod,
	call: {
		readonly grants: ManifestPermissions;
		readonly mode: InstallMode;
		readonly readOnly: boolean;
		readonly mutatingTool?: boolean;
	},
): DeniedReason | null => {
	const policy = CAPS_METHOD_POLICY[method];
	if (!policy.grant(call.grants)) return "grant";
	if (call.mode === "shadow" && policy.shadowDenied) return "shadow";
	const isEffect = policy.effect === "tool"
		? call.mutatingTool !== false
		: policy.effect;
	if (call.readOnly && isEffect) return "read-only";
	return null;
};

/** Per-call props of `createKernelCaps` / the `KernelCaps` entrypoint. */
export type CapsProps = {
	readonly inst: string;
	readonly extId: string;
	readonly version: string;
	readonly scopeKey: string;
	/** The installation's node (its subtree is the confinement boundary). */
	readonly node: { readonly id: string; readonly path: string };
	/** Repo id for repo-scoped installations (default target of id-keyed calls). */
	readonly repo?: string;
	/** Approved permissions (`installations.grants_json`), written by WP7a, read by WP7b. */
	readonly grants: ManifestPermissions;
	readonly backgroundRole: 10 | 20 | 30 | 40;
	/**
	 * The acting principal: `x_<inst>` for init, onEvent, onTimer, gate
	 * and echo (background: grants at `backgroundRole`); the user or agent for
	 * action, callTool and context (interactive: grants ∩ actor role ∩
	 * `bounds`). Render runs read-only as the viewer.
	 */
	readonly actor: Actor;
	readonly onBehalfOf?: PrincipalId;
	/**
	 * Credential bounds of an interactive actor (token ceiling, scopes, node
	 * subtree, lane pin, delegation), from its AuthContext; null for the
	 * installation actor. Caps applies `boundRole` and `scopesAllow` to it.
	 * Never visible to the extension.
	 */
	readonly bounds: ActorBounds | null;
	/** Informational: who caused this call, e.g. the event's actor in onEvent. Never acted as. */
	readonly trigger?: Actor;
	readonly causedBy?: EventId;
	readonly depth: number;
	readonly mode: InstallMode;
	readonly readOnly: boolean;
	/**
	 * Installation ids of the `interfaces.call` chain that led here, outermost
	 * first. The host rejects a call that would re-enter an installation
	 * already on the chain (a mutex deadlock) with `conflict("call cycle")`.
	 */
	readonly callChain?: readonly string[];
	/**
	 * The manifest's `provides`, so the KernelCaps entrypoint checks K10
	 * `mayEmit` and `land.submit` without reading the registry (WP7b).
	 */
	readonly provides?: readonly ProvidableInterface[];
};
