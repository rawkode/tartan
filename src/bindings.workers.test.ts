/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The pool's Artifacts fake (test/fakes/bindings.worker.ts) covers the calls
// the lane backends make: lane repos are created with `import()` (the source
// branch `main`), and listed and deleted by lane GC; canonical repos are
// created with `create()`.

import { laneArtifactsName, repoArtifactsName, ulid } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../test/env.ts";

type SeedingArtifacts = Artifacts & {
	seed(
		name: string,
		options?: { files?: Record<string, string>; alsoRefs?: string[] },
	): Promise<{ head: string | null }>;
};
const artifacts = env.ARTIFACTS as unknown as SeedingArtifacts;
const mirror = (name: string) =>
	`https://public.artifacts.fake.test/git/tartan-test/${name}.git`;

describe("FakeArtifacts", () => {
	it("import() keeps the source branch, so a lane repo imported from `main` has `main`", async () => {
		const repoUlid = ulid();
		const source = repoArtifactsName(repoUlid);
		const { head } = await artifacts.seed(source, {
			files: { "README.md": "# source\n" },
			alsoRefs: ["refs/heads/feat-a"],
		});
		const name = laneArtifactsName(repoUlid, ulid());
		const imported = await env.ARTIFACTS.import({
			source: { url: mirror(source), branch: "main" },
			target: { name },
		});
		expect(imported.defaultBranch).toBe("main");
		using lane = await env.ARTIFACTS.get(name);
		expect((await lane.log({ ref: "main", limit: 1 }))[0].hash).toBe(head);
		const other = laneArtifactsName(repoUlid, ulid());
		const feature = await env.ARTIFACTS.import({
			source: { url: mirror(source), branch: "feat-a" },
			target: { name: other },
		});
		expect(feature.defaultBranch).toBe("feat-a");
		expect(await env.ARTIFACTS.delete(name)).toBe(true);
		expect(await env.ARTIFACTS.delete(other)).toBe(true);
		expect(await env.ARTIFACTS.delete(source)).toBe(true);
	});

	it("create() and get() serve the token calls the capability route makes", async () => {
		const name = repoArtifactsName(ulid());
		await env.ARTIFACTS.create(name);
		const repo = await env.ARTIFACTS.get(name);
		const token = await repo.createToken("read", 120);
		expect(token.scope).toBe("read");
		expect(await repo.revokeToken(token.id)).toBe(true);
		// A revoked token is not listed.
		const { tokens } = await repo.listTokens();
		expect(tokens.find((t) => t.id === token.id)).toBeUndefined();
		expect(await env.ARTIFACTS.delete(name)).toBe(true);
	});
});
