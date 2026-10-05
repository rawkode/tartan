import assert from "node:assert/strict";
import {
	deregister,
	type DestroyDeps,
	DestroyError,
	type DestroyOptions,
	destroyOptionsFromArgs,
	isEmptyInventory,
	namespaceStep,
	runDestroy,
	stageImages,
} from "./destroy.ts";
import { type Run, type RunResult, UsageError } from "./preflight.ts";

const eq = (actual: unknown, expected: unknown) =>
	assert.deepEqual(actual, expected);
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WHOAMI = JSON.stringify({
	loggedIn: true,
	accounts: [{ id: ACCOUNT, name: "Example" }],
});
const SOURCE = await Deno.readTextFile(
	new URL("../wrangler.jsonc", import.meta.url),
);

const fakeClock = () => {
	let t = Date.parse("2026-10-02T12:00:00Z");
	return {
		now: () => t,
		sleep: (ms: number) => Promise.resolve(void (t += ms)),
	};
};

type Cloud = {
	worker: boolean;
	workflows: Set<string>;
	apps: { id: string; name: string }[];
	images: { name: string; tags: string[] }[];
	bucket: boolean;
	objects: string[];
	kv: { id: string; title: string }[];
	repos: string[];
	namespaces: string[];
	healthStage: string;
	destroyTokenLive: number;
	dcr: unknown;
};

const cloud = (stage: string, over: Partial<Cloud> = {}): Cloud => {
	const worker = `tartan-${stage}`;
	return {
		worker: true,
		workflows: new Set(
			["run", "land", "ingest", "swarm"].map((s) => `${worker}-${s}`),
		),
		apps: [{ id: "app1", name: `${worker}-tartansandbox` }, {
			id: "app2",
			name: `${worker}-x-tartansandbox`,
		}],
		images: [{ name: `${worker}-tartansandbox`, tags: ["aa", "bb"] }, {
			name: "other",
			tags: ["cc"],
		}],
		bucket: true,
		objects: [],
		kv: [{ id: "kv1", title: `${worker}-oauth-kv` }, {
			id: "kv2",
			title: `${worker}-x-oauth-kv`,
		}],
		repos: ["r-01abc", "l-01abc-01def"],
		namespaces: [worker, `${worker}-x`],
		healthStage: stage,
		destroyTokenLive: 1,
		dcr: { clientId: "client-123", deregistered: true },
		...over,
	};
};

const harness = (
	stage: string,
	c: Cloud,
	extra: { interactive?: boolean; answer?: string } = {},
) => {
	const worker = `tartan-${stage}`;
	const calls: { line: string; stdin?: string }[] = [];
	const requests: string[] = [];
	const files = new Map<string, string>();
	const removedFiles: string[] = [];
	const logs: string[] = [];
	let destroyToken: string | null = null;
	let deregisterPosts = 0;
	const run: Run = (cmd, args, options) => {
		const line = [cmd, ...args].join(" ");
		calls.push({ line, stdin: options?.stdin });
		if (line === "npx wrangler whoami --json") {
			return Promise.resolve(ok(WHOAMI));
		}
		if (line === "npx wrangler auth token --json") {
			return Promise.resolve(ok('{"type":"oauth","token":"tok"}'));
		}
		if (line === "npx wrangler containers images list --json") {
			return Promise.resolve(ok(JSON.stringify(c.images)));
		}
		if (line.startsWith("npx wrangler secret put TARTAN_DESTROY_TOKEN")) {
			destroyToken = options?.stdin ?? null;
			return Promise.resolve(ok());
		}
		const imageDelete = /^npx wrangler containers images delete (\S+):(\S+) /
			.exec(line);
		if (imageDelete) {
			const image = c.images.find((i) => i.name === imageDelete[1]);
			if (image) image.tags = image.tags.filter((t) => t !== imageDelete[2]);
			return Promise.resolve(ok());
		}
		const repoDelete =
			/^npx wrangler artifacts repos delete (\S+) --namespace (\S+) --force$/
				.exec(line);
		if (repoDelete && repoDelete[2] === worker) {
			c.repos = c.repos.filter((r) => r !== repoDelete[1]);
			return Promise.resolve(ok());
		}
		return Promise.resolve({
			code: 1,
			stdout: "",
			stderr: `no fake for ${line}`,
		});
	};
	const fetcher = ((req: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(req));
		const method = init?.method ?? "GET";
		const p = decodeURIComponent(
			url.pathname.replace("/client/v4", "").replace(
				`/accounts/${ACCOUNT}`,
				"",
			),
		);
		requests.push(
			`${method} ${
				url.host === "api.cloudflare.com" ? p : url.origin + url.pathname
			}`,
		);
		const found = (yes: boolean) =>
			Promise.resolve(
				json(yes ? 200 : 404, {
					success: yes,
					result: yes ? {} : null,
					errors: [],
				}),
			);
		const done = () =>
			Promise.resolve(json(200, { success: true, result: null }));
		if (url.host !== "api.cloudflare.com") {
			if (url.pathname === "/-/health") {
				return Promise.resolve(
					json(c.worker ? 200 : 404, {
						product: "Tartan",
						stage: c.healthStage,
					}),
				);
			}
			if (url.pathname === "/-/admin/idp/deregister" && method === "POST") {
				deregisterPosts++;
				const auth = new Headers(init?.headers).get("authorization");
				if (destroyToken === null || deregisterPosts <= c.destroyTokenLive) {
					return Promise.resolve(json(404, {}));
				}
				assert.equal(auth, `Bearer ${destroyToken}`);
				return Promise.resolve(json(200, c.dcr));
			}
			return Promise.resolve(json(404, {}));
		}
		if (p === "/workers/subdomain") {
			return Promise.resolve(json(200, { result: { subdomain: "example" } }));
		}
		if (p === `/workers/scripts/${worker}/settings`) return found(c.worker);
		if (method === "DELETE" && p === `/workers/scripts/${worker}`) {
			c.worker = false;
			return done();
		}
		const wf = /^\/workflows\/(.+)$/.exec(p);
		if (wf) {
			if (method === "DELETE") c.workflows.delete(wf[1]);
			return method === "DELETE" ? done() : found(c.workflows.has(wf[1]));
		}
		if (p === "/containers/applications") {
			return Promise.resolve(json(200, { result: c.apps }));
		}
		const app = /^\/containers\/applications\/(.+)$/.exec(p);
		if (app && method === "DELETE") {
			c.apps = c.apps.filter((a) => a.id !== app[1]);
			return done();
		}
		if (p === `/r2/buckets/${worker}-blobs`) {
			if (method === "GET") return found(c.bucket);
			if (c.objects.length > 0) {
				return Promise.resolve(
					json(409, { errors: [{ code: 10008, message: "bucket not empty" }] }),
				);
			}
			c.bucket = false;
			return done();
		}
		if (p === `/r2/buckets/${worker}-blobs/objects`) {
			return Promise.resolve(
				json(200, { result: c.objects.slice(0, 2).map((key) => ({ key })) }),
			);
		}
		const obj = /^\/r2\/buckets\/[^/]+\/objects\/(.+)$/.exec(p);
		if (obj && method === "DELETE") {
			c.objects = c.objects.filter((k) => k !== obj[1]);
			return done();
		}
		if (p === "/workers/durable_objects/namespaces") {
			return Promise.resolve(
				json(200, {
					result: c.worker
						? [{ class: "ForgeDO", script: worker }, {
							class: "ForgeDO",
							script: `${worker}-x`,
						}]
						: [{ class: "ForgeDO", script: `${worker}-x` }],
					result_info: { total_pages: 1 },
				}),
			);
		}
		if (p === "/storage/kv/namespaces") {
			return Promise.resolve(
				json(200, { result: c.kv, result_info: { total_pages: 1 } }),
			);
		}
		const kv = /^\/storage\/kv\/namespaces\/(.+)$/.exec(p);
		if (kv && method === "DELETE") {
			c.kv = c.kv.filter((k) => k.id !== kv[1]);
			return done();
		}
		if (p === `/artifacts/namespaces/${worker}/repos`) {
			return Promise.resolve(
				json(200, {
					result: c.repos.map((name) => ({ name })),
					result_info: { total_pages: 1 },
				}),
			);
		}
		if (p === "/artifacts/namespaces") {
			return Promise.resolve(
				json(200, { result: c.namespaces.map((namespace) => ({ namespace })) }),
			);
		}
		if (method === "DELETE" && p === `/artifacts/namespaces/${worker}`) {
			c.namespaces = c.namespaces.filter((n) => n !== worker);
			return done();
		}
		return Promise.resolve(json(404, {}));
	}) as typeof fetch;
	const clock = fakeClock();
	const deps: DestroyDeps = {
		run,
		fetch: fetcher,
		env: () => undefined,
		now: clock.now,
		sleep: clock.sleep,
		root: "/repo",
		readText: (file) =>
			Promise.resolve(
				file === "/repo/wrangler.jsonc" ? SOURCE : files.get(file) ?? null,
			),
		writeText: (file, text) => Promise.resolve(void files.set(file, text)),
		remove: (file) => Promise.resolve(void removedFiles.push(file)),
		random: (n) => new Uint8Array(n).fill(7),
		log: (line) => logs.push(line),
		interactive: extra.interactive ?? false,
		ask: () => Promise.resolve(extra.answer ?? null),
	};
	return {
		deps,
		calls,
		requests,
		files,
		removedFiles,
		logs,
		deregisterPosts: () => deregisterPosts,
	};
};

const options = (
	stage: string,
	over: Partial<DestroyOptions> = {},
): DestroyOptions => ({
	stage,
	yes: true,
	keepRepos: false,
	deleteNamespace: false,
	...over,
});

Deno.test("destroy options", () => {
	eq(destroyOptionsFromArgs(["--", "--stage", "dev-x", "--yes"]), {
		stage: "dev-x",
		account: undefined,
		yes: true,
		keepRepos: false,
		deleteNamespace: false,
	});
	eq(destroyOptionsFromArgs(["-h"]), undefined);
	assert.throws(() => destroyOptionsFromArgs([]), UsageError);
	assert.throws(() => destroyOptionsFromArgs(["--stage", "A"]), UsageError);
	assert.throws(
		() =>
			destroyOptionsFromArgs([
				"--stage",
				"dev",
				"--keep-repos",
				"--delete-namespace",
			]),
		UsageError,
	);
});

Deno.test("images and the namespace step", () => {
	eq(
		stageImages([{ name: "a-tartansandbox", tags: ["1", "2"] }, {
			name: "b",
			tags: ["3"],
		}, null], "a-tartansandbox"),
		["a-tartansandbox:1", "a-tartansandbox:2"],
	);
	eq(stageImages("nope", "x"), []);
	const step = namespaceStep(ACCOUNT, "tartan-dev-x");
	assert(
		step.includes(`/accounts/${ACCOUNT}/artifacts/namespaces/tartan-dev-x`),
	);
	assert(step.includes("--delete-namespace"));
});

Deno.test("deregister: waits for the token to go live, then maps the answer", async () => {
	const answers = [
		json(404, {}),
		json(200, { clientId: "c1", deregistered: true }),
	];
	const fetcher =
		(() => Promise.resolve(answers.shift()!)) as unknown as typeof fetch;
	const clock = fakeClock();
	eq(
		await deregister({
			fetch: fetcher,
			origin: "https://x",
			token: "t",
			timeoutMs: 60_000,
			...clock,
		}),
		{ kind: "deregistered", clientId: "c1" },
	);
	const none = (() =>
		Promise.resolve(
			json(200, {
				clientId: "",
				deregistered: false,
				reason: "no IdP is configured",
			}),
		)) as unknown as typeof fetch;
	eq(
		(await deregister({
			fetch: none,
			origin: "https://x",
			token: "t",
			timeoutMs: 1,
			...fakeClock(),
		})).kind,
		"none",
	);
	const refused = (() =>
		Promise.resolve(
			json(200, {
				clientId: "c9",
				deregistered: false,
				reason: "IdP answered 401",
			}),
		)) as unknown as typeof fetch;
	eq(
		await deregister({
			fetch: refused,
			origin: "https://x",
			token: "t",
			timeoutMs: 1,
			...fakeClock(),
		}),
		{ kind: "failed", clientId: "c9", reason: "IdP answered 401" },
	);
	const never =
		(() => Promise.resolve(json(404, {}))) as unknown as typeof fetch;
	const timedOut = await deregister({
		fetch: never,
		origin: "https://x",
		token: "t",
		timeoutMs: 10_000,
		...fakeClock(),
	});
	assert(timedOut.kind === "failed" && timedOut.reason.includes("404"));
});

Deno.test("destroy removes exactly the stage's resources, DCR client first", async () => {
	const c = cloud("dev-wp21", { objects: ["logs/a", "logs/b", "ext/c"] });
	const h = harness("dev-wp21", c);
	const report = await runDestroy(options("dev-wp21"), h.deps);
	eq(report.failed, []);
	eq(report.dcr, { kind: "deregistered", clientId: "client-123" });
	const deletes = h.requests.filter((r) => r.startsWith("DELETE"));
	const firstDelete = h.requests.findIndex((r) => r.startsWith("DELETE"));
	const deregisterAt = h.requests.findIndex((r) =>
		r.includes("/-/admin/idp/deregister")
	);
	assert(
		deregisterAt >= 0 && deregisterAt < firstDelete,
		"deregister runs before any delete",
	);
	for (const d of deletes) {
		assert(/tartan-dev-wp21|app1|kv1/.test(d), `unexpected delete ${d}`);
		assert(
			!d.includes("-x-") && !d.includes("app2") && !d.includes("kv2"),
			`touched another stage: ${d}`,
		);
	}
	assert(deletes.includes("DELETE /workers/scripts/tartan-dev-wp21"));
	eq(c.apps.map((a) => a.id), ["app2"]);
	eq(c.kv.map((k) => k.id), ["kv2"]);
	eq(c.images, [{ name: "tartan-dev-wp21-tartansandbox", tags: [] }, {
		name: "other",
		tags: ["cc"],
	}]);
	eq([c.worker, c.workflows.size, c.bucket, c.objects, c.repos], [
		false,
		0,
		false,
		[],
		[],
	]);
	const put = h.calls.find((x) =>
		x.line.startsWith("npx wrangler secret put TARTAN_DESTROY_TOKEN")
	)!;
	assert.match(put.stdin!, /^[A-Za-z0-9_-]{43}$/);
	assert(!h.logs.some((l) => l.includes(put.stdin!)));
	assert(isEmptyInventory(report.left));
	eq(report.left.namespace, true);
	assert(h.logs.some((l) => l.includes("curl -X DELETE")));
	assert(
		h.removedFiles.includes("/repo/.wrangler/deploy/wrangler.dev-wp21.jsonc"),
	);
	const record = JSON.parse(
		h.files.get("/repo/.wrangler/deploy/record.dev-wp21.json")!,
	);
	eq(record.dcr, { kind: "deregistered", clientId: "client-123" });
	assert(record.destroyedAt);
});

Deno.test("--delete-namespace sends the namespace DELETE once the repos are gone", async () => {
	const c = cloud("dev-wp21");
	const h = harness("dev-wp21", c);
	const report = await runDestroy(
		options("dev-wp21", { deleteNamespace: true }),
		h.deps,
	);
	eq(report.left.namespace, false);
	eq(c.namespaces, ["tartan-dev-wp21-x"]);
});

Deno.test("--keep-repos keeps the git data", async () => {
	const c = cloud("dev-wp21");
	const h = harness("dev-wp21", c);
	const report = await runDestroy(
		options("dev-wp21", { keepRepos: true }),
		h.deps,
	);
	eq(c.repos, ["r-01abc", "l-01abc-01def"]);
	assert(!h.calls.some((x) => x.line.includes("artifacts repos delete")));
	assert(!isEmptyInventory(report.left));
});

Deno.test("a Worker that reports another stage is refused before anything is removed", async () => {
	const c = cloud("dev-wp21", { healthStage: "dev" });
	const h = harness("dev-wp21", c);
	await assert.rejects(
		() => runDestroy(options("dev-wp21"), h.deps),
		(e) => e instanceof DestroyError && e.message.includes("refusing"),
	);
	assert(
		!h.requests.some((r) => r.startsWith("DELETE") || r.startsWith("POST")),
	);
	assert(!h.calls.some((x) => x.line.includes("secret put")));
});

Deno.test("confirmation: no terminal and no --yes refuses; a wrong answer removes nothing", async () => {
	const h = harness("dev-wp21", cloud("dev-wp21"));
	await assert.rejects(
		() => runDestroy(options("dev-wp21", { yes: false }), h.deps),
		(e) => e instanceof DestroyError && e.message.includes("--yes"),
	);
	const wrong = harness("dev-wp21", cloud("dev-wp21"), {
		interactive: true,
		answer: "dev",
	});
	await assert.rejects(
		() => runDestroy(options("dev-wp21", { yes: false }), wrong.deps),
		(e) => e instanceof DestroyError && e.message.includes("not confirmed"),
	);
	assert(!wrong.requests.some((r) => r.startsWith("DELETE")));
	const right = harness("dev-wp21", cloud("dev-wp21"), {
		interactive: true,
		answer: "dev-wp21",
	});
	const report = await runDestroy(
		options("dev-wp21", { yes: false }),
		right.deps,
	);
	eq(report.failed, []);
});

Deno.test("a failed deregistration names the client to remove by hand", async () => {
	const c = cloud("dev-wp21", {
		dcr: {
			clientId: "client-9",
			deregistered: false,
			reason: "IdP answered 500",
		},
	});
	const h = harness("dev-wp21", c);
	const report = await runDestroy(options("dev-wp21"), h.deps);
	eq(report.dcr?.kind, "failed");
	assert(
		h.logs.some((l) =>
			l.includes("Remove client client-9 at your IdP by hand")
		),
	);
	eq(c.worker, false);
});

Deno.test("an already destroyed stage is a no-op", async () => {
	const c = cloud("dev-wp21", {
		worker: false,
		workflows: new Set(),
		apps: [],
		images: [],
		bucket: false,
		kv: [],
		repos: [],
		namespaces: [],
	});
	const h = harness("dev-wp21", c);
	const report = await runDestroy(options("dev-wp21", { yes: false }), h.deps);
	eq([report.removed, report.failed, report.dcr], [[], [], null]);
	assert(h.logs.some((l) => l.includes("Nothing of this stage")));
});
