// `/-/live`, `/-/api/events` and `/-/api/audit` handlers over fake ports (WP6):
// the exact-Origin check, the forwarded upgrade carrying only server-set
// headers, read authorization, shadow reads for Maintainers, chain verification
// and admin-only routes.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createUlid, type Envelope } from "@tartan/contract";
import { DO_MODULE_HEADER } from "@tartan/contract/kernel.ts";
import { errorResponse } from "./http.ts";
import { LIVE_ROLE_HEADER } from "./live.ts";
import { auditHandler, eventsHandler, liveHandler } from "./routes.ts";
import {
	authOf,
	CANONICAL,
	createFakePorts,
	errorOf,
	routeContext,
} from "./testing/ports.ts";

const ulid = createUlid();
const REPO = ulid();
const READER = `u_${ulid()}`;
const MAINTAINER = `u_${ulid()}`;
const STRANGER = `u_${ulid()}`;

const setup = () => {
	const fake = createFakePorts();
	fake.state.repos.add(REPO);
	fake.state.roles.set(READER, 20);
	fake.state.roles.set(MAINTAINER, 40);
	return fake;
};

const run = async (
	handler: typeof liveHandler,
	c: Parameters<typeof liveHandler>[0],
	ports: Parameters<typeof liveHandler>[1],
): Promise<Response> => {
	try {
		return await handler(c, ports);
	} catch (error) {
		return errorResponse(error);
	}
};

const upgrade = (
	origin: string | null,
	extra: Record<string, string> = {},
) => ({
	upgrade: "websocket",
	...(origin === null ? {} : { origin }),
	...extra,
});

Deno.test("live: needs an upgrade, a valid query and the exact canonical Origin", async () => {
	const { ports } = setup();
	const auth = authOf(READER);
	const live = (path: string, headers: Record<string, string>) =>
		run(liveHandler, routeContext("GET", path, { auth, headers }), ports);
	equal((await live(`/-/live?repo=${REPO}`, {})).status, 426);
	equal(
		await errorOf(await live("/-/live?repo=x", upgrade(CANONICAL))),
		"400 invalid",
	);
	equal(
		await errorOf(
			await live(`/-/live?repo=${REPO}&since=0`, upgrade("https://evil.test")),
		),
		"403 denied:csrf",
	);
	equal(
		await errorOf(await live(`/-/live?repo=${REPO}`, upgrade(null))),
		"403 denied:csrf",
	);
	equal(
		await errorOf(
			await live(`/-/live?repo=${ulid()}`, upgrade(CANONICAL)),
		),
		"404 not_found",
	);
});

Deno.test("live: authorizes read and forwards only server-set headers", async () => {
	const { ports, state } = setup();
	const denied = await run(
		liveHandler,
		routeContext("GET", `/-/live?repo=${REPO}`, {
			auth: authOf(STRANGER),
			headers: upgrade(CANONICAL),
		}),
		ports,
	);
	equal(await errorOf(denied), "403 denied:role");
	const anonymous = await run(
		liveHandler,
		routeContext("GET", `/-/live?repo=${REPO}`, {
			auth: null,
			headers: upgrade(CANONICAL),
		}),
		ports,
	);
	equal(anonymous.status, 401);
	equal(state.fetched.length, 0);

	const res = await run(
		liveHandler,
		routeContext("GET", `/-/live?repo=${REPO}&since=42`, {
			auth: authOf(MAINTAINER),
			headers: upgrade(CANONICAL, {
				[LIVE_ROLE_HEADER]: "50",
				cookie: "__Host-tartan-session=secret",
				[DO_MODULE_HEADER]: "core",
			}),
		}),
		ports,
	);
	equal(res.status, 200);
	const [forwarded] = state.fetched;
	const url = new URL(forwarded.url);
	equal(url.search, "?since=42");
	equal(forwarded.headers.get(LIVE_ROLE_HEADER), "40");
	equal(forwarded.headers.get(DO_MODULE_HEADER), "events");
	equal(forwarded.headers.get("cookie"), null);
	equal(forwarded.headers.get("origin"), null);
	equal(forwarded.headers.get("upgrade"), "websocket");
});

const envelope = (seq: number, shadow = false): Envelope => ({
	id: ulid(),
	seq,
	stream: `repo:${REPO}`,
	type: "x.acme.radar.ping",
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "user", id: READER },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow,
	at: seq,
	data: {},
});

Deno.test("events: readers read; shadow is for Maintainers; verify reports the chain", async () => {
	const { ports, state } = setup();
	state.events.push(envelope(1), envelope(2, true), envelope(3));
	const get = (path: string, principal: string | null) =>
		run(
			eventsHandler,
			routeContext("GET", path, {
				auth: principal === null ? null : authOf(principal),
			}),
			ports,
		);
	equal((await get(`/-/api/events?repo=${REPO}`, null)).status, 401);
	equal(
		await errorOf(await get(`/-/api/events?repo=${REPO}`, STRANGER)),
		"403 denied:role",
	);
	// deno-lint-ignore no-explicit-any
	const body: any = await (await get(`/-/api/events?repo=${REPO}`, READER))
		.json();
	deepStrictEqual(body.events.map((e: Envelope) => e.seq), [1, 3]);
	equal(body.head, 3);
	equal(
		await errorOf(await get(`/-/api/events?repo=${REPO}&shadow=1`, READER)),
		"403 denied:role",
	);
	// deno-lint-ignore no-explicit-any
	const shadow: any = await (await get(
		`/-/api/events?repo=${REPO}&shadow=1`,
		MAINTAINER,
	)).json();
	deepStrictEqual(shadow.events.map((e: Envelope) => e.seq), [1, 2, 3]);
	const verify = await (await get(
		`/-/api/events?repo=${REPO}&verify=1`,
		READER,
	)).json();
	deepStrictEqual(verify, { repo: REPO, from: 1, to: 3, head: 3, ok: true });
	equal(
		await errorOf(await get(`/-/api/events?repo=${REPO}&since=-1`, READER)),
		"400 invalid",
	);
	equal(
		await errorOf(await get(`/-/api/events?repo=${REPO}&types=a%20b`, READER)),
		"400 invalid",
	);
});

Deno.test("forge stream and audit are admin-only", async () => {
	const { ports } = setup();
	const forge = (auth: ReturnType<typeof authOf>) =>
		run(
			eventsHandler,
			routeContext("GET", "/-/api/events?stream=forge", { auth }),
			ports,
		);
	equal(await errorOf(await forge(authOf(READER))), "403 denied:role");
	const ok1 = await forge(authOf(READER, { isAdmin: true }));
	deepStrictEqual(await ok1.json(), { stream: "forge", events: [], head: 0 });
	const audit = (auth: ReturnType<typeof authOf> | null) =>
		run(
			auditHandler,
			routeContext("GET", "/-/api/audit?since=4", { auth }),
			ports,
		);
	equal((await audit(null)).status, 401);
	equal(await errorOf(await audit(authOf(READER))), "403 denied:role");
	const { entries } = await (await audit(authOf(READER, { isAdmin: true })))
		.json() as { entries: { seq: number }[] };
	ok(entries.length === 1 && entries[0].seq === 5);
});
