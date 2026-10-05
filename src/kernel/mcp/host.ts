// The MCP host (WP11), shared by both transports (the SDK's `createMcpHandler`
// and the raw JSON-RPC fallback). Per request:
//
// - `open`: the session (caller, scope, protocol cards in force there);
// - `instructions`: the kernel card plus the scope's protocol cards;
// - `listTools`: kernel tools, interface tools of providers in force and
//   extension-private tools, filtered by the caller's role (WP7b's
//   `ExtDispatch.tools`); the forge scope lists kernel tools only;
// - `callTool`: kernel tools run here; interface and extension tools go to
//   their ExtensionDO with a kernel-derived `ToolContext` and the token's
//   bounds. A call whose target repo runs another protocol than the session
//   scope answers `{error: "protocol_mismatch", mcpUrl}`; so does a kernel
//   tool whose `repo` argument names such a repo,
//   except `protocol_get` (it reads another scope's protocol) and
//   `inbox_read` (`repo` only filters). Lane handles in
//   the result are completed (`awaitLane`, outside the ExtensionDO) and
//   rebuilt; then the notices middleware appends the caller's unread notices.

import {
	invalid,
	KERNEL_TOOLS,
	type KernelToolName,
	type Lane,
	type NodeDto,
	type ProtocolMismatch,
	stripControl,
	type ToolContext,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type ResolvedTool,
} from "@tartan/contract/kernel.ts";
import { z } from "zod";
import { actorOf, createKernelTools, inSessionScope } from "./kernel-tools.ts";
import { completeLaneField } from "./lanes.ts";
import type { McpPorts } from "./ports.ts";
import { instructionsOf, mcpUrlOf, protocolFingerprint } from "./protocol.ts";
import { REPO_CONFIG_CARD_LINE } from "./repoconfig.ts";
import {
	errorResult,
	okResult,
	type ToolCallResult,
	type ToolOutcome,
	withNotices,
} from "./result.ts";
import {
	createRepoResolver,
	type McpSession,
	openSession,
	repoOfWorkRef,
	sessionRepo,
} from "./session.ts";

export type ToolListing = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
};

/** A tool name unknown at the scope: a protocol error (JSON-RPC -32602), not a tool result. */
export class UnknownToolError extends Error {
	override readonly name = "UnknownToolError";
	constructor(readonly tool: string) {
		super(`Unknown tool: ${tool}`);
	}
}

export type McpHost = {
	open(auth: AuthContext, rest: string | undefined): Promise<McpSession>;
	instructions(session: McpSession): string;
	listTools(session: McpSession): Promise<ToolListing[]>;
	callTool(
		session: McpSession,
		name: string,
		args: unknown,
	): Promise<ToolCallResult>;
};

const isKernelTool = (name: string): name is KernelToolName =>
	Object.hasOwn(KERNEL_TOOLS, name);

/** Kernel tools whose `repo` argument is no target of work under a protocol. */
const PROTOCOL_FREE: ReadonlySet<KernelToolName> = new Set([
	"protocol_get",
	"inbox_read",
]);

/** The installation a resolved interface or extension tool runs in. */
const installationOf = (tool: ResolvedTool | null): string | null =>
	tool === null || tool.kind === "kernel"
		? null
		: tool.kind === "interface"
		? tool.provider.installation.id
		: tool.installation.installation.id;

const JSON_SCHEMA_OPTIONS = {
	target: "draft-2020-12",
	io: "input",
	unrepresentable: "any",
} as const;

/** Kernel tools at the forge scope (no node, so no role there to filter by). */
let forgeScopeListing: ToolListing[] | null = null;
/** Static: converted once per isolate. */
const forgeScopeTools = (): ToolListing[] =>
	forgeScopeListing ??= (Object.keys(KERNEL_TOOLS) as KernelToolName[])
		.filter((name) => KERNEL_TOOLS[name].milestone === "M1")
		.map((name) => {
			const schema = z.toJSONSchema(
				KERNEL_TOOLS[name].input,
				JSON_SCHEMA_OPTIONS,
			) as Record<string, unknown>;
			delete schema.$schema;
			return {
				name,
				description: KERNEL_TOOLS[name].description,
				inputSchema: schema,
			};
		});

export const createMcpHost = (ports: McpPorts): McpHost => {
	const kernel = createKernelTools(ports);
	const resolver = createRepoResolver(ports);

	/** The node an interface or extension tool call targets. */
	const targetOf = async (
		session: McpSession,
		args: Record<string, unknown>,
	): Promise<NodeDto | null> => {
		if (typeof args.repo === "string" && args.repo !== "") {
			return await resolver.locate(session, args.repo);
		}
		const workRepo = repoOfWorkRef(args.ref) ?? repoOfWorkRef(args.parent);
		if (workRepo !== null) return await resolver.locate(session, workRepo);
		return await sessionRepo(ports, session) ?? session.scope.node;
	};

	const mismatch = (session: McpSession, node: NodeDto): ToolOutcome => {
		const value: ProtocolMismatch = {
			error: "protocol_mismatch",
			mcpUrl: mcpUrlOf(session.origin, node.path),
			message: `${node.path} runs a different protocol than ${
				session.scope.path === "" ? "this MCP URL" : session.scope.path
			}`,
		};
		return { value, mismatch: value };
	};

	/**
	 * The protocol rule for kernel tools: a `repo` argument outside the session
	 * scope, or running another card set, is a `protocol_mismatch`. The forge
	 * scope (a token without a node) has no protocol and lists kernel tools only,
	 * so its kernel tools serve every repo the caller may use.
	 */
	const kernelMismatch = async (
		session: McpSession,
		name: KernelToolName,
		args: unknown,
	): Promise<ToolOutcome | null> => {
		const scope = session.scope.node;
		if (scope === null || PROTOCOL_FREE.has(name)) return null;
		const arg = typeof args === "object" && args !== null
			? (args as Record<string, unknown>).repo
			: undefined;
		if (typeof arg !== "string" || arg === "") return null;
		// An unknown, invisible or non-repo target is the tool's own answer.
		const target = await resolver.locate(session, arg).catch(() => null);
		if (target === null || target.id === scope.id) return null;
		const same = inSessionScope(session, target) &&
			await protocolFingerprint(await ports.protocolCards(target.id)) ===
				session.protocol;
		return same ? null : mismatch(session, target);
	};

	/** Interface and extension tools: route to the ExtensionDO in force at the target. */
	const routeTool = async (
		session: McpSession,
		name: string,
		rawArgs: unknown,
	): Promise<ToolOutcome> => {
		const args = (typeof rawArgs === "object" && rawArgs !== null &&
				!Array.isArray(rawArgs)
			? rawArgs
			: {}) as Record<string, unknown>;
		const { auth, scope } = session;
		const atScope = scope.node === null
			? null
			: await ports.dispatch.resolveTool(scope.node.id, name, auth);
		const target = await targetOf(session, args);
		if (target === null) {
			if (atScope === null) throw new UnknownToolError(name);
			throw invalid(`${name}: repo required`);
		}
		const atTarget = target.id === scope.node?.id
			? atScope
			: await ports.dispatch.resolveTool(target.id, name, auth);
		if (atScope === null && atTarget === null) {
			throw new UnknownToolError(name);
		}
		// The target must run the session's protocol (same scope
		// subtree, same card set, same installation for this tool).
		const sameProtocol = scope.node !== null && atTarget !== null &&
			atScope !== null && inSessionScope(session, target) &&
			installationOf(atScope) === installationOf(atTarget) &&
			(target.id === scope.node.id ||
				await protocolFingerprint(await ports.protocolCards(target.id)) ===
					session.protocol);
		if (!sameProtocol) return mismatch(session, target);
		const resolved = atTarget!;
		if (resolved.kind === "kernel") throw new UnknownToolError(name);
		const installation = resolved.kind === "interface"
			? resolved.provider.installation
			: resolved.installation.installation;
		const toolName = resolved.kind === "interface"
			? name
			: resolved.contribution.name;
		const repo = target.kind === "repo" ? target : null;
		if (installation.storageScope === "repo" && repo === null) {
			throw invalid(`${name}: repo required`);
		}
		// No `laneId` from tool input: the ExtensionDO bounds a lane-pinned
		// token by it, and a caller could name its pinned lane on any tool to
		// lift the Reporter cap. Only kernel-derived values go in the context.
		const ctx: ToolContext = {
			node: target.id,
			...(repo ? { repo: repo.id } : {}),
			scope: scope.path,
			actor: actorOf(auth),
			mode: installation.mode === "shadow" ? "shadow" : "enforce",
		};
		const out = await ports.callTool(
			{
				installationId: installation.id,
				scope: installation.storageScope === "repo"
					? { kind: "repo", repoId: repo!.id }
					: { kind: "node" },
			},
			toolName,
			args,
			ctx,
			actorBoundsOf(auth),
		);
		if (repo === null) return { value: out };
		// Complete and rebuild the lane handle, here.
		const completed = await completeLaneField(
			ports.repo(repo.id).core,
			out,
			session.origin,
		);
		return {
			value: completed.value,
			...(completed.lane ? { lane: completed.lane } : {}),
		};
	};

	/** The caller's unread notices (marked delivered), never failing the call. */
	const peekNotices = async (session: McpSession) => {
		try {
			const repo = await sessionRepo(ports, session);
			return await ports.inbox(session.auth.principal).peek(
				10,
				"mcp",
				repo?.id,
			);
		} catch (error) {
			ports.log("[tartan] mcp: notices unavailable", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	};

	return {
		open: async (auth, rest) => {
			const origin = await ports.canonicalOrigin();
			if (origin === null) throw invalid("the forge has no canonical origin");
			return await openSession(ports, auth, rest, origin);
		},

		instructions: (session) =>
			instructionsOf(
				session.origin,
				session.scope.path,
				session.cards,
				// WP23: in a repo scope with repository config on, root `*.cue`
				// files are policy (K13.3).
				session.scope.node?.kind === "repo" && ports.repoConfigEnabled()
					? [REPO_CONFIG_CARD_LINE]
					: [],
			),

		listTools: async (session) =>
			session.scope.node === null
				? forgeScopeTools()
				: (await ports.dispatch.tools(session.scope.node.id, session.auth))
					.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),

		callTool: async (session, name, args) => {
			let result: ToolCallResult;
			let lane: Lane | undefined;
			try {
				const outcome = isKernelTool(name)
					? await kernelMismatch(session, name, args) ??
						await kernel[name](session, args)
					: await routeTool(session, name, args);
				lane = outcome.lane;
				result = okResult(outcome);
			} catch (error) {
				if (error instanceof UnknownToolError) throw error;
				result = errorResult(error);
				if (result.structuredContent.error === "internal") {
					ports.log("[tartan] mcp: tool failed", {
						tool: stripControl(name).slice(0, 64),
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return withNotices(
				result,
				await peekNotices(session),
				session.protocol,
				lane,
			);
		},
	};
};
