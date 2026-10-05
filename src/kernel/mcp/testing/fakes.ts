// Test-only: an in-memory forge behind `McpPorts` (WP11 Deno tests).
//
// - Nodes, grants (an agent's owner user folded in, as the tree does) and
//   principals; WP3's `authorize` modelled with the contract's `boundRole`
//   and `scopesAllow`.
// - Installations from the real bundled manifests (`src/builtins.ts`), the
//   protocol cards given per installation, and WP7b's real
//   `createExtDispatchWith` for tool listing and routing.
// - ExtensionDO tool calls answered by scripted handlers (recorded).
// - RepoDO ports per repo: WP5a's real `core` (its Deno harness) where a test
//   passes one, otherwise a minimal fake.
// - An inbox per principal with `peek` marking delivered.
// Runtime code never imports this file.

import {
	type ActorBounds,
	boundRole,
	createUlid,
	denied,
	type EffectiveRole,
	type InstallationInForce,
	isWithinPath,
	type NodeDto,
	type NodeKind,
	type Notice,
	NOTICES_PER_RESULT,
	notImplemented,
	PERMISSION_MIN_ROLE,
	ROLE,
	type Role,
	sanitizeNoticeText,
	scopesAllow,
	selectNotices,
	stripControl,
	type ToolContext,
	unauthenticated,
	type Visibility,
} from "@tartan/contract";
import type {
	AuthContext,
	PrincipalRow,
	ResolvedPath,
} from "@tartan/contract/kernel.ts";
import { builtins } from "../../../builtins.ts";
import { createExtDispatchWith } from "../../exthost/host/fanout.ts";
import {
	acting,
	byNearest,
	providerOf,
	resolve,
} from "../../exthost/registry/resolve.ts";
import type {
	McpInbox,
	McpPorts,
	McpRepoPorts,
	McpToolTarget,
	ProtocolCard,
} from "../ports.ts";

export const ORIGIN = "https://code.example.test";

const ulid = createUlid();

export type ToolHandler = (
	args: unknown,
	ctx: ToolContext,
	bounds: ActorBounds,
) => unknown | Promise<unknown>;

export type ToolCall = {
	readonly target: McpToolTarget;
	readonly ext: string;
	readonly name: string;
	readonly args: unknown;
	readonly ctx: ToolContext;
	readonly bounds: ActorBounds;
	readonly startedAt: number;
	finishedAt?: number;
};

export type FakeInbox = McpInbox & {
	readonly notices: Notice[];
	readonly peeks: { via: string; repoId?: string }[];
};

export type FakeForge = {
	readonly ports: McpPorts;
	readonly nodes: Map<string, NodeDto>;
	readonly principals: Map<string, PrincipalRow>;
	readonly calls: ToolCall[];
	readonly logs: { message: string; data?: Record<string, unknown> }[];
	addNode(
		path: string,
		kind: NodeKind,
		options?: { id?: string; visibility?: Visibility },
	): NodeDto;
	nodeAt(path: string): NodeDto;
	addPrincipal(
		input: {
			id?: string;
			kind: "user" | "agent";
			handle: string;
			owner?: string;
			tool?: string;
		},
	): PrincipalRow;
	grant(principal: string, path: string, role: Role): void;
	/**
	 * Installs a bundled package at a node: one row, or a pack's own row
	 * then each member's (with the pack's member config). `card` goes to the
	 * first row (a pack's card); `bundledCards` gives every
	 * other row its bundled card, as the registry serves them.
	 */
	install(
		extId: string,
		path: string,
		options?: { card?: string; bundledCards?: boolean },
	): InstallationInForce[];
	/** Changes an installation's mode (a swap's disable step). */
	setMode(
		installationId: string,
		mode: "enforce" | "shadow" | "disabled",
	): void;
	/** Answers `name` for the installation of `extId`. */
	onTool(extId: string, name: string, handler: ToolHandler): void;
	setRepo(repoId: string, repo: Partial<McpRepoPorts>): void;
	inbox(principal: string): FakeInbox;
	/** Delivers a notice to a principal's inbox (sanitized on write, as InboxDO does). */
	notify(principal: string, notice: Partial<Notice> & { text: string }): Notice;
	/** Overrides the canonical origin (null = setup never recorded one). */
	setOrigin(origin: string | null): void;
	/** Replaces ports (a reader, RepoProbe, the context assembler). */
	override(ports: Partial<McpPorts>): void;
};

const notYet = (what: string) => () => Promise.reject(notImplemented(what));

export const authOf = (
	principal: string,
	extra: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: principal.startsWith("a_") ? "agent" : "user",
	via: principal.startsWith("a_") ? "agent-token" : "pat",
	scopes: ["repo:read", "repo:write", "lanes", "mcp"],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
	...extra,
});

export const createFakeForge = (): FakeForge => {
	const nodes = new Map<string, NodeDto>();
	const byPath = new Map<string, NodeDto>();
	const principals = new Map<string, PrincipalRow>();
	const grants = new Map<string, Map<string, Role>>();
	const installations: InstallationInForce[] = [];
	const cards = new Map<string, string>();
	const handlers = new Map<string, ToolHandler>();
	const calls: ToolCall[] = [];
	const repos = new Map<string, Partial<McpRepoPorts>>();
	const inboxes = new Map<string, FakeInbox>();
	const logs: { message: string; data?: Record<string, unknown> }[] = [];
	let origin: string | null = ORIGIN;
	let seq = 0;
	/** Install order (`installedAt`): at equal depth, the newer install is nearer. */
	let installSeq = 0;

	const ancestorsOrSelf = (node: NodeDto): NodeDto[] => {
		const parts = node.path.split("/");
		return parts.map((_, i) => byPath.get(parts.slice(0, i + 1).join("/")))
			.filter((n): n is NodeDto => n !== undefined);
	};

	const granted = (
		principalIds: readonly string[],
		nodeId: string,
	): EffectiveRole => {
		const node = nodes.get(nodeId);
		if (node === undefined) return 0;
		const who = new Set<string>();
		for (const p of principalIds) {
			who.add(p);
			const owner = principals.get(p)?.owner_user_id;
			if (owner) who.add(owner);
		}
		let role = 0;
		for (const n of ancestorsOrSelf(node)) {
			for (const p of who) role = Math.max(role, grants.get(p)?.get(n.id) ?? 0);
		}
		return role as EffectiveRole;
	};

	/** The registry query: non-disabled installations at the node or above. */
	const installed = (nodeId: string): InstallationInForce[] => {
		const node = nodes.get(nodeId);
		if (node === undefined) return [];
		return installations
			.filter((i) =>
				i.installation.mode !== "disabled" &&
				isWithinPath(i.installation.nodePath, node.path)
			)
			.sort(byNearest);
	};

	/** What the registry answers as in force (WP7a's own resolution). */
	const inForce = (nodeId: string): InstallationInForce[] =>
		acting(installed(nodeId));

	const provider = (iface: string, nodeId: string) =>
		providerOf(iface, installed(nodeId));

	const protocolCards = (nodeId: string): ProtocolCard[] =>
		resolve(installed(nodeId)).effective.flatMap((i) => {
			const md = cards.get(i.installation.id);
			return md === undefined
				? []
				: [{ installation: i.installation.id, ext: i.installation.extId, md }];
		});

	const portNode = (id: string) => {
		const n = nodes.get(id);
		return n === undefined ? null : { id: n.id, path: n.path, kind: n.kind };
	};

	const dispatchDeps = {
		clock: { now: () => Date.now() },
		inForce: (nodeId: string) => Promise.resolve(inForce(nodeId)),
		provider: (iface: string, nodeId: string) =>
			Promise.resolve(provider(iface, nodeId)),
		protocolCards: (nodeId: string) => Promise.resolve(protocolCards(nodeId)),
		host: () => {
			throw notImplemented("fake dispatch host");
		},
		lane: notYet("fake lane"),
		laneRange: notYet("fake laneRange"),
		addedLines: notYet("fake addedLines"),
		diffPaths: notYet("fake diffPaths"),
		node: (id: string) => Promise.resolve(portNode(id)),
		effectiveRole: (principalIds: readonly string[], nodeId: string) =>
			Promise.resolve(granted(principalIds, nodeId)),
	};
	const dispatch = createExtDispatchWith(dispatchDeps);
	const contextAnswer: Awaited<ReturnType<McpPorts["dispatch"]["context"]>> = {
		md: "## context\n",
		sections: [],
		budgetTokens: 6000,
		truncated: false,
	};

	/**
	 * WP3's `createNodeAccess`: the member role (grants, Reporter on
	 * `internal` for signed-in callers, then the bounds), and `read` /
	 * `read-metadata` for anyone on a `public` node (the public view).
	 */
	const access: McpPorts["access"] = (auth, target, perm) => {
		const node = nodes.get(target.node.id);
		if (node === undefined) return Promise.reject(denied("scope"));
		const min = PERMISSION_MIN_ROLE[perm];
		const anyone = node.visibility === "public" &&
				(perm === "read" || perm === "read-metadata")
			? ROLE.reporter
			: 0;
		if (auth === null) {
			if (anyone >= min) {
				return Promise.resolve({
					role: anyone as EffectiveRole,
					member: 0 as EffectiveRole,
				});
			}
			return Promise.reject(unauthenticated());
		}
		const bounds: ActorBounds = {
			maxRole: auth.maxRole,
			scopes: auth.via === "session" ? null : auth.scopes,
			nodeId: auth.nodeId,
			laneId: auth.laneId,
		};
		const root = auth.nodeId === null ? null : nodes.get(auth.nodeId);
		const floor = node.visibility === "internal" ? ROLE.reporter : 0;
		const member = boundRole(
			Math.max(granted([auth.principal], node.id), floor) as EffectiveRole,
			bounds,
			{
				withinTokenNode: root === null ||
					(root !== undefined && isWithinPath(root.path, node.path)),
				laneId: target.laneId ?? null,
			},
		);
		const scoped = scopesAllow(bounds.scopes, perm);
		const role = Math.max(scoped ? member : 0, anyone) as EffectiveRole;
		if (role < min) {
			return Promise.reject(
				scoped
					? denied("role", `${perm} needs role ${min}`)
					: denied("scopes", `${perm} needs a scope`),
			);
		}
		return Promise.resolve({
			role,
			member: scopesAllow(bounds.scopes, "read") ? member : 0 as EffectiveRole,
		});
	};
	const authorize: McpPorts["authorize"] = async (auth, target, perm) =>
		(await access(auth, target, perm)).role;

	const fakeRepo = (repoId: string): McpRepoPorts => {
		const given = repos.get(repoId) ?? {};
		return {
			core: given.core ?? {
				info: notYet("fake core.info"),
				resolveRef: (ref: string) =>
					Promise.resolve(/^[0-9a-f]{40}$/.test(ref) ? ref : "a".repeat(40)),
				readContext: () =>
					Promise.resolve({
						view: "public" as const,
						visibleTips: ["a".repeat(40)],
						recentTips: [],
						ownLanes: [],
					}),
				getLane: () => Promise.resolve(null),
				listLanes: () => Promise.resolve({ lanes: [] }),
				openLane: notYet("fake openLane"),
				closeLane: notYet("fake closeLane"),
				delegateLane: notYet("fake delegateLane"),
				syncLane: notYet("fake syncLane"),
				restackLane: notYet("fake restackLane"),
				awaitLane: notYet("fake awaitLane"),
			},
			events: given.events ?? {
				read: () => Promise.resolve([]),
				head: () => Promise.resolve(0),
			},
			runs: given.runs ?? {
				get: () => Promise.resolve(null),
				logs: () => Promise.resolve(""),
			},
			repoconfig: given.repoconfig ?? {
				state: notYet("fake repoconfig.state"),
				preview: notYet("fake repoconfig.preview"),
				previewByKey: () => Promise.resolve(null),
			},
			land: given.land ?? { why: () => Promise.resolve(null) },
		};
	};

	const inbox = (principal: string): FakeInbox => {
		const existing = inboxes.get(principal);
		if (existing !== undefined) return existing;
		const notices: Notice[] = [];
		const peeks: { via: string; repoId?: string }[] = [];
		const matches = (n: Notice, repoId?: string) =>
			repoId === undefined || n.repoId === undefined || n.repoId === repoId;
		const created: FakeInbox = {
			notices,
			peeks,
			peek: (limit, via, repoId) => {
				peeks.push({ via, ...(repoId ? { repoId } : {}) });
				const unread = selectNotices(
					notices.filter((n) =>
						n.deliveredAt === undefined && matches(n, repoId)
					),
					limit,
				);
				const at = Date.now();
				for (const n of unread) {
					const i = notices.indexOf(n);
					notices[i] = { ...n, deliveredAt: at, deliveredVia: via };
				}
				return Promise.resolve(
					unread.map((n) => ({ ...n, deliveredAt: at, deliveredVia: via })),
				);
			},
			read: (query) =>
				Promise.resolve(
					notices.filter((n) =>
						n.seq > (query.since ?? 0) && matches(n, query.repoId)
					).slice(0, query.limit ?? 50),
				),
			ack: (ids) => {
				let acked = 0;
				notices.forEach((n, i) => {
					if (ids.includes(n.id) && n.ackedAt === undefined) {
						notices[i] = { ...n, ackedAt: Date.now() };
						acked += 1;
					}
				});
				return Promise.resolve({ acked });
			},
			wait: (_timeoutMs, repoId, via = "mcp") =>
				created.peek(NOTICES_PER_RESULT, via, repoId),
			deliver: (input) => {
				const n = forge.notify(principal, {
					...input,
					text: input.text,
					source: input.source,
					...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
				});
				return Promise.resolve({ id: n.id, created: true });
			},
		};
		inboxes.set(principal, created);
		return created;
	};

	const ports: McpPorts = {
		canonicalOrigin: () => Promise.resolve(origin),
		resolvePath: (path) => {
			const node = byPath.get(path);
			if (node !== undefined) {
				return Promise.resolve({ node, rest: "" } satisfies ResolvedPath);
			}
			const parts = path.split("/");
			for (let i = parts.length - 1; i > 0; i--) {
				const prefix = byPath.get(parts.slice(0, i).join("/"));
				if (prefix !== undefined) {
					return Promise.resolve({
						node: prefix,
						rest: parts.slice(i).join("/"),
					});
				}
			}
			return Promise.resolve(null);
		},
		node: (id) => Promise.resolve(nodes.get(id) ?? null),
		listRepos: () =>
			Promise.resolve({
				repos: [...nodes.values()].filter((n) => n.kind === "repo").map((
					n,
				) => ({
					id: n.id,
					path: n.path,
				})),
			}),
		authorize,
		access,
		effectiveRole: (principalIds, nodeId) =>
			Promise.resolve(granted(principalIds, nodeId)),
		principal: (id) => Promise.resolve(principals.get(id) ?? null),
		principalByHandle: (handle) =>
			Promise.resolve(
				[...principals.values()].find((p) => p.handle === handle) ?? null,
			),
		protocolCards: (nodeId) => Promise.resolve(protocolCards(nodeId)),
		provider: (iface, nodeId) => Promise.resolve(provider(iface, nodeId)),
		dispatch: {
			tools: (scope, auth) => dispatch.tools(scope, auth),
			resolveTool: (scope, name, auth) =>
				dispatch.resolveTool(scope, name, auth),
			context: () => Promise.resolve(contextAnswer),
		},
		callTool: async (target, name, args, ctx, bounds) => {
			const inst = installations.find((i) =>
				i.installation.id === target.installationId
			);
			const ext = inst?.installation.extId ?? "?";
			const call: ToolCall = {
				target,
				ext,
				name,
				args,
				ctx,
				bounds,
				startedAt: Date.now(),
			};
			calls.push(call);
			const handler = handlers.get(`${ext}:${name}`);
			if (handler === undefined) {
				throw notImplemented(`${ext} tool ${name}`);
			}
			try {
				return await handler(args, ctx, bounds);
			} finally {
				call.finishedAt = Date.now();
			}
		},
		repo: fakeRepo,
		reader: () => Promise.reject(notImplemented("fake reader")),
		probe: {
			projectGraph: notYet("fake projectGraph"),
			affected: notYet("fake affected"),
		},
		repoConfigSchema: notYet("fake repoConfigSchema"),
		repoConfigEffective: (_repoId: string) =>
			Promise.resolve({ effective: [], approvals: [], epoch: 0 }),
		repoConfigEnabled: () => false,
		inbox,
		now: () => Date.now(),
		log: (message, data) => void logs.push({ message, data }),
	};

	const forge: FakeForge = {
		ports,
		nodes,
		principals,
		calls,
		logs,
		addNode: (path, kind, options = {}) => {
			const parent = path.includes("/")
				? byPath.get(path.slice(0, path.lastIndexOf("/")))
				: undefined;
			const node: NodeDto = {
				id: options.id ?? ulid(),
				parentId: parent?.id ?? null,
				kind,
				slug: path.slice(path.lastIndexOf("/") + 1),
				path,
				depth: path.split("/").length - 1,
				visibility: options.visibility ?? "private",
				...(kind === "repo" ? { defaultBranch: "main" } : {}),
				archived: false,
				createdAt: 0,
			};
			nodes.set(node.id, node);
			byPath.set(path, node);
			return node;
		},
		nodeAt: (path) => {
			const node = byPath.get(path);
			if (node === undefined) throw new Error(`no node ${path}`);
			return node;
		},
		addPrincipal: (input) => {
			const id = input.id ??
				(input.kind === "agent" ? `a_${ulid()}` : `u_${ulid()}`);
			const row: PrincipalRow = {
				id,
				kind: input.kind,
				handle: input.handle,
				display: input.handle,
				email: null,
				email_verified: 0,
				owner_user_id: input.owner ?? null,
				agent_tool: input.tool ?? null,
				agent_model: null,
				is_admin: 0,
				created_at: 0,
				disabled_at: null,
			};
			principals.set(id, row);
			return row;
		},
		grant: (principal, path, role) => {
			const node = forge.nodeAt(path);
			const map = grants.get(principal) ?? new Map<string, Role>();
			map.set(node.id, role);
			grants.set(principal, map);
		},
		install: (extId, path, options = {}) => {
			const node = forge.nodeAt(path);
			const pkg = builtins.get(extId);
			if (pkg === undefined) throw new Error(`no builtin ${extId}`);
			// As the registry does: a pack installs its own row and
			// each member, all with the pack's id in `pack`, members with the
			// pack's member config over their defaults.
			const isPack = pkg.manifest.kind === "pack";
			const rows = [
				{ pkg, config: {} as Record<string, unknown> },
				...(isPack
					? (pkg.manifest.members ?? []).map((m) => {
						const member = builtins.get(m.id)!;
						return {
							pkg: member,
							config: {
								...(member.manifest.config?.default ?? {}),
								...(m.config ?? {}),
							},
						};
					})
					: []),
			];
			installSeq += 1;
			return rows.map(({ pkg: member, config }, i) => {
				const id = `i_${ulid()}`;
				const installation: InstallationInForce = {
					installation: {
						id,
						extId: member.manifest.id,
						version: member.manifest.version,
						nodeId: node.id,
						nodePath: node.path,
						mode: "enforce",
						storageScope: member.manifest.storage.scope,
						config: isPack || i > 0
							? config
							: { ...(member.manifest.config?.default ?? {}) },
						grants: member.manifest.permissions,
						backgroundRole: 30,
						locked: false,
						backfill: "none",
						...(isPack ? { pack: extId } : {}),
						installedBy: "u_00000000000000000000000000",
						installedAt: installSeq,
					},
					manifest: member.manifest,
					depth: node.depth,
				};
				installations.push(installation);
				if (options.card !== undefined && i === 0) {
					cards.set(id, options.card);
				} else if (
					options.bundledCards && member.protocol !== undefined &&
					member.manifest.contributes?.protocol !== undefined
				) {
					cards.set(id, member.protocol);
				}
				return installation;
			});
		},
		setMode: (installationId, mode) => {
			const at = installations.findIndex((i) =>
				i.installation.id === installationId
			);
			if (at < 0) throw new Error(`no installation ${installationId}`);
			const i = installations[at];
			installations[at] = {
				...i,
				installation: { ...i.installation, mode },
			};
		},
		onTool: (extId, name, handler) =>
			void handlers.set(`${extId}:${name}`, handler),
		setRepo: (repoId, repo) => void repos.set(repoId, repo),
		inbox,
		notify: (principal, notice) => {
			seq += 1;
			const n: Notice = {
				id: notice.id ?? `n_${seq}`,
				seq,
				source: notice.source ?? "kernel",
				...(notice.sourceLabel
					? { sourceLabel: stripControl(notice.sourceLabel) }
					: {}),
				kind: notice.kind ?? "system",
				severity: notice.severity ?? "info",
				text: sanitizeNoticeText(notice.text),
				...(notice.repoId ? { repoId: notice.repoId } : {}),
				...(notice.laneId ? { laneId: notice.laneId } : {}),
				createdAt: Date.now(),
			};
			inbox(principal).notices.push(n);
			return n;
		},
		setOrigin: (value) => {
			origin = value;
		},
		override: (replacement) => void Object.assign(ports, replacement),
	};
	return forge;
};
