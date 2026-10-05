// The WP25 dev route's pieces that run without a Worker: the dev key is an
// HMAC of the root secret under its own label, the seeded commit holds the
// tree the in-memory git fixture writes (same object ids), and the route is
// a plain 404 without dev tools or the key.

import { equal, notEqual } from "node:assert/strict";
import { createMemGit } from "../../../packages/monorepo/test/memgit.ts";
import { CUENV_DEMO_FILES } from "../../../packages/monorepo/test/fixtures/cuenv-demo.ts";
import { devLandKey } from "../land/dev.ts";
import type { RouteContext } from "../../router.ts";
import { commitOf, devProjectsKey, handleDevProjects } from "./dev.ts";

Deno.test("dev key: an HMAC of the secret under the projects label", async () => {
	const key = await devProjectsKey("s3cret");
	equal(key.length, 64);
	equal(await devProjectsKey("s3cret"), key);
	notEqual(await devProjectsKey("other"), key);
	notEqual(await devLandKey("s3cret"), key, "not the land route's key");
});

Deno.test("seed: the commit's root tree is the tree the in-memory fixture writes", async () => {
	const mem = createMemGit();
	const { pack, head, tree } = await commitOf(CUENV_DEMO_FILES, "fixture");
	equal(tree, mem.writeTree(CUENV_DEMO_FILES));
	equal(head.length, 40);
	equal(new TextDecoder("latin1").decode(pack.subarray(0, 4)), "PACK");
});

Deno.test("route: a plain 404 without dev tools or without the key", async () => {
	const call = async (env: Record<string, string>, key?: string) =>
		(await handleDevProjects({
			req: new Request(
				"https://x.test/-/dev/projects/01k6aaaaaaaaaaaaaaaaaaaaaa/graph",
				{
					headers: key ? { "x-tartan-dev-key": key } : {},
				},
			),
			env,
			params: { rest: "01k6aaaaaaaaaaaaaaaaaaaaaa/graph" },
			url: new URL(
				"https://x.test/-/dev/projects/01k6aaaaaaaaaaaaaaaaaaaaaa/graph",
			),
		} as unknown as RouteContext)).status;
	const key = await devProjectsKey("s3cret");
	const dev = {
		TARTAN_STAGE: "dev-wp25",
		TARTAN_DEV_TOOLS: "1",
		TARTAN_SECRET: "s3cret",
	};
	equal(await call(dev), 404);
	equal(await call(dev, "0".repeat(64)), 404);
	equal(await call({ ...dev, TARTAN_DEV_TOOLS: "0" }, key), 404);
	equal(await call({ ...dev, TARTAN_STAGE: "prod" }, key), 404);
	// With the key the route answers (here: the sha is missing).
	equal(await call(dev, key), 400);
});
