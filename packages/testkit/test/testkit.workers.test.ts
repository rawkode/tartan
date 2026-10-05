// The testkit inside workerd (nodejs_compat `node:zlib` and `node:crypto`):
// codecs, FakeArtifacts end to end, captures, FakeKernelCaps and the
// conformance suite, as WP3/WP5/WP8 workerd tests will use them.

import { describe, expect, it } from "vitest";
import {
	commitChanges,
	createFakeArtifacts,
	createFakeKernelCaps,
	createObjectStore,
	hashObject,
	push,
	readPack,
	runConformance,
	scenario,
	seedScenario,
	STOCK_GIT_CAPTURES,
	utf8,
	writeCommit,
	writePack,
	writeTree,
} from "@tartan/testkit";

describe("testkit in workerd", () => {
	it("runs in workerd and hashes like stock git", () => {
		expect(navigator.userAgent).toBe("Cloudflare-Workers");
		expect(hashObject({ type: "blob", data: new Uint8Array(0) })).toBe(
			"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
		);
	});

	it("round-trips a pack with trailing bytes after it", () => {
		const store = createObjectStore();
		const tree = writeTree(store, { "a.txt": "a\n", "dir/b.txt": "b\n" });
		const commit = writeCommit(store, tree, { message: "c" });
		const objects = store.oids().map((oid) => store.get(oid)!);
		const pack = writePack(objects);
		const parsed = readPack(new Uint8Array([...pack, ...utf8("0000")]));
		expect(parsed.objects.has(commit)).toBe(true);
		expect(parsed.end).toBe(pack.length);
	});

	it("FakeArtifacts: seed, push over smart HTTP, read by SHA only", async () => {
		const fake = createFakeArtifacts();
		const s = await seedScenario(fake, "r-w", scenario("disjoint-projects"));
		const store = fake.inspect.store("r-w");
		const next = commitChanges(store, s.base, { "NOTES.md": "n\n" }, {
			message: "notes",
		});
		const report = await push(
			fake.fetch,
			fake.remote("r-w"),
			[{ ref: "refs/heads/main", old: s.base, new: next }],
			[store.get(next)!],
			{ auth: { bearer: s.token } },
		);
		expect(report.refs.get("refs/heads/main")).toBe("ok");
		const repo = await fake.get("r-w");
		expect((await repo.log({ ref: "main", limit: 1 }))[0].hash).toBe(next);
		expect(await repo.log({ ref: "refs/heads/main" })).toEqual([]);
		expect(fake.pushEvents.at(-1)?.payload.ref).toBe("refs/heads/main");
	});

	it("the conformance suite passes on the fake", async () => {
		const fake = createFakeArtifacts();
		const results = await runConformance({
			artifacts: fake,
			fetch: fake.fetch,
			prefix: "w",
		});
		expect(results.filter((r) => !r.pass)).toEqual([]);
	});

	it("loads the captures and enforces caps", async () => {
		expect(STOCK_GIT_CAPTURES.length).toBeGreaterThan(0);
		const caps = createFakeKernelCaps({ props: { readOnly: true } });
		await expect(caps.events.emit("x.y", {})).rejects.toThrow(/read-only/);
	});
});
