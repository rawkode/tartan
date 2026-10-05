// The global log's HTTP surface (WP26). Forge Owner only:
//
//   GET  /-/api/log/status                    LogStatusResponse
//   GET  /-/api/log/dead[?limit=&cursor=]     LogDeadListResponse
//   POST /-/api/log/dead/<id>/retry           204 (404 when not parked)
//   POST /-/api/log/dead/<id>/discard         204 (404 when not parked)
//
// A Maintainer (or any non-Owner, agent tokens included) gets 403. The
// answers carry ids, counts, states and codes only. Retry and discard are
// audited (`log.dead.retry`, `log.dead.discard`).

import {
	denied,
	FORGE_DO_NAME,
	httpStatus,
	invalid,
	notFound,
	toWire,
	unauthenticated,
	unavailable,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { withRpc } from "../../do/dispose.ts";
import { FORGE_WIDE_HINT, isForgeWide } from "../http/owner.ts";
import type { LogDeadListResponse } from "./contract.ts";
import {
	envStatusPorts,
	readK2Health,
	readLogStatus,
	type StatusPorts,
} from "./status.ts";

export type LogPorts = StatusPorts & {
	isOwner(principal: string): Promise<boolean>;
	audit(
		entry: { principal: string; action: string; target: string },
	): Promise<void>;
};

export const envLogPorts = (env: Env): LogPorts => {
	const forge = env.FORGE.getByName(FORGE_DO_NAME);
	return {
		...envStatusPorts(env),
		isOwner: (principal) =>
			withRpc(
				() => forge.identity(),
				(identity) => identity.isOwner(principal),
			),
		audit: (entry) =>
			withRpc(() => forge.events(), (events) => events.audit(entry)),
	};
};

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const noContent = (): Response =>
	new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

const errorResponse = (error: unknown): Response => {
	const wire = toWire(error);
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: { "cache-control": "no-store" },
	});
};

/** The forge Owner, signed in as themselves (never an agent token). */
const requireOwner = async (
	auth: AuthContext | null,
	ports: LogPorts,
): Promise<AuthContext> => {
	if (auth === null) throw unauthenticated();
	if (!isForgeWide(auth) || !(await ports.isOwner(auth.principal))) {
		throw denied(
			"role",
			`the global log is for the forge Owner (${FORGE_WIDE_HINT})`,
		);
	}
	return auth;
};

const DEAD_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export const logHandler = async (
	c: RouteContext,
	ports: LogPorts,
): Promise<Response> => {
	const auth = await requireOwner(c.auth, ports);
	const parts = (c.params.rest ?? "").split("/").filter(Boolean);
	const method = c.req.method;
	if (method === "GET" && parts.length === 1 && parts[0] === "status") {
		return json(await readLogStatus(ports));
	}
	if (parts[0] !== "dead") throw notFound("not found");
	const consumer = ports.consumer();
	if (consumer === null) throw unavailable("no global log consumer");
	if (method === "GET" && parts.length === 1) {
		const limitText = c.url.searchParams.get("limit");
		const limit = limitText === null ? undefined : Number(limitText);
		if (
			limit !== undefined &&
			(!Number.isInteger(limit) || limit < 1 || limit > 100)
		) {
			throw invalid("limit must be an integer in [1, 100]");
		}
		const cursor = c.url.searchParams.get("cursor") ?? undefined;
		const page = await consumer.deadList({
			...(limit === undefined ? {} : { limit }),
			...(cursor === undefined ? {} : { cursor }),
		});
		const body: LogDeadListResponse = page;
		return json(body);
	}
	if (
		method === "POST" && parts.length === 3 &&
		(parts[2] === "retry" || parts[2] === "discard")
	) {
		const id = decodeURIComponent(parts[1]);
		if (!DEAD_ID_RE.test(id)) throw invalid("not a record id");
		const done = parts[2] === "retry"
			? await consumer.deadRetry(id)
			: await consumer.deadDiscard(id);
		if (!done) throw notFound("no parked record with that id");
		await ports.audit({
			principal: auth.principal,
			action: `log.dead.${parts[2]}`,
			target: id,
		});
		return noContent();
	}
	throw notFound("not found");
};

/** `/-/api/log/{status,dead[/…]}` (forge Owner only). */
export const handleGlobalLog: RouteHandler = async (c) => {
	try {
		return await logHandler(c, envLogPorts(c.env));
	} catch (error) {
		return errorResponse(error);
	}
};

/** `/-/health` `k2`: off, produce-only, degraded, blocked or ok. */
export const healthK2 = (env: Env) => readK2Health(envStatusPorts(env));
