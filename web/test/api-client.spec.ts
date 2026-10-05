// The typed API client: same-origin cookies, JSON bodies (CSRF needs the
// content type), WireError mapping, slot URL shapes, login `return_to`.

import { describe, expect, it } from "vitest";
import { b64urlJson, createApi, loginHref } from "../src/api/client.ts";
import {
	ApiError,
	createHttp,
	errorMessage,
	type FetchLike,
	HTTP_TIMEOUT_MS,
	HTTP_WRITE_TIMEOUT_MS,
	withQuery,
} from "../src/api/http.ts";
import { recordingFetch } from "./support/app.ts";

const reply = (status: number, body?: unknown): FetchLike => () =>
	Promise.resolve(
		new Response(body === undefined ? "" : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);

describe("http", () => {
	it("sends JSON with same-origin credentials", async () => {
		const seen: RequestInit[] = [];
		const http = createHttp((_input, init) => {
			seen.push(init ?? {});
			return reply(200, { ok: true })("");
		});
		await http.post("/-/api/x", { a: 1 });
		await http.get("/-/api/y");
		expect(seen[0]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
			body: '{"a":1}',
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
		});
		expect(seen[1]).toMatchObject({
			method: "GET",
			credentials: "same-origin",
		});
		expect((seen[1]!.headers as Record<string, string>)["content-type"])
			.toBeUndefined();
	});

	it("maps WireError bodies to ApiError", async () => {
		const http = createHttp(
			reply(403, { error: "denied", message: "Not yours", reason: "lane" }),
		);
		const error = await http.get("/-/api/x").catch((e) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 403,
			code: "denied",
			message: "Not yours",
			reason: "lane",
		});
		expect(errorMessage(error)).toBe("Not yours");
	});

	it("maps non-JSON failures and network errors", async () => {
		const http = createHttp(() =>
			Promise.resolve(new Response("<html>", { status: 502 }))
		);
		expect(await http.get("/x").catch((e) => e)).toMatchObject({
			status: 502,
			code: "http",
		});
		const down = createHttp(() =>
			Promise.reject(new TypeError("fetch failed"))
		);
		expect(await down.get("/x").catch((e) => e)).toMatchObject({
			status: 0,
			code: "network",
		});
	});

	it("fails a request that never answers after its timeout, and aborts it (e2e /-/health hang)", async () => {
		let signal: AbortSignal | undefined;
		const http = createHttp((_input, init) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		}, { timeoutMs: 15 });
		const started = Date.now();
		const error = await http.get("/-/health").catch((e) => e);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 0, code: "timeout" });
		expect(signal?.aborted).toBe(true);
		// A body that never ends is bounded too.
		const slowBody = createHttp(() =>
			Promise.resolve(
				new Response(new ReadableStream({ start: () => {} }), {
					status: 200,
				}),
			), { timeoutMs: 15 });
		expect(await slowBody.get("/x").catch((e) => e)).toMatchObject({
			code: "timeout",
		});
		expect(HTTP_TIMEOUT_MS).toBe(60_000);
	});

	it("bounds writes far longer than reads, and a call may set its own bound", async () => {
		const pending = () => new Promise<Response>(() => {});
		const http = createHttp(pending, { timeoutMs: 15, writeTimeoutMs: 200 });
		const started = Date.now();
		const outcome = await Promise.race([
			http.post("/-/api/groups/acme/repos", { importUrl: "x" }).then(
				() => "answered",
				(e: ApiError) => e.code,
			),
			new Promise((r) => setTimeout(() => r("still waiting"), 60)),
		]);
		expect(outcome).toBe("still waiting");
		expect(
			await http.put("/x", {}, { timeoutMs: 15 }).catch((e) => e.code),
		).toBe("timeout");
		expect(await http.get("/x").catch((e) => e.code)).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(1000);
		expect(HTTP_WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
	});

	it("builds query strings and skips empty values", () => {
		expect(withQuery("/a", { x: "1 2", y: undefined, z: null, n: 0, b: false }))
			.toBe(
				"/a?x=1+2&n=0&b=false",
			);
		expect(withQuery("/a", {})).toBe("/a");
	});
});

describe("api", () => {
	it("calls the slot render and action routes with the contribution id and b64url ctx", async () => {
		const { fetch, calls } = recordingFetch(
			reply(200, { v: 1, root: { t: "divider" } }),
		);
		const api = createApi(createHttp(fetch));
		const hint = {
			node: "acme/r",
			entity: { kind: "change", id: "zkqv" },
		};
		await api.slots.render("i_01k6g000000000000000000504", "checks", hint);
		await api.slots.action(
			"i_01k6g000000000000000000504",
			"checks",
			{
				action: "ci.rerun",
				ctx: hint,
			},
		);
		const render = new URL(calls[0]!.path, "https://forge.test");
		// The contribution id is the route's `<slotId>` (WP7a); no `?item=`.
		expect(render.pathname).toBe(
			"/-/api/slot/i_01k6g000000000000000000504/checks",
		);
		expect([...render.searchParams.keys()]).toEqual(["ctx"]);
		const ctx = render.searchParams.get("ctx")!;
		expect(ctx).toMatch(/^[A-Za-z0-9_-]+$/);
		// The entity object survives the base64url JSON round trip.
		expect(JSON.parse(atob(ctx.replace(/-/g, "+").replace(/_/g, "/")))).toEqual(
			hint,
		);
		expect(calls[1]).toMatchObject({
			method: "POST",
			path: "/-/api/slot/i_01k6g000000000000000000504/checks/action",
			body: { action: "ci.rerun", ctx: hint },
		});
	});

	it("encodes path segments", async () => {
		const { fetch, calls } = recordingFetch(reply(200, {}));
		const api = createApi(createHttp(fetch));
		await api.extensions.setMode("i_a/../b", "shadow");
		expect(calls[0]!.path).toBe("/-/api/installations/i_a%2F..%2Fb/mode");
	});

	it("b64url-encodes unicode JSON", () => {
		const encoded = b64urlJson({ path: "ä/ö" });
		expect(encoded).not.toMatch(/[+/=]/);
		const bytes = Uint8Array.from(
			atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
			(c) => c.charCodeAt(0),
		);
		expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
			path: "ä/ö",
		});
	});

	it("forces login return_to to a same-origin path", () => {
		expect(loginHref("/acme?tab=1")).toBe(
			"/-/auth/login?return_to=%2Facme%3Ftab%3D1",
		);
		expect(loginHref("//evil.example")).toBe("/-/auth/login?return_to=%2F");
		expect(loginHref("https://evil.example")).toBe(
			"/-/auth/login?return_to=%2F",
		);
		expect(loginHref("/-/setup", { purpose: "bootstrap" })).toBe(
			"/-/auth/login?return_to=%2F-%2Fsetup&purpose=bootstrap",
		);
	});
});
