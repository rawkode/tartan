// The pool's ARTIFACTS binding as the product sees it, once vitest.config.ts
// bundles `test/fakes/bindings.worker.ts`: git content over
// RPC with the live limits. Skipped while the pool still wires the older
// content-free fake.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type TestArtifacts = Artifacts & {
	seed(
		name: string,
		options?: { files?: Record<string, string> },
	): Promise<{ name: string; head: string | null; token: string }>;
	refs(name: string): Promise<Record<string, string>>;
	remote(name: string): Promise<string>;
};

const artifacts = (env as unknown as { ARTIFACTS: TestArtifacts }).ARTIFACTS;
const wired = typeof (artifacts as { seed?: unknown }).seed === "function" &&
	(await artifacts.seed(`probe-${crypto.randomUUID()}`).then(
		() => true,
		() => false,
	));

describe.skipIf(!wired)("ARTIFACTS binding (git-content fake)", () => {
	it("serves reads by SHA and short branch name over RPC", async () => {
		const name = `r-${crypto.randomUUID()}`;
		const { head } = await artifacts.seed(name, {
			files: { "README.md": "# rpc\n" },
		});
		using repo = await artifacts.get(name.toUpperCase());
		expect((await repo.info()).lastPushAt).toBeNull();
		expect((await repo.log({ ref: "main" }))[0].hash).toBe(head);
		expect(await repo.log({ ref: "refs/heads/main" })).toEqual([]);
		const blob = await repo.readFile({ ref: head!, path: "README.md" });
		expect(await blob?.text()).toBe("# rpc\n");
		expect(await repo.readBlob(head!)).toBeNull();
		// Settle the RPC promise with `then` (vitest's `rejects` probes the
		// value's properties, which pipelines extra calls on an RpcPromise).
		const dup = await artifacts.create(name.toUpperCase()).then(
			() => null,
			(e: Error & { code?: string }) => e,
		);
		expect(dup?.name).toBe("ArtifactsError");
		expect(dup?.message).toMatch(/already exists/);
		const t = await repo.createToken("read", 60);
		expect(t.plaintext).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);
		expect(await repo.revokeToken(t.id)).toBe(true);
	});
});
