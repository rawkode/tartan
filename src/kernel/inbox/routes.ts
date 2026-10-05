// Inbox HTTP API (WP6). The caller's own inbox
// (`inbox:<principal>`); every route needs a signed-in caller.
//
// - `GET  /-/api/inbox?since&repo&limit` → `InboxResponse` (read; nothing is
//   marked delivered).
// - `GET  /-/api/inbox/peek?limit&repo&via=api|hook` → unread notices,
//   highest severity first, marked delivered (the Claude Code hook uses
//   `via=hook`).
// - `GET  /-/api/inbox/wait?timeoutMs&repo` → long-poll ≤ 25 s.
// - `POST /-/api/inbox/ack {ids}` → `{acked}`.
// - `POST /-/api/inbox/send {to, body, repo, laneId?}` → `{id}`: `to` is a
//   principal id or handle; the sender must read the repo and the recipient
//   must hold a role on it.

import { z } from "zod";
import {
	InboxAckRequestSchema,
	type InboxResponse,
	invalid,
	isPrincipalId,
	notFound,
	unauthenticated,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	intParam,
	json,
	type KernelPorts,
	kernelPorts,
	repoNode,
	withPorts,
} from "../events/http.ts";
import {
	INBOX_WAIT_MAX_MS,
	PEEK_MAX,
	READ_DEFAULT,
	READ_MAX,
} from "./module.ts";
import { createInboxSend } from "./send.ts";

const SendRequestSchema = z.strictObject({
	to: z.string().min(1).max(64),
	body: z.string().min(1).max(8192),
	repo: z.string(),
	laneId: z.string().optional(),
});

const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

const optionalRepo = (url: URL): string | undefined =>
	url.searchParams.get("repo") ?? undefined;

const readJson = async (req: Request): Promise<unknown> => {
	if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
		throw invalid("expected application/json");
	}
	try {
		return await req.json();
	} catch {
		throw invalid("invalid JSON body");
	}
};

export const inboxHandler = async (
	c: RouteContext,
	ports: KernelPorts,
): Promise<Response> => {
	const auth = requireAuth(c.auth);
	const inbox = ports.inbox(auth.principal);
	const action = c.params.rest ?? "";
	const method = c.req.method === "HEAD" ? "GET" : c.req.method;
	const route = `${method} ${action}`;
	switch (route) {
		case "GET ": {
			const since = intParam(c.url, "since", 0);
			const notices = await inbox.read({
				since,
				limit: intParam(c.url, "limit", READ_DEFAULT, 1, READ_MAX),
				...(optionalRepo(c.url) ? { repoId: optionalRepo(c.url) } : {}),
			});
			const body: InboxResponse = {
				notices,
				unread: await inbox.unreadCount(),
				head: notices.at(-1)?.seq ?? since,
			};
			return json(body);
		}
		case "GET peek": {
			const via = c.url.searchParams.get("via") ?? "api";
			if (via !== "api" && via !== "hook") throw invalid("via is api or hook");
			return json({
				notices: await inbox.peek(
					intParam(c.url, "limit", 10, 1, PEEK_MAX),
					via,
					optionalRepo(c.url),
				),
			});
		}
		case "GET wait":
			return json({
				notices: await inbox.wait(
					intParam(c.url, "timeoutMs", INBOX_WAIT_MAX_MS, 0, INBOX_WAIT_MAX_MS),
					optionalRepo(c.url),
					"api",
				),
			});
		case "POST ack": {
			const body = InboxAckRequestSchema.safeParse(await readJson(c.req));
			if (!body.success) throw invalid("ack takes {ids: string[1..200]}");
			return json(await inbox.ack(body.data.ids));
		}
		case "POST send": {
			const body = SendRequestSchema.safeParse(await readJson(c.req));
			if (!body.success) throw invalid("send takes {to, body, repo, laneId?}");
			const { to, repo, laneId } = body.data;
			// The sender must be able to read the repo it writes about.
			await ports.authorize(auth, await repoNode(ports, repo), "read");
			const recipient = isPrincipalId(to)
				? to
				: await ports.principalByHandle(to);
			if (recipient === null) throw notFound(`no principal ${to}`);
			const send = createInboxSend({
				roleOn: ports.roleOn,
				inbox: ports.inbox,
			});
			const result = await send({
				from: auth.principal,
				to: recipient,
				body: body.data.body,
				repoId: repo,
				...(laneId !== undefined ? { laneId } : {}),
			});
			return json(result, result.created ? 201 : 200);
		}
		default:
			throw notFound(`no inbox route ${route.trim()}`);
	}
};

/** `/-/api/inbox[/*]`: read, peek, wait, ack, send. */
export const handleInbox: RouteHandler = withPorts(inboxHandler, kernelPorts);
