// The SPA against the merged kernel handlers (the wave-1 blocking
// mismatches): WP2's setup routes (`status`, `code`, `unlock`) and
// `MeResponse`, WP7a's installations shape, WP5a's lanes and WP6's events
// query names. Each case pins the path, method and query the real handler
// reads, and the SPA's reading of the real response shape.

import { describe, expect, it } from "vitest";
import type { MeResponse } from "@tartan/contract/api.ts";
import { createApi, ENDPOINTS } from "../src/api/client.ts";
import { createHttp, type FetchLike } from "../src/api/http.ts";
import { createSession } from "../src/auth/session.ts";
import { recordingFetch } from "./support/app.ts";

const answering = (body: unknown, status = 200): FetchLike => () =>
	Promise.resolve(Response.json(body, { status }));

const apiWith = (inner: FetchLike) => {
	const rec = recordingFetch(inner);
	return { api: createApi(createHttp(rec.fetch)), calls: rec.calls };
};

describe("setup routes (WP2 `handleSetupApi`)", () => {
	it("reads the status and asks for a claim code with POSTs", async () => {
		const { api, calls } = apiWith(answering({ created: true }));
		await api.setup.status();
		await api.setup.code();
		await api.setup.unlock("a-token-of-sixteen-chars");
		expect(calls.map((c) => [c.method, c.path])).toEqual([
			["POST", "/-/setup/status"],
			["POST", "/-/setup/code"],
			["POST", "/-/setup/unlock"],
		]);
		expect(calls[2]?.body).toEqual({ token: "a-token-of-sixteen-chars" });
		expect(Object.values(ENDPOINTS)).not.toContain("/-/setup/state");
		expect(Object.values(ENDPOINTS).some((p) => p.endsWith("/pack"))).toBe(
			false,
		);
	});
});

describe("session (WP2 `MeResponse`)", () => {
	const me: MeResponse = {
		principal: {
			id: "u_01k6g000000000000000000001",
			kind: "user",
			handle: "rawkode",
			display: "David",
			avatar: "/-/avatar/u_01k6g000000000000000000001",
		},
		auth: {
			via: "session",
			isAdmin: true,
			scopes: [],
			nodeId: null,
			laneId: null,
			maxRole: 50,
		},
		forge: { rootKeyFallback: true, devTools: false },
	};

	it("reads isAdmin from auth, not the top level", async () => {
		const session = createSession(apiWith(answering(me)).api);
		await session.load();
		expect(session.state.status).toBe("signed-in");
		expect(session.isAdmin()).toBe(true);
		expect(session.principal()?.handle).toBe("rawkode");
		expect(session.state.me?.forge.rootKeyFallback).toBe(true);

		const member = createSession(
			apiWith(answering({ ...me, auth: { ...me.auth, isAdmin: false } })).api,
		);
		await member.load();
		expect(member.isAdmin()).toBe(false);
	});

	it("treats `{principal: null}` and 503 setup_required as signed out", async () => {
		const anonymous = createSession(
			apiWith(answering({ principal: null })).api,
		);
		await anonymous.load();
		expect(anonymous.state.status).toBe("anonymous");
		expect(anonymous.isAdmin()).toBe(false);
		expect(anonymous.principal()).toBeNull();

		const unclaimed = createSession(
			apiWith(
				answering({ error: "setup_required", message: "set up first" }, 503),
			).api,
		);
		await unclaimed.load();
		expect(unclaimed.state.status).toBe("anonymous");

		const broken = createSession(
			apiWith(answering({ error: "internal", message: "boom" }, 500)).api,
		);
		await broken.load();
		expect(broken.state.status).toBe("error");
	});
});

describe("installations (WP7a)", () => {
	it("always sends the node, which the handler requires", async () => {
		const { api, calls } = apiWith(answering({ node: {}, installations: [] }));
		const res = await api.extensions.installations("acme/platform");
		expect(calls[0]?.path).toBe("/-/api/installations?node=acme%2Fplatform");
		expect(res.installations).toEqual([]);
	});
});

describe("lanes (WP5a) and events (WP6)", () => {
	it("uses the handlers' query names", async () => {
		const { api, calls } = apiWith(
			answering({ lanes: [], events: [], head: 0 }),
		);
		await api.lanes.list("acme/platform/router", {
			state: ["open", "opening"],
			limit: 200,
			cursor: "ln_x",
		});
		await api.lanes.get(
			"acme/platform/router",
			"ln_01k6g000000000000000003001",
		);
		await api.events.list("01k6g000000000000000000040", {
			since: 12,
			limit: 500,
			types: ["lane.*", "push.accepted"],
		});
		await api.events.list("01k6g000000000000000000040");
		expect(calls.map((c) => c.path)).toEqual([
			"/-/api/lanes?repo=acme%2Fplatform%2Frouter&state=open%2Copening&cursor=ln_x&limit=200",
			"/-/api/lanes/ln_01k6g000000000000000003001?repo=acme%2Fplatform%2Frouter",
			"/-/api/events?repo=01k6g000000000000000000040&since=12&limit=500&types=lane.*%2Cpush.accepted",
			"/-/api/events?repo=01k6g000000000000000000040",
		]);
	});
});
