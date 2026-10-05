// Auxiliary worker for the vitest pool with git-content fakes:
// the bindings miniflare cannot run locally, as RPC entrypoints behind
// service bindings, built from `@tartan/testkit` so workerd tests get the
// same FakeArtifacts as Deno tests (real git objects, reads by SHA or short
// branch name only, case-folded names, per-repo tokens).
//
// - FakeArtifacts: the Artifacts namespace. One in-memory namespace per pool
//   run, shared by every test (use unique repo names). `get()` returns an
//   RpcTarget repo handle like the real binding's stub. Test-only helpers
//   (`seed`, `commit`, `setRef`, `refs`, `pushEvents`, `reset`) are extra
//   RPC methods; product code never calls them.
// - default `fetch`: the repos' smart-HTTP remotes (`info.remote`), so the
//   gateway and the capability route can be driven end to end when the main
//   worker's outbound fetches are routed here.
// - FakeAi: Workers AI; `run()` returns an empty response.
// - FakeAssets: serves a marker SPA shell so router tests see the fallthrough.
//
// vitest.config.ts (integrator-only) bundles this file with esbuild, because
// miniflare loads auxiliary workers without a build step. Never used by the
// deployed Worker.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
	createFakeArtifacts,
	type FakePushEvent,
	type FileChanges,
	type FileMap,
} from "@tartan/testkit";

/**
 * A credential-free mirror of every fake repo for `import()` sources in
 * tests (`https://public.artifacts.fake.test/git/tartan-test/<name>.git`):
 * it reads with a short-lived read token and forwards the answer unchanged.
 * Tests that exercise the real capability route import from it instead.
 */
const PUBLIC_MIRROR_HOST = "public.artifacts.fake.test";

const publicMirror = async (request: Request): Promise<Response> => {
	const url = new URL(request.url);
	const m = /^\/git\/[^/]+\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(
		url.pathname,
	);
	if (url.host !== PUBLIC_MIRROR_HOST || !m) {
		return new Response("not found\n", { status: 404 });
	}
	const repo = await fake.get(m[1]).catch(() => null);
	if (!repo) return new Response("not found\n", { status: 404 });
	const token = await repo.createToken("read", 60);
	const requestBody = request.method === "POST"
		? new Uint8Array(await request.arrayBuffer())
		: null;
	const gitProtocol = request.headers.get("git-protocol");
	const upstream = await fake.fetch(
		new Request(`${fake.remote(m[1])}/${m[2]}${url.search}`, {
			method: request.method,
			headers: {
				authorization: `Bearer ${token.plaintext}`,
				"content-type": request.headers.get("content-type") ?? "",
				...(gitProtocol ? { "git-protocol": gitProtocol } : {}),
			},
			body: requestBody,
		}),
	);
	await repo.revokeToken(token.id);
	return new Response(await upstream.arrayBuffer(), {
		status: upstream.status,
		headers: upstream.headers,
	});
};

const fake = createFakeArtifacts({
	namespace: "tartan-test",
	host: "fake-account.artifacts.fake.test",
	fetch: publicMirror,
});

/** One repo handle over RPC (prototype methods only: workerd RPC rule). */
class FakeArtifactsRepoStub extends RpcTarget {
	#repo: ArtifactsRepo;

	constructor(repo: ArtifactsRepo) {
		super();
		this.#repo = repo;
	}

	info() {
		return this.#repo.info();
	}
	createToken(scope?: "write" | "read", ttl?: number) {
		return this.#repo.createToken(scope, ttl);
	}
	listTokens() {
		return this.#repo.listTokens();
	}
	revokeToken(tokenOrId: string) {
		return this.#repo.revokeToken(tokenOrId);
	}
	readBlob(hash: string) {
		return this.#repo.readBlob(hash);
	}
	readTree(hash: string) {
		return this.#repo.readTree(hash);
	}
	readCommit(hash: string) {
		return this.#repo.readCommit(hash);
	}
	readFile(args: { ref: string; path: string }) {
		return this.#repo.readFile(args);
	}
	log(opts?: { ref?: string; limit?: number; offset?: number }) {
		return this.#repo.log(opts);
	}
}

export class FakeArtifacts extends WorkerEntrypoint {
	create(
		name: string,
		opts?: {
			readOnly?: boolean;
			description?: string;
			setDefaultBranch?: string;
		},
	) {
		return fake.create(name, opts);
	}

	async get(name: string) {
		return new FakeArtifactsRepoStub(await fake.get(name));
	}

	import(params: Parameters<typeof fake.import>[0]) {
		return fake.import(params);
	}

	list(opts?: { limit?: number; cursor?: string }) {
		return fake.list(opts);
	}

	delete(name: string) {
		return fake.delete(name);
	}

	// Test-only helpers (never called by product code).
	seed(
		name: string,
		options?: { files?: FileMap; defaultBranch?: string; alsoRefs?: string[] },
	) {
		return fake.seed(name, options);
	}

	commit(name: string, ref: string, changes: FileChanges, message: string) {
		return fake.commit(name, ref, changes, { message });
	}

	setRef(name: string, ref: string, oid: string | null) {
		fake.setRef(name, ref, oid);
	}

	refs(name: string): Record<string, string> {
		return fake.inspect.refs(name);
	}

	pushEvents(): FakePushEvent[] {
		return [...fake.pushEvents];
	}

	remote(name: string): string {
		return fake.remote(name);
	}

	reset() {
		fake.reset();
	}
}

export class FakeAi extends WorkerEntrypoint {
	run(_model: string, _inputs: unknown) {
		return { response: "" };
	}
}

// Marker header on every FakeAssets response (a worker module may only export handlers).
const FAKE_ASSETS_HEADER = "x-tartan-fake-assets";

export class FakeAssets extends WorkerEntrypoint {
	override fetch(request: Request) {
		const { pathname } = new URL(request.url);
		return new Response(
			`<!doctype html><title>Tartan</title><div id="app" data-path="${
				encodeURIComponent(pathname)
			}"></div>`,
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					[FAKE_ASSETS_HEADER]: "1",
				},
			},
		);
	}
}

export default {
	/** The fake repos' smart-HTTP remotes; anything else is a 404. */
	fetch: (request: Request) => {
		const host = new URL(request.url).host;
		return host === fake.host
			? fake.fetch(request)
			: host === PUBLIC_MIRROR_HOST
			? publicMirror(request)
			: new Response("tartan vitest fakes: no such host", { status: 404 });
	},
};
