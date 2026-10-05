// Kernel MCP tools (WP11; contract `KERNEL_TOOLS`).
//
// Each tool resolves its repo, authorizes the caller there with WP3's
// `authorize` (token ceiling, node subtree, lane pin, scopes) and calls the
// owning module's facade. The `lanes_*` tools are thin callers of WP5a's
// K16-checked RepoDO methods: the `LaneOpActor` is built here from the
// token's `AuthContext` (never from tool input), with its credential bounds,
// and RepoDO decides in its own transaction (a denial is `denied("lane-op")`).
//
// A caller below Reporter as a member reads a public repo in the public view,
// as the gateway and the browse routes do: refs and
// SHAs resolve through browse's public-view resolver (visible tips and
// commits reachable from them; never a lane id or a hidden ref), and the
// lane reads (`lanes_get`, `lanes_list`, `context_get` with a lane) are
// refused.

import {
	type Actor,
	DEFINED_INTERFACE_IDS,
	denied,
	EVENTS_TAIL_MAX,
	INBOX_WAIT_MAX_MS,
	type InstallationInForce,
	invalid,
	isIdOf,
	isPrincipalId,
	isSha,
	KERNEL_TOOLS,
	type KernelToolName,
	type Lane,
	type NodeDto,
	notFound,
	type ProtocolGetResult,
	REPO_READ_MAX_BYTES,
	type WhoamiResult,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type PrincipalRow,
} from "@tartan/contract/kernel.ts";
import { createResolver } from "../browse/access.ts";
import type { SourceReader } from "../caps/ports.ts";
import { createInboxSend } from "../inbox/send.ts";
import { actorOf as laneActorOfAuth } from "../repo/routes.ts";
import { laneView, requireHandle, settleLane } from "./lanes.ts";
import type { McpPorts } from "./ports.ts";
import { protocolFingerprint } from "./protocol.ts";
import { createRepoConfigTools } from "./repoconfig.ts";
import type { ToolOutcome } from "./result.ts";
import {
	createRepoResolver,
	findNode,
	isWithin,
	type McpSession,
	normalizeNodeArg,
	type RepoReadView,
	sessionRepo,
} from "./session.ts";

export type KernelTool = (
	session: McpSession,
	args: unknown,
) => Promise<ToolOutcome>;

/** `repo_list` scans at most this many repos and returns at most `REPO_LIST_MAX`. */
export const REPO_LIST_SCAN = 1000;
export const REPO_LIST_MAX = 200;
/** `lanes_list` page size. */
export const LANES_LIST_MAX = 200;
/** `inbox_read` page size. */
export const INBOX_READ_MAX = 50;
/** `events_tail` default `limit`. */
export const EVENTS_TAIL_DEFAULT = 50;
/** Parallel `authorize` calls in `repo_list`. */
const AUTHORIZE_BATCH = 16;

/** The actor of an MCP caller: who, for whom. */
export const actorOf = (auth: AuthContext): Actor => ({
	kind: auth.kind,
	id: auth.principal,
	...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
});

/**
 * The K16 actor of an MCP caller, as WP5a's lanes API builds it (the one
 * definition): a token always (cookies never reach `/-/mcp`), so always
 * with its credential bounds.
 */
export const laneActorOf = laneActorOfAuth;

const parseInput = <N extends KernelToolName>(
	name: N,
	args: unknown,
): Record<string, unknown> => {
	const parsed = KERNEL_TOOLS[name].input.safeParse(args ?? {});
	if (!parsed.success) {
		throw invalid(
			`${name}: ${
				parsed.error.issues.map((i) =>
					`${i.path.join(".") || "input"}: ${i.message}`
				).join("; ")
			}`,
		);
	}
	return parsed.data as Record<string, unknown>;
};

const str = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Lanes are never in the public view: the lane reads need a member's Reporter. */
const requireMember = (view: RepoReadView): void => {
	if (view.publicView) {
		throw denied("role", "lanes are visible to repo members only");
	}
};

/** browse's resolver reads (`hash`, as the binding names it) over a SHA reader. */
const resolverReads = (reader: SourceReader) => ({
	commit: (sha: string) => reader.commit(sha),
	log: async (sha: string, options?: { readonly limit?: number }) =>
		(await reader.log(sha, options?.limit ?? 1000)).map((c) => ({
			hash: c.sha,
		})),
});

/** First 8 KB contain a NUL byte: treated as binary (as git does). */
const looksBinary = (bytes: Uint8Array): boolean =>
	bytes.subarray(0, 8192).includes(0);

export const createKernelTools = (
	ports: McpPorts,
): Readonly<Record<KernelToolName, KernelTool>> => {
	const resolver = createRepoResolver(ports);
	const core = (repoId: string) => ports.repo(repoId).core;

	/**
	 * A ref, lane id or SHA → SHA through RepoDO (K15); `HEAD` by default.
	 * In the public view through browse's resolver: a visible ref's tip or a
	 * commit reachable from one, else `not_found` (as for an unknown ref).
	 */
	const resolveSha = async (view: RepoReadView, ref: string | undefined) => {
		const wanted = ref ?? "HEAD";
		if (view.publicView) {
			const reader = await ports.reader({ repoId: view.node.id });
			return await createResolver(
				{ node: view.node, publicView: true, repo: core(view.node.id) },
				resolverReads(reader),
			).commit(wanted);
		}
		const sha = isSha(wanted)
			? wanted
			: await core(view.node.id).resolveRef(wanted);
		if (sha === null) throw notFound(`unknown ref ${wanted}`);
		return sha;
	};

	/** The repo that holds a ref's objects: a lane id reads its lane's repo (K15). */
	const sourceOf = (repoId: string, ref: string | undefined) =>
		ref !== undefined && isIdOf("lane", ref)
			? { repoId, laneId: ref }
			: { repoId };

	const treeAt = async (
		source: { repoId: string; laneId?: string },
		sha: string,
		path: string,
	) => {
		const reader = await ports.reader(source);
		const commit = await reader.commit(sha);
		if (commit === null) throw notFound(`commit ${sha} not found`);
		let tree = commit.treeSha;
		const segments = path === "" ? [] : path.split("/");
		for (const segment of segments) {
			const entries = await reader.tree(tree);
			const next = entries?.find((e) =>
				e.name === segment && e.type === "tree"
			);
			if (next === undefined) throw notFound(`no directory ${path}`);
			tree = next.hash;
		}
		const entries = await reader.tree(tree) ?? [];
		return entries.map((e) => ({
			name: e.name,
			path: path === "" ? e.name : `${path}/${e.name}`,
			type: e.type,
			mode: e.mode,
			hash: e.hash,
		}));
	};

	/** A principal by id or handle (`inbox_send.to`, `lanes_delegate`). */
	const principalOf = async (who: string): Promise<PrincipalRow> => {
		const row = isPrincipalId(who)
			? await ports.principal(who)
			: await ports.principalByHandle(who);
		if (row === null || row.disabled_at !== null) {
			throw notFound(`no principal ${who}`);
		}
		return row;
	};

	/** A principal's role on a repo, an agent's owner included. */
	const roleOn = async (principal: string, repoId: string) => {
		const row = await ports.principal(principal);
		const principals = row?.owner_user_id
			? [principal, row.owner_user_id]
			: [principal];
		return await ports.effectiveRole(principals, repoId);
	};

	const repoInfoOf = (node: NodeDto) => ({
		id: node.id,
		path: node.path,
		visibility: node.visibility,
		...(node.description ? { description: node.description } : {}),
		...(node.defaultBranch ? { defaultBranch: node.defaultBranch } : {}),
	});

	const laneOf = async (repoId: string, laneId: string): Promise<Lane> => {
		const lane = await core(repoId).getLane(laneId);
		if (lane === null) throw notFound(`no lane ${laneId}`);
		return lane;
	};

	const tools: Record<KernelToolName, KernelTool> = {
		...createRepoConfigTools(ports, resolver),
		whoami: async (session, args) => {
			parseInput("whoami", args);
			const { auth, scope } = session;
			const row = await ports.principal(auth.principal);
			const role = scope.node === null ? 0 : await ports.authorize(
				auth,
				{ node: scope.node },
				"read-metadata",
			).catch(() => 0);
			const value: WhoamiResult = {
				principal: {
					id: auth.principal,
					kind: auth.kind,
					handle: row?.handle ?? auth.principal,
					display: row?.display ?? auth.principal,
					...(row?.agent_tool ? { agentTool: row.agent_tool } : {}),
					...(row?.agent_model ? { agentModel: row.agent_model } : {}),
				},
				...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
				scope: { nodeId: scope.node?.id ?? "", path: scope.path },
				role,
				...(auth.expiresAt !== undefined
					? { tokenExpiresAt: auth.expiresAt }
					: {}),
			};
			return { value };
		},

		protocol_get: async (session, args) => {
			const input = parseInput("protocol_get", args);
			const node = input.repo === undefined
				? session.scope.node
				: await resolver.repo(session, input.repo, "read-metadata");
			if (node === null) {
				const value: ProtocolGetResult = {
					scope: "",
					protocol: session.protocol,
					cards: [],
					providers: {},
				};
				return { value };
			}
			const same = node.id === session.scope.node?.id;
			const cards = same ? session.cards : await ports.protocolCards(node.id);
			const providers = await Promise.all(
				DEFINED_INTERFACE_IDS.filter((id) => id !== "context@1").map(
					async (id) => [id, await ports.provider(id, node.id)] as const,
				),
			);
			const providerOf = (p: InstallationInForce | null) =>
				p === null ? null : {
					installation: p.installation.id,
					ext: p.installation.extId,
					node: p.installation.nodePath,
				};
			const value: ProtocolGetResult = {
				scope: node.path,
				protocol: same ? session.protocol : await protocolFingerprint(cards),
				cards: cards.map((c) => ({ ...c })),
				providers: Object.fromEntries(
					providers.map(([id, p]) => [id, providerOf(p)]),
				),
			};
			return { value };
		},

		context_get: async (session, args) => {
			const input = parseInput("context_get", args);
			const laneId = str(input.laneId);
			const view = await resolver.view(session, input.repo, "read", {
				...(laneId ? { laneId } : {}),
			});
			if (laneId) requireMember(view);
			const { node } = view;
			const pack = await ports.dispatch.context(
				{
					repo: { id: node.id, path: node.path, nodeId: node.id },
					...(str(input.work) ? { work: str(input.work) } : {}),
					...(laneId ? { laneId } : {}),
					...(Array.isArray(input.paths)
						? { paths: input.paths as string[] }
						: {}),
					...(typeof input.budgetTokens === "number"
						? { budgetTokens: input.budgetTokens }
						: {}),
					actor: actorOf(session.auth),
				},
				actorBoundsOf(session.auth),
			);
			return { value: pack, text: pack.md };
		},

		inbox_read: async (session, args) => {
			const input = parseInput("inbox_read", args);
			const repo = input.repo === undefined
				? null
				: await resolver.locate(session, input.repo);
			const notices = await ports.inbox(session.auth.principal).read({
				...(typeof input.since === "number" ? { since: input.since } : {}),
				...(repo ? { repoId: repo.id } : {}),
				limit: INBOX_READ_MAX,
			});
			return {
				value: {
					notices,
					head: notices.at(-1)?.seq ?? (input.since as number ?? 0),
				},
			};
		},

		inbox_wait: async (session, args) => {
			const input = parseInput("inbox_wait", args);
			const repo = await sessionRepo(ports, session);
			const notices = await ports.inbox(session.auth.principal).wait(
				typeof input.timeoutMs === "number"
					? input.timeoutMs
					: INBOX_WAIT_MAX_MS,
				repo?.id,
				"mcp",
			);
			return { value: { notices } };
		},

		inbox_ack: async (session, args) => {
			const input = parseInput("inbox_ack", args);
			return {
				value: await ports.inbox(session.auth.principal).ack(
					input.ids as string[],
				),
			};
		},

		inbox_send: async (session, args) => {
			const input = parseInput("inbox_send", args);
			const laneId = str(input.laneId);
			const node = await resolver.repo(session, input.repo, "read");
			const [sender, recipient] = await Promise.all([
				ports.principal(session.auth.principal),
				principalOf(input.to as string),
			]);
			const send = createInboxSend({
				roleOn,
				inbox: (principal) => ports.inbox(principal),
			});
			const result = await send({
				from: session.auth.principal,
				...(sender ? { fromLabel: sender.handle } : {}),
				to: recipient.id,
				body: input.body as string,
				repoId: node.id,
				...(laneId ? { laneId } : {}),
			});
			return { value: { ...result, to: recipient.id } };
		},

		repo_list: async (session, args) => {
			const input = parseInput("repo_list", args);
			const under = str(input.under) !== undefined
				? normalizeNodeArg(input.under as string, session.origin)
				: session.scope.path;
			const root = under === ""
				? null
				: await findNode(ports, under, session.origin);
			// Unknown and invisible subtrees both list nothing (no oracle).
			if (under !== "" && root === null) return { value: { repos: [] } };
			const candidates: { id: string; path: string }[] = [];
			let cursor: string | undefined;
			let scanned = 0;
			do {
				const page = await ports.listRepos({
					...(cursor ? { cursor } : {}),
					limit: 200,
				});
				scanned += page.repos.length;
				for (const repo of page.repos) {
					if (
						root === null || repo.path === root.path ||
						repo.path.startsWith(`${root.path}/`)
					) candidates.push(repo);
				}
				cursor = page.cursor;
			} while (cursor !== undefined && scanned < REPO_LIST_SCAN);
			const readable: ReturnType<typeof repoInfoOf>[] = [];
			for (
				let i = 0;
				i < candidates.length && readable.length < REPO_LIST_MAX;
				i += AUTHORIZE_BATCH
			) {
				const batch = await Promise.all(
					candidates.slice(i, i + AUTHORIZE_BATCH).map(async (repo) => {
						const node = await ports.node(repo.id);
						if (node === null || node.archived) return null;
						try {
							await ports.authorize(session.auth, { node }, "read");
							return repoInfoOf(node);
						} catch {
							return null;
						}
					}),
				);
				for (const r of batch) if (r !== null) readable.push(r);
			}
			return {
				value: {
					repos: readable.slice(0, REPO_LIST_MAX),
					...(cursor !== undefined || readable.length > REPO_LIST_MAX
						? { truncated: true }
						: {}),
				},
			};
		},

		repo_tree: async (session, args) => {
			const input = parseInput("repo_tree", args);
			const ref = str(input.ref);
			const view = await resolver.view(session, input.repo, "read", {
				...(ref && isIdOf("lane", ref) ? { laneId: ref } : {}),
			});
			const { node } = view;
			const sha = await resolveSha(view, ref);
			const path = (input.path as string).replace(/\/+$/, "");
			const entries = await treeAt(sourceOf(node.id, ref), sha, path);
			return {
				value: { repo: node.path, ref: ref ?? "HEAD", sha, path, entries },
			};
		},

		repo_read: async (session, args) => {
			const input = parseInput("repo_read", args);
			const ref = str(input.ref);
			const view = await resolver.view(session, input.repo, "read", {
				...(ref && isIdOf("lane", ref) ? { laneId: ref } : {}),
			});
			const { node } = view;
			const sha = await resolveSha(view, ref);
			const path = input.path as string;
			const reader = await ports.reader(sourceOf(node.id, ref));
			const bytes = await reader.file(sha, path);
			if (bytes === null) throw notFound(`no file ${path} at ${sha}`);
			const base = { repo: node.path, ref: ref ?? "HEAD", sha, path };
			if (looksBinary(bytes)) {
				return {
					value: { ...base, size: bytes.length, binary: true },
					text: `${path}: binary file, ${bytes.length} bytes`,
				};
			}
			const truncated = bytes.length > REPO_READ_MAX_BYTES;
			const text = decoder.decode(
				truncated ? bytes.subarray(0, REPO_READ_MAX_BYTES) : bytes,
			);
			return {
				value: { ...base, size: bytes.length, truncated, text },
				text,
			};
		},

		repo_projects: async (session, args) => {
			const input = parseInput("repo_projects", args);
			const view = await resolver.view(session, input.repo, "read");
			const sha = await resolveSha(view, undefined);
			return { value: await ports.probe.projectGraph(view.node.id, sha) };
		},

		repo_affected: async (session, args) => {
			const input = parseInput("repo_affected", args);
			const view = await resolver.view(session, input.repo, "read");
			const [base, head] = await Promise.all([
				resolveSha(view, input.base as string),
				resolveSha(view, input.head as string),
			]);
			return {
				value: await ports.probe.affected(view.node.id, base, head),
			};
		},

		lanes_open: async (session, args) => {
			const input = parseInput("lanes_open", args);
			const node = await resolver.repo(session, input.repo, "claim");
			const { auth } = session;
			const repoCore = core(node.id);
			// An agent works for its owner user: the
			// delegation's user (OAuth, M2), else the agent's creator.
			const onBehalfOf = auth.onBehalfOf ??
				(auth.kind === "agent"
					? (await ports.principal(auth.principal))?.owner_user_id ?? undefined
					: undefined);
			const opened = await repoCore.openLane({
				owner: auth.principal,
				...(onBehalfOf ? { onBehalfOf } : {}),
				...(input.footprint
					? { footprint: input.footprint as Lane["footprint"] }
					: {}),
				actor: laneActorOf(auth),
			});
			// The wait is here, per request, never in an ExtensionDO.
			const lane = await settleLane(repoCore, opened);
			return {
				value: {
					lane: requireHandle(lane, session.origin),
					repo: node.path,
					purpose: input.purpose,
				},
				lane,
			};
		},

		lanes_get: async (session, args) => {
			const input = parseInput("lanes_get", args);
			const laneId = input.laneId as string;
			const view = await resolver.view(session, input.repo, "read", {
				laneId,
			});
			requireMember(view);
			const lane = await laneOf(view.node.id, laneId);
			return { value: { lane: laneView(lane, session.origin) }, lane };
		},

		lanes_list: async (session, args) => {
			const input = parseInput("lanes_list", args);
			const view = await resolver.view(session, input.repo, "read");
			requireMember(view);
			const { node } = view;
			const page = await core(node.id).listLanes({
				...(Array.isArray(input.state)
					? { state: input.state as Lane["state"][] }
					: {}),
				...(input.mine === true ? { owner: session.auth.principal } : {}),
				limit: LANES_LIST_MAX,
			});
			return {
				value: {
					repo: node.path,
					lanes: page.lanes.map((l) => laneView(l, session.origin)),
					...(page.cursor ? { cursor: page.cursor } : {}),
				},
			};
		},

		lanes_close: async (session, args) => {
			const input = parseInput("lanes_close", args);
			const laneId = input.laneId as string;
			const node = await resolver.repo(session, input.repo, "claim", {
				laneId,
			});
			const repoCore = core(node.id);
			await repoCore.closeLane(
				laneId,
				input.reason as string,
				laneActorOf(session.auth),
			);
			const lane = await laneOf(node.id, laneId);
			return {
				value: { ok: true, lane: laneView(lane, session.origin) },
				lane,
			};
		},

		lanes_delegate: async (session, args) => {
			const input = parseInput("lanes_delegate", args);
			const laneId = input.laneId as string;
			const node = await resolver.repo(session, input.repo, "claim", {
				laneId,
			});
			const ids = async (list: unknown) =>
				Array.isArray(list)
					? await Promise.all(
						(list as string[]).map(async (h) => (await principalOf(h)).id),
					)
					: [];
			const [add, remove] = await Promise.all([
				ids(input.add),
				ids(input.remove),
			]);
			await core(node.id).delegateLane(
				laneId,
				add,
				remove,
				laneActorOf(session.auth),
			);
			const lane = await laneOf(node.id, laneId);
			return { value: { laneId, delegates: lane.delegates }, lane };
		},

		lanes_sync: async (session, args) => {
			const input = parseInput("lanes_sync", args);
			const laneId = input.laneId as string;
			const node = await resolver.repo(session, input.repo, "claim", {
				laneId,
			});
			const onto = str(input.onto);
			const actor = laneActorOf(session.auth);
			const result = onto === undefined || onto === "trunk"
				? await core(node.id).syncLane(laneId, actor)
				: await core(node.id).restackLane(laneId, onto, actor);
			return { value: result };
		},

		runs_status: async (session, args) => {
			const input = parseInput("runs_status", args);
			const node = await resolver.repo(session, input.repo, "read");
			const run = await ports.repo(node.id).runs.get(input.runId as string);
			if (run === null) throw notFound(`no run ${input.runId}`);
			return { value: run };
		},

		runs_logs: async (session, args) => {
			const input = parseInput("runs_logs", args);
			const node = await resolver.repo(session, input.repo, "read");
			const log = await ports.repo(node.id).runs.logs(
				input.runId as string,
				input.jobId as string,
				typeof input.tailBytes === "number" ? input.tailBytes : undefined,
			);
			return {
				value: { runId: input.runId, jobId: input.jobId, log },
				text: log,
			};
		},

		events_tail: async (session, args) => {
			const input = parseInput("events_tail", args);
			const node = await resolver.repo(session, input.repo, "read");
			const events = ports.repo(node.id).events;
			const limit = typeof input.limit === "number"
				? Math.min(input.limit, EVENTS_TAIL_MAX)
				: EVENTS_TAIL_DEFAULT;
			const head = await events.head();
			const since = typeof input.since === "number"
				? input.since
				: Math.max(0, head - limit);
			const page = await events.read({
				since,
				limit,
				...(Array.isArray(input.types)
					? { patterns: input.types as string[] }
					: {}),
			});
			return { value: { events: page, head } };
		},

		why: async (session, args) => {
			const input = parseInput("why", args);
			const view = await resolver.view(session, input.repo, "read");
			const { node } = view;
			const named = str(input.sha);
			const ref = str(input.ref);
			// The public view checks a caller-named SHA like a ref.
			const sha = named !== undefined
				? view.publicView ? await resolveSha(view, named) : named
				: ref !== undefined
				? await resolveSha(view, ref)
				: undefined;
			const answer = await ports.repo(node.id).land.why({
				...(sha ? { sha } : {}),
				...(str(input.path) ? { path: str(input.path) } : {}),
				...(typeof input.line === "number" ? { line: input.line } : {}),
			});
			if (answer === null) throw notFound("no why note for that commit");
			return { value: answer };
		},
	};
	return tools;
};

/** True when `node` is inside the session scope (the forge scope holds everything). */
export const inSessionScope = (session: McpSession, node: NodeDto): boolean =>
	session.scope.node === null || isWithin(session.scope.node, node);
