// Lanes HTTP API (WP5a): thin callers of RepoDO
// core, which runs K16 itself on the actor built here from the
// authenticated context (never from request input), credential bounds
// included. WP3's `authorize` checks the role at the repo node first (`read`
// to look, `claim` to open, close or delegate); WP2's middleware has already
// authenticated the caller and checked CSRF and the `api` scope.
//
//   GET    /-/api/lanes?repo=<path>[&state=…][&owner=…][&cursor=…][&limit=…]
//   GET    /-/api/lanes/<laneId>?repo=<path>
//   POST   /-/api/lanes                     {repo, purpose, footprint?} → 201
//   DELETE /-/api/lanes/<laneId>?repo=<path>[&reason=…]           → 204
//   POST   /-/api/lanes/<laneId>/delegates  {repo, add?, remove?}
//   GET|PUT /-/api/repos/<repoId>/lanes/settings (Owner)
//
// The `repo` backend's self-test route is WP5b's
// (`lanes/repo-backend/index.ts`).

import {
	denied,
	FORGE_DO_NAME,
	httpStatus,
	invalid,
	isIdOf,
	isPrincipalId,
	LANE_STATES,
	LaneOpenRequestSchema,
	type LaneState,
	type NodeDto,
	notFound,
	type Permission,
	repoDoName,
	RepoLaneSettingsRequestSchema,
	ROLE,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type Authorize,
	type CreateAuthorize,
	type LaneOpActor,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { createNodeAccess, type NodeAccessCheck } from "../tree/authz.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: NO_STORE });

const failure = (error: unknown): Response => {
	const wire = toWire(error);
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: NO_STORE,
	});
};

/**
 * The K16 actor of an authenticated caller, with a token's credential bounds
 * (RepoDO bounds the role it derives with them).
 */
export const actorOf = (auth: AuthContext): LaneOpActor => ({
	kind: auth.kind,
	id: auth.principal,
	...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
	...(auth.via !== "session" ? { bounds: actorBoundsOf(auth) } : {}),
});

const requireAuth = (c: RouteContext): AuthContext => {
	if (c.auth === null) throw unauthenticated();
	return c.auth;
};

const forgeTree = (env: Env) => env.FORGE.getByName(FORGE_DO_NAME).tree();

const repoCore = (env: Env, repoId: string) =>
	env.REPO.getByName(repoDoName(repoId)).core();

export type LaneRoutesDeps = {
	/** WP3's authorization (tests inject one). */
	readonly createAuthorize: CreateAuthorize<Env>;
};

/**
 * WP3's authorization, plus membership for lane reads: `read` on a public
 * repo is the public view (Reporter for anyone), but lanes live in the hidden
 * namespaces, so listing or reading one needs a member's Reporter.
 */
export const laneAuthorize =
	(access: NodeAccessCheck): Authorize => async (auth, target, perm) => {
		const { role, member } = await access(auth, target, perm);
		if (perm === "read" && member < ROLE.reporter) {
			throw denied("role", "lanes are visible to repo members only");
		}
		return role;
	};

const createLaneAuthorize: CreateAuthorize<Env> = (env) =>
	laneAuthorize(createNodeAccess(env));

const DEFAULT_DEPS: LaneRoutesDeps = { createAuthorize: createLaneAuthorize };

const readJson = async (req: Request): Promise<unknown> => {
	try {
		return await req.json();
	} catch {
		throw invalid("the body must be JSON");
	}
};

type DelegatesBody = {
	readonly repo: string;
	readonly add: readonly string[];
	readonly remove: readonly string[];
};

const principalList = (value: unknown): string[] => {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) || value.length > 32 ||
		!value.every((p) => typeof p === "string" && isPrincipalId(p))
	) {
		throw invalid("add and remove are lists of principal ids");
	}
	return value as string[];
};

const delegatesBody = (body: unknown): DelegatesBody => {
	const input = (body ?? {}) as Record<string, unknown>;
	if (typeof input.repo !== "string" || input.repo.length === 0) {
		throw invalid("repo is required");
	}
	return {
		repo: input.repo,
		add: principalList(input.add),
		remove: principalList(input.remove),
	};
};

const parseStates = (value: string | null): LaneState[] | undefined => {
	if (value === null || value === "") return undefined;
	const states = value.split(",");
	for (const state of states) {
		if (!(LANE_STATES as readonly string[]).includes(state)) {
			throw invalid(`unknown lane state: ${state}`);
		}
	}
	return states as LaneState[];
};

/** `/-/api/lanes[/*]`: list, get, open, close and delegate lanes. */
export const createLanesHandler = (
	deps: LaneRoutesDeps = DEFAULT_DEPS,
): RouteHandler =>
async (c) => {
	/** A repo node by path, after WP3's `authorize` for `perm` (at `laneId`: lane pins apply). */
	const repoAt = async (
		c: RouteContext,
		auth: AuthContext,
		path: string | null,
		perm: Permission,
		laneId?: string,
	): Promise<NodeDto> => {
		if (path === null || path.length === 0) throw invalid("repo is required");
		const resolved = await forgeTree(c.env).resolvePath(path);
		if (
			resolved === null || resolved.node.kind !== "repo" || resolved.rest !== ""
		) {
			throw notFound(`no repo at ${path}`);
		}
		await deps.createAuthorize(c.env)(
			auth,
			{ node: resolved.node, ...(laneId ? { laneId } : {}) },
			perm,
		);
		return resolved.node;
	};
	try {
		const auth = requireAuth(c);
		const rest = (c.params.rest ?? "").split("/").filter((p) => p !== "");
		const method = c.req.method;
		const repoParam = c.url.searchParams.get("repo");
		if (rest.length === 0 && method === "GET") {
			const node = await repoAt(c, auth, repoParam, "read");
			const owner = c.url.searchParams.get("owner");
			if (owner !== null && !isPrincipalId(owner)) {
				throw invalid(`invalid owner: ${owner}`);
			}
			const limit = Number(c.url.searchParams.get("limit") ?? "50");
			const cursor = c.url.searchParams.get("cursor");
			const states = parseStates(c.url.searchParams.get("state"));
			const page = await repoCore(c.env, node.id).listLanes({
				...(states ? { state: states } : {}),
				...(owner !== null ? { owner } : {}),
				...(cursor !== null ? { cursor } : {}),
				limit: Number.isFinite(limit) ? limit : 50,
			});
			return json(page);
		}
		if (rest.length === 0 && method === "POST") {
			const body = LaneOpenRequestSchema.safeParse(await readJson(c.req));
			if (!body.success) throw invalid("invalid lane open request");
			const node = await repoAt(c, auth, body.data.repo, "claim");
			const lane = await repoCore(c.env, node.id).openLane({
				owner: auth.principal,
				...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
				...(body.data.footprint ? { footprint: body.data.footprint } : {}),
				actor: actorOf(auth),
			});
			return json(lane, 201);
		}
		const laneId = rest[0];
		if (!isIdOf("lane", laneId)) throw notFound("no such lane");
		if (rest.length === 1 && method === "GET") {
			const node = await repoAt(c, auth, repoParam, "read");
			const lane = await repoCore(c.env, node.id).getLane(laneId);
			if (lane === null) throw notFound("no such lane");
			return json(lane);
		}
		if (rest.length === 1 && method === "DELETE") {
			// A lane mutation, like open: `claim` (the `lanes` scope), bounded.
			const node = await repoAt(c, auth, repoParam, "claim", laneId);
			const reason = c.url.searchParams.get("reason") ?? "closed via the API";
			await repoCore(c.env, node.id).closeLane(laneId, reason, actorOf(auth));
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		if (rest.length === 2 && rest[1] === "delegates" && method === "POST") {
			const body = delegatesBody(await readJson(c.req));
			const node = await repoAt(c, auth, body.repo, "claim", laneId);
			const core = repoCore(c.env, node.id);
			await core.delegateLane(laneId, body.add, body.remove, actorOf(auth));
			return json(await core.getLane(laneId));
		}
		throw notFound("no such lane endpoint");
	} catch (error) {
		return failure(error);
	}
};

export const handleLanes: RouteHandler = createLanesHandler();

/**
 * `GET|PUT /-/api/repos/<id>/lanes/settings` (Owner): lane mode, active lane
 * cap and attic retention of one repo (`RepoLaneSettingsDto`).
 */
export const createLaneSettingsHandler = (
	deps: LaneRoutesDeps = DEFAULT_DEPS,
): RouteHandler =>
async (c) => {
	try {
		const auth = requireAuth(c);
		const repoId = c.params.repoId ?? "";
		const node = await forgeTree(c.env).node(repoId);
		if (node === null || node.kind !== "repo") throw notFound("no such repo");
		await deps.createAuthorize(c.env)(auth, { node }, "grant");
		const core = repoCore(c.env, node.id);
		if (c.req.method === "GET") return json(await core.laneSettings());
		const body = RepoLaneSettingsRequestSchema.safeParse(await readJson(c.req));
		if (!body.success) throw invalid("invalid lane settings");
		return json(await core.setLaneSettings(body.data, actorOf(auth)));
	} catch (error) {
		return failure(error);
	}
};

export const handleLaneSettings: RouteHandler = createLaneSettingsHandler();
