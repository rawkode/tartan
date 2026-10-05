// In-memory fakes of the kernel ports (`KernelPorts`) and ForgeDO's registry
// (`InstallationSource`) for the WP7b host, caps and dispatch tests. TEST
// FIXTURE: production code never imports it; it has no platform imports, so
// the Deno tests and the workerd pool share it. WP1's `@tartan/testkit` will
// supersede these when it lands.
//
// The fake tree has an installation subtree `acme` (a group, the repo
// `acme/router` and the group `acme/platform`) and an outside repo
// `other/secret`; grants are per (principal, node) and inherit downwards.

import {
	type Actor,
	type AppendInput,
	createUlid,
	type EffectiveRole,
	type Envelope,
	extPrincipalId,
	type InstallationDto,
	isWithinPath,
	type Lane,
	type Manifest,
	matchesAnyPattern,
	type NoticeInput,
	type PrincipalInfo,
	type ToolContext,
} from "@tartan/contract";
import type { InstallationInForce } from "@tartan/contract/kernel.ts";
import type {
	KernelPorts,
	NoticeDelivery,
	PortNode,
	RepoPorts,
	SourceReader,
	ToolTarget,
} from "../../../caps/ports.ts";
import type {
	InstallationSnapshot,
	InstallationSource,
} from "../installation.ts";

/** A fixed, valid lowercase ULID per number (test ids). */
export const fixedUlid = (n: number): string =>
	`01k6${String(n).padStart(22, "0")}`;

export const NODES = {
	acme: { id: fixedUlid(1), path: "acme", kind: "group" },
	router: { id: fixedUlid(2), path: "acme/router", kind: "repo" },
	platform: { id: fixedUlid(3), path: "acme/platform", kind: "group" },
	platformApi: { id: fixedUlid(4), path: "acme/platform/api", kind: "repo" },
	other: { id: fixedUlid(5), path: "other", kind: "group" },
	secret: { id: fixedUlid(6), path: "other/secret", kind: "repo" },
} as const satisfies Record<string, PortNode>;

export const PRINCIPALS = {
	/** Developer at acme. */
	dev: `u_${fixedUlid(101)}`,
	/** Reporter at acme/router only. */
	reporter: `u_${fixedUlid(102)}`,
	/** No role inside acme; Owner of other. */
	outsider: `u_${fixedUlid(103)}`,
	/** An agent acting for `dev`, with no grants of its own. */
	agent: `a_${fixedUlid(104)}`,
	/** Maintainer at acme. */
	maintainer: `u_${fixedUlid(105)}`,
} as const;

export const INSTALLATION_ID = `i_${fixedUlid(201)}`;
export const OTHER_INSTALLATION_ID = `i_${fixedUlid(202)}`;
export const LANE_ID = `ln_${fixedUlid(301)}`;
export const SECRET_LANE_ID = `ln_${fixedUlid(302)}`;

export const userActor = (id: string): Actor => ({ kind: "user", id });
export const agentActor = (id: string, onBehalfOf?: string): Actor => ({
	kind: "agent",
	id,
	...(onBehalfOf ? { onBehalfOf } : {}),
});
export const installationActor = (inst = INSTALLATION_ID): Actor => ({
	kind: "ext",
	id: extPrincipalId(inst),
});

export type PortCall = {
	readonly port: string;
	readonly args: readonly unknown[];
};

const ulid = createUlid();

/** An envelope with defaults (repo stream of `acme/router`). */
export const makeEvent = (
	partial: Partial<Envelope> & Pick<Envelope, "type" | "seq">,
): Envelope => ({
	id: ulid(),
	stream: `repo:${NODES.router.id}`,
	v: 1,
	source: { kind: "kernel" },
	actor: userActor(PRINCIPALS.dev),
	node: NODES.router.id,
	repo: NODES.router.id,
	depth: 0,
	shadow: false,
	at: Date.now(),
	data: {},
	...partial,
});

const laneOf = (id: string, repoId: string, owner: string): Lane => ({
	id,
	repoId,
	kind: "lane",
	mode: "branch",
	ref: `refs/heads/lanes/${id}`,
	branch: `lanes/${id}`,
	owner,
	delegates: [],
	footprint: { projects: [], prefixes: [] },
	base: "a".repeat(40),
	head: "b".repeat(40),
	state: "open",
	quarantined: false,
	leaseExpiresAt: Date.now() + 60_000,
	pushes: 1,
	createdAt: Date.now(),
	remote: `/${repoId}.git`,
});

export type FakeKernel = {
	readonly ports: KernelPorts;
	readonly calls: PortCall[];
	readonly nodes: Map<string, PortNode>;
	/** `(principal, nodeId) → role`, inherited by descendants. */
	readonly grants: Map<string, EffectiveRole>;
	readonly repoLogs: Map<string, Envelope[]>;
	readonly forgeLog: Envelope[];
	/**
	 * ForgeDO's subtree-filtered scan, modelled: at most `max` matching rows
	 * per read, `visible` the K12 filter (default: everything, unbounded).
	 */
	readonly forgeScan: { max: number; visible: (e: Envelope) => boolean };
	readonly appended: AppendInput[];
	readonly forgeAppended: unknown[];
	readonly notices: { principal: string; notice: NoticeDelivery }[];
	readonly lanes: Map<string, Lane>;
	readonly providers: Map<string, InstallationInForce>;
	readonly principals: Map<string, PrincipalInfo & { email?: string }>;
	/** `land.submit` behaviour (default: returns the batch id). */
	landSubmit: (
		request: unknown,
	) => Promise<{ batchId: string; created: boolean }>;
	/** `callTool` behaviour (interfaces.call). */
	callTool: (
		target: ToolTarget,
		name: string,
		args: unknown,
		ctx: ToolContext,
	) => Promise<unknown>;
	/** Files by `<repoId>:<sha>:<path>` for `reader().file`. */
	readonly files: Map<string, Uint8Array>;
	/** Adds an event to a repo log (seq assigned) and returns it. */
	addEvent(
		repoId: string,
		partial: Partial<Envelope> & Pick<Envelope, "type">,
	): Envelope;
	head(repoId: string): number;
	grant(principal: string, nodeId: string, role: EffectiveRole): void;
	called(port: string): PortCall[];
};

export const createFakeKernel = (): FakeKernel => {
	const calls: PortCall[] = [];
	const nodes = new Map<string, PortNode>(
		Object.values(NODES).map((n) => [n.id, n]),
	);
	const grants = new Map<string, EffectiveRole>();
	const repoLogs = new Map<string, Envelope[]>();
	const forgeLog: Envelope[] = [];
	const forgeScan = {
		max: Number.MAX_SAFE_INTEGER,
		visible: (_e: Envelope) => true,
	};
	const appended: AppendInput[] = [];
	const forgeAppended: unknown[] = [];
	const notices: { principal: string; notice: NoticeDelivery }[] = [];
	const lanes = new Map<string, Lane>([
		[LANE_ID, laneOf(LANE_ID, NODES.router.id, PRINCIPALS.agent)],
		[
			SECRET_LANE_ID,
			laneOf(SECRET_LANE_ID, NODES.secret.id, PRINCIPALS.outsider),
		],
	]);
	const providers = new Map<string, InstallationInForce>();
	const principals = new Map<string, PrincipalInfo & { email?: string }>([
		[PRINCIPALS.dev, {
			id: PRINCIPALS.dev,
			kind: "user",
			handle: "dev",
			display: "Dev",
			email: "dev@example.com",
		}],
	]);
	const files = new Map<string, Uint8Array>();
	const record = (port: string, args: unknown[]) => {
		calls.push({ port, args });
	};

	const logOf = (repoId: string): Envelope[] => {
		let log = repoLogs.get(repoId);
		if (log === undefined) {
			log = [];
			repoLogs.set(repoId, log);
		}
		return log;
	};

	const effectiveRole = (
		principalIds: readonly string[],
		nodeId: string,
	): EffectiveRole => {
		const node = nodes.get(nodeId);
		if (node === undefined) return 0;
		let best = 0;
		for (const [key, role] of grants) {
			const [principal, grantNode] = key.split("@");
			const granted = nodes.get(grantNode);
			if (
				principalIds.includes(principal) && granted !== undefined &&
				isWithinPath(granted.path, node.path) && role > best
			) {
				best = role;
			}
		}
		return best as EffectiveRole;
	};

	const fake: FakeKernel = {
		calls,
		nodes,
		grants,
		repoLogs,
		forgeLog,
		forgeScan,
		appended,
		forgeAppended,
		notices,
		lanes,
		providers,
		principals,
		files,
		landSubmit: (request) =>
			Promise.resolve({
				batchId: (request as { batchId: string }).batchId,
				created: true,
			}),
		callTool: () => Promise.resolve({}),
		addEvent: (repoId, partial) => {
			const log = logOf(repoId);
			const ev = makeEvent({
				stream: `repo:${repoId}`,
				node: repoId,
				repo: repoId,
				...partial,
				seq: log.length + 1,
			});
			log.push(ev);
			return ev;
		},
		head: (repoId) => logOf(repoId).length,
		grant: (principal, nodeId, role) => {
			grants.set(`${principal}@${nodeId}`, role);
		},
		called: (port) => calls.filter((c) => c.port === port),
		ports: undefined as unknown as KernelPorts,
	};

	const repo = (repoId: string): RepoPorts => ({
		core: {
			info: () => {
				record("core.info", [repoId]);
				return Promise.resolve({
					id: repoId,
					nodeId: repoId,
					path: nodes.get(repoId)?.path ?? "",
					defaultBranch: "main",
					visibility: "private",
					trunkSha: "c".repeat(40),
					landingPaused: false,
				});
			},
			resolveRef: (ref) => {
				record("core.resolveRef", [repoId, ref]);
				if (ref === "main") return Promise.resolve("c".repeat(40));
				const lane = lanes.get(ref);
				return Promise.resolve(
					lane?.repoId === repoId ? lane.head ?? null : null,
				);
			},
			getLane: (laneId) => {
				record("core.getLane", [repoId, laneId]);
				const lane = lanes.get(laneId);
				return Promise.resolve(lane?.repoId === repoId ? lane : null);
			},
			listLanes: (filter) => {
				record("core.listLanes", [repoId, filter]);
				return Promise.resolve({
					lanes: [...lanes.values()].filter((l) => l.repoId === repoId),
				});
			},
			openLane: (input) => {
				record("core.openLane", [repoId, input]);
				return Promise.resolve(
					laneOf(`ln_${fixedUlid(999)}`, repoId, input.owner),
				);
			},
			adoptLane: (input) => {
				record("core.adoptLane", [repoId, input]);
				return Promise.resolve(
					laneOf(`ln_${fixedUlid(998)}`, repoId, input.owner),
				);
			},
			closeLane: (...args) => {
				record("core.closeLane", [repoId, ...args]);
				return Promise.resolve();
			},
			archiveLane: (...args) => {
				record("core.archiveLane", [repoId, ...args]);
				return Promise.resolve({ kind: "summary" } as const);
			},
			delegateLane: (...args) => {
				record("core.delegateLane", [repoId, ...args]);
				return Promise.resolve();
			},
			syncLane: (...args) => {
				record("core.syncLane", [repoId, ...args]);
				return Promise.resolve({ ok: true, head: "d".repeat(40) });
			},
			restackLane: (...args) => {
				record("core.restackLane", [repoId, ...args]);
				return Promise.resolve({ ok: true, head: "d".repeat(40) });
			},
			laneRange: (laneId) => {
				record("core.laneRange", [repoId, laneId]);
				return Promise.resolve({
					head: "b".repeat(40),
					rangeBase: "a".repeat(40),
					rangeTruncated: false,
					diffKey: "k",
				});
			},
			laneFetchSpecs: (laneIds) => {
				record("core.laneFetchSpecs", [repoId, laneIds]);
				return Promise.resolve([]);
			},
		},
		events: {
			append: (input) => {
				record("events.append", [repoId, input]);
				appended.push(input);
				const log = logOf(repoId);
				const existing = log.find((e) =>
					(e as Envelope & { idemKey?: string }).idemKey === input.idemKey
				);
				if (existing !== undefined) {
					return Promise.resolve({
						id: existing.id,
						seq: existing.seq,
						hash: "0".repeat(64),
						created: false,
					});
				}
				const ev = {
					...makeEvent({
						type: input.type,
						seq: log.length + 1,
						stream: `repo:${repoId}`,
						source: input.source,
						actor: input.actor,
						node: input.node,
						repo: input.repo,
						depth: input.depth,
						shadow: input.shadow,
						data: input.data,
						...(input.causedBy ? { causedBy: input.causedBy } : {}),
						...(input.subject ? { subject: input.subject } : {}),
					}),
					idemKey: input.idemKey,
				};
				log.push(ev);
				return Promise.resolve({
					id: ev.id,
					seq: ev.seq,
					hash: "0".repeat(64),
					created: true,
				});
			},
			read: (query) => {
				record("events.read", [repoId, query]);
				const patterns = query.patterns ?? ["*"];
				return Promise.resolve(
					logOf(repoId)
						.filter((e) => e.seq > query.since)
						.filter((e) => query.includeShadow === true || !e.shadow)
						.filter((e) => matchesAnyPattern(patterns, e.type))
						.slice(0, query.limit ?? 100),
				);
			},
			head: () => Promise.resolve(logOf(repoId).length),
		},
		land: {
			submit: (request, requestedBy) => {
				record("land.submit", [repoId, request, requestedBy]);
				return fake.landSubmit(request);
			},
			status: (batchId) => {
				record("land.status", [repoId, batchId]);
				return Promise.resolve(null);
			},
			report: (...args) => {
				record("land.report", [repoId, ...args]);
				return Promise.resolve({ accepted: true });
			},
			contributeNote: (...args) => {
				record("land.contributeNote", [repoId, ...args]);
				return Promise.resolve();
			},
		},
		runs: {
			start: (input) => {
				record("runs.start", [repoId, input]);
				return Promise.resolve({ runId: "run_1" });
			},
			get: (runId) => {
				record("runs.get", [repoId, runId]);
				return Promise.resolve(null);
			},
			cancel: (...args) => {
				record("runs.cancel", [repoId, ...args]);
				return Promise.resolve();
			},
			logs: (...args) => {
				record("runs.logs", [repoId, ...args]);
				return Promise.resolve("");
			},
		},
		repoconfig: {
			policy: (...args) => {
				record("repoconfig.policy", [repoId, ...args]);
				return Promise.resolve({ state: "none" as const });
			},
		},
	});

	const reader = (repoId: string): SourceReader => ({
		commit: (sha) =>
			Promise.resolve({
				sha,
				treeSha: "e".repeat(40),
				subject: "s",
				message: "s",
				author: { name: "a", email: "a@example.com" },
				committer: { name: "a", email: "a@example.com" },
				parents: [],
				authoredAt: 0,
				committedAt: 0,
				trailers: [],
			}),
		tree: () =>
			Promise.resolve([{
				name: "README.md",
				mode: "100644",
				hash: "f".repeat(40),
				type: "blob",
			}]),
		file: (commit, path) =>
			Promise.resolve(files.get(`${repoId}:${commit}:${path}`) ?? null),
		log: () => Promise.resolve([]),
	});

	const ports: KernelPorts = {
		node: (ref) => {
			record("node", [ref]);
			const found = "id" in ref
				? nodes.get(ref.id)
				: [...nodes.values()].find((n) => n.path === ref.path);
			return Promise.resolve(found ?? null);
		},
		effectiveRole: (principalIds, nodeId) => {
			record("effectiveRole", [principalIds, nodeId]);
			return Promise.resolve(effectiveRole(principalIds, nodeId));
		},
		principal: (id) => {
			record("principal", [id]);
			return Promise.resolve(principals.get(id) ?? null);
		},
		provider: (iface, nodeId) => {
			record("provider", [iface, nodeId]);
			const node = nodes.get(nodeId);
			// Keys are `<iface>@<nodeId>`, and interface ids contain an `@` too.
			const found = [...providers.entries()].find(([key]) => {
				const cut = key.lastIndexOf("@");
				const i = key.slice(0, cut);
				const root = nodes.get(key.slice(cut + 1));
				return i === iface && node !== undefined && root !== undefined &&
					isWithinPath(root.path, node.path);
			});
			return Promise.resolve(found?.[1] ?? null);
		},
		repo,
		forgeEvents: {
			read: (since, patterns, options) => {
				record("forgeEvents.read", [since, patterns, options]);
				return Promise.resolve(
					forgeLog.filter((e) => e.seq > since)
						.filter((e) => matchesAnyPattern(patterns, e.type))
						.slice(0, options?.limit ?? 100),
				);
			},
			readPage: (since, patterns, options) => {
				record("forgeEvents.read", [since, patterns, options]);
				const limit = options?.limit ?? 100;
				// Like ForgeDO's subtree read: at most `forgeScanMax` matching rows.
				const matching = forgeLog.filter((e) => e.seq > since)
					.filter((e) => matchesAnyPattern(patterns, e.type));
				const scanned = matching.slice(0, forgeScan.max);
				const events: typeof forgeLog = [];
				let scannedTo = since;
				for (const e of scanned) {
					scannedTo = e.seq;
					if (forgeScan.visible(e)) events.push(e);
					if (events.length >= limit) break;
				}
				const reachedHead = events.length < limit &&
					scanned.length === matching.length;
				return Promise.resolve({
					events,
					scannedTo: reachedHead ? forgeLog.length : scannedTo,
				});
			},
			head: () => Promise.resolve(forgeLog.length),
			appendKernel: (event) => {
				record("forgeEvents.appendKernel", [event]);
				forgeAppended.push(event);
				return Promise.resolve({ id: ulid(), seq: forgeAppended.length });
			},
		},
		probe: {
			diffPaths: (...args) => {
				record("probe.diffPaths", args);
				return Promise.resolve({
					paths: [{ path: "a.ts", change: "modified" }],
					truncated: false,
				});
			},
			hunks: (...args) => {
				record("probe.hunks", args);
				return Promise.resolve([]);
			},
			merge3: (...args) => {
				record("probe.merge3", args);
				return Promise.resolve([]);
			},
			diff: (...args) => {
				record("probe.diff", args);
				return Promise.resolve([]);
			},
			projectGraph: (...args) => {
				record("probe.projectGraph", args);
				return Promise.resolve(
					{ sha: "c".repeat(40), projects: [], globalFiles: [] } as never,
				);
			},
			affected: (...args) => {
				record("probe.affected", args);
				return Promise.resolve({ projects: [], global: false } as never);
			},
			treeHash: (...args) => {
				record("probe.treeHash", args);
				return Promise.resolve(null);
			},
		},
		reader: (source) => {
			record("reader", [source]);
			return Promise.resolve(reader(source.repoId));
		},
		deliverNotice: (principal, notice) => {
			record("deliverNotice", [principal, notice]);
			notices.push({ principal, notice });
			return Promise.resolve();
		},
		presence: (repoId) => {
			record("presence", [repoId]);
			return Promise.resolve([]);
		},
		callTool: (target, name, args, ctx, bounds, chain) => {
			record("callTool", [target, name, args, ctx, bounds, chain]);
			return fake.callTool(target, name, args, ctx);
		},
		ai: (...args) => {
			record("ai", args);
			return Promise.resolve({ ok: true });
		},
		modelVar: (name) =>
			name === "TARTAN_JUDGE_MODEL" ? "@cf/test-model" : undefined,
	};
	(fake as { ports: KernelPorts }).ports = ports;

	// Default grants.
	fake.grant(PRINCIPALS.dev, NODES.acme.id, 30);
	fake.grant(PRINCIPALS.maintainer, NODES.acme.id, 40);
	fake.grant(PRINCIPALS.reporter, NODES.router.id, 20);
	fake.grant(PRINCIPALS.outsider, NODES.other.id, 50);
	return fake;
};

/** A notice as `notify.send` delivers it (assertion helper). */
export type DeliveredNotice = NoticeInput & { source: string };

export type FakeInstallations = InstallationSource & {
	snapshot: InstallationSnapshot | null;
	/** Replaces the installation (bumps `ext_version`). */
	set(
		update: (current: InstallationSnapshot) => InstallationSnapshot,
	): void;
	readonly loads: number;
};

export const installationDto = (
	manifest: Manifest,
	overrides: Partial<InstallationDto> = {},
): InstallationDto => ({
	id: INSTALLATION_ID,
	extId: manifest.id,
	version: manifest.version,
	nodeId: NODES.acme.id,
	nodePath: NODES.acme.path,
	mode: "enforce",
	storageScope: manifest.storage.scope,
	config: {},
	grants: manifest.permissions,
	backgroundRole: 20,
	locked: false,
	backfill: manifest.backfill,
	installedBy: PRINCIPALS.maintainer,
	installedAt: 0,
	...overrides,
});

export const createFakeInstallations = (
	manifest: Manifest,
	overrides: Partial<InstallationDto> = {},
): FakeInstallations => {
	let version = 1;
	let loads = 0;
	const state: { snapshot: InstallationSnapshot | null } = {
		snapshot: {
			installation: installationDto(manifest, overrides),
			manifest,
			sha256: "a".repeat(64),
			extVersion: version,
		},
	};
	return {
		get snapshot() {
			return state.snapshot;
		},
		set snapshot(value) {
			state.snapshot = value;
		},
		get loads() {
			return loads;
		},
		version: () => Promise.resolve(version),
		load: (id) => {
			loads += 1;
			const snap = state.snapshot;
			return Promise.resolve(
				snap !== null && snap.installation.id === id
					? { ...snap, extVersion: version }
					: null,
			);
		},
		set: (update) => {
			if (state.snapshot === null) throw new Error("no installation");
			version += 1;
			state.snapshot = { ...update(state.snapshot), extVersion: version };
		},
	};
};

/** An `InstallationInForce` for dispatch and provider tests. */
export const inForce = (
	manifest: Manifest,
	overrides: Partial<InstallationDto> = {},
	depth = 1,
): InstallationInForce => ({
	installation: installationDto(manifest, overrides),
	manifest,
	depth,
});
