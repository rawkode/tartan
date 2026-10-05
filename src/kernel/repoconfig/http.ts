// Repository-config HTTP API (ADR repo config, "MCP, CLI and HTTP"). Thin
// callers of RepoDO's repoconfig facade and ForgeDO's registry: the
// role, session and lane-ownership checks live here, the state machine and
// the registry rules in the modules. Every handler takes its facades as
// explicit dependencies (`routes.ts` binds them to the Worker).
//
//   GET    /-/api/repos/:repo/config                      Reporter+ (member)
//   GET    /-/api/repos/:repo/config/schema               Reporter+ (member)
//   GET    /-/api/repos/:repo/config/evals/:inputKey      Reporter+ (member)
//   POST   /-/api/repos/:repo/config/preview  {laneId}    lane readers; agents: own lanes
//   POST   /-/api/repos/:repo/config/apply    {sha}       Maintainer+, session
//   POST   /-/api/repos/:repo/config/reevaluate           Maintainer+, session
//   POST   /-/api/repos/:repo/config/override {action}    Owner, session
//   GET    /-/api/repos/:repo/lanes/:laneId/config        lane readers
//   POST   /-/api/repos/:repo/lanes/:laneId/policy-signoff {head, policyDigest}
//                                                         Maintainer+, session
//   DELETE /-/api/repos/:repo/lanes/:laneId/policy-signoff?head=<sha>
//                                                         Maintainer+, session
//   GET    /-/api/nodes/:node/config-approvals            Reporter+ (member)
//   PUT    /-/api/nodes/:node/config-approvals/:extId     Owner, session
//   DELETE /-/api/nodes/:node/config-approvals/:extId     Owner, session
//   PUT    /-/api/installations/:id/repo-overrides {on}   Owner at the installation's node, session
//
// A sign-off, an apply, a re-evaluation, an override and an approval are a
// person's acts in a browser (K13.3): a token (agent or PAT) is refused with
// `denied(session)`. A caller who cannot read a node gets the same 404 for a
// real repo, node or installation as for an unknown one:
// the role check comes before anything about the looked-up thing is said.
// Repository-controlled strings in the answers (CUE messages, resolved
// settings, repo policy) are data; the SPA renders them as text only.

import {
	ConfigApprovalRequestSchema,
	denied,
	ExtIdSchema,
	fromRpcError,
	httpStatus,
	InputKeySchema,
	invalid,
	isIdOf,
	isUlid,
	type Lane,
	type NodeDto,
	notFound,
	type Permission,
	PolicySignoffRequestSchema,
	RepoConfigApplyRequestSchema,
	RepoConfigOverrideRequestSchema,
	RepoConfigPreviewRequestSchema,
	type RepoConfigStateDto,
	RepoOverridesRequestSchema,
	ROLE,
	ShaSchema,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import type {
	AuthContext,
	RegistryFacade,
	RepoConfigFacade,
} from "@tartan/contract/kernel.ts";
import type { NodeAccessCheck } from "../tree/authz.ts";

export type RepoConfigHttpDeps = {
	readonly node: (id: string) => Promise<NodeDto | null>;
	/** WP3's `createNodeAccess`: the role for `perm` (throws below it) and the member role. */
	readonly access: NodeAccessCheck;
	readonly repoconfig: (
		repoId: string,
	) => Pick<
		RepoConfigFacade,
		| "state"
		| "evaluation"
		| "preview"
		| "previewOf"
		| "signOff"
		| "revokeSignOff"
		| "apply"
		| "reevaluate"
		| "override"
	>;
	readonly lane: (repoId: string, laneId: string) => Promise<Lane | null>;
	readonly registry: Pick<
		RegistryFacade,
		| "repoConfigSchema"
		| "repoConfigEffective"
		| "requestConfigApproval"
		| "revokeConfigApproval"
		| "configApprovals"
		| "setRepoOverrides"
		| "installation"
	>;
};

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: NO_STORE });

const noContent = (): Response =>
	new Response(null, { status: 204, headers: NO_STORE });

const failure = (error: unknown): Response => {
	const wire = toWire(error);
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: NO_STORE,
	});
};

const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

/** A person in a browser (K13.3): never an agent token or a PAT. */
export const requireSessionUser = (
	auth: AuthContext,
	what: string,
): AuthContext => {
	if (auth.via !== "session" || auth.kind !== "user") {
		throw denied("session", `${what} needs a person in a browser session`);
	}
	return auth;
};

const readJson = async (req: Request): Promise<unknown> => {
	const text = await req.text();
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw invalid("the body must be JSON");
	}
};

const parseBody = async <T>(
	req: Request,
	schema: {
		safeParse(
			v: unknown,
		): { success: true; data: T } | { success: false };
	},
	what: string,
): Promise<T> => {
	const parsed = schema.safeParse(await readJson(req));
	if (!parsed.success) throw invalid(`invalid ${what}`);
	return parsed.data;
};

export const createRepoConfigHttp = (deps: RepoConfigHttpDeps) => {
	/** Whether the caller may see the node at all (`read-metadata`; else it does not exist for them). */
	const canRead = async (
		auth: AuthContext,
		node: NodeDto,
	): Promise<boolean> => {
		try {
			await deps.access(auth, { node }, "read-metadata");
			return true;
		} catch (error) {
			if (fromRpcError(error).code === "denied") return false;
			throw error;
		}
	};

	/** A node the caller can read; 404 for an unknown one and an unreadable one alike. */
	const readable = async (
		auth: AuthContext,
		node: NodeDto | null,
		what: string,
	): Promise<NodeDto> => {
		if (node === null || !(await canRead(auth, node))) {
			throw notFound(`no such ${what}`);
		}
		return node;
	};

	const repoNode = async (
		auth: AuthContext,
		repoId: string,
	): Promise<NodeDto> => {
		const node = isUlid(repoId) ? await deps.node(repoId) : null;
		if (node === null || node.kind !== "repo") throw notFound("no such repo");
		return await readable(auth, node, "repo");
	};

	/** `perm` at the node (lane pins apply at `laneId`); reads need a member's Reporter. */
	const authorize = async (
		auth: AuthContext,
		node: NodeDto,
		perm: Permission,
		laneId?: string,
	): Promise<void> => {
		const { member } = await deps.access(
			auth,
			{ node, ...(laneId ? { laneId } : {}) },
			perm,
		);
		if (perm === "read" && member < ROLE.reporter) {
			throw denied("role", "repository config is visible to members only");
		}
	};

	/** The lane, which must belong to the repo; an agent may name only its own (or delegated) lanes. */
	const laneOf = async (
		auth: AuthContext,
		repoId: string,
		laneId: string,
	): Promise<Lane> => {
		if (!isIdOf("lane", laneId)) throw notFound("no such lane");
		const lane = await deps.lane(repoId, laneId);
		if (lane === null || lane.repoId !== repoId) {
			throw notFound("no such lane in this repo");
		}
		if (
			auth.kind === "agent" && lane.owner !== auth.principal &&
			!lane.delegates.includes(auth.principal)
		) {
			throw denied("lane-op", "an agent may preview only its own lanes");
		}
		return lane;
	};

	/** `/-/api/repos/:repoId/config[/<rest>]`. */
	const config = async (
		req: Request,
		params: { readonly repoId: string; readonly rest?: string },
		authIn: AuthContext | null,
	): Promise<Response> => {
		try {
			const auth = requireAuth(authIn);
			const node = await repoNode(auth, params.repoId);
			const facade = deps.repoconfig(node.id);
			const rest = (params.rest ?? "").split("/").filter((p) => p !== "");
			const method = req.method === "HEAD" ? "GET" : req.method;
			if (rest.length === 0 && method === "GET") {
				await authorize(auth, node, "read");
				const [head, forge] = await Promise.all([
					facade.state(),
					deps.registry.repoConfigEffective(node.id),
				]);
				const state: RepoConfigStateDto = {
					...head,
					effective: forge.effective,
					approvals: forge.approvals,
					epoch: forge.epoch,
				};
				return json(state);
			}
			if (rest.length === 1 && rest[0] === "schema" && method === "GET") {
				await authorize(auth, node, "read");
				return json(await deps.registry.repoConfigSchema(node.id));
			}
			if (rest.length === 2 && rest[0] === "evals" && method === "GET") {
				await authorize(auth, node, "read");
				const key = InputKeySchema.safeParse(rest[1]);
				if (!key.success) throw invalid("an input key is 64 hex digits");
				const row = await facade.evaluation(key.data);
				if (row === null) throw notFound("no cached evaluation for that key");
				return json(row);
			}
			if (rest.length === 1 && method === "POST") {
				switch (rest[0]) {
					case "preview": {
						const body = await parseBody(
							req,
							RepoConfigPreviewRequestSchema,
							"preview request",
						);
						await authorize(auth, node, "read", body.laneId);
						await laneOf(auth, node.id, body.laneId);
						return json(await facade.preview(body.laneId, auth.principal));
					}
					case "apply": {
						requireSessionUser(auth, "applying trunk config");
						await authorize(auth, node, "approve");
						const body = await parseBody(
							req,
							RepoConfigApplyRequestSchema,
							"apply request",
						);
						return json(await facade.apply(body.sha, auth.principal));
					}
					case "reevaluate": {
						// It resets trunk work and backoffs: a person's act.
						requireSessionUser(auth, "re-evaluating trunk config");
						await authorize(auth, node, "approve");
						return json(await facade.reevaluate(auth.principal));
					}
					case "override": {
						requireSessionUser(auth, "keeping the last good config");
						await authorize(auth, node, "grant");
						const body = await parseBody(
							req,
							RepoConfigOverrideRequestSchema,
							"override request",
						);
						return json(await facade.override(body.action, auth.principal));
					}
				}
			}
			throw notFound("no such repository-config endpoint");
		} catch (error) {
			return failure(error);
		}
	};

	/** `/-/api/repos/:repoId/lanes/:laneId/(config|policy-signoff)`. */
	const lane = async (
		req: Request,
		params: {
			readonly repoId: string;
			readonly laneId: string;
			readonly what: string;
		},
		authIn: AuthContext | null,
	): Promise<Response> => {
		try {
			const auth = requireAuth(authIn);
			const node = await repoNode(auth, params.repoId);
			const facade = deps.repoconfig(node.id);
			const method = req.method === "HEAD" ? "GET" : req.method;
			if (params.what === "config" && method === "GET") {
				await authorize(auth, node, "read", params.laneId);
				const ln = await deps.lane(node.id, params.laneId);
				if (ln === null || ln.repoId !== node.id) {
					throw notFound("no such lane in this repo");
				}
				const preview = await facade.previewOf(params.laneId);
				if (preview === null) {
					throw notFound("no repository-config preview for this lane yet");
				}
				return json(preview);
			}
			if (params.what === "policy-signoff" && method === "POST") {
				requireSessionUser(auth, "a policy sign-off");
				await authorize(auth, node, "approve");
				const body = await parseBody(
					req,
					PolicySignoffRequestSchema,
					"sign-off (it names {head, policyDigest})",
				);
				return json(
					await facade.signOff(params.laneId, body, auth.principal),
					201,
				);
			}
			if (params.what === "policy-signoff" && method === "DELETE") {
				requireSessionUser(auth, "revoking a policy sign-off");
				await authorize(auth, node, "approve");
				const head = ShaSchema.safeParse(
					new URL(req.url).searchParams.get("head"),
				);
				if (!head.success) throw invalid("head=<sha> is required");
				await facade.revokeSignOff(params.laneId, head.data, auth.principal);
				return noContent();
			}
			throw notFound("no such lane endpoint");
		} catch (error) {
			return failure(error);
		}
	};

	/** `/-/api/nodes/:nodeId/config-approvals[/:extId]`. */
	const approvals = async (
		req: Request,
		params: { readonly nodeId: string; readonly extId?: string },
		authIn: AuthContext | null,
	): Promise<Response> => {
		try {
			const auth = requireAuth(authIn);
			const node = await readable(
				auth,
				await deps.node(params.nodeId),
				"node",
			);
			const method = req.method === "HEAD" ? "GET" : req.method;
			if (params.extId === undefined || params.extId === "") {
				if (method !== "GET") throw notFound("name the extension");
				await authorize(auth, node, "read");
				return json(await deps.registry.configApprovals(node.id));
			}
			const extId = ExtIdSchema.safeParse(params.extId);
			if (!extId.success) throw invalid("not an extension id");
			if (method === "PUT") {
				requireSessionUser(auth, "approving a package for repo config");
				await authorize(auth, node, "grant");
				const body = await parseBody(
					req,
					ConfigApprovalRequestSchema,
					"approval (it names {version, backgroundRole?})",
				);
				return json(
					await deps.registry.requestConfigApproval(
						auth.principal,
						node.id,
						extId.data,
						body,
					),
					202,
				);
			}
			if (method === "DELETE") {
				requireSessionUser(auth, "revoking a repo-config approval");
				await authorize(auth, node, "grant");
				await deps.registry.revokeConfigApproval(
					auth.principal,
					node.id,
					extId.data,
				);
				return noContent();
			}
			throw notFound("no such approvals endpoint");
		} catch (error) {
			return failure(error);
		}
	};

	/** `PUT /-/api/installations/:installationId/repo-overrides {on}`. */
	const repoOverrides = async (
		req: Request,
		params: { readonly installationId: string },
		authIn: AuthContext | null,
	): Promise<Response> => {
		try {
			const auth = requireAuth(authIn);
			if (req.method !== "PUT") throw notFound("use PUT");
			requireSessionUser(auth, "changing repo overrides");
			if (!isIdOf("installation", params.installationId)) {
				throw notFound("no such installation");
			}
			const installation = await deps.registry.installation(
				params.installationId,
			);
			// A caller who cannot read the installation's node learns
			// nothing about it (the same 404 as an unknown id); the Owner role
			// is checked before anything else.
			const node = await readable(
				auth,
				installation === null ? null : await deps.node(installation.nodeId),
				"installation",
			);
			await authorize(auth, node, "grant");
			const body = await parseBody(
				req,
				RepoOverridesRequestSchema,
				"repo-overrides request (it names {on})",
			);
			return json(
				await deps.registry.setRepoOverrides(
					auth.principal,
					params.installationId,
					body.on,
				),
			);
		} catch (error) {
			return failure(error);
		}
	};

	return { config, lane, approvals, repoOverrides };
};

export type RepoConfigHttp = ReturnType<typeof createRepoConfigHttp>;
