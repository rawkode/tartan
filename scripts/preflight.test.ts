import assert from "node:assert/strict";
import {
	artifactsCheck,
	assessImageRecord,
	buildsImageHere,
	checkDeno,
	checkNode,
	createCfApi,
	domainChecks,
	parseDfAvailable,
	parseFlags,
	pickAccount,
	PLAN_FLAGS,
	planFromFlags,
	PreflightError,
	type PreflightPlan,
	resolveAuth,
	type Run,
	runPreflight,
	type RunResult,
	stageNames,
	UsageError,
	zoneCandidates,
} from "./preflight.ts";

const assertEquals = (actual: unknown, expected: unknown) =>
	assert.deepEqual(actual, expected);
// deno-lint-ignore no-explicit-any
type ErrorClass = new (...args: any[]) => Error;
const matches = (cls?: ErrorClass, text?: string) => (error: unknown) =>
	(cls === undefined || error instanceof cls) &&
	(text === undefined || (error as Error).message.includes(text));
const assertThrows = (fn: () => unknown, cls?: ErrorClass, text?: string) =>
	assert.throws(fn, matches(cls, text));
const assertRejects = (
	fn: () => Promise<unknown>,
	cls?: ErrorClass,
	text?: string,
) => assert.rejects(fn, matches(cls, text));

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const err = (code = 1, stderr = ""): RunResult => ({
	code,
	stdout: "",
	stderr,
});

/** A fake process runner: the first matching prefix answers; calls are kept. */
const fakeRun = (
	answers: Record<string, RunResult | (() => RunResult) | "missing">,
) => {
	const calls: { line: string; stdin?: string }[] = [];
	const run: Run = (cmd, args, options) => {
		const line = [cmd, ...args].join(" ");
		calls.push({ line, stdin: options?.stdin });
		const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
		const answer = key === undefined
			? err(127, `no fake for ${line}`)
			: answers[key];
		if (answer === "missing") {
			return Promise.reject(new Deno.errors.NotFound(cmd));
		}
		return Promise.resolve(typeof answer === "function" ? answer() : answer);
	};
	return { run, calls };
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

/** A fake fetch over the v4 API: `METHOD path` (no query) → response. */
const fakeFetch = (routes: Record<string, () => Response>) => {
	const requests: string[] = [];
	const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const key = `${init?.method ?? "GET"} ${
			url.pathname.replace("/client/v4", "")
		}`;
		requests.push(`${key}${url.search}`);
		const route = routes[key];
		return Promise.resolve(
			route ? route() : json(404, { success: false, errors: [] }),
		);
	}) as typeof fetch;
	return { fetch: fetcher, requests };
};

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WHOAMI = JSON.stringify({
	loggedIn: true,
	email: "owner@example.com",
	accounts: [{ id: ACCOUNT, name: "Example" }],
});

const basePlan = (over: Partial<PreflightPlan> = {}): PreflightPlan => ({
	stage: "dev-wp21",
	takeDomain: false,
	containers: true,
	image: "dockerfile",
	imageRecordPath: "/repo/.wrangler/deploy/runner-image.json",
	...over,
});

const accountRoutes = (artifactsStatus = 200) => ({
	[`GET /accounts/${ACCOUNT}/artifacts/namespaces`]: () =>
		json(artifactsStatus, {
			success: artifactsStatus === 200,
			result: [],
			errors: [],
		}),
	[`GET /accounts/${ACCOUNT}/workers/subdomain`]: () =>
		json(200, { result: { subdomain: "example" } }),
	[`GET /accounts/${ACCOUNT}/subscriptions`]: () =>
		json(403, {
			success: false,
			errors: [{ code: 10000, message: "Authentication error" }],
		}),
});

const DIGEST_REF = `ttl.sh/tartan-runner-abc@sha256:${"a".repeat(64)}`;
const HEAD = "b".repeat(40);
const NOW = Date.parse("2026-10-02T12:00:00Z");

const preflightDeps = (
	run: Run,
	fetcher: typeof fetch,
	files: Record<string, string> = {},
) => ({
	run,
	fetch: fetcher,
	env: () => undefined,
	now: () => NOW,
	root: "/repo",
	readText: (file: string) => Promise.resolve(files[file] ?? null),
	denoVersion: "2.9.6",
	log: () => {},
	login: false,
});

const WRANGLER_PKG = {
	"/repo/node_modules/wrangler/package.json": '{"version":"4.145.0"}',
};

const noDockerRun = (extra: Record<string, RunResult | "missing"> = {}) =>
	fakeRun({
		"node --version": ok("v22.20.0\n"),
		"npx wrangler whoami --json": ok(WHOAMI),
		"npx wrangler auth token --json": ok('{"type":"oauth","token":"tok"}'),
		"git rev-parse HEAD": ok(`${HEAD}\n`),
		"docker": "missing",
		"df -Pk": ok(
			"Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 1 20000000 1% /\n",
		),
		...extra,
	});

Deno.test("Artifacts entitlement: 200 passes, 401 is a bad token, 403/404 are gated", () => {
	assertEquals(artifactsCheck(200).status, "pass");
	const bad = artifactsCheck(401);
	assertEquals(bad.status, "fail");
	assert(bad.fix?.includes("wrangler login"));
	for (const status of [403, 404]) {
		const gated = artifactsCheck(status);
		assertEquals(gated.status, "fail");
		assert(gated.fix?.includes("request access"));
	}
	assertEquals(artifactsCheck(500).status, "warn");
});

Deno.test("flags: values, inline values, booleans and refusals", () => {
	const flags = parseFlags([
		"--",
		"--stage=dev-x",
		"--domain",
		"git.example.com",
		"--take-domain",
	], PLAN_FLAGS);
	assertEquals(flags.get("stage"), "dev-x");
	assertEquals(flags.get("domain"), "git.example.com");
	assertEquals(flags.get("take-domain"), true);
	assertThrows(() => parseFlags(["--nope"], PLAN_FLAGS), UsageError);
	assertThrows(
		() => parseFlags(["--stage"], PLAN_FLAGS),
		UsageError,
		"needs a value",
	);
	assertThrows(
		() => parseFlags(["--no-containers=1"], PLAN_FLAGS),
		UsageError,
		"takes no value",
	);
	const plan = planFromFlags(
		parseFlags(["--stage", "dev-x"], PLAN_FLAGS),
		"/repo",
	);
	assertEquals(plan.image, "dockerfile");
	assertEquals(plan.containers, true);
	assertEquals(
		plan.imageRecordPath,
		"/repo/.wrangler/deploy/runner-image.json",
	);
	const refuse = (args: string[], message: string) =>
		assertThrows(
			() => planFromFlags(parseFlags(args, PLAN_FLAGS), "/repo"),
			UsageError,
			message,
		);
	refuse([], "--stage is required");
	refuse(["--stage", "Dev"], "invalid --stage");
	refuse(
		["--stage", "dev", "--no-containers", "--image", "registry"],
		"cannot be combined",
	);
	refuse(
		["--stage", "dev", "--image-record", "x.json"],
		"needs --image registry",
	);
	refuse(["--stage", "dev", "--image", "tag"], "invalid --image");
	refuse(["--stage", "dev", "--take-domain"], "needs --domain");
	refuse(
		["--stage", "dev", "--domain", "https://x.example.com"],
		"invalid --domain",
	);
});

Deno.test("account: one is picked, several need a choice", () => {
	const a = { id: "a1", name: "Alpha" };
	const b = { id: "b2", name: "Beta" };
	assertEquals(pickAccount([a], undefined), a);
	assertEquals(pickAccount([a, b], "Beta"), b);
	assertEquals(pickAccount([a, b], "a1"), a);
	assertThrows(
		() => pickAccount([a, b], undefined),
		PreflightError,
		"--account",
	);
	assertThrows(() => pickAccount([a], "zz"), PreflightError, "not one of");
});

Deno.test("auth: CLOUDFLARE_API_TOKEN wins; otherwise wrangler's token; not logged in fails", async () => {
	const { run, calls } = fakeRun({
		"npx wrangler whoami --json": ok(`banner\n${WHOAMI}`),
		"npx wrangler auth token --json": ok(
			'{"type":"oauth","token":"from-wrangler"}',
		),
	});
	const viaEnv = await resolveAuth({
		run,
		env: (n) => (n === "CLOUDFLARE_API_TOKEN" ? "from-env" : undefined),
		login: false,
		log: () => {},
	});
	assertEquals([viaEnv.token, viaEnv.tokenSource], [
		"from-env",
		"CLOUDFLARE_API_TOKEN",
	]);
	assert(!calls.some((c) => c.line.includes("auth token")));
	const viaWrangler = await resolveAuth({
		run,
		env: () => undefined,
		login: false,
		log: () => {},
	});
	assertEquals([viaWrangler.token, viaWrangler.account.id], [
		"from-wrangler",
		ACCOUNT,
	]);

	const loggedOut = fakeRun({ "npx wrangler whoami --json": err(1) });
	await assertRejects(
		() =>
			resolveAuth({
				run: loggedOut.run,
				env: () => undefined,
				login: false,
				log: () => {},
			}),
		PreflightError,
		"wrangler login",
	);

	let whoamiCalls = 0;
	const login = fakeRun({
		"npx wrangler whoami --json": () =>
			whoamiCalls++ === 0 ? err(1) : ok(WHOAMI),
		"npx wrangler login": ok(),
		"npx wrangler auth token --json": err(1),
	});
	const afterLogin = await resolveAuth({
		run: login.run,
		env: () => undefined,
		login: true,
		log: () => {},
	});
	assert(login.calls.some((c) => c.line === "npx wrangler login"));
	assertEquals([afterLogin.token, afterLogin.tokenSource], [null, "none"]);
});

Deno.test("image record: digest, age and commit decide whether it is reused", async () => {
	const record = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			ref: DIGEST_REF,
			commit: HEAD,
			builtAt: new Date(NOW - 3_600_000).toISOString(),
			...over,
		});
	const deps = (changed = false) => ({
		now: NOW,
		head: HEAD,
		runnerChangedSince: () => Promise.resolve(changed),
	});
	assertEquals((await assessImageRecord(record(), deps())).valid, true);
	assertEquals((await assessImageRecord(null, deps())).valid, false);
	const old = await assessImageRecord(
		record({ builtAt: new Date(NOW - 23.5 * 3_600_000).toISOString() }),
		deps(),
	);
	assert(!old.valid && old.reason.includes("24 h"));
	const tagged = await assessImageRecord(
		record({ ref: "ttl.sh/tartan-runner-abc:24h" }),
		deps(),
	);
	assert(!tagged.valid && tagged.reason.includes("tag"));
	const other = "c".repeat(40);
	assertEquals(
		(await assessImageRecord(record({ commit: other }), deps(false))).valid,
		true,
	);
	const changed = await assessImageRecord(
		record({ commit: other }),
		deps(true),
	);
	assert(!changed.valid && changed.reason.includes("containers/runner/"));
});

Deno.test("only a local image build needs a container engine", () => {
	const valid = { valid: true, ref: DIGEST_REF, reason: "" } as const;
	const invalid = { valid: false, reason: "expired" } as const;
	assertEquals(
		buildsImageHere({ containers: false, image: "dockerfile" }, null),
		false,
	);
	assertEquals(
		buildsImageHere({ containers: true, image: "dockerfile" }, null),
		true,
	);
	assertEquals(
		buildsImageHere({ containers: true, image: "registry" }, valid),
		false,
	);
	assertEquals(
		buildsImageHere({ containers: true, image: "registry" }, invalid),
		true,
	);
});

Deno.test("preflight without Docker: --no-containers and a valid registry record pass, dockerfile fails with a fix", async () => {
	const { fetch } = fakeFetch(accountRoutes());

	const none = noDockerRun();
	const noContainers = await runPreflight(
		basePlan({ containers: false }),
		preflightDeps(none.run, fetch, WRANGLER_PKG),
	);
	assert(noContainers.ok, JSON.stringify(noContainers.checks));
	assert(!none.calls.some((c) => c.line.startsWith("docker")));

	const reg = noDockerRun();
	const record = JSON.stringify({
		ref: DIGEST_REF,
		commit: HEAD,
		builtAt: new Date(NOW - 60_000).toISOString(),
	});
	const registry = await runPreflight(
		basePlan({ image: "registry" }),
		preflightDeps(reg.run, fetch, {
			...WRANGLER_PKG,
			"/repo/.wrangler/deploy/runner-image.json": record,
		}),
	);
	assert(registry.ok, JSON.stringify(registry.checks));
	assertEquals(registry.buildsImage, false);
	assert(!reg.calls.some((c) => c.line.startsWith("docker")));

	const df = noDockerRun();
	const dockerfile = await runPreflight(
		basePlan(),
		preflightDeps(df.run, fetch, WRANGLER_PKG),
	);
	assertEquals(dockerfile.ok, false);
	const engine = dockerfile.checks.find((c) => c.id === "container-engine")!;
	assertEquals(engine.status, "fail");
	assert(engine.fix!.includes("--no-containers"));
	assert(engine.fix!.includes("Docker"));

	const stopped = noDockerRun({
		"docker info": err(1, "Cannot connect to the Docker daemon"),
	});
	const notRunning = await runPreflight(
		basePlan(),
		preflightDeps(stopped.run, fetch, WRANGLER_PKG),
	);
	assertEquals(
		notRunning.checks.find((c) => c.id === "container-engine")?.status,
		"fail",
	);
});

Deno.test("preflight: a gated account and a missing workers.dev subdomain fail", async () => {
	const { fetch } = fakeFetch({
		...accountRoutes(403),
		[`GET /accounts/${ACCOUNT}/workers/subdomain`]: () =>
			json(404, { success: false, errors: [] }),
	});
	const { run } = noDockerRun();
	const result = await runPreflight(
		basePlan({ containers: false }),
		preflightDeps(run, fetch, WRANGLER_PKG),
	);
	assertEquals(result.ok, false);
	assertEquals(result.checks.find((c) => c.id === "artifacts")?.status, "fail");
	assertEquals(
		result.checks.find((c) => c.id === "workers.dev")?.status,
		"fail",
	);
	assertEquals(
		result.checks.find((c) => c.id === "workers-paid")?.status,
		"warn",
	);
});

Deno.test("preflight: no API token degrades the account checks to a warning", async () => {
	const { run } = noDockerRun({ "npx wrangler auth token --json": err(1) });
	const { fetch, requests } = fakeFetch({});
	const result = await runPreflight(
		basePlan({ containers: false }),
		preflightDeps(run, fetch, WRANGLER_PKG),
	);
	assert(result.ok);
	assertEquals(result.checks.find((c) => c.id === "api-token")?.status, "warn");
	assertEquals(requests, []);
});

Deno.test("domain: another Worker's Custom Domain is refused unless --take-domain", () => {
	const zone = { id: "z1", name: "rawkode.academy" };
	const host = "code.rawkode.academy";
	const demo = { zone, attachedTo: ["tartan-dev-demo"], dnsRecords: ["AAAA"] };
	const refused = domainChecks(host, "tartan-dev-wp21", demo, false);
	const takeover = refused.find((c) => c.id === "domain-takeover")!;
	assertEquals(takeover.status, "fail");
	assert(takeover.message.includes("tartan-dev-demo"));
	assertEquals(
		domainChecks(host, "tartan-dev-wp21", demo, true).find((c) =>
			c.id === "domain-takeover"
		)?.status,
		"warn",
	);
	assert(
		domainChecks(host, "tartan-dev-demo", demo, false).every((c) =>
			c.status === "pass"
		),
	);
	const dns = domainChecks(host, "tartan-x", {
		zone,
		attachedTo: [],
		dnsRecords: ["CNAME"],
	}, false);
	assertEquals(dns.find((c) => c.id === "domain-dns")?.status, "fail");
	const unknown = domainChecks(host, "tartan-x", {
		zone,
		attachedTo: [],
		dnsRecords: null,
	}, false);
	assertEquals(unknown.find((c) => c.id === "domain-dns")?.status, "warn");
	const noZone = domainChecks(host, "tartan-x", {
		zone: null,
		attachedTo: [],
		dnsRecords: null,
	}, false);
	assertEquals(noZone.map((c) => [c.id, c.status]), [["domain-zone", "fail"]]);
});

Deno.test("preflight reads the domain's zone, Custom Domains and DNS", async () => {
	const { fetch, requests } = fakeFetch({
		...accountRoutes(),
		"GET /zones": () =>
			json(200, { result: [{ id: "z1", name: "example.com" }] }),
		[`GET /accounts/${ACCOUNT}/workers/domains`]: () =>
			json(200, {
				result: [{ hostname: "git.example.com", service: "tartan-prod" }],
			}),
		"GET /zones/z1/dns_records": () =>
			json(403, { success: false, errors: [] }),
	});
	const { run } = noDockerRun();
	const result = await runPreflight(
		basePlan({ containers: false, domain: "git.example.com" }),
		preflightDeps(run, fetch, WRANGLER_PKG),
	);
	assertEquals(result.ok, false);
	assertEquals(
		result.checks.find((c) => c.id === "domain-takeover")?.status,
		"fail",
	);
	assert(requests.some((r) => r.startsWith("GET /zones?name=git.example.com")));
});

Deno.test("small parsers", () => {
	assertEquals(zoneCandidates("a.b.example.com"), [
		"a.b.example.com",
		"b.example.com",
		"example.com",
	]);
	assertEquals(
		parseDfAvailable(
			"Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 50 2048 50% /x\n",
		),
		2048 * 1024,
	);
	assertEquals(parseDfAvailable("garbage"), null);
	assertEquals(checkNode("v22.1.0").status, "pass");
	assertEquals(checkNode("v20.9.0").status, "fail");
	assertEquals(checkNode(null).status, "fail");
	assertEquals(checkDeno("2.9.0").status, "pass");
	assertEquals(checkDeno("3.0.0").status, "pass");
	assertEquals(checkDeno("2.8.9").status, "fail");
});

Deno.test("stage names match render-config's", () => {
	const names = stageNames("dev-wp21");
	assertEquals(names.worker, "tartan-dev-wp21");
	assertEquals(names.namespace, "tartan-dev-wp21");
	assertEquals(names.bucket, "tartan-dev-wp21-blobs");
	assertEquals(names.workflows, [
		"tartan-dev-wp21-run",
		"tartan-dev-wp21-land",
		"tartan-dev-wp21-ingest",
		"tartan-dev-wp21-swarm",
	]);
	assertEquals(names.kvTitle, "tartan-dev-wp21-oauth-kv");
	assertEquals(names.containerApp, "tartan-dev-wp21-tartansandbox");
	assertThrows(() => stageNames("../x"));
});

Deno.test("the REST client paginates and sends the bearer token", async () => {
	const seen: string[] = [];
	const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push(new Headers(init?.headers).get("authorization") ?? "");
		const page = Number(url.searchParams.get("page"));
		return Promise.resolve(json(200, {
			result: page === 1 ? [1, 2] : [3],
			result_info: { total_pages: 2 },
		}));
	}) as typeof fetch;
	const api = createCfApi({ token: "t", accountId: ACCOUNT, fetch: fetcher });
	assertEquals(await api.list("/x", 2), [1, 2, 3]);
	assertEquals(seen, ["Bearer t", "Bearer t"]);
});
