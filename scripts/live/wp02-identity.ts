// WP2 live acceptance against a deployed stage.
//
// Automated, read-only checks: health and setup gating, the security
// headers, the canonical-host rules (when `--alt-url` names the stage's
// workers.dev origin), and, with a PAT in `TARTAN_TOKEN` (scopes `api` +
// `repo:read`), the token path, the scope check and a refused cookie on git.
// The IdP side is user-assisted: `--guide` prints the steps (paste
// `https://id.rawkode.academy` in the wizard so Tartan registers itself by
// DCR, sign in as owner with the public PKCE client, invite a second user,
// recover with a rotated token, then repeat from `code.rawkode.academy`).
// Nothing here writes to the forge, and no secret is printed.
//
// Usage:
//   deno task live -- --stage dev wp02 --url https://code.example.com \
//     [--alt-url https://tartan-dev.<sub>.workers.dev] [--guide]
//   TARTAN_TOKEN=tpat_… deno task live -- --stage dev wp02 --url …

type Check = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
};

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};

const GUIDE = `The IdP side (user-assisted), on the stage named by --url:
 1. Open the setup URL the deploy printed (#t=… is the single-use token) or read the claim code from Workers Logs.
 2. Name the forge; keep the canonical origin.
 3. Paste https://id.rawkode.academy as the issuer: Tartan registers itself by RFC 7591 when the IdP allows it. Record
    the client id and that client_auth is 'none' (Admin → Health shows it).
 4. "Sign in to become owner": the IdP's login page, then back to the forge, signed in. Check groups/roles/email_verified
    in the ID token claims (the IdP's consent screen or its admin UI).
 5. Admin → Invites: create an invite at your root; open it in a private window and sign in as the second user.
 6. Recovery: wrangler secret put TARTAN_SETUP_TOKEN (a NEW value) → /-/setup → Recover → sign in as owner; the
    7-day banner appears; the same value is refused a second time.
 7. Create a PAT (scopes api, repo:read) and rerun this script with TARTAN_TOKEN set.
 8. Destroy a scratch stage with deno task destroy and confirm the client is gone at the IdP (RFC 7592).
 9. Repeat 3–4 from https://code.rawkode.academy (same zone as the IdP).`;

const main = async (): Promise<number> => {
	if (Deno.args.includes("--guide")) {
		console.log(GUIDE);
		return 0;
	}
	const stage = arg("stage");
	const origin = arg("url");
	if (!stage || !origin || !/^dev(-|$)/.test(stage)) {
		console.error(
			"usage: wp02-identity.ts --stage dev[-wpNN] --url <canonical origin> [--alt-url <origin>] [--guide]",
		);
		return 2;
	}
	const token = Deno.env.get("TARTAN_TOKEN");
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail = "") =>
		checks.push({ name, ok, detail });
	const get = (path: string, init: RequestInit = {}, base = origin) =>
		fetch(`${base}${path}`, { redirect: "manual", ...init });

	const health = await get("/-/health");
	const body = await health.json() as { setupState?: string };
	check("health answers 200", health.status === 200, `status ${health.status}`);
	check(
		"security headers on health",
		health.headers.get("x-content-type-options") === "nosniff" &&
			(health.headers.get("strict-transport-security") ?? "").startsWith(
				"max-age=",
			),
		"",
	);
	const page = await get("/", {
		headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
	});
	await page.body?.cancel();
	if (body.setupState !== "done") {
		check(
			"setup gating: pages go to /-/setup",
			page.status === 302 && page.headers.get("location") === "/-/setup",
			`status ${page.status}`,
		);
		const api = await get("/-/api/me");
		check(
			"setup gating: API answers 503 setup_required",
			api.status === 503,
			`status ${api.status}`,
		);
		await api.body?.cancel();
		console.log(
			`setup state is ${body.setupState}; run with --guide for the user-assisted IdP steps`,
		);
	} else {
		check(
			"SPA shell carries the CSP",
			(page.headers.get("content-security-policy") ?? "").includes(
				"frame-ancestors 'none'",
			),
			"",
		);
		const anon = await get("/-/api/me");
		check(
			"anonymous /-/api/me",
			anon.status === 200 &&
				(await anon.json() as { principal: unknown }).principal === null,
			`status ${anon.status}`,
		);
		if (token) {
			const me = await get("/-/api/me", {
				headers: { authorization: `Bearer ${token}` },
			});
			check(
				"PAT authenticates /-/api/me",
				me.status === 200,
				`status ${me.status}`,
			);
			await me.body?.cancel();
			const bad = await get("/-/api/me", {
				headers: { authorization: `Bearer tpat_${"x".repeat(43)}` },
			});
			check(
				"an unknown token is 401",
				bad.status === 401,
				`status ${bad.status}`,
			);
			await bad.body?.cancel();
			const git = await get("/no/such.git/info/refs?service=git-upload-pack", {
				headers: { cookie: "__Host-tartan-session=forged" },
			});
			check(
				"a cookie on git is not a credential (no session error)",
				git.status !== 401 || !(await git.text()).includes("session"),
				`status ${git.status}`,
			);
		} else {
			console.log("TARTAN_TOKEN not set: token checks skipped");
		}
	}
	const alt = arg("alt-url");
	if (alt && body.setupState === "done") {
		const moved = await get("/-/api/me", {}, alt);
		check(
			"non-canonical host: API 308",
			moved.status === 308 &&
				moved.headers.get("location") === `${origin}/-/api/me`,
			`status ${moved.status}`,
		);
		const git = await get("/a/b.git/info/refs", {}, alt);
		check(
			"non-canonical host: git 403",
			git.status === 403,
			`status ${git.status}`,
		);
		await git.body?.cancel();
		const altHealth = await get("/-/health", {}, alt);
		check(
			"non-canonical host: health served",
			altHealth.status === 200,
			`status ${altHealth.status}`,
		);
		await altHealth.body?.cancel();
	}
	for (const c of checks) {
		console.log(
			`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`,
		);
	}
	return checks.every((c) => c.ok) ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
