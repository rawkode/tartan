// MCP: kernel tools, the `_tartan` trailer
// and naming rules. Interface tools (`work_*`, `changes_*`, …) are defined in
// `interfaces.ts`; extension-private tools are `<extshort>_<tool>`.
//
// Repo routing: every tool that names a lane, change, conflict or run by
// id also takes an optional `repo`. The host resolves the repo from that
// argument, else from the session's repo scope (an MCP URL at a repo node, or
// a lane-pinned token), else answers `invalid("repo required")`.

import { z } from "zod";
import {
	FootprintSchema,
	LaneIdSchema,
	RepoPathSchema,
	ShaSchema,
} from "./common.ts";
import {
	type ContextPriority,
	RepoArgSchema,
	RepoHintSchema,
} from "./interfaces.ts";
import { INBOX_BODY_MAX_BYTES } from "./notices.ts";
import { byteLength } from "./text.ts";
import { LaneBackendNameSchema, LaneStateSchema } from "./lanes.ts";
import { NoticeSchema } from "./notices.ts";

export const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const INBOX_WAIT_MAX_MS = 25_000;
export const REPO_READ_MAX_BYTES = 256 * 1024;
export const EVENTS_TAIL_MAX = 200;

const Ref = z.string().min(1).max(1024);

export type KernelToolDef = {
	readonly input: z.ZodType;
	/** Minimum role at the scope (agents: after token/role intersection). */
	readonly role: 10 | 20 | 30 | 40 | 50;
	readonly milestone: "M1" | "M2";
	readonly description: string;
};

const def = (
	input: z.ZodType,
	role: KernelToolDef["role"],
	description: string,
	milestone: KernelToolDef["milestone"] = "M1",
): KernelToolDef => ({ input, role, milestone, description });

export const WhoamiInput = z.object({});
export const ProtocolGetInput = z.object({ repo: RepoArgSchema.optional() });
export const ContextGetInput = z.object({
	repo: RepoArgSchema,
	work: z.string().max(4200).optional(),
	laneId: LaneIdSchema.optional(),
	paths: z.array(RepoPathSchema).max(200).optional(),
	budgetTokens: z.number().int().min(500).max(32000).optional(),
});
export const InboxReadInput = z.object({
	repo: RepoArgSchema.optional(),
	since: z.number().int().nonnegative().optional(),
});
export const InboxWaitInput = z.object({
	timeoutMs: z.number().int().min(0).max(INBOX_WAIT_MAX_MS).optional(),
});
export const InboxAckInput = z.object({
	ids: z.array(z.string().max(64)).min(1).max(200),
});
export const InboxSendInput = z.object({
	/** Recipient principal handle. */
	to: z.string().min(1).max(64),
	/** ≤ 2 KB of UTF-8: rejected, never silently truncated. */
	body: z.string().min(1).max(INBOX_BODY_MAX_BYTES).refine(
		(body) => byteLength(body) <= INBOX_BODY_MAX_BYTES,
		`at most ${INBOX_BODY_MAX_BYTES} bytes of UTF-8`,
	),
	repo: RepoArgSchema,
	laneId: LaneIdSchema.optional(),
});
export const RepoListInput = z.object({
	under: z.string().max(4096).optional(),
});
export const RepoTreeInput = z.object({
	repo: RepoArgSchema,
	ref: Ref.optional(),
	path: RepoPathSchema.default(""),
});
export const RepoReadInput = z.object({
	repo: RepoArgSchema,
	ref: Ref.optional(),
	path: RepoPathSchema.min(1),
});
export const RepoProjectsInput = z.object({ repo: RepoArgSchema });
export const RepoAffectedInput = z.object({
	repo: RepoArgSchema,
	base: Ref,
	head: Ref,
});
export const LanesOpenInput = z.object({
	repo: RepoArgSchema,
	purpose: z.string().min(1).max(500),
	footprint: FootprintSchema.optional(),
});
export const LanesGetInput = z.object({
	repo: RepoHintSchema,
	laneId: LaneIdSchema,
});
export const LanesListInput = z.object({
	repo: RepoArgSchema,
	mine: z.boolean().optional(),
	state: z.array(LaneStateSchema).optional(),
});
export const LanesCloseInput = z.object({
	repo: RepoHintSchema,
	laneId: LaneIdSchema,
	reason: z.string().min(1).max(500),
});
/** Principal handles (as in `inbox_send.to`), resolved by the MCP host. */
const PrincipalHandle = z.string().min(1).max(64);
export const LanesDelegateInput = z.object({
	repo: RepoHintSchema,
	laneId: LaneIdSchema,
	add: z.array(PrincipalHandle).max(32).optional(),
	remove: z.array(PrincipalHandle).max(32).optional(),
});
export const LanesSyncInput = z.object({
	repo: RepoHintSchema,
	laneId: LaneIdSchema,
	onto: z.union([z.literal("trunk"), LaneIdSchema]).optional(),
});
export const RunsStatusInput = z.object({
	repo: RepoHintSchema,
	runId: z.string().min(1).max(64),
});
export const RunsLogsInput = z.object({
	repo: RepoHintSchema,
	runId: z.string().min(1).max(64),
	jobId: z.string().min(1).max(64),
	tailBytes: z.number().int().min(1).max(1024 * 1024).optional(),
});
export const EventsTailInput = z.object({
	repo: RepoArgSchema,
	since: z.number().int().nonnegative().optional(),
	types: z.array(z.string().max(128)).max(32).optional(),
	limit: z.number().int().min(1).max(EVENTS_TAIL_MAX).optional(),
});
export const WhyInput = z.object({
	repo: RepoArgSchema,
	sha: ShaSchema.optional(),
	path: RepoPathSchema.optional(),
	line: z.number().int().min(1).optional(),
	ref: Ref.optional(),
}).refine(
	(v) => v.sha !== undefined || v.path !== undefined,
	"either sha or path (with optional line)",
);

/** Repository config (ADR repo config): reads and previews only. */
export const RepoConfigGetInput = z.object({ repo: RepoArgSchema });
export const RepoConfigSchemaInput = z.object({ repo: RepoArgSchema });
export const RepoConfigPreviewInput = z.object({
	repo: RepoHintSchema,
	laneId: LaneIdSchema,
});
export const RepoConfigResultInput = z.object({
	repo: RepoArgSchema,
	inputKey: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Kernel tools, always present. The `lanes_*` tools are thin callers:
 * the MCP host builds the `LaneOpActor` from the token's `AuthContext` (never
 * from tool input) and passes it to the RepoDO lane method, which enforces
 * K16 in its own transaction; the host never pre-checks in its place. Every
 * lane handle in a result is rebuilt with `laneHandleOf`.
 */
export const KERNEL_TOOLS = {
	whoami: def(
		WhoamiInput,
		10,
		"Who am I: principal, on-behalf-of, scope, role, token expiry",
	),
	protocol_get: def(
		ProtocolGetInput,
		10,
		"Protocol cards and the provider of each interface at a scope",
	),
	context_get: def(
		ContextGetInput,
		20,
		"Context pack: protocol, contract, where you are, neighbourhood, tried-before, project facts",
	),
	inbox_read: def(InboxReadInput, 10, "Read your notices"),
	inbox_wait: def(InboxWaitInput, 10, "Wait up to 25 s for new notices"),
	inbox_ack: def(InboxAckInput, 10, "Acknowledge notices"),
	inbox_send: def(
		InboxSendInput,
		20,
		"Send a message to another principal with a role on the repo",
	),
	repo_list: def(RepoListInput, 10, "List repos you can read"),
	repo_tree: def(RepoTreeInput, 20, "List a directory"),
	repo_read: def(RepoReadInput, 20, "Read a file (≤ 256 KB)"),
	repo_projects: def(RepoProjectsInput, 20, "Project graph of a monorepo"),
	repo_affected: def(
		RepoAffectedInput,
		20,
		"Projects affected between two commits",
	),
	lanes_open: def(
		LanesOpenInput,
		30,
		"Open a lane directly (protocols without work@1); returns the lane handle. The server waits up to 20 s for a lane that is still opening and may still return state opening: poll it with lanes_get",
	),
	lanes_get: def(
		LanesGetInput,
		20,
		"Get a lane (its backend, state, remote, ref and head); poll an opening lane with it",
	),
	lanes_list: def(
		LanesListInput,
		20,
		"List lanes in a repo with their remotes and refs",
	),
	lanes_close: def(
		LanesCloseInput,
		30,
		"Close a lane: its owner or a delegate, or a Maintainer+; closing an opening lane cancels its seed",
	),
	lanes_delegate: def(
		LanesDelegateInput,
		30,
		"Add or remove delegates of your lane (owner only)",
	),
	lanes_sync: def(
		LanesSyncInput,
		30,
		"Rebase your own lane (owner or delegate; onto another lane: owner only) onto trunk or another lane, server-side; refused while landing",
		"M2",
	),
	runs_status: def(RunsStatusInput, 20, "Status of a CI or git run"),
	runs_logs: def(RunsLogsInput, 20, "Tail of a job log (redacted)"),
	events_tail: def(EventsTailInput, 20, "Tail the repo event log"),
	why: def(
		WhyInput,
		20,
		"Why is this commit/line here: change, work item, agent, events, gates",
	),
	// Repository config (WP23): no tool signs off, applies, approves or
	// overrides; every repository-controlled string comes back in a fenced
	// untrusted block.
	repo_config_get: def(
		RepoConfigGetInput,
		20,
		"Tartan config of a repo (the root CUE package tartan): status, plan, repo policy, issues and denials",
	),
	repo_config_schema: def(
		RepoConfigSchemaInput,
		20,
		"The forge's CUE schema files for a repo's package tartan and the cue export command, to write config before you push",
	),
	repo_config_preview: def(
		RepoConfigPreviewInput,
		20,
		"Evaluate your lane's root *.cue files (package tartan) against the forge schema; answers at once with a cached result or evaluating; never applies",
	),
	repo_config_result: def(
		RepoConfigResultInput,
		20,
		"Poll a repo-config preview by its input key",
	),
} as const;
export type KernelToolName = keyof typeof KERNEL_TOOLS;
export const KERNEL_TOOL_NAMES = Object.keys(KERNEL_TOOLS) as KernelToolName[];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * `structuredContent._tartan` on every tool result. Mirrors the
 * fenced notices block appended to `content` (`renderNoticesBlock`).
 */
export const TartanTrailerSchema = z.strictObject({
	notices: z.array(NoticeSchema).max(10),
	/** sha8 of the protocol card set in force at the session scope. */
	protocol: z.string().regex(/^[0-9a-f]{8}$/),
	lane: z.strictObject({
		id: LaneIdSchema,
		mode: LaneBackendNameSchema,
		state: LaneStateSchema,
		leaseExpiresAt: z.number().int(),
	}).optional(),
});
export type TartanTrailer = z.infer<typeof TartanTrailerSchema>;
export const TARTAN_TRAILER_KEY = "_tartan" as const;

/**
 * `context_get` result, assembled by WP7b's `ExtDispatch.context`:
 * kernel sections first, then `context@1` contributors in priority order,
 * fenced as untrusted where they quote others' text, within the budget.
 */
export type ContextPack = {
	readonly md: string;
	readonly sections: readonly {
		/** `kernel` or the contributing installation id. */
		readonly source: string;
		readonly id: string;
		readonly priority: ContextPriority | "kernel";
		readonly bytes: number;
		readonly truncated: boolean;
	}[];
	readonly budgetTokens: number;
	readonly truncated: boolean;
};

export type WhoamiResult = {
	readonly principal: {
		readonly id: string;
		readonly kind: "user" | "agent";
		readonly handle: string;
		readonly display: string;
		readonly agentTool?: string;
		readonly agentModel?: string;
	};
	readonly onBehalfOf?: string;
	readonly scope: { readonly nodeId: string; readonly path: string };
	readonly role: number;
	readonly tokenExpiresAt?: number;
};

export type ProtocolGetResult = {
	readonly scope: string;
	readonly protocol: string;
	readonly cards: readonly {
		readonly installation: string;
		readonly ext: string;
		readonly md: string;
	}[];
	readonly providers: Readonly<
		Record<
			string,
			{
				readonly installation: string;
				readonly ext: string;
				readonly node: string;
			} | null
		>
	>;
};

/** `{error: "protocol_mismatch", mcpUrl}`. */
export const ProtocolMismatchSchema = z.strictObject({
	error: z.literal("protocol_mismatch"),
	mcpUrl: z.string(),
	message: z.string().optional(),
});
export type ProtocolMismatch = z.infer<typeof ProtocolMismatchSchema>;

export const EventsTailResultSchema = z.strictObject({
	events: z.array(z.unknown()),
	head: z.number().int().nonnegative(),
});

/** MCP endpoint paths: `/-/mcp` (token scope) and `/-/mcp/<path>`. */
export const MCP_BASE_PATH = "/-/mcp" as const;
export const mcpPath = (scopePath?: string): string =>
	scopePath ? `${MCP_BASE_PATH}/${scopePath}` : MCP_BASE_PATH;
