/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP2 end to end in workerd: the bootstrap against a
// mock IdP (jose-signed ID tokens) through the real router and security
// middleware: claim code from the logs, unlock, environment checks, name,
// RFC 7591 registration, the owner's sign-in with PKCE as a public client,
// then the setup token refused, the session, PATs (revocation at once on
// this isolate), invites, logout and the destroy-token deregistration. The
// identity module runs on a real Durable Object's SQLite storage; WP3 and
// WP6 are fakes until they merge.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { sha256Hex } from "./crypto.ts";
import { cookieValue, createE2e, type E2e } from "./testing/e2e.ts";
import { loggedCode } from "./testing/harness.ts";
import { createMockIdp, type MockIdp } from "./testing/mock-idp.ts";

const ORIGIN = "https://code.example.com";
const SAME = {
	"sec-fetch-site": "same-origin",
	"content-type": "application/json",
};
const OWNER = {
	sub: "owner-sub",
	preferred_username: "rawkode",
	name: "David Flanagan",
	email: "david@example.com",
	email_verified: true,
};

const inForge = <T>(
	fn: (state: DurableObjectState) => Promise<T>,
): Promise<T> =>
	runInDurableObject(
		env.FORGE.getByName(uniqueName("wp02-e2e")),
		(_i, state) => fn(state),
	);

const post = (
	e: E2e,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	e.fetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { ...SAME, ...headers },
		body: JSON.stringify(body),
	});

const cookies = (pairs: Record<string, string | null>): string =>
	Object.entries(pairs).filter(([, v]) => v !== null).map(([k, v]) =>
		`${k}=${v}`
	).join("; ");

/** Logs in through `/-/auth/login` → mock IdP → `/-/auth/callback`; returns the callback response. */
const signIn = async (
	e: E2e,
	idp: MockIdp,
	user: Record<string, unknown> & { sub: string },
	options: { setupCookie?: string; query?: string } = {},
) => {
	const login = await e.fetch(
		`${ORIGIN}/-/auth/login?${options.query ?? "return_to=/rawkode"}`,
		{
			headers: {
				cookie: cookies({ "__Host-tartan-setup": options.setupCookie ?? null }),
			},
		},
	);
	expect(login.status, await login.clone().text()).toBe(302);
	const loginCookie = login.headers.getSetCookie()[0].split(";")[0];
	const callback = idp.authorize(login.headers.get("location") as string, user);
	return await e.fetch(callback.href, {
		headers: {
			cookie: [
				loginCookie,
				cookies({ "__Host-tartan-setup": options.setupCookie ?? null }),
			]
				.filter((c) => c !== "").join("; "),
		},
	});
};

/** Fresh forge → claimed by the owner through the wizard's calls. Returns the owner's session cookie. */
const bootstrap = async (e: E2e, idp: MockIdp) => {
	expect((await post(e, "/-/setup/code", {})).status).toBe(200);
	const unlock = await post(e, "/-/setup/unlock", {
		token: loggedCode(e.harness.logs),
	});
	expect(unlock.status).toBe(200);
	const setup = cookieValue(unlock, "__Host-tartan-setup") as string;
	const withSetup = { cookie: `__Host-tartan-setup=${setup}` };
	expect(
		(await post(e, "/-/setup/name", {
			forgeName: "Rawkode",
			canonicalOrigin: ORIGIN,
		}, withSetup)).status,
	).toBe(200);
	const registered = await post(e, "/-/setup/idp/register", {
		issuer: idp.issuer,
	}, withSetup);
	expect((await registered.json<{ clientId: string }>()).clientId).toMatch(
		/^client-\d+$/,
	);
	const callback = await signIn(e, idp, OWNER, { setupCookie: setup });
	expect(callback.status).toBe(303);
	expect(callback.headers.get("location")).toBe("/rawkode");
	return {
		session: cookieValue(callback, "__Host-tartan-session") as string,
		callback,
	};
};

describe("bootstrap end to end (mock IdP, real router and middleware)", () => {
	it("fresh: pages go to the wizard, the API answers 503, health and the wizard work", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const me = await e.fetch(`${ORIGIN}/-/api/me`);
			expect(me.status).toBe(503);
			expect(await me.json()).toMatchObject({ error: "setup_required" });
			const page = await e.fetch(`${ORIGIN}/acme`, {
				headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
			});
			expect(page.status).toBe(302);
			expect(page.headers.get("location")).toBe("/-/setup");
			const health = await e.fetch(`${ORIGIN}/-/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ setupState: "fresh" });
			const status = await post(e, "/-/setup/status", {});
			expect(await status.json()).toMatchObject({
				state: "fresh",
				session: null,
			});
		});
	});

	it("claims the forge by DCR and a public-client login; the token request has the verifier and no client auth", async () => {
		const idp = await createMockIdp({ issParameter: true });
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session, callback } = await bootstrap(e, idp);
			expect(callback.headers.get("cache-control")).toBe("no-store");
			expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
			const sessionLine = callback.headers.getSetCookie().find((l) =>
				l.startsWith("__Host-tartan-session=")
			);
			expect(sessionLine).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
			expect(
				callback.headers.getSetCookie().some((l) =>
					l.startsWith("__Host-tartan-setup=; Max-Age=0")
				),
			).toBe(true);

			const row = await e.harness.facade.idp();
			expect(row).toMatchObject({
				client_auth: "none",
				client_secret_sealed: null,
				source: "dcr",
			});
			const [token] = idp.tokenRequests();
			const form = new URLSearchParams(token.body);
			expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
			expect(form.get("client_secret")).toBeNull();
			expect(token.headers.authorization).toBeUndefined();

			const me = await e.fetch(`${ORIGIN}/-/api/me`, {
				headers: { cookie: `__Host-tartan-session=${session}` },
			});
			expect(me.status).toBe(200);
			expect(await me.json()).toMatchObject({
				principal: {
					handle: "rawkode",
					display: "David Flanagan",
					kind: "user",
				},
				auth: { via: "session", isAdmin: true },
				forge: { name: "Rawkode" },
			});
			expect(e.harness.tree.roots).toEqual([
				expect.objectContaining({ kind: "user", slug: "rawkode" }),
			]);
			expect((await e.harness.facade.setupState()).state).toBe("done");
		});
	});

	it("after the claim the logs code and any setup secret are refused on unlock and recover (403)", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			const code = loggedCode(e.harness.logs);
			for (const path of ["/-/setup/unlock", "/-/setup/recover"]) {
				const r = await post(e, path, { token: code }, {
					"cf-connecting-ip": "198.51.100.7",
				});
				expect(r.status, path).toBe(403);
			}
		});
	});

	it("with a deployed TARTAN_SETUP_TOKEN: it unlocks, the claim consumes it, then 403 on unlock and recover", async () => {
		const idp = await createMockIdp();
		const token = "deployed-setup-token-0123456789abcdefghij";
		await inForge(async (state) => {
			const e = createE2e({
				state,
				baseEnv: env,
				idp,
				env: { TARTAN_SETUP_TOKEN: token },
			});
			expect(await (await post(e, "/-/setup/code", {})).json()).toEqual({
				created: false,
			});
			expect(e.harness.logs).toEqual([]);
			const unlock = await post(e, "/-/setup/unlock", { token });
			const setup = cookieValue(unlock, "__Host-tartan-setup") as string;
			const withSetup = { cookie: `__Host-tartan-setup=${setup}` };
			await post(e, "/-/setup/name", {
				forgeName: "R",
				canonicalOrigin: ORIGIN,
			}, withSetup);
			await post(e, "/-/setup/idp/register", { issuer: idp.issuer }, withSetup);
			expect((await signIn(e, idp, OWNER, { setupCookie: setup })).status).toBe(
				303,
			);
			expect((await post(e, "/-/setup/unlock", { token })).status).toBe(403);
			expect((await post(e, "/-/setup/recover", { token })).status).toBe(403);
		});
	});

	it("the claim needs the setup session; without one the login is refused", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const login = await e.fetch(`${ORIGIN}/-/auth/login`);
			expect(login.status).toBe(403);
		});
	});

	it("a callback without the browser's login cookie, or replayed, is refused", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			const login = await e.fetch(`${ORIGIN}/-/auth/login?return_to=/x`);
			const callback = idp.authorize(
				login.headers.get("location") as string,
				OWNER,
			);
			const stolen = await e.fetch(callback.href);
			expect(stolen.status).toBe(400);
			expect(await stolen.text()).toContain("another browser");
			const loginCookie = login.headers.getSetCookie()[0].split(";")[0];
			expect(
				(await e.fetch(callback.href, { headers: { cookie: loginCookie } }))
					.status,
			).toBe(303);
			const replay = await e.fetch(callback.href, {
				headers: { cookie: loginCookie },
			});
			expect(replay.status).toBe(400);
		});
	});

	it("return_to cannot leave the forge", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			for (
				const evil of [
					"https://evil.example.net/",
					"//evil.example.net",
					"/\\evil.example.net",
				]
			) {
				const r = await signIn(e, idp, OWNER, {
					query: `return_to=${encodeURIComponent(evil)}`,
				});
				expect(r.status, evil).toBe(303);
				expect(r.headers.get("location"), evil).toBe("/");
			}
		});
	});

	it("an unknown identity gets a 403 page; an invite admits exactly one identity", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			const stranger = await signIn(e, idp, { sub: "stranger" });
			expect(stranger.status).toBe(403);
			expect(await stranger.text()).toContain("invite");

			e.harness.tree.addNode("rawkode");
			e.harness.tree.addNode("rawkode/team");
			const created = await post(e, "/-/api/invites", {
				node: "rawkode/team",
				role: 30,
			}, { cookie: `__Host-tartan-session=${session}` });
			expect(created.status).toBe(201);
			const { url } = await created.json<{ url: string }>();
			expect(url).toMatch(new RegExp(`^${ORIGIN}/-/invite/[A-Za-z0-9_-]{43}$`));
			const code = url.split("/").pop() as string;
			const alice = await signIn(e, idp, {
				sub: "alice",
				preferred_username: "alice",
			}, { query: `invite=${code}&return_to=/rawkode/team` });
			expect(alice.status).toBe(303);
			expect(alice.headers.get("location")).toBe("/rawkode/team");
			expect(e.harness.tree.grants).toEqual([
				expect.objectContaining({ role: 30 }),
			]);
			const bob = await signIn(e, idp, { sub: "bob" }, {
				query: `invite=${code}`,
			});
			expect(bob.status).toBe(403);
		});
	});

	it("PATs: created in the browser, used as Bearer with the api scope, revoked at once on this isolate", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			const browser = { cookie: `__Host-tartan-session=${session}` };
			const created = await post(e, "/-/api/tokens", {
				name: "cli",
				scopes: ["api", "repo:read"],
				expiresInDays: 30,
			}, browser);
			expect(created.status).toBe(201);
			const { token, tokenId } = await created.json<
				{ token: string; tokenId: string }
			>();
			expect(token).toMatch(/^tpat_[A-Za-z0-9_-]{43}$/);
			const bearer = { authorization: `Bearer ${token}` };
			const list = await e.fetch(`${ORIGIN}/-/api/tokens`, { headers: bearer });
			expect(list.status).toBe(200);
			expect(JSON.stringify(await list.json())).not.toContain(token);
			// A token cannot mint tokens.
			expect(
				(await post(e, "/-/api/tokens", {
					name: "x",
					scopes: ["api"],
					expiresInDays: 1,
				}, bearer)).status,
			).toBe(403);
			const revoked = await e.fetch(`${ORIGIN}/-/api/tokens/${tokenId}`, {
				method: "DELETE",
				headers: { ...browser, "sec-fetch-site": "same-origin" },
			});
			expect(revoked.status).toBe(204);
			const after = await e.fetch(`${ORIGIN}/-/api/tokens`, {
				headers: bearer,
			});
			expect(after.status).toBe(401);
			expect(after.headers.get("www-authenticate")).toBe(
				'Bearer realm="Tartan"',
			);
		});
	});

	it("CSRF: cookie writes from another site are refused; the wizard's calls are same-origin JSON", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			const body = JSON.stringify({
				name: "x",
				scopes: ["api"],
				expiresInDays: 1,
			});
			for (const site of ["cross-site", "same-site", "none"]) {
				const r = await e.fetch(`${ORIGIN}/-/api/tokens`, {
					method: "POST",
					headers: {
						cookie: `__Host-tartan-session=${session}`,
						"sec-fetch-site": site,
						"content-type": "application/json",
					},
					body,
				});
				expect(r.status, site).toBe(403);
				expect(await r.json(), site).toMatchObject({ reason: "csrf" });
			}
			const form = await e.fetch(`${ORIGIN}/-/setup/unlock`, {
				method: "POST",
				headers: {
					"sec-fetch-site": "same-origin",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: "token=x",
			});
			expect(form.status).toBe(403);
			const exact = await e.fetch(`${ORIGIN}/-/api/tokens`, {
				method: "POST",
				headers: {
					cookie: `__Host-tartan-session=${session}`,
					origin: ORIGIN,
					"content-type": "application/json",
				},
				body,
			});
			expect(exact.status).toBe(201);
		});
	});

	it("cookies are never accepted on git or MCP; tokens are", async () => {
		const idp = await createMockIdp();
		const echo = (c: { auth: unknown }) => Response.json({ auth: c.auth });
		await inForge(async (state) => {
			const e = createE2e({
				state,
				baseEnv: env,
				idp,
				handlers: { "git.canonical.info-refs": echo, "mcp": echo },
			});
			const { session } = await bootstrap(e, idp);
			const cookie = `__Host-tartan-session=${session}`;
			const git = await e.fetch(
				`${ORIGIN}/rawkode/shop.git/info/refs?service=git-upload-pack`,
				{ headers: { cookie } },
			);
			expect(await git.json()).toEqual({ auth: null });
			const mcp = await e.fetch(`${ORIGIN}/-/mcp`, {
				method: "POST",
				headers: { cookie },
			});
			expect(mcp.status).toBe(401);
			const created = await post(e, "/-/api/tokens", {
				name: "git",
				scopes: ["repo:read", "mcp"],
				expiresInDays: 1,
			}, { cookie });
			const { token } = await created.json<{ token: string }>();
			const viaGit = await e.fetch(
				`${ORIGIN}/rawkode/shop.git/info/refs?service=git-upload-pack`,
				{
					headers: { authorization: `Basic ${btoa(`x:${token}`)}`, cookie },
				},
			);
			expect(await viaGit.json()).toMatchObject({ auth: { via: "pat" } });
		});
	});

	it("canonical host: pages and API 308 to the canonical origin, git 403, health anywhere", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			const away = "https://tartan-dev.acct.workers.dev";
			const page = await e.fetch(`${away}/rawkode?tab=1`);
			expect(page.status).toBe(308);
			expect(page.headers.get("location")).toBe(`${ORIGIN}/rawkode?tab=1`);
			expect((await e.fetch(`${away}/-/api/me`)).status).toBe(308);
			const git = await e.fetch(`${away}/rawkode/shop.git/info/refs`);
			expect(git.status).toBe(403);
			expect(await git.json()).toMatchObject({
				error: "denied",
				reason: "host",
			});
			expect((await e.fetch(`${away}/-/health`)).status).toBe(200);
			// The login moves itself to the canonical host (the redirect URI lives there).
			const login = await e.fetch(`${away}/-/auth/login?return_to=/x`);
			expect(login.headers.get("location")).toBe(
				`${ORIGIN}/-/auth/login?return_to=/x`,
			);
		});
	});

	it("logout deletes the session (same-origin) and clears the cookie", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			const cookie = `__Host-tartan-session=${session}`;
			expect(
				(await e.fetch(`${ORIGIN}/-/auth/logout`, {
					method: "POST",
					headers: { cookie, "sec-fetch-site": "cross-site" },
				})).status,
			).toBe(403);
			const out = await e.fetch(`${ORIGIN}/-/auth/logout`, {
				method: "POST",
				headers: { cookie, "sec-fetch-site": "same-origin" },
			});
			expect(out.status).toBe(200);
			expect(await out.json()).toMatchObject({
				ok: true,
				endSessionUrl: `${idp.issuer}/logout?client_id=client-1`,
			});
			expect(out.headers.getSetCookie()).toContain(
				"__Host-tartan-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
			);
			expect(await e.harness.facade.session(await sha256Hex(session)))
				.toBeNull();
			expect(
				(await e.fetch(`${ORIGIN}/-/api/tokens`, { headers: { cookie } }))
					.status,
			).toBe(401);
		});
	});

	it("the bulk-token route is 404 unless TARTAN_STAGE ^dev and TARTAN_DEV_TOOLS=1", async () => {
		const idp = await createMockIdp();
		for (
			const flags of [{}, { TARTAN_STAGE: "dev-wp02" }, {
				TARTAN_DEV_TOOLS: "1",
			}]
		) {
			await inForge(async (state) => {
				const e = createE2e({ state, baseEnv: env, idp, env: flags });
				const { session } = await bootstrap(e, idp);
				const r = await post(e, "/-/api/agents/bulk", {
					count: 2,
					prefix: "sim",
					node: "rawkode",
				}, { cookie: `__Host-tartan-session=${session}` });
				expect(r.status, JSON.stringify(flags)).toBe(404);
			});
		}
	});

	it("deregister is 404 without TARTAN_DESTROY_TOKEN; with it the registration is deleted once", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			expect(
				(await e.fetch(`${ORIGIN}/-/admin/idp/deregister`, { method: "POST" }))
					.status,
			).toBe(404);
		});
		await inForge(async (state) => {
			const destroy = "destroy-token-0123456789abcdef";
			const e = createE2e({
				state,
				baseEnv: env,
				idp,
				env: { TARTAN_DESTROY_TOKEN: destroy },
			});
			await bootstrap(e, idp);
			const call = () =>
				e.fetch(`https://tartan-dev.acct.workers.dev/-/admin/idp/deregister`, {
					method: "POST",
					headers: { authorization: `Bearer ${destroy}` },
				});
			const clientId = (await e.harness.facade.idp())?.client_id as string;
			const first = await call();
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({ clientId, deregistered: true });
			expect(idp.deleted).toEqual([clientId]);
			expect((await call()).status).toBe(403);
		});
	});

	it("forged capability traffic reads the setup state once per isolate per 10 s", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const lane = "ln_01k0000000000000000000000a";
			const repo = "01k6aaaaaaaaaaaaaaaaaaaaaa";
			const forged = Array.from(
				{ length: 200 },
				(_, i) =>
					e.fetch(
						`${ORIGIN}/-/cap/v1/1790000000/${lane}/${
							i.toString(16).padStart(32, "0")
						}/${"ab".repeat(32)}/${repo}.git/info/refs?service=git-upload-pack`,
					),
			);
			const answers = await Promise.all(forged);
			expect(new Set(answers.map((r) => r.status))).toEqual(new Set([503]));
			expect(e.calls.setupState).toBe(1);
		});
	});

	it("the environment check runs pre-claim checks only, behind the setup session", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			expect((await post(e, "/-/setup/checks", {})).status).toBe(401);
			await post(e, "/-/setup/code", {});
			const unlock = await post(e, "/-/setup/unlock", {
				token: loggedCode(e.harness.logs),
			});
			const setup = cookieValue(unlock, "__Host-tartan-setup") as string;
			const r = await post(e, "/-/setup/checks", {}, {
				cookie: `__Host-tartan-setup=${setup}`,
			});
			expect(r.status).toBe(200);
			const { checks } = await r.json<
				{
					checks: {
						id: string;
						phase: string;
						ok: boolean;
						optional: boolean;
					}[];
				}
			>();
			expect(checks.map((c) => c.id).sort()).toEqual([
				"ai",
				"artifacts",
				"containers",
				"loader",
				"origin",
				"r2",
			]);
			expect(checks.every((c) => c.phase === "setup")).toBe(true);
			const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
			expect(byId.r2.ok).toBe(true);
			expect(byId.loader.ok).toBe(true);
			expect(byId.artifacts.ok).toBe(true);
			expect(byId.containers.optional).toBe(true);
			expect(byId.origin.ok).toBe(true);
		});
	});

	it("sign-in is rate-limited per IP (20/min); another IP is not affected", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			await bootstrap(e, idp);
			const login = (ip: string) =>
				e.fetch(`${ORIGIN}/-/auth/login`, {
					headers: { "cf-connecting-ip": ip },
				});
			for (let i = 0; i < 20; i++) {
				expect((await login("203.0.113.1")).status).toBe(302);
			}
			const limited = await login("203.0.113.1");
			expect(limited.status).toBe(429);
			expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
			expect((await login("203.0.113.2")).status).toBe(302);
		});
	});

	it("agents: created in the browser with a tagt_ token and copy-paste snippets; tokens cannot create agents", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			e.harness.tree.addNode("rawkode");
			e.harness.tree.addNode("rawkode/platform");
			const cookie = `__Host-tartan-session=${session}`;
			const created = await post(e, "/-/api/agents", {
				name: "claude-code-1",
				tool: "claude-code",
				node: "rawkode/platform",
			}, { cookie });
			expect(created.status).toBe(201);
			const body = await created.json<
				{
					token: string;
					agent: { id: string; handle: string };
					snippets: Record<string, string>;
				}
			>();
			expect(body.token).toMatch(/^tagt_[A-Za-z0-9_-]{43}$/);
			expect(body.agent.handle).toBe("claude-code-1");
			expect(body.snippets.claudeCode).toBe(
				`claude mcp add --transport http tartan ${ORIGIN}/-/mcp/rawkode/platform --header "Authorization: Bearer $TARTAN_TOKEN"`,
			);
			expect(body.snippets.codex).toContain(
				'bearer_token_env_var = "TARTAN_TOKEN"',
			);
			const agentAuth = await e.harness.facade.token(
				await sha256Hex(body.token),
			);
			expect(agentAuth).toMatchObject({
				kind: "agent",
				via: "agent-token",
				maxRole: 30,
			});
			const viaToken = await post(e, "/-/api/agents", {
				name: "x",
				tool: "codex",
				node: "rawkode/platform",
			}, {
				authorization: `Bearer ${body.token}`,
			});
			expect(viaToken.status).toBe(403);
			const listed = await e.fetch(`${ORIGIN}/-/api/agents`, {
				headers: { cookie },
			});
			expect((await listed.json<{ agents: unknown[] }>()).agents).toHaveLength(
				1,
			);
			const disabled = await e.fetch(
				`${ORIGIN}/-/api/agents/${body.agent.id}`,
				{
					method: "DELETE",
					headers: { cookie, "sec-fetch-site": "same-origin" },
				},
			);
			expect(disabled.status).toBe(204);
			expect(await e.harness.facade.token(await sha256Hex(body.token)))
				.toBeNull();
		});
	});

	it("JWKS and avatars are served by the forge itself", async () => {
		const idp = await createMockIdp();
		await inForge(async (state) => {
			const e = createE2e({ state, baseEnv: env, idp });
			const { session } = await bootstrap(e, idp);
			const jwks = await e.fetch(`${ORIGIN}/-/auth/jwks.json`);
			expect(jwks.status).toBe(200);
			expect(await jwks.json()).toEqual({ keys: [] });
			const me = await (await e.fetch(`${ORIGIN}/-/api/me`, {
				headers: { cookie: `__Host-tartan-session=${session}` },
			})).json<{ principal: { avatar: string } }>();
			const avatar = await e.fetch(`${ORIGIN}${me.principal.avatar}`);
			expect(avatar.status).toBe(200);
			expect(avatar.headers.get("content-type")).toBe(
				"image/svg+xml; charset=utf-8",
			);
			expect(avatar.headers.get("content-security-policy")).toContain(
				"sandbox",
			);
			expect(await avatar.text()).toContain(">DF<");
			expect(
				(await e.fetch(`${ORIGIN}/-/avatar/u_01k6aaaaaaaaaaaaaaaaaaaaaz`))
					.status,
			).toBe(404);
		});
	});
});
