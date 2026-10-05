// Typed client for the kernel HTTP API, built on contract DTOs.
//
// Route prefixes come from `src/router.ts` (WP0). Where a kernel handler is
// merged (WP2 setup and identity, WP5a lanes, WP6 events, WP7a view, slots
// and installations) the paths, query names and response shapes follow it;
// the rest (WP3 browse and nodes, WP5b's stored self-test, forge settings,
// root-key export) are the SPA's assumptions, requested from the contract,
// so one table changes when those handlers land.

import type {
	ActionRequest,
	ActionResponse,
	AdvancesResponse,
	AgentCreatedResponse,
	AgentCreateRequest,
	AgentsResponse,
	BlobResponse,
	CommitResponse,
	CompareResponse,
	EventsResponse,
	GateReplayResponse,
	HealthResponse,
	IdpConfigRequest,
	IdpRegisterRequest,
	IdpRegisterResponse,
	InstallationDto,
	InstallationsResponse,
	InstallRequest,
	InviteCreated,
	InviteCreateRequest,
	JobLogResponse,
	LandBatchDto,
	LaneDto,
	LaneSelfTestResult,
	LanesResponse,
	LogResponse,
	MeResponse,
	NodeCreateRequestSchema,
	NodeDto,
	NodesResponse,
	PackagesResponse,
	PermissionSheet,
	ReplaceProviderRequest,
	ReplaceProviderResponse,
	RepoCreateRequestSchema,
	RepoLaneSettingsDto,
	RepoLaneSettingsRequest,
	RunDto,
	RunsResponse,
	SetupChecksResponse,
	SetupCodeResponse,
	SetupOkResponse,
	SetupStateDto,
	SetupStatusResponse,
	SetupUnlockResponse,
	SlotRenderResponse,
	TreeResponse,
	ViewResponse,
	WhyResponse,
} from "@tartan/contract/api.ts";
import type { InstallationMode } from "@tartan/contract/common.ts";
import type { BreakerStatus } from "@tartan/contract/do/ext.ts";
import type { LaneState } from "@tartan/contract/lanes.ts";
import type {
	ConfigApprovalDto,
	ConfigApprovalRequestDto,
	PolicySignoffDto,
	PolicySignoffRequest,
	RepoConfigEvalDto,
	RepoConfigHeadDto,
	RepoConfigPreviewDto,
	RepoConfigSchemaDto,
	RepoConfigStateDto,
} from "@tartan/contract/repoconfig.ts";
import type { SlotCtxHint } from "@tartan/contract/slot-ctx.ts";
import type { z } from "zod";
import { sameOriginPath } from "../ui/links.ts";
import type { Http } from "./http.ts";
import type {
	ForgeSettingsDto,
	LaneSelfTestStatus,
	RootKeyExport,
} from "./types.ts";

export const ENDPOINTS = {
	health: "/-/health",
	me: "/-/api/me",
	setupStatus: "/-/setup/status",
	setupCode: "/-/setup/code",
	setupUnlock: "/-/setup/unlock",
	setupChecks: "/-/setup/checks",
	setupName: "/-/setup/name",
	setupIdpRegister: "/-/setup/idp/register",
	setupIdp: "/-/setup/idp",
	login: "/-/auth/login",
	logout: "/-/auth/logout",
	selftestLanes: "/-/api/admin/selftest/lanes",
	rootKeyExport: "/-/api/admin/root-key/export",
	settings: "/-/api/settings",
	nodes: "/-/api/nodes",
	repos: "/-/api/nodes/repos",
	view: "/-/api/view",
	slot: "/-/api/slot",
	tree: "/-/api/tree",
	blob: "/-/api/blob",
	log: "/-/api/log",
	commit: "/-/api/commit",
	compare: "/-/api/compare",
	agents: "/-/api/agents",
	tokens: "/-/api/tokens",
	invites: "/-/api/invites",
	packages: "/-/api/packages",
	installations: "/-/api/installations",
	repoApi: "/-/api/repos",
	lanes: "/-/api/lanes",
	events: "/-/api/events",
	runs: "/-/api/runs",
	advances: "/-/api/advances",
	why: "/-/api/why",
	live: "/-/live",
} as const;

const enc = encodeURIComponent;

/** base64url of a JSON value (slot `ctx` hints). */
export const b64urlJson = (value: unknown): string => {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
		/=+$/,
		"",
	);
};

/**
 * Route-derived hints the SPA sends with slot calls (the contract's type;
 * pages build them with `slots/ctx.ts`); the kernel re-derives them.
 */
export type { SlotCtxHint };

/** `POST /-/api/nodes/repos` body (`RepoCreateRequestSchema`, WP3). */
export type RepoCreate = z.input<typeof RepoCreateRequestSchema>;

/** `POST /-/api/nodes` body (`NodeCreateRequestSchema`, WP3). */
export type GroupCreate = z.input<typeof NodeCreateRequestSchema>;

/** `GET /-/api/commit` and `/-/api/compare` options (WP3, WP8 patches). */
export type DiffQuery = {
	/** Ask for each file's unified patch (`FileDiff.patch`, `patchOmitted`). */
	readonly patch?: boolean;
};

/** `GET /-/api/lanes` filters (WP5a `handleLanes`). */
export type LaneListQuery = {
	readonly state?: readonly LaneState[];
	readonly owner?: string;
	readonly cursor?: string;
	readonly limit?: number;
};

/** `GET /-/api/events?repo=<id>` paging and filters (WP6). */
export type EventsQuery = {
	readonly since?: number;
	readonly limit?: number;
	/** Event-type patterns (`EVENT_PATTERN_RE`), sent comma-separated. */
	readonly types?: readonly string[];
};

/** `GET /-/api/runs/<repoId>` paging and filter (WP9). */
export type RunsQuery = {
	/** Only runs for this subject (`{kind, id}`, sent as `<kind>:<id>`). */
	readonly subject?: { readonly kind: string; readonly id: string };
	readonly cursor?: string;
	readonly limit?: number;
};

/** `GET /-/api/why`: a landed commit, or the newest landing that touched a file. */
export type WhyQuery =
	| { readonly sha: string }
	| { readonly path: string; readonly line?: number };

const csv = (values: readonly string[] | undefined): string | undefined =>
	values && values.length > 0 ? values.join(",") : undefined;

export const createApi = (http: Http) => ({
	health: () => http.get<HealthResponse>(ENDPOINTS.health),
	me: () => http.get<MeResponse>(ENDPOINTS.me),
	logout: () => http.post<unknown>(ENDPOINTS.logout),

	setup: {
		/** Any setup state; `session` is null without a valid setup cookie. */
		status: () => http.post<SetupStatusResponse>(ENDPOINTS.setupStatus),
		/** Without `TARTAN_SETUP_TOKEN`: writes a claim code to Workers Logs. */
		code: () => http.post<SetupCodeResponse>(ENDPOINTS.setupCode),
		unlock: (token: string) =>
			http.post<SetupUnlockResponse>(ENDPOINTS.setupUnlock, { token }),
		checks: () => http.post<SetupChecksResponse>(ENDPOINTS.setupChecks),
		name: (forgeName: string, canonicalOrigin: string) =>
			http.post<SetupStateDto>(ENDPOINTS.setupName, {
				forgeName,
				canonicalOrigin,
			}),
		registerIdp: (request: IdpRegisterRequest) =>
			http.post<IdpRegisterResponse>(ENDPOINTS.setupIdpRegister, request),
		configureIdp: (request: IdpConfigRequest) =>
			http.post<SetupOkResponse>(ENDPOINTS.setupIdp, request),
	},

	admin: {
		runLaneSelfTest: () =>
			http.post<LaneSelfTestResult>(ENDPOINTS.selftestLanes),
		lastLaneSelfTest: () =>
			http.get<LaneSelfTestStatus>(ENDPOINTS.selftestLanes),
		settings: () => http.get<ForgeSettingsDto>(ENDPOINTS.settings),
		/** Button path: the generated root key, shown once to move into `TARTAN_SECRET`. */
		exportRootKey: () => http.post<RootKeyExport>(ENDPOINTS.rootKeyExport),
	},

	nodes: {
		children: (parent: string | null, cursor?: string) =>
			http.get<NodesResponse>(ENDPOINTS.nodes, {
				parent: parent ?? undefined,
				cursor,
			}),
		createGroup: (request: GroupCreate) =>
			http.post<NodeDto>(ENDPOINTS.nodes, request),
		createRepo: (request: RepoCreate) =>
			http.post<NodeDto>(ENDPOINTS.repos, request),
	},

	view: (path: string, view: string) =>
		http.get<ViewResponse>(ENDPOINTS.view, { path, view }),

	slots: {
		/**
		 * `slotId` is the contribution id (`SlotInstanceDto.id`, unique within
		 * a manifest): the route's `<slotId>` segment (WP7a).
		 */
		render: (installationId: string, slotId: string, ctx: SlotCtxHint) =>
			http.get<SlotRenderResponse>(
				`${ENDPOINTS.slot}/${enc(installationId)}/${enc(slotId)}`,
				{ ctx: b64urlJson(ctx) },
			),
		action: (
			installationId: string,
			slotId: string,
			request: ActionRequest,
		) =>
			http.post<ActionResponse>(
				`${ENDPOINTS.slot}/${enc(installationId)}/${enc(slotId)}/action`,
				request,
			),
	},

	browse: {
		tree: (repo: string, ref: string, path: string) =>
			http.get<TreeResponse>(ENDPOINTS.tree, { repo, ref, path }),
		blob: (repo: string, ref: string, path: string) =>
			http.get<BlobResponse>(ENDPOINTS.blob, { repo, ref, path }),
		log: (repo: string, ref: string, path?: string, cursor?: string) =>
			http.get<LogResponse>(ENDPOINTS.log, { repo, ref, path, cursor }),
		/** `patch`: each file carries its unified patch (`patch=1`), within the kernel's caps. */
		commit: (repo: string, sha: string, options: DiffQuery = {}) =>
			http.get<CommitResponse>(ENDPOINTS.commit, {
				repo,
				sha,
				patch: options.patch ? 1 : undefined,
			}),
		compare: (
			repo: string,
			base: string,
			head: string,
			options: DiffQuery = {},
		) =>
			http.get<CompareResponse>(ENDPOINTS.compare, {
				repo,
				base,
				head,
				patch: options.patch ? 1 : undefined,
			}),
	},

	lanes: {
		/** A repo's lanes by its node path (WP5a; `state` filters, comma-joined). */
		list: (repo: string, query: LaneListQuery = {}) =>
			http.get<LanesResponse>(ENDPOINTS.lanes, {
				repo,
				state: csv(query.state),
				owner: query.owner,
				cursor: query.cursor,
				limit: query.limit,
			}),
		get: (repo: string, laneId: string) =>
			http.get<LaneDto>(`${ENDPOINTS.lanes}/${enc(laneId)}`, { repo }),
		settings: (repoId: string) =>
			http.get<RepoLaneSettingsDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/lanes/settings`,
			),
		saveSettings: (repoId: string, request: RepoLaneSettingsRequest) =>
			http.put<RepoLaneSettingsDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/lanes/settings`,
				request,
			),
	},

	/**
	 * Repository config (WP23, ADR repo config). Reads need a
	 * member (Reporter+); a sign-off, an apply and an override are a
	 * person's acts in a browser session, which the kernel checks.
	 */
	repoConfig: {
		state: (repoId: string) =>
			http.get<RepoConfigStateDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config`,
			),
		schema: (repoId: string) =>
			http.get<RepoConfigSchemaDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/schema`,
			),
		evaluation: (repoId: string, inputKey: string) =>
			http.get<RepoConfigEvalDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/evals/${enc(inputKey)}`,
			),
		/** Asks for a lane preview; answers at once (`evaluating` or a cached result). */
		preview: (repoId: string, laneId: string) =>
			http.post<RepoConfigPreviewDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/preview`,
				{ laneId },
			),
		/** A lane's preview (404 until the lane touches a root .cue file). */
		lane: (repoId: string, laneId: string) =>
			http.get<RepoConfigPreviewDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/lanes/${enc(laneId)}/config`,
			),
		/** Maintainer+, session: "Approve policy change" for the head the page shows (K13.3). */
		signOff: (repoId: string, laneId: string, request: PolicySignoffRequest) =>
			http.post<PolicySignoffDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/lanes/${
					enc(laneId)
				}/policy-signoff`,
				request,
			),
		revokeSignOff: (repoId: string, laneId: string, head: string) =>
			http.del<unknown>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/lanes/${
					enc(laneId)
				}/policy-signoff?head=${enc(head)}`,
			),
		/** Maintainer+, session: apply trunk's config at `sha` (`needs-apply`). */
		apply: (repoId: string, sha: string) =>
			http.post<RepoConfigHeadDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/apply`,
				{ sha },
			),
		reevaluate: (repoId: string) =>
			http.post<RepoConfigHeadDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/reevaluate`,
			),
		/** Owner, session: keep the last good config while held, or clear that. */
		override: (repoId: string, action: "keep-last-good" | "clear") =>
			http.post<RepoConfigHeadDto>(
				`${ENDPOINTS.repoApi}/${enc(repoId)}/config/override`,
				{ action },
			),
		/** An Owner's approvals at a node and their pending requests (members read). */
		approvals: (nodeId: string) =>
			http.get<{
				readonly approvals: readonly ConfigApprovalDto[];
				readonly requests: readonly ConfigApprovalRequestDto[];
			}>(`${ENDPOINTS.nodes}/${enc(nodeId)}/config-approvals`),
	},

	events: {
		/** The repo log after `since`, ascending; `head` is the log's head (WP6). */
		list: (repoId: string, query: EventsQuery = {}) =>
			http.get<EventsResponse>(ENDPOINTS.events, {
				repo: repoId,
				since: query.since,
				limit: query.limit,
				types: csv(query.types),
			}),
	},

	runs: {
		/** A repo's runs, newest first (WP9; repo id, signed-in callers with `read`). */
		list: (repoId: string, query: RunsQuery = {}) =>
			http.get<RunsResponse>(`${ENDPOINTS.runs}/${enc(repoId)}`, {
				subject: query.subject
					? `${query.subject.kind}:${query.subject.id}`
					: undefined,
				cursor: query.cursor,
				limit: query.limit,
			}),
		get: (repoId: string, runId: string) =>
			http.get<RunDto>(`${ENDPOINTS.runs}/${enc(repoId)}/${enc(runId)}`),
		/** The redacted tail of one job's log (`tail` bytes, kernel default 8 KB). */
		log: (repoId: string, runId: string, jobId: string, tail?: number) =>
			http.get<JobLogResponse>(
				`${ENDPOINTS.runs}/${enc(repoId)}/${enc(runId)}/jobs/${enc(jobId)}/log`,
				{ tail },
			),
	},

	land: {
		/** Every trunk move of a repo, newest first (WP10; repo path). */
		advances: (
			repo: string,
			query: { readonly cursor?: string; readonly limit?: number } = {},
		) =>
			http.get<AdvancesResponse>(ENDPOINTS.advances, {
				repo,
				cursor: query.cursor,
				limit: query.limit,
			}),
		/** One land batch (`/-/api/advances/<batchId>`). */
		batch: (repo: string, batchId: string) =>
			http.get<LandBatchDto>(`${ENDPOINTS.advances}/${enc(batchId)}`, {
				repo,
			}),
		why: (repo: string, at: WhyQuery) =>
			http.get<WhyResponse>(ENDPOINTS.why, {
				repo,
				...("sha" in at ? { sha: at.sha } : { path: at.path, line: at.line }),
			}),
	},

	agents: {
		list: () => http.get<AgentsResponse>(ENDPOINTS.agents),
		create: (request: AgentCreateRequest) =>
			http.post<AgentCreatedResponse>(ENDPOINTS.agents, request),
		disable: (agentId: string) =>
			http.del<unknown>(`${ENDPOINTS.agents}/${enc(agentId)}`),
		revokeToken: (tokenId: string) =>
			http.del<unknown>(`${ENDPOINTS.tokens}/${enc(tokenId)}`),
	},

	invites: {
		create: (request: InviteCreateRequest) =>
			http.post<InviteCreated>(ENDPOINTS.invites, request),
	},

	extensions: {
		packages: () => http.get<PackagesResponse>(ENDPOINTS.packages),
		/** What is in force at a node path (WP7a requires `node`). */
		/** Without `node`: at the viewer's start node (WP7a picks one that exists). */
		installations: (node?: string) =>
			http.get<InstallationsResponse>(ENDPOINTS.installations, { node }),
		installation: (id: string) =>
			http.get<InstallationDto>(`${ENDPOINTS.installations}/${enc(id)}`),
		sheet: (request: InstallRequest) =>
			http.post<PermissionSheet>(`${ENDPOINTS.installations}/sheet`, request),
		/** Also installs a protocol pack and its members. */
		install: (request: InstallRequest) =>
			http.post<InstallationDto>(ENDPOINTS.installations, request),
		/**
		 * Swaps the provider of one interface at a node: `dryRun`
		 * answers the plan (the swap sheet) without changing anything.
		 */
		replaceProvider: (request: ReplaceProviderRequest) =>
			http.post<ReplaceProviderResponse>(
				`${ENDPOINTS.installations}/replace`,
				request,
			),
		/** Shadow → enforce; the old enforce installation is disabled. */
		promote: (id: string) =>
			http.post<InstallationDto>(
				`${ENDPOINTS.installations}/${enc(id)}/promote`,
				{},
			),
		/** Replays the `ref.advance` gate over a repo's last `n` (≤ 50) advances. */
		replay: (id: string, request: { repo: string; n?: number }) =>
			http.post<GateReplayResponse>(
				`${ENDPOINTS.installations}/${enc(id)}/replay`,
				request,
			),
		/** The circuit breaker of a js/wasm installation scope. */
		breaker: (id: string, repo?: string) =>
			http.get<BreakerResponse>(
				`${ENDPOINTS.installations}/${enc(id)}/breaker`,
				repo ? { repo } : undefined,
			),
		/** An Owner's reset. */
		resetBreaker: (id: string, repo?: string) =>
			http.post<BreakerResponse>(
				`${ENDPOINTS.installations}/${enc(id)}/breaker${
					repo ? `?repo=${encodeURIComponent(repo)}` : ""
				}`,
				{},
			),
		setMode: (id: string, mode: InstallationMode) =>
			http.put<InstallationDto>(
				`${ENDPOINTS.installations}/${enc(id)}/mode`,
				{ mode },
			),
		/**
		 * An Owner's opt-in at the installation's node (repository config,
		 * WP23): repositories below may overlay its overridable settings.
		 */
		setRepoOverrides: (id: string, on: boolean) =>
			http.put<InstallationDto>(
				`${ENDPOINTS.installations}/${enc(id)}/repo-overrides`,
				{ on },
			),
		/** `contributes.settings` values (REQUEST: route and DTO not in the contract yet). */
		saveConfig: (id: string, config: Readonly<Record<string, unknown>>) =>
			http.put<InstallationDto>(
				`${ENDPOINTS.installations}/${enc(id)}/config`,
				{ config },
			),
	},
});

/** `GET`/`POST /-/api/installations/<id>/breaker`. */
export type BreakerResponse = {
	readonly installation: string;
	readonly scope: { readonly kind: "node" } | {
		readonly kind: "repo";
		readonly repoId: string;
	};
	readonly breaker: BreakerStatus;
};

export type Api = ReturnType<typeof createApi>;

/** `/-/auth/login` with a same-origin `return_to` (anything else becomes `/`). */
export const loginHref = (
	returnTo: string,
	extra: Readonly<Record<string, string>> = {},
): string => {
	const safe = sameOriginPath(returnTo) ?? "/";
	const params = new URLSearchParams({ return_to: safe, ...extra });
	return `${ENDPOINTS.login}?${params.toString()}`;
};
