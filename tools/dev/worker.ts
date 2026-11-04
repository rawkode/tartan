// The local dev environment's companion Worker (`tartan-dev`), run next to the
// real Tartan Worker by `deno task dev` (tools/dev/main.ts). Never deployed.
//
// - Front door (default `fetch`): every browser and git request goes through
//   here to the Tartan Worker. A redirect to the mock IdP's authorization
//   endpoint is answered on the spot (the dev user signs in at once), because
//   a browser cannot reach an `https://…:443` IdP on a loopback port, and the
//   kernel accepts nothing else (src/kernel/identity/ssrf.ts). Behind a
//   tunnel that sign-in also needs the dev key cookie (`hasKey`).
// - `Outbound`: the Tartan Worker's outbound service. The mock IdP's origin
//   and the fake Artifacts remotes are answered here; anything else goes to
//   the internet.
// - `FakeArtifacts`, `FakeAi`: the bindings miniflare cannot run locally,
//   from `@tartan/testkit` as in the workerd tests (test/fakes). Each push
//   to a fake repo starts the IngestWorkflow, as the
//   `cf.artifacts.repo.pushed` trigger does on a deployed stage.
//
// All state here is in memory: the launcher keeps nothing between runs, so
// the Durable Objects and the fake repos always agree.

import { env, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createFakeArtifacts } from "@tartan/testkit";
import { createMockIdp } from "../../src/kernel/identity/testing/mock-idp.ts";

type DevEnv = {
	readonly TARTAN: Fetcher;
	readonly INGEST: Workflow;
	readonly ARTIFACTS_NAMESPACE: string;
	readonly DEV_IDP_ISSUER: string;
	/** Set behind a tunnel: the automatic sign-in needs it; "" locally. */
	readonly DEV_KEY: string;
};

const devEnv = env as unknown as DevEnv;

/** The one user the mock IdP signs in. */
export const DEV_USER = {
	sub: "dev-user",
	preferred_username: "dev",
	name: "Dev User",
	email: "dev@tartan-dev.test",
	email_verified: true,
} as const;

const fake = createFakeArtifacts({
	namespace: devEnv.ARTIFACTS_NAMESPACE,
	host: "local.artifacts.tartan-dev.test",
});

// Ingest starts are collected here and awaited by the request that pushed.
const pendingIngest: Promise<unknown>[] = [];
fake.onPush((event) => {
	const what = `${event.source.repoName} ${event.payload.ref}`;
	pendingIngest.push(
		devEnv.INGEST.create({ id: event.id, params: event }).then(
			() => console.log(`[tartan-dev] ingest started: ${what}`),
			(err) =>
				console.error(`[tartan-dev] ingest start failed: ${what}: ${err}`),
		),
	);
});
const drainIngest = () => Promise.allSettled(pendingIngest.splice(0));

let idp: ReturnType<typeof createMockIdp> | undefined;
const mockIdp = () =>
	idp ??= createMockIdp({ issuer: devEnv.DEV_IDP_ISSUER, issParameter: true });

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
}

export class FakeAi extends WorkerEntrypoint {
	run(_model: string, _inputs: unknown) {
		return { response: "" };
	}
}

export class Outbound extends WorkerEntrypoint {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.origin === devEnv.DEV_IDP_ISSUER) {
			return (await mockIdp()).fetch(request);
		}
		if (url.host === fake.host) {
			const response = await fake.fetch(request);
			this.ctx.waitUntil(drainIngest());
			return response;
		}
		return fetch(request);
	}
}

const isRedirect = (status: number) => status >= 301 && status <= 308;

// Behind a tunnel (DEV_KEY set) the automatic sign-in is the one thing a
// stranger could use: everything else needs a session, a token or the setup
// code printed in the local terminal. So it needs this cookie, which the
// sign-in link printed by the launcher sets.
const SIGN_IN_PATH = "/-/tartan-dev/sign-in";
const KEY_COOKIE = "__Host-tartan-dev-key";

const sameKey = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

const cookieKey = (request: Request): string | null => {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === KEY_COOKIE) return value.join("=");
	}
	return null;
};

const hasKey = (request: Request): boolean => {
	const key = cookieKey(request);
	return devEnv.DEV_KEY === "" ||
		(key !== null && sameKey(key, devEnv.DEV_KEY));
};

/** `GET /-/tartan-dev/sign-in?key=…`: sets the key cookie, then signs in. */
const signIn = (url: URL): Response => {
	const key = url.searchParams.get("key") ?? "";
	if (devEnv.DEV_KEY === "" || !sameKey(key, devEnv.DEV_KEY)) {
		return new Response("tartan-dev: wrong or missing key\n", { status: 403 });
	}
	return new Response(null, {
		status: 303,
		headers: {
			location: "/-/auth/login?return_to=/",
			"set-cookie":
				`${KEY_COOKIE}=${key}; Path=/; Secure; HttpOnly; SameSite=Lax`,
			"referrer-policy": "no-referrer",
		},
	});
};

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === SIGN_IN_PATH) return signIn(url);
		const response = await devEnv.TARTAN.fetch(request);
		const location = response.headers.get("location");
		if (
			!isRedirect(response.status) || location === null ||
			!location.startsWith(`${devEnv.DEV_IDP_ISSUER}/authorize`)
		) {
			return response;
		}
		if (!hasKey(request)) {
			return new Response(
				"tartan-dev: sign in with the link `deno task dev` printed\n",
				{ status: 403 },
			);
		}
		const callback = (await mockIdp()).authorize(location, DEV_USER);
		const headers = new Headers(response.headers);
		headers.set("location", callback.href);
		return new Response(null, { status: 302, headers });
	},
} satisfies ExportedHandler;
