import assert from "node:assert/strict";
import * as path from "node:path";
import {
	assessNodeModules,
	checkDeployedDigest,
	type ClientFetch,
	createDomainPoller,
	createFreshFetch,
	denoFreshFetch,
	type DeployDeps,
	DeployError,
	type DeployOptions,
	EXT_PACKAGES,
	formatElapsed,
	generateSecret,
	isRegistryPushTimeout,
	optionsFromArgs,
	parseDeployOutput,
	planSecrets,
	type ProbeKind,
	runDeploy,
	setupUrl,
	WARM_ATTEMPT_TIMEOUT_MS,
	WARM_TIMEOUT_MS,
	warmUp,
} from "./deploy.ts";
import {
	PreflightError,
	type Run,
	type RunResult,
	UsageError,
} from "./preflight.ts";
import { parseJsoncValue } from "./render-config.ts";

const eq = (actual: unknown, expected: unknown) =>
	assert.deepEqual(actual, expected);

const ROOT = "/repo";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WHOAMI = JSON.stringify({
	loggedIn: true,
	accounts: [{ id: ACCOUNT, name: "Example" }],
});
const SOURCE = await Deno.readTextFile(
	new URL("../wrangler.jsonc", import.meta.url),
);
const PACKAGE = await Deno.readTextFile(
	new URL("../package.json", import.meta.url),
);
const DIGEST = `sha256:${"d".repeat(64)}`;

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

/** A fake clock: sleep advances time. */
const fakeClock = (start = Date.parse("2026-10-02T12:00:00Z")) => {
	let t = start;
	return {
		now: () => t,
		sleep: (ms: number) => Promise.resolve(void (t += ms)),
	};
};

const health = (
	stage: string,
	setupState = "fresh",
	extra: Record<string, unknown> = {},
) => ({
	ok: true,
	product: "Tartan",
	version: "0.0.0",
	compatDate: "2026-08-15",
	stage,
	setupState,
	bindings: { FORGE: "ok", ARTIFACTS: "ok" },
	...extra,
});

/** Installed node_modules matching package.json's pins. */
const pinnedModules = (): Record<string, string> => {
	const manifest = JSON.parse(PACKAGE);
	return Object.fromEntries(
		Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
			.map(([name, version]) => [
				path.join(ROOT, "node_modules", name, "package.json"),
				JSON.stringify({ version }),
			]),
	);
};

type World = {
	readonly deps: DeployDeps;
	readonly calls: {
		line: string;
		stdin?: string;
		env?: Record<string, string>;
	}[];
	readonly requests: string[];
	readonly files: Map<string, { text: string; secret: boolean }>;
	readonly logs: string[];
	readonly printed: string[];
};

const world = (input: {
	stage?: string;
	workerExists?: boolean;
	secrets?: string[];
	setupState?: string;
	deployResults?: RunResult[];
	healthStage?: string;
	symlink?: boolean;
	modules?: Record<string, string>;
	runner?: Record<string, unknown>;
	containersList?: unknown;
	interactive?: boolean;
	/** Answers for exact command lines (an Error rejects, like a missing binary). */
	commands?: Record<string, RunResult | Error>;
} = {}): World => {
	const stage = input.stage ?? "dev-wp21";
	const worker = `tartan-${stage}`;
	const workersDev = `https://${worker}.example.workers.dev`;
	const calls: World["calls"] = [];
	const requests: string[] = [];
	const files = new Map<string, { text: string; secret: boolean }>();
	const logs: string[] = [];
	const printed: string[] = [];
	const deployResults = [
		...(input.deployResults ??
			[ok(
				`Deployed ${worker}\n  ${workersDev}\nCurrent Version ID: 11111111-2222-3333-4444-555555555555\n`,
			)]),
	];
	const readable: Record<string, string> = {
		[path.join(ROOT, "package.json")]: PACKAGE,
		[path.join(ROOT, "wrangler.jsonc")]: SOURCE,
		[path.join(ROOT, "node_modules", "wrangler", "package.json")]:
			'{"version":"4.145.0"}',
		...(input.modules ?? pinnedModules()),
	};
	const run: Run = (cmd, args, options) => {
		const line = [cmd, ...args].join(" ");
		calls.push({
			line,
			stdin: options?.stdin,
			env: options?.env ? { ...options.env } : undefined,
		});
		const answer = input.commands?.[line];
		if (answer instanceof Error) return Promise.reject(answer);
		if (answer !== undefined) return Promise.resolve(answer);
		if (line === "node --version") return Promise.resolve(ok("v22.20.0"));
		if (line === "npx wrangler whoami --json") {
			return Promise.resolve(ok(WHOAMI));
		}
		if (line === "npx wrangler auth token --json") {
			return Promise.resolve(ok('{"type":"oauth","token":"tok"}'));
		}
		if (line === "git rev-parse HEAD") {
			return Promise.resolve(ok(`${"e".repeat(40)}\n`));
		}
		if (line.startsWith("npx wrangler deploy")) {
			return Promise.resolve(deployResults.shift() ?? ok());
		}
		if (line.startsWith("npx wrangler containers list")) {
			return Promise.resolve(ok(JSON.stringify(input.containersList ?? [])));
		}
		if (line.startsWith("docker")) {
			return Promise.reject(new Deno.errors.NotFound("docker"));
		}
		return Promise.resolve(ok());
	};
	const fetcher = ((req: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(req));
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url.origin}${url.pathname}`);
		const p = url.pathname.replace("/client/v4", "");
		if (url.host === "api.cloudflare.com") {
			if (p === `/accounts/${ACCOUNT}/artifacts/namespaces`) {
				return Promise.resolve(json(200, { result: [] }));
			}
			if (p === `/accounts/${ACCOUNT}/workers/subdomain`) {
				return Promise.resolve(json(200, { result: { subdomain: "example" } }));
			}
			if (p === `/accounts/${ACCOUNT}/subscriptions`) {
				return Promise.resolve(json(403, { errors: [] }));
			}
			if (p === `/accounts/${ACCOUNT}/workers/scripts/${worker}/secrets`) {
				return Promise.resolve(
					input.workerExists
						? json(200, {
							result: (input.secrets ?? []).map((name) => ({
								name,
								type: "secret_text",
							})),
						})
						: json(404, { errors: [{ code: 10007 }] }),
				);
			}
			return Promise.resolve(json(404, {}));
		}
		if (url.pathname === "/-/health") {
			return Promise.resolve(
				json(
					200,
					health(input.healthStage ?? stage, input.setupState ?? "fresh"),
				),
			);
		}
		if (url.pathname === "/-/health/warm") {
			return Promise.resolve(
				json(
					200,
					input.runner ??
						{
							ok: true,
							gitVersion: "2.55.0",
							pnpmVersion: "10.34.6",
							mergeTree: true,
							users: true,
							image: null,
							checkedAt: 1,
						},
				),
			);
		}
		return Promise.resolve(json(404, {}));
	}) as typeof fetch;
	const clock = fakeClock();
	let n = 0;
	const deps: DeployDeps = {
		run,
		fetch: fetcher,
		freshFetch: fetcher,
		env: () => undefined,
		now: clock.now,
		sleep: clock.sleep,
		root: ROOT,
		readText: (file) =>
			Promise.resolve(files.get(file)?.text ?? readable[file] ?? null),
		writeText: (file, text, options) => {
			files.set(file, { text, secret: options?.secret === true });
			return Promise.resolve();
		},
		isSymlink: () => Promise.resolve(input.symlink === true),
		random: (size) => new Uint8Array(size).fill(++n),
		denoVersion: "2.9.6",
		log: (line) => logs.push(line),
		interactive: input.interactive ?? false,
		confirm: () => Promise.resolve(true),
		printSecret: (line) => printed.push(line),
	};
	return { deps, calls, requests, files, logs, printed };
};

const opts = (args: string[]): DeployOptions => optionsFromArgs(args, ROOT)!;

Deno.test("options: defaults and refusals", () => {
	const o = opts(["--stage", "dev-wp21", "--no-containers"]);
	eq([
		o.containers,
		o.printUrl,
		o.build,
		o.evictionFlag,
		o.devTools,
		o.repoConfig,
		o.projects,
	], [
		false,
		true,
		true,
		true,
		false,
		false,
		false,
	]);
	eq(o.urlFile, "/repo/.wrangler/deploy/setup-url.dev-wp21.txt");
	eq(optionsFromArgs(["--help"], ROOT), undefined);
	const refuse = (args: string[], text: string) =>
		assert.throws(
			() => optionsFromArgs(args, ROOT),
			(e) => e instanceof UsageError && e.message.includes(text),
		);
	refuse(["--stage", "prod", "--dev-tools"], "dev or dev-*");
	refuse(
		["--stage", "dev", "--repo-config", "--no-containers"],
		"needs containers",
	);
	eq(opts(["--stage", "dev", "--repo-config"]).repoConfig, true);
	eq(opts(["--stage", "dev", "--projects", "--no-containers"]).projects, true);
	refuse(["--stage", "dev", "--url-file", "x"], "needs --no-print-url");
	refuse(
		["--stage", "dev", "--delete-setup-token", "--keep-setup-token"],
		"exclude",
	);
	eq(
		opts(["--stage", "dev", "--no-print-url", "--url-file", "out/u.txt"])
			.urlFile,
		"/repo/out/u.txt",
	);
});

Deno.test("small helpers", () => {
	const secret = generateSecret(() => new Uint8Array(32).fill(255));
	assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
	eq(
		setupUrl("https://git.example.com", "a+b"),
		"https://git.example.com/-/setup#t=a%2Bb",
	);
	eq(
		parseDeployOutput(
			"Uploaded\n  https://tartan-dev.acme.workers.dev\nCurrent Version ID: 00000000-0000-4000-8000-000000000001\n",
			"tartan-dev",
		),
		{
			workersDev: "https://tartan-dev.acme.workers.dev",
			versionId: "00000000-0000-4000-8000-000000000001",
		},
	);
	eq(
		parseDeployOutput(
			"  https://tartan-dev-wp21.acme.workers.dev",
			"tartan-dev",
		),
		{},
	);
	assert(
		isRegistryPushTimeout(
			"Error: pushing layer abc: net/http: TLS handshake timeout",
		),
	);
	assert(
		isRegistryPushTimeout(
			"registry.cloudflare.com: context deadline exceeded while uploading image",
		),
	);
	assert(!isRegistryPushTimeout("Error: binding ARTIFACTS is invalid"));
	assert(!isRegistryPushTimeout("pushing layer abc: unauthorized"));
});

Deno.test("node_modules: exact pins decide ok, stale and missing", async () => {
	const read = (files: Record<string, string>) => (file: string) =>
		Promise.resolve(
			file === "/repo/package.json" ? PACKAGE : files[file] ?? null,
		);
	eq(await assessNodeModules(ROOT, read(pinnedModules())), { state: "ok" });
	eq(await assessNodeModules(ROOT, read({})), { state: "missing" });
	const modules = pinnedModules();
	modules["/repo/node_modules/wrangler/package.json"] = '{"version":"4.0.0"}';
	const stale = await assessNodeModules(ROOT, read(modules));
	assert(
		stale.state === "stale" &&
			stale.mismatches.some((m) => m.startsWith("wrangler 4.0.0")),
	);
});

Deno.test("secrets: the root key only on a new Worker; a new setup token while unclaimed", () => {
	eq(
		planSecrets({
			firstDeploy: true,
			existing: new Set(),
			setupState: "fresh",
			keepSetupToken: false,
		}).put,
		["TARTAN_SECRET", "TARTAN_SETUP_TOKEN"],
	);
	const redeploy = planSecrets({
		firstDeploy: false,
		existing: new Set(["TARTAN_SETUP_TOKEN"]),
		setupState: "fresh",
		keepSetupToken: false,
	});
	eq([redeploy.put, redeploy.setupTokenKnown], [["TARTAN_SETUP_TOKEN"], true]);
	assert(redeploy.notes.some((n) => n.includes("TARTAN_SECRET is not set")));
	const kept = planSecrets({
		firstDeploy: false,
		existing: new Set(["TARTAN_SECRET", "TARTAN_SETUP_TOKEN"]),
		setupState: "idp",
		keepSetupToken: true,
	});
	eq([kept.put, kept.setupTokenKnown, kept.notes.length], [[], false, 1]);
	const claimed = planSecrets({
		firstDeploy: false,
		existing: new Set(["TARTAN_SECRET", "TARTAN_SETUP_TOKEN"]),
		setupState: "done",
		keepSetupToken: false,
	});
	eq([claimed.put, claimed.offerDelete], [[], true]);
	eq(
		planSecrets({
			firstDeploy: false,
			existing: new Set(["TARTAN_SECRET"]),
			setupState: "done",
			keepSetupToken: false,
		}).offerDelete,
		false,
	);
});

Deno.test("registry digest check: the deployed app must run the recorded digest", () => {
	const ref = `ttl.sh/tartan-runner-x@${DIGEST}`;
	const app = "tartan-dev-tartansandbox";
	eq(checkDeployedDigest([{ name: app, image: ref }], app, ref).ok, true);
	const other = checkDeployedDigest(
		[{ name: app, image: `ttl.sh/x@sha256:${"0".repeat(64)}` }],
		app,
		ref,
	);
	assert(!other.ok && other.message.includes("not the recorded"));
	assert(
		!checkDeployedDigest(
			[{ name: app, image: "registry.cloudflare.com/x:tag" }],
			app,
			ref,
		).ok,
	);
	assert(!checkDeployedDigest([], app, ref).ok);
	assert.throws(() => checkDeployedDigest([], app, "ttl.sh/x:24h"));
});

// ---------------------------------------------------------------------------
// Health polls: a new connection per attempt, each attempt classified
// ---------------------------------------------------------------------------

const ORIGIN = "https://git.example.com";
const STAGE = "dev-wp21";

/** A failed fetch the way Deno 2.9 reports it (cause carries the detail). */
const fetchFailed = (detail: string, url = `${ORIGIN}/-/health`) =>
	new TypeError("fetch failed", {
		cause: new Error(
			`error sending request for url (${url}): client error (Connect): ${detail}`,
		),
	});
const DNS =
	"dns error: failed to lookup address information: nodename nor servname provided, or not known";
const ALERT = "received fatal alert: HandshakeFailure";
const UNTRUSTED = "invalid peer certificate: UnknownIssuer";
const REFUSED = "tcp connect error: Connection refused (os error 61)";
const TIMED_OUT = () =>
	new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** The server the hostname's old A record pointed at. */
const oldServer = () =>
	new Response("<html>old site</html>", {
		status: 200,
		headers: { server: "nginx", "content-type": "text/html" },
	});
const thisStage = () => json(200, health(STAGE));
const starting = () =>
	json(503, { ...health(STAGE), ok: false, bindings: { AI: "missing" } });

type Answer = (() => Response) | Error;

/** Answers in order; the last one repeats. Records every request. */
const scripted = (answers: readonly Answer[]) => {
	const seen: { url: string; init?: RequestInit }[] = [];
	const fetcher = ((req: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(req), init });
		const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
		return answer instanceof Error
			? Promise.reject(answer)
			: Promise.resolve(answer());
	}) as typeof fetch;
	return { fetcher, seen };
};

const poller = (fetcher: typeof fetch, logs: string[] = []) =>
	createDomainPoller({
		fetch: fetcher,
		clock: fakeClock(),
		log: (line) => logs.push(line),
	});

const FOREIGN_LINE =
	"connected, but the answer is not from Tartan stage dev-wp21 (HTTP 200, server: nginx): another server still answers for this hostname (an old DNS record, a cached lookup, or a route that is not live yet)";
const HEALTHY_LINE = "healthy: stage dev-wp21, setup fresh, 2 bindings ok";

Deno.test("health probe: DNS, TLS, unreachable, another server, this stage unhealthy, healthy", async () => {
	const cases: readonly [Answer, ProbeKind, string][] = [
		[fetchFailed(DNS), "dns", "nodename nor servname provided"],
		[fetchFailed(ALERT), "tls", "received fatal alert: HandshakeFailure"],
		[fetchFailed(UNTRUSTED), "tls", "invalid peer certificate: UnknownIssuer"],
		[fetchFailed(REFUSED), "unreachable", "Connection refused"],
		[TIMED_OUT(), "unreachable", "timed out after 10s"],
		[oldServer, "foreign", "HTTP 200, server: nginx"],
		[() => json(404, { error: "not found" }), "foreign", "HTTP 404"],
		[
			() => json(200, health("dev")),
			"foreign",
			'Tartan stage "dev" answered, HTTP 200',
		],
		[starting, "unhealthy", "HTTP 503; bindings not ok: AI=missing"],
	];
	for (const [answer, kind, text] of cases) {
		const probe = await poller(scripted([answer]).fetcher).probe(
			ORIGIN,
			STAGE,
		);
		const detail = probe.kind === "healthy" ? "" : probe.detail;
		assert(
			probe.kind === kind && detail.includes(text),
			`${kind}: ${JSON.stringify(probe)}`,
		);
		// The URL in Deno's message is not part of the detail.
		assert(!detail.includes("error sending request"));
	}
	const healthy = await poller(scripted([thisStage]).fetcher).probe(
		ORIGIN,
		STAGE,
	);
	assert(healthy.kind === "healthy" && healthy.health.stage === STAGE);
	// A hostname that contains "tls" does not turn a refused connection into a
	// certificate problem.
	const refused = await poller(
		scripted([fetchFailed(REFUSED, "https://tls.example.com/-/health")])
			.fetcher,
	).probe("https://tls.example.com", STAGE);
	eq(refused.kind, "unreachable");

	// Every attempt: no keep-alive, no redirects, its own timeout.
	const { fetcher, seen } = scripted([thisStage]);
	await poller(fetcher).probe(ORIGIN, STAGE);
	eq(seen[0].url, `${ORIGIN}/-/health`);
	const init = seen[0].init!;
	const headers = new Headers(init.headers);
	eq([headers.get("connection"), headers.get("cache-control")], [
		"close",
		"no-store",
	]);
	eq(init.redirect, "manual");
	assert(init.signal instanceof AbortSignal && !init.signal.aborted);
});

Deno.test("domain poll: an old server answers first, then this stage (the stale-server case)", async () => {
	const logs: string[] = [];
	const { fetcher, seen } = scripted([
		oldServer,
		oldServer,
		oldServer,
		thisStage,
	]);
	const body = await poller(fetcher, logs).poll({
		origin: ORIGIN,
		stage: STAGE,
		timeoutMs: 600_000,
		intervalMs: 10_000,
	});
	eq(body.stage, STAGE);
	eq(seen.length, 4);
	assert(
		seen.every((s) =>
			new Headers(s.init?.headers).get("connection") === "close"
		),
	);
	// One line per change of classification, with the elapsed time; nothing
	// claims a certificate problem.
	eq(logs, [`  [0s] ${FOREIGN_LINE}`, `  [30s] ${HEALTHY_LINE}`]);
	assert(!logs.some((l) => l.includes("certificate")));
});

Deno.test("domain poll: DNS, then the certificate, then this stage starting, then healthy", async () => {
	const logs: string[] = [];
	const { fetcher } = scripted([
		fetchFailed(DNS),
		fetchFailed(DNS),
		fetchFailed(ALERT),
		fetchFailed(ALERT),
		fetchFailed(ALERT),
		starting,
		thisStage,
	]);
	await poller(fetcher, logs).poll({
		origin: ORIGIN,
		stage: STAGE,
		timeoutMs: 600_000,
		intervalMs: 10_000,
	});
	eq(logs, [
		`  [0s] the hostname does not resolve yet (${DNS})`,
		`  [20s] the TLS handshake failed: the certificate is probably still being issued (${ALERT})`,
		"  [50s] stage dev-wp21 answered, but is not healthy yet (HTTP 503; bindings not ok: AI=missing)",
		`  [1m00s] ${HEALTHY_LINE}`,
	]);
	eq(logs.filter((l) => l.includes("certificate")).length, 1);
});

Deno.test("domain poll: the overall deadline ends it with the last classification", async () => {
	const logs: string[] = [];
	const budgets: number[] = [];
	const { fetcher, seen } = scripted([fetchFailed(DNS), oldServer]);
	await assert.rejects(
		() =>
			createDomainPoller({
				fetch: fetcher,
				clock: fakeClock(),
				log: (line) => logs.push(line),
				timeout: (ms) => {
					budgets.push(ms);
					return new AbortController().signal;
				},
			}).poll({
				origin: ORIGIN,
				stage: STAGE,
				timeoutMs: 60_000,
				intervalMs: 10_000,
			}),
		(e) =>
			e instanceof DeployError &&
			e.message ===
				`${ORIGIN}/-/health did not answer as Tartan stage dev-wp21 within 1m00s; for the last 49s: ${FOREIGN_LINE}`,
	);
	// t = 0, 10, …, 50 s, then 59 s: each attempt's timeout is capped at the
	// deadline, and the last one still gets a full second, so no attempt starts
	// at the deadline, times out at once and hides what the others saw.
	eq(seen.length, 7);
	eq(budgets, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 1_000]);
	eq(logs.length, 2);
});

Deno.test("domain poll: a request that never answers is cut off per attempt, so the poll cannot hang", async () => {
	let calls = 0;
	// A kept-alive connection to a server that never answers: only the
	// attempt's abort signal (the real AbortSignal.timeout) ends the request.
	const hung = ((_req: string | URL | Request, init?: RequestInit) => {
		calls++;
		const signal = init!.signal!;
		return new Promise<Response>((_, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			})
		);
	}) as typeof fetch;
	const logs: string[] = [];
	await assert.rejects(
		() =>
			poller(hung, logs).poll({
				origin: ORIGIN,
				stage: STAGE,
				timeoutMs: 30_000,
				intervalMs: 10_000,
				attemptTimeoutMs: 20,
			}),
		(e) =>
			e instanceof DeployError && e.message.includes("within 30s") &&
			e.message.includes("no answer (timed out after"),
	);
	eq(calls, 4); // t = 0, 10, 20, 29 s
	eq(logs.length, 1);
	assert(logs[0].startsWith("  [0s] no answer (timed out after"));
});

Deno.test("fresh fetch: a new client per call, closed after the body is read and on failure", async () => {
	type FakeClient = { closed: boolean; readonly close: () => void };
	const clients: FakeClient[] = [];
	const used: unknown[] = [];
	const fresh = createFreshFetch({
		createClient: () => {
			const client: FakeClient = {
				closed: false,
				close: () => void (client.closed = true),
			};
			clients.push(client);
			return client as unknown as Deno.HttpClient;
		},
		fetch: ((_input, init) => {
			used.push(init.client);
			assert(!(init.client as unknown as FakeClient).closed);
			return used.length === 3
				? Promise.reject(fetchFailed(REFUSED))
				: Promise.resolve(
					new Response(JSON.stringify({ n: used.length }), {
						status: 200,
						headers: { server: "fake" },
					}),
				);
		}) as ClientFetch,
	});
	const first = await fresh(`${ORIGIN}/-/health`);
	const second = await fresh(`${ORIGIN}/-/health`, {
		headers: { connection: "close" },
	});
	// The body was read before the client closed, so it is still readable.
	eq(await first.json(), { n: 1 });
	eq([second.status, second.headers.get("server")], [200, "fake"]);
	await assert.rejects(() => fresh(`${ORIGIN}/-/health`), TypeError);
	eq(clients.length, 3);
	eq(new Set(used).size, 3);
	assert(clients.every((c) => c.closed));
});

Deno.test("fresh fetch against a local server: every attempt opens its own connection", async () => {
	const ports: number[] = [];
	const connection: (string | null)[] = [];
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		(req, info) => {
			ports.push(info.remoteAddr.port);
			connection.push(req.headers.get("connection"));
			return Response.json(health(STAGE));
		},
	);
	try {
		const fresh = denoFreshFetch();
		const origin = `http://127.0.0.1:${server.addr.port}`;
		// Without `connection: close` both sides would keep the connection
		// alive: only the client per call keeps the next call off it.
		for (let i = 0; i < 2; i++) {
			eq((await fresh(`${origin}/-/health`)).status, 200);
		}
		const probe = poller(fresh).probe;
		for (let i = 0; i < 2; i++) {
			eq((await probe(origin, STAGE)).kind, "healthy");
		}
	} finally {
		await server.shutdown();
	}
	eq(new Set(ports).size, 4);
	eq(connection, [null, null, "close", "close"]);
});

Deno.test("elapsed time format", () => {
	eq([0, 999, 45_000, 60_000, 125_400, 600_000].map(formatElapsed), [
		"0s",
		"1s",
		"45s",
		"1m00s",
		"2m05s",
		"10m00s",
	]);
});

Deno.test("warm-up: a 429 means running, the result comes from /-/health", async () => {
	const clock = fakeClock();
	const started = clock.now();
	let posts = 0;
	const fetcher = ((req: string | URL | Request, init?: RequestInit) => {
		void req;
		if (init?.method === "POST") {
			posts++;
			return Promise.resolve(
				posts === 1
					? new Response("upstream timeout", { status: 524 })
					: json(429, { error: { code: "rate_limited" } }),
			);
		}
		const runner = clock.now() - started > 30_000
			? {
				ok: true,
				gitVersion: "2.55.0",
				pnpmVersion: "10",
				mergeTree: true,
				users: true,
				image: null,
				checkedAt: started + 5_000,
			}
			: undefined;
		return Promise.resolve(
			json(200, { ...health("dev"), ...(runner ? { runner } : {}) }),
		);
	}) as typeof fetch;
	const result = await warmUp({
		fetch: fetcher,
		origin: "https://x",
		timeoutMs: 120_000,
		clock,
	});
	assert(result.ok);
	assert(posts >= 2);
	const never =
		(() => Promise.resolve(json(429, {}))) as unknown as typeof fetch;
	const timedOut = await warmUp({
		fetch: never,
		origin: "https://x",
		timeoutMs: 30_000,
		clock: fakeClock(),
	});
	assert(!timedOut.ok && timedOut.reason.includes("no selftest result"));
	const failed = (() =>
		Promise.resolve(
			json(503, {
				ok: false,
				gitVersion: "2.34.1",
				pnpmVersion: null,
				mergeTree: false,
				users: true,
				image: null,
				checkedAt: 1,
			}),
		)) as unknown as typeof fetch;
	const bad = await warmUp({
		fetch: failed,
		origin: "https://x",
		timeoutMs: 30_000,
		clock: fakeClock(),
	});
	assert(!bad.ok && bad.reason.includes("2.34.1"));
});

Deno.test("warm-up: every request has its own timeout, capped at the step deadline", async () => {
	// The selftest keeps running (429) and /-/health shows no result yet. Each
	// request is recorded with the timeout of the signal it carried.
	const budgets = new WeakMap<AbortSignal, number>();
	const requests: string[] = [];
	const running = ((req: string | URL | Request, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		requests.push(
			`${method} ${new URL(String(req)).pathname} ${
				init?.signal ? budgets.get(init.signal) : "none"
			}`,
		);
		return Promise.resolve(
			method === "POST"
				? json(429, { error: { code: "rate_limited" } })
				: json(200, health("dev")),
		);
	}) as typeof fetch;
	const result = await warmUp({
		fetch: running,
		origin: "https://x",
		timeoutMs: WARM_TIMEOUT_MS,
		clock: fakeClock(),
		timeout: (ms) => {
			const signal = new AbortController().signal;
			budgets.set(signal, ms);
			return signal;
		},
	});
	assert(
		!result.ok &&
			result.reason === "no selftest result within 2m00s (selftest running)",
	);
	// A POST and a GET at t = 0, 10, …, 110 s, then 119 s.
	eq(requests.length, 26);
	eq(requests.slice(0, 2), [
		`POST /-/health/warm ${WARM_ATTEMPT_TIMEOUT_MS}`,
		"GET /-/health 10000",
	]);
	eq(requests[8], "POST /-/health/warm 80000"); // t = 40 s: 80 s left
	eq(requests.slice(-2), [
		"POST /-/health/warm 1000",
		"GET /-/health 1000",
	]);

	// A POST that never answers: the real AbortSignal.timeout ends each one.
	let posts = 0;
	const hung = ((_req: string | URL | Request, init?: RequestInit) => {
		posts++;
		const signal = init!.signal!;
		return new Promise<Response>((_, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			})
		);
	}) as typeof fetch;
	const stuck = await warmUp({
		fetch: hung,
		origin: "https://x",
		timeoutMs: 30_000,
		attemptTimeoutMs: 20,
		clock: fakeClock(),
	});
	assert(
		!stuck.ok &&
			stuck.reason.startsWith("no selftest result within 30s (timed out after"),
		JSON.stringify(stuck),
	);
	eq(posts, 4); // t = 0, 10, 20, 29 s
});

Deno.test("first deploy, --no-containers: render, build, deploy, both secrets via stdin, health, URL printed once", async () => {
	const w = world();
	const record = await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers"]),
		w.deps,
	);
	const lines = w.calls.map((c) => c.line);
	const index = (prefix: string) =>
		lines.findIndex((l) => l.startsWith(prefix));
	assert(index("npm run build:web") < index("npx wrangler deploy -c"));
	assert(
		index("npx wrangler deploy -c") <
			index("npx wrangler secret put TARTAN_SECRET"),
	);
	assert(!lines.some((l) => l.startsWith("docker") || l.startsWith("npm ci")));
	const config = "/repo/.wrangler/deploy/wrangler.dev-wp21.jsonc";
	assert(lines.includes(`npx wrangler deploy -c ${config}`));
	const rendered = parseJsoncValue(w.files.get(config)!.text) as Record<
		string,
		unknown
	>;
	eq(rendered.name, "tartan-dev-wp21");
	eq(rendered.containers, undefined);
	// Repository config stays off unless --repo-config asks for it.
	eq(
		(rendered.vars as Record<string, unknown>)["TARTAN_REPO_CONFIG"],
		undefined,
	);
	// Projects stay off unless --projects asks for them (WP25).
	eq(
		(rendered.vars as Record<string, unknown>)["TARTAN_PROJECTS"],
		undefined,
	);
	const puts = w.calls.filter((c) => c.line.includes("secret put"));
	eq(puts.map((c) => c.line.split(" ")[4]), [
		"TARTAN_SECRET",
		"TARTAN_SETUP_TOKEN",
	]);
	for (const put of puts) {
		assert.match(put.stdin!, /^[A-Za-z0-9_-]{43}$/);
		eq(put.env?.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
		assert(
			!w.logs.some((l) => l.includes(put.stdin!)),
			"a secret reached the log",
		);
	}
	const token = puts[1].stdin!;
	eq(w.printed, [
		`  https://tartan-dev-wp21.example.workers.dev/-/setup#t=${token}`,
	]);
	assert(w.logs.some((l) => l.includes("/-/auth/callback")));
	eq(record.image, { variant: "none" });
	eq(record.versionId, "11111111-2222-3333-4444-555555555555");
	assert(!w.requests.some((r) => r.endsWith("/-/health/warm")));
	const saved = JSON.parse(
		w.files.get("/repo/.wrangler/deploy/record.dev-wp21.json")!.text,
	);
	eq([saved.worker, saved.setupState, saved.domain], [
		"tartan-dev-wp21",
		"fresh",
		null,
	]);
	assert(!JSON.stringify(saved).includes(token));
});

Deno.test("--no-print-url writes the URL to a 0600 file and prints nothing secret", async () => {
	const w = world();
	await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers", "--no-print-url"]),
		w.deps,
	);
	eq(w.printed, []);
	const file = w.files.get("/repo/.wrangler/deploy/setup-url.dev-wp21.txt")!;
	assert(file.secret);
	assert.match(
		file.text,
		/^https:\/\/tartan-dev-wp21\.example\.workers\.dev\/-\/setup#t=[A-Za-z0-9_-]{43}\n$/,
	);
});

Deno.test("redeploy of an unclaimed forge: a new setup token, the root key untouched", async () => {
	const w = world({
		workerExists: true,
		secrets: ["TARTAN_SECRET", "TARTAN_SETUP_TOKEN"],
	});
	await runDeploy(opts(["--stage", "dev-wp21", "--no-containers"]), w.deps);
	const puts = w.calls.filter((c) => c.line.includes("secret put")).map((c) =>
		c.line.split(" ")[4]
	);
	eq(puts, ["TARTAN_SETUP_TOKEN"]);
	eq(w.printed.length, 1);
});

Deno.test("redeploy of a claimed forge: no URL, the setup token deleted on request", async () => {
	const w = world({
		workerExists: true,
		secrets: ["TARTAN_SECRET", "TARTAN_SETUP_TOKEN"],
		setupState: "done",
	});
	await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers", "--delete-setup-token"]),
		w.deps,
	);
	eq(w.printed, []);
	assert(!w.calls.some((c) => c.line.includes("secret put")));
	assert(
		w.calls.some((c) =>
			c.line.startsWith("npx wrangler secret delete TARTAN_SETUP_TOKEN")
		),
	);
	const offered = world({
		workerExists: true,
		secrets: ["TARTAN_SETUP_TOKEN"],
		setupState: "done",
	});
	await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers"]),
		offered.deps,
	);
	assert(!offered.calls.some((c) => c.line.includes("secret delete")));
	assert(
		offered.logs.some((l) =>
			l.includes(
				"npx wrangler secret delete TARTAN_SETUP_TOKEN --name tartan-dev-wp21",
			)
		),
	);
});

Deno.test("a registry push timeout is retried once; other failures are not", async () => {
	const timeout: RunResult = {
		code: 1,
		stdout: "",
		stderr: "pushing layer 3f2a: i/o timeout",
	};
	const docker = (w: World) => {
		const run = w.deps.run;
		return {
			...w.deps,
			run:
				((cmd, args, options) =>
					cmd === "docker"
						? Promise.resolve(ok("29.8.1"))
						: cmd === "df"
						? Promise.resolve(ok("F 1 U A C M\n/d 1 1 99999999 1% /\n"))
						: run(cmd, args, options)) as Run,
		};
	};
	const retried = world({
		deployResults: [
			timeout,
			ok("  https://tartan-dev-wp21.example.workers.dev\n"),
		],
	});
	await runDeploy(opts(["--stage", "dev-wp21"]), docker(retried));
	eq(
		retried.calls.filter((c) => c.line.startsWith("npx wrangler deploy"))
			.length,
		2,
	);
	assert(retried.requests.some((r) => r.endsWith("/-/health/warm")));

	const twice = world({ deployResults: [timeout, timeout] });
	await assert.rejects(
		() => runDeploy(opts(["--stage", "dev-wp21"]), docker(twice)),
		DeployError,
	);
	eq(
		twice.calls.filter((c) => c.line.startsWith("npx wrangler deploy")).length,
		2,
	);

	const other = world({
		deployResults: [{ code: 1, stdout: "", stderr: "binding invalid" }],
	});
	await assert.rejects(
		() => runDeploy(opts(["--stage", "dev-wp21"]), docker(other)),
		DeployError,
	);
	eq(
		other.calls.filter((c) => c.line.startsWith("npx wrangler deploy")).length,
		1,
	);
});

Deno.test("registry variant: a fresh record is rendered by digest and checked after the deploy", async () => {
	const ref = `ttl.sh/tartan-runner-e-0011223344556677@${DIGEST}`;
	const w = world({
		containersList: [{ name: "tartan-dev-wp21-tartansandbox", image: ref }],
	});
	const recordFile = "/repo/.wrangler/deploy/runner-image.json";
	await w.deps.writeText(
		recordFile,
		JSON.stringify({
			ref,
			commit: "e".repeat(40),
			builtAt: new Date(w.deps.now() - 60_000).toISOString(),
		}),
	);
	const record = await runDeploy(
		opts(["--stage", "dev-wp21", "--image", "registry", "--repo-config"]),
		w.deps,
	);
	eq(record.image, { variant: "registry", ref });
	const rendered =
		w.files.get("/repo/.wrangler/deploy/wrangler.dev-wp21.jsonc")!.text;
	assert(rendered.includes(`"image": "${ref}"`));
	// --repo-config renders the switch (ADR repo config; off by default).
	assert(rendered.includes('"TARTAN_REPO_CONFIG": "on"'));
	assert(
		!w.calls.some((c) =>
			c.line.includes("publish.ts") || c.line.startsWith("docker")
		),
	);

	const wrong = world({
		containersList: [{
			name: "tartan-dev-wp21-tartansandbox",
			image: `ttl.sh/x@sha256:${"0".repeat(64)}`,
		}],
	});
	await wrong.deps.writeText(
		recordFile,
		JSON.stringify({
			ref,
			commit: "e".repeat(40),
			builtAt: new Date(wrong.deps.now() - 60_000).toISOString(),
		}),
	);
	await assert.rejects(
		() =>
			runDeploy(
				opts(["--stage", "dev-wp21", "--image", "registry"]),
				wrong.deps,
			),
		(e) => e instanceof DeployError && e.message.includes("not the recorded"),
	);
});

Deno.test("preflight failure stops before anything is deployed", async () => {
	const w = world();
	await assert.rejects(
		() => runDeploy(opts(["--stage", "dev-wp21"]), w.deps),
		PreflightError,
	);
	assert(
		!w.calls.some((c) =>
			c.line.startsWith("npx wrangler deploy") || c.line.startsWith("npm run")
		),
	);
	assert(w.logs.some((l) => l.includes("container-engine")));
});

Deno.test("stale node_modules: npm ci, but never through a symlinked node_modules", async () => {
	const modules = pinnedModules();
	modules["/repo/node_modules/vite/package.json"] = '{"version":"1.0.0"}';
	const linked = world({ modules, symlink: true });
	await assert.rejects(
		() =>
			runDeploy(opts(["--stage", "dev-wp21", "--no-containers"]), linked.deps),
		(e) => e instanceof DeployError && e.message.includes("symlink"),
	);
	assert(!linked.calls.some((c) => c.line === "npm ci"));
	const plain = world({ modules });
	await runDeploy(opts(["--stage", "dev-wp21", "--no-containers"]), plain.deps);
	eq(plain.calls[0].line, "npm ci");
});

Deno.test("a domain deploy polls the custom domain and prints its setup URL", async () => {
	const w = world();
	const fetcher = w.deps.fetch;
	const deps: DeployDeps = {
		...w.deps,
		fetch: ((req: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(req));
			if (
				url.host === "api.cloudflare.com" && url.pathname.endsWith("/zones")
			) {
				return Promise.resolve(
					json(200, { result: [{ id: "z", name: "example.com" }] }),
				);
			}
			if (
				url.host === "api.cloudflare.com" &&
				url.pathname.endsWith("/workers/domains")
			) {
				return Promise.resolve(json(200, { result: [] }));
			}
			return fetcher(req, init);
		}) as typeof fetch,
	};
	await runDeploy(
		opts([
			"--stage",
			"dev-wp21",
			"--no-containers",
			"--domain",
			"git.example.com",
		]),
		deps,
	);
	assert(w.requests.includes("GET https://git.example.com/-/health"));
	const waiting = w.logs.findIndex((l) =>
		l.startsWith("waiting for https://git.example.com/-/health (up to 10m00s")
	);
	assert(waiting >= 0);
	eq(w.logs[waiting + 1], `  [0s] ${HEALTHY_LINE}`);
	assert(!w.logs.some((l) => l.includes("certificate")));
	assert(w.printed[0].startsWith("  https://git.example.com/-/setup#t="));
	assert(
		w.files.get("/repo/.wrangler/deploy/wrangler.dev-wp21.jsonc")!.text
			.includes('"pattern": "git.example.com"'),
	);
});

Deno.test("--build-ext: each extension package is built after the SPA and before the deploy", async () => {
	const w = world({
		commands: {
			"rustup target list --installed": ok(
				"aarch64-apple-darwin\nwasm32-unknown-unknown\n",
			),
		},
	});
	eq(opts(["--stage", "dev-wp21"]).buildExt, false);
	await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers", "--build-ext"]),
		w.deps,
	);
	const lines = w.calls.map((c) => c.line);
	const at = (line: string) => lines.indexOf(line);
	for (const name of EXT_PACKAGES) {
		const build = at(`deno task build:ext ${name}`);
		assert(build > at("npm run build:web"), lines.join("\n"));
		assert(
			build < lines.findIndex((l) => l.startsWith("npx wrangler deploy -c")),
		);
	}
	assert(w.logs.some((l) => l.includes("PUT /-/api/packages")));
});

Deno.test("--build-ext: a missing toolchain stops before anything is built or deployed", async () => {
	const w = world({
		commands: {
			"rustup target list --installed": ok("aarch64-apple-darwin\n"),
			"wasm-tools --version": new Deno.errors.NotFound("wasm-tools"),
		},
	});
	await assert.rejects(
		() =>
			runDeploy(
				opts(["--stage", "dev-wp21", "--no-containers", "--build-ext"]),
				w.deps,
			),
		(e) =>
			e instanceof PreflightError &&
			e.message.includes("rustup target add wasm32-unknown-unknown") &&
			e.message.includes("wasm-tools is missing"),
	);
	assert(
		!w.calls.some((c) =>
			c.line.startsWith("npx wrangler deploy") ||
			c.line.startsWith("npm run") ||
			c.line.startsWith("deno task build:ext")
		),
	);
});

Deno.test("--lane-mode and --workload-transport: the stage's switch overrides, rendered as vars", async () => {
	const plain = opts(["--stage", "dev-wp21", "--no-containers"]);
	eq([plain.laneMode, plain.workloadTransport], [undefined, undefined]);
	const k2 = opts([
		"--stage",
		"dev-wp21",
		"--k2",
		"--k2-token-store",
		"0123456789abcdef0123456789abcdef",
		"--k2-token-secret",
		"k2-consumer",
		"--workload-transport",
		"k2",
		"--lane-mode",
		"import",
	]);
	eq([k2.laneMode, k2.workloadTransport], ["import", "k2"]);
	assert.throws(
		() => opts(["--stage", "dev-wp21", "--workload-transport", "k2"]),
		(e) => e instanceof UsageError && e.message.includes("needs --k2"),
	);
	assert.throws(
		() => opts(["--stage", "dev-wp21", "--lane-mode", "bogus"]),
		(e) => e instanceof UsageError && e.message.includes("--lane-mode is"),
	);
	assert.throws(
		() => opts(["--stage", "dev-wp21", "--workload-transport", "queue"]),
		UsageError,
	);
	const w = world();
	await runDeploy(
		opts(["--stage", "dev-wp21", "--no-containers", "--lane-mode", "import"]),
		w.deps,
	);
	const config = "/repo/.wrangler/deploy/wrangler.dev-wp21.jsonc";
	const rendered = parseJsoncValue(w.files.get(config)!.text) as Record<
		string,
		unknown
	>;
	const vars = rendered.vars as Record<string, unknown>;
	eq(vars["TARTAN_LANE_MODE"], "import");
	eq(vars["TARTAN_WORKLOAD_TRANSPORT"], undefined);
});
