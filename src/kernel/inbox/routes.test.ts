// `/-/api/inbox` and `inbox_send` (WP6) over
// fake ports: the caller's own inbox, JSON-only writes, the
// recipient-membership rule, 2 KB bodies rejected (not truncated) and
// stripped of control characters.

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
	createUlid,
	INBOX_BODY_MAX_BYTES,
	isTartanError,
} from "@tartan/contract";
import { errorResponse } from "../events/http.ts";
import {
	authOf,
	createFakePorts,
	errorOf,
	routeContext,
} from "../events/testing/ports.ts";
import { inboxHandler } from "./routes.ts";
import { createInboxSend } from "./send.ts";

const ulid = createUlid();
const REPO = ulid();
const SENDER = `a_${ulid()}`;
const MEMBER = `a_${ulid()}`;
const OUTSIDER = `u_${ulid()}`;

const setup = () => {
	const fake = createFakePorts();
	fake.state.repos.add(REPO);
	fake.state.roles.set(SENDER, 30);
	fake.state.roles.set(MEMBER, 30);
	fake.state.handles.set("codex-2", MEMBER);
	return fake;
};

const call = async (
	ports: ReturnType<typeof setup>["ports"],
	method: string,
	rest: string | undefined,
	options: { query?: string; body?: unknown; auth?: string | null } = {},
): Promise<Response> => {
	const auth = options.auth === undefined ? SENDER : options.auth;
	try {
		return await inboxHandler(
			routeContext(
				method,
				`/-/api/inbox${rest ? `/${rest}` : ""}${options.query ?? ""}`,
				{
					auth: auth === null ? null : authOf(auth),
					...(options.body !== undefined ? { body: options.body } : {}),
					...(rest !== undefined ? { rest } : {}),
				},
			),
			ports,
		);
	} catch (error) {
		return errorResponse(error);
	}
};

Deno.test("inbox routes need a caller and known actions", async () => {
	const { ports } = setup();
	equal((await call(ports, "GET", undefined, { auth: null })).status, 401);
	equal(await errorOf(await call(ports, "GET", "nope")), "404 not_found");
	equal(await errorOf(await call(ports, "POST", "peek")), "404 not_found");
	deepStrictEqual(await (await call(ports, "GET", undefined)).json(), {
		notices: [],
		unread: 0,
		head: 0,
	});
	equal((await call(ports, "GET", "peek", { query: "?via=hook" })).status, 200);
	equal(
		await errorOf(await call(ports, "GET", "peek", { query: "?via=mcp" })),
		"400 invalid",
	);
	equal(
		(await call(ports, "GET", "wait", { query: "?timeoutMs=100" })).status,
		200,
	);
	equal(
		await errorOf(
			await call(ports, "GET", "wait", { query: "?timeoutMs=26000" }),
		),
		"400 invalid",
	);
	deepStrictEqual(
		await (await call(ports, "POST", "ack", { body: { ids: ["a", "b"] } }))
			.json(),
		{ acked: 2 },
	);
	equal(
		await errorOf(await call(ports, "POST", "ack", { body: { ids: [] } })),
		"400 invalid",
	);
});

Deno.test("send: resolves handles, needs a member recipient, sanitizes", async () => {
	const { ports, state } = setup();
	const res = await call(ports, "POST", "send", {
		body: {
			to: "codex-2",
			body: "rebase onto ln_7\u001b[2J please",
			repo: REPO,
		},
	});
	equal(res.status, 201);
	equal(state.delivered.length, 1);
	deepStrictEqual(state.delivered[0], {
		principal: MEMBER,
		notice: {
			repoId: REPO,
			kind: "message",
			severity: "info",
			text: "rebase onto ln_7[2J please",
			source: SENDER,
		},
	});
	equal(
		await errorOf(
			await call(ports, "POST", "send", {
				body: { to: OUTSIDER, body: "hi", repo: REPO },
			}),
		),
		"403 denied:role",
	);
	equal(
		await errorOf(
			await call(ports, "POST", "send", {
				body: { to: "ghost", body: "hi", repo: REPO },
			}),
		),
		"404 not_found",
	);
	// A sender who cannot read the repo cannot write about it.
	equal(
		await errorOf(
			await call(ports, "POST", "send", {
				auth: OUTSIDER,
				body: { to: MEMBER, body: "hi", repo: REPO },
			}),
		),
		"403 denied:role",
	);
});

Deno.test("send: bodies over 2 KB of UTF-8 are rejected, not truncated", async () => {
	const { ports, state } = setup();
	const send = createInboxSend({ roleOn: ports.roleOn, inbox: ports.inbox });
	// 683 three-byte characters = 2,049 bytes but only 683 UTF-16 units.
	const body = "€".repeat(683);
	await rejects(
		send({ from: SENDER, to: MEMBER, body, repoId: REPO }),
		(e: unknown) => isTartanError(e) && e.code === "invalid",
	);
	await send({
		from: SENDER,
		to: MEMBER,
		body: "x".repeat(INBOX_BODY_MAX_BYTES),
		repoId: REPO,
	});
	equal(state.delivered.length, 1);
	await rejects(
		send({ from: SENDER, to: MEMBER, body: "   ", repoId: REPO }),
		(e: unknown) => isTartanError(e) && e.code === "invalid",
	);
	await rejects(
		send({ from: SENDER, to: MEMBER, body: "x", repoId: REPO, laneId: "ln_x" }),
		(e: unknown) => isTartanError(e) && e.code === "invalid",
	);
});
