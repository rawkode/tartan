// Advances, why and why-blame HTTP API (WP10):
// thin readers of RepoDO `land()`, behind WP2's middleware (`apiPublic`: a
// public repo answers anonymous callers) and WP3's `authorize` (`read` on
// the repo node).
//
//   GET /-/api/why?repo=<path>&sha=<7–40 hex>        → WhyResponse
//   GET /-/api/why?repo=<path>&path=<file>[&line=n]  → the newest landing
//                                                      that touched the file
//   GET /-/api/advances?repo=<path>[&cursor=…][&limit=…] → AdvancesResponse
//   GET /-/api/advances/<batchId>?repo=<path>       → LandBatchDto
//   GET /-/api/blame                                 → 501 (why-blame is M2)
//   POST /-/api/seed-history?repo=<path> {count}    → the dev-only seeding:
//        dev stages with dev tools, a forge admin and the Owner's
//        bounded permission on the repo (it writes trunk past protection),
//        else 404/403; audited as `land.seed_history`
//
// The RepoDO copy of the note answers (git notes are the truth, and the Advance
// writes both from the same builder).

import {
	type AdvancesResponse,
	denied,
	FORGE_DO_NAME,
	httpStatus,
	invalid,
	isIdOf,
	type LandBatchDto,
	type NodeDto,
	notFound,
	type Permission,
	repoDoName,
	toWire,
	type WhyResponse,
} from "@tartan/contract";
import type { CreateAuthorize, TreeFacade } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { notImplementedRoute } from "../stub.ts";
import { createAuthorize } from "../tree/authz.ts";
import type { LandFacade } from "./types.ts";

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

export type LandRoutesDeps = {
	readonly createAuthorize: CreateAuthorize<Env>;
	tree(env: Env): Pick<TreeFacade, "resolvePath">;
	land(
		env: Env,
		repoId: string,
	): Pick<LandFacade, "why" | "status" | "advances" | "seedHistory">;
	/** The forge audit log (ForgeDO `events().audit`). */
	audit(
		env: Env,
		entry: {
			principal: string;
			action: string;
			target: string;
			data: unknown;
		},
	): Promise<void>;
};

export const DEFAULT_LAND_ROUTES_DEPS: LandRoutesDeps = {
	createAuthorize,
	tree: (env) =>
		env.FORGE.getByName(FORGE_DO_NAME).tree() as unknown as Pick<
			TreeFacade,
			"resolvePath"
		>,
	land: (env, repoId) =>
		env.REPO.getByName(repoDoName(repoId)).land() as unknown as LandFacade,
	audit: (env, entry) =>
		env.FORGE.getByName(FORGE_DO_NAME).events().audit(entry),
};

/** Resolves `?repo=<path>` to a repo node the caller holds `perm` on. */
const repoWith = async (
	c: RouteContext,
	deps: LandRoutesDeps,
	perm: Permission,
): Promise<NodeDto> => {
	const path = c.url.searchParams.get("repo");
	if (path === null || path.length === 0) throw invalid("repo is required");
	const resolved = await deps.tree(c.env).resolvePath(path);
	if (
		resolved === null || resolved.node.kind !== "repo" || resolved.rest !== ""
	) {
		throw notFound(`no repo at ${path}`);
	}
	await deps.createAuthorize(c.env)(c.auth, { node: resolved.node }, perm);
	return resolved.node;
};

/** Resolves `?repo=<path>` to a repo node the caller may read. */
const readableRepo = (c: RouteContext, deps: LandRoutesDeps) =>
	repoWith(c, deps, "read");

export const createWhyHandler = (
	deps: LandRoutesDeps = DEFAULT_LAND_ROUTES_DEPS,
): RouteHandler =>
async (c) => {
	try {
		const node = await readableRepo(c, deps);
		const sha = c.url.searchParams.get("sha");
		const path = c.url.searchParams.get("path");
		const line = c.url.searchParams.get("line");
		if ((sha === null) === (path === null)) {
			throw invalid("give exactly one of sha and path");
		}
		const found = await deps.land(c.env, node.id).why({
			...(sha !== null ? { sha } : {}),
			...(path !== null ? { path } : {}),
			...(line !== null && /^\d{1,7}$/.test(line)
				? { line: Number(line) }
				: {}),
		});
		if (found === null) throw notFound("no landing answers this");
		const body: WhyResponse = {
			repo: node.path,
			commit: found.commit,
			note: found.note,
			events: found.events,
		};
		return json(body);
	} catch (error) {
		return failure(error);
	}
};

export const createAdvancesHandler = (
	deps: LandRoutesDeps = DEFAULT_LAND_ROUTES_DEPS,
): RouteHandler =>
async (c) => {
	try {
		const rest = (c.params.rest ?? "").split("/").filter((p) => p !== "");
		if (rest.length > 1) throw notFound("not found");
		const node = await readableRepo(c, deps);
		const land = deps.land(c.env, node.id);
		if (rest.length === 1) {
			if (!isIdOf("batch", rest[0])) throw invalid("not a batch id");
			const status = await land.status(rest[0]);
			if (status === null) throw notFound(`no batch ${rest[0]}`);
			const body: LandBatchDto = status;
			return json(body);
		}
		const cursor = c.url.searchParams.get("cursor");
		const limit = c.url.searchParams.get("limit");
		const page: AdvancesResponse = await land.advances({
			...(cursor !== null ? { cursor } : {}),
			...(limit !== null ? { limit: Number(limit) } : {}),
		});
		return json(page);
	} catch (error) {
		return failure(error);
	}
};

/** Dev stages with dev tools only. */
const devToolsOn = (env: Env): boolean =>
	/^dev/.test(env.TARTAN_STAGE ?? "") && env.TARTAN_DEV_TOOLS === "1";

/**
 * `POST /-/api/seed-history?repo=<path>` `{count}`: the dev-only audited
 * seeding of labelled Advances for the gate replay (demo beat 3). It
 * does not exist without dev tools (404); it is a forge admin's act, never
 * an agent's.
 */
export const createSeedHistoryHandler = (
	deps: LandRoutesDeps = DEFAULT_LAND_ROUTES_DEPS,
): RouteHandler =>
async (c) => {
	try {
		if (!devToolsOn(c.env) || c.req.method !== "POST") {
			throw notFound("not found");
		}
		const auth = c.auth;
		if (auth === null) throw notFound("not found");
		if (auth.kind !== "user") {
			throw denied("actor", "agents cannot seed history");
		}
		if (!auth.isAdmin) throw denied("role", "seeding history needs an admin");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			throw invalid("the body must be JSON");
		}
		const count = (body as { count?: unknown } | null)?.count;
		if (typeof count !== "number") throw invalid("count is a number");
		// A direct trunk write past protected refs, gates and CI: the Owner's
		// permission on the repo, within the credential's bounds.
		const node = await repoWith(c, deps, "install-privileged");
		const seeded = await deps.land(c.env, node.id).seedHistory({
			count,
			actor: { kind: "user", id: auth.principal },
		});
		await deps.audit(c.env, {
			principal: auth.principal,
			action: "land.seed_history",
			target: node.id,
			data: {
				repo: node.path,
				count,
				advances: seeded.advances,
				head: seeded.head,
				withFakeKeys: seeded.withFakeKeys,
			},
		});
		return json({ repo: node.path, ...seeded }, 201);
	} catch (error) {
		return failure(error);
	}
};

/** `POST /-/api/seed-history` (dev tools only). */
export const handleSeedHistory: RouteHandler = createSeedHistoryHandler();

/** `GET /-/api/advances[/*]`: advances and land batches. */
export const handleAdvances: RouteHandler = createAdvancesHandler();

/** `GET /-/api/why`: why note and reason chain for a commit or line. */
export const handleWhy: RouteHandler = createWhyHandler();

/** `GET /-/api/blame`: why-blame ranges (M2: `git blame` in the sandbox). */
export const handleBlame: RouteHandler = notImplementedRoute;
