// Event log, live feed and audit HTTP surface (WP6).
//
// - `GET /-/live?repo=<id>&since=<seq>`: a WebSocket upgrade with the exact
//   canonical `Origin` by a caller who may read the repo. The Worker
//   forwards a fresh request (only the headers it sets: the upgrade and the
//   caller's role) to RepoDO's `events` module, so no client header
//   reaches the DO.
// - `GET /-/api/events?repo=<id>[&since&types&limit&shadow=1]`: the repo log
//   (readers; shadow events for Maintainers+). `&verify=1&from&to` verifies the
//   hash chain over a range. `?stream=forge` reads the forge stream (admins).
// - `GET /-/api/audit?since&limit`: the forge audit log (admins).

import {
	denied,
	EVENT_PATTERN_RE,
	invalid,
	LiveQuerySchema,
	ROLE,
	unauthenticated,
} from "@tartan/contract";
import { type AuthContext, moduleRequest } from "@tartan/contract/kernel.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	intParam,
	json,
	type KernelPorts,
	kernelPorts,
	repoNode,
	repoParam,
	withPorts,
} from "./http.ts";
import { LIVE_ROLE_HEADER } from "./live.ts";
import { READ_DEFAULT_LIMIT, READ_MAX_LIMIT, VERIFY_MAX_RANGE } from "./log.ts";
import { AUDIT_MAX_LIMIT } from "./forge.ts";

/** The forwarded upgrade's URL inside the DO (only its query matters). */
const DO_LIVE_URL = "https://repo.internal/-/live";

const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

const requireAdmin = (auth: AuthContext | null): AuthContext => {
	const a = requireAuth(auth);
	if (!a.isAdmin) throw denied("role", "forge admins only");
	return a;
};

const typesParam = (url: URL): string[] | undefined => {
	const text = url.searchParams.get("types");
	if (text === null || text === "") return undefined;
	const types = text.split(",").map((t) => t.trim()).filter(Boolean);
	if (!types.every((t) => EVENT_PATTERN_RE.test(t))) {
		throw invalid("types are event patterns");
	}
	return types;
};

export const liveHandler = async (
	c: RouteContext,
	ports: KernelPorts,
): Promise<Response> => {
	if (c.req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return json({
			error: "invalid",
			message: "expected a WebSocket upgrade",
		}, 426);
	}
	const query = LiveQuerySchema.safeParse(
		Object.fromEntries(c.url.searchParams),
	);
	if (!query.success) throw invalid("live takes repo=<id> and since=<seq>");
	const origin = c.req.headers.get("origin");
	if (origin === null || origin !== await ports.canonicalOrigin(c.url)) {
		throw denied("csrf", "Origin must be the canonical origin");
	}
	const node = await repoNode(ports, query.data.repo);
	const role = await ports.authorize(c.auth, node, "read");
	const target = new URL(DO_LIVE_URL);
	if (query.data.since !== undefined) {
		target.searchParams.set("since", String(query.data.since));
	}
	const forwarded = new Request(target, {
		headers: { upgrade: "websocket", [LIVE_ROLE_HEADER]: String(role) },
	});
	return await ports.repoFetch(
		query.data.repo,
		moduleRequest("events", forwarded),
	);
};

export const eventsHandler = async (
	c: RouteContext,
	ports: KernelPorts,
): Promise<Response> => {
	const url = c.url;
	if (url.searchParams.get("stream") === "forge") {
		requireAdmin(c.auth);
		const events = await ports.forgeEvents().read(
			intParam(url, "since", 0),
			typesParam(url) ?? ["*"],
			{ limit: intParam(url, "limit", READ_DEFAULT_LIMIT, 1, READ_MAX_LIMIT) },
		);
		return json({
			stream: "forge",
			events,
			head: await ports.forgeEvents().head(),
		});
	}
	requireAuth(c.auth);
	const repo = repoParam(url);
	const role = await ports.authorize(
		c.auth,
		await repoNode(ports, repo),
		"read",
	);
	const log = ports.repoEvents(repo);
	const head = await log.head();
	if (url.searchParams.get("verify") === "1") {
		const from = intParam(url, "from", 1, 1);
		const to = intParam(url, "to", head, 0);
		if (to - from + 1 > VERIFY_MAX_RANGE) {
			throw invalid(`verify at most ${VERIFY_MAX_RANGE} events per call`);
		}
		const verdict = await log.verifyChain(from, to);
		return json({ repo, from, to: Math.min(to, head), head, ...verdict });
	}
	const includeShadow = url.searchParams.get("shadow") === "1";
	if (includeShadow && role < ROLE.maintainer) {
		throw denied("role", "shadow events are for Maintainers");
	}
	const events = await log.read({
		since: intParam(url, "since", 0),
		limit: intParam(url, "limit", READ_DEFAULT_LIMIT, 1, READ_MAX_LIMIT),
		...(typesParam(url) ? { patterns: typesParam(url) } : {}),
		includeShadow,
	});
	return json({ repo, events, head });
};

export const auditHandler = async (
	c: RouteContext,
	ports: KernelPorts,
): Promise<Response> => {
	requireAdmin(c.auth);
	const entries = await ports.forgeEvents().auditLog(
		intParam(c.url, "since", 0),
		intParam(c.url, "limit", 100, 1, AUDIT_MAX_LIMIT),
	);
	return json({ entries });
};

/** `GET /-/live?repo=<id>&since=<seq>`: WebSocket upgrade to the repo feed (exact Origin). */
export const handleLive: RouteHandler = withPorts(liveHandler, kernelPorts);

/** `GET /-/api/events`: event log reads and chain verification. */
export const handleEvents: RouteHandler = withPorts(eventsHandler, kernelPorts);

/** `GET /-/api/audit`: forge audit log (admins). */
export const handleAudit: RouteHandler = withPorts(auditHandler, kernelPorts);
