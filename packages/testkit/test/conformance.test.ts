// The conformance suite passes on FakeArtifacts and fails on fakes that
// resolve full refnames or ignore per-repo token scoping. A run against a
// deployed binding goes through the smoke Worker.

import { deepStrictEqual, equal } from "node:assert/strict";
import {
	CONFORMANCE_IDS,
	createFakeArtifacts,
	type FakeArtifacts,
	runConformance,
} from "../src/index.ts";

const failing = (results: Awaited<ReturnType<typeof runConformance>>) =>
	results.filter((r) => !r.pass).map((r) => r.id);

Deno.test("conformance passes on FakeArtifacts (with an import source)", async () => {
	const canonical = createFakeArtifacts({
		namespace: "canonical",
		host: "canonical.artifacts.fake.test",
	});
	const src = await canonical.seed("src", { files: { "a.txt": "a\n" } });
	// A public, credential-free route to the source (the capability route's role).
	const publicRoute = async (request: Request) => {
		const url = new URL(request.url);
		const op = url.pathname.endsWith("/info/refs")
			? "info/refs"
			: "git-upload-pack";
		const res = await canonical.fetch(
			new Request(`${canonical.remote("src")}/${op}${url.search}`, {
				method: request.method,
				headers: { authorization: `Bearer ${src.token}` },
				body: request.method === "POST" ? await request.arrayBuffer() : null,
			}),
		);
		return new Response(await res.arrayBuffer());
	};
	const fake = createFakeArtifacts({ fetch: publicRoute });
	const results = await runConformance({
		artifacts: fake,
		fetch: fake.fetch,
		prefix: "conf",
		importSource: {
			url: "https://forge.example/-/cap/v1/demo/src.git",
			branch: "main",
			head: src.head!,
		},
	});
	deepStrictEqual(failing(results), [], JSON.stringify(results, null, 2));
	deepStrictEqual(results.map((r) => r.id), CONFORMANCE_IDS);
	equal(fake.inspect.names().length, 0, "the suite deletes its repos");
});

/** A fake whose reads resolve full refnames and HEAD (what K15 forbids). */
const refnameResolving = (inner: FakeArtifacts): Artifacts => ({
	...inner,
	get: async (name: string) => {
		const repo = await inner.get(name);
		const fix = (ref?: string) =>
			ref === "HEAD" ? "main" : ref?.replace(/^(refs\/)?heads\//, "");
		return {
			...repo,
			log: (o?: { ref?: string; limit?: number; offset?: number }) =>
				repo.log({ ...o, ref: fix(o?.ref) }),
			readFile: (a: { ref: string; path: string }) =>
				repo.readFile({ ...a, ref: fix(a.ref)! }),
		} as ArtifactsRepo;
	},
});

Deno.test("conformance fails when a fake read resolves a full refname", async () => {
	const fake = createFakeArtifacts();
	const results = await runConformance({
		artifacts: refnameResolving(fake),
		fetch: fake.fetch,
		prefix: "conf",
	});
	deepStrictEqual(failing(results), ["C3"]);
});

Deno.test("conformance fails when a token for one repo writes another", async () => {
	const fake = createFakeArtifacts();
	// A server that ignores which repo a token was minted for.
	const unscoped = async (request: Request) => {
		const name = /\/([^/]+)\.git\//.exec(new URL(request.url).pathname)?.[1];
		const own = fake.inspect.issuedTokens().find((t) =>
			t.repo === name && t.origin === "create"
		);
		const headers = new Headers(request.headers);
		if (own && headers.has("authorization")) {
			headers.set("authorization", `Bearer ${own.plaintext}`);
		}
		return await fake.fetch(
			new Request(request.url, {
				method: request.method,
				headers,
				body: request.method === "POST" ? await request.arrayBuffer() : null,
			}),
		);
	};
	const results = await runConformance({
		artifacts: fake,
		fetch: unscoped,
		prefix: "conf",
	});
	deepStrictEqual(failing(results), ["C5"]);
});
