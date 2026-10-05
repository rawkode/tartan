/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The capability route and lane remotes in workerd (vitest project `gateway`):
// the stream machinery the Deno suites cannot vouch for — the pull-based relay
// and its cancel path, WebCrypto HMAC, gzip request decoding — with
// FakeArtifacts' importer pulling through the route inside the isolate (the
// trailing-flush transform's workerd test is gitproto's).

import { importerRequestBody } from "@tartan/testkit";
import { describe, expect, it } from "vitest";
import {
	capLaneName,
	capPost,
	capWorld,
	importLane,
	LANE_MAIN,
} from "./testing/capworld.ts";

describe("capability route in workerd", () => {
	it("FakeArtifacts' import() seeds a lane repo through the route from a master repo", async () => {
		const world = await capWorld({ defaultBranch: "master" });
		const { lane, url } = await world.lane();
		await importLane(world, url, lane);
		await world.settle();
		expect(world.fake.inspect.refs(capLaneName(world, lane))).toEqual({
			[LANE_MAIN]: world.trunk,
		});
		expect(world.tokenOps()).toEqual({ create: 2, revoke: 2 });
		const served = world.state.reports.find((r) =>
			r.report.outcome === "served"
		);
		expect(served?.report.bytes ?? 0).toBeGreaterThan(100);
	});

	it("a cancelled pack response revokes the read token and reports aborted", async () => {
		const world = await capWorld();
		const { url } = await world.lane();
		const res = await capPost(world, url, importerRequestBody(world.trunk));
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		await reader.cancel("client went away");
		await world.settle();
		expect(world.tokenOps()).toEqual({ create: 1, revoke: 1 });
		expect(world.state.reports.at(-1)?.report.outcome).toBe("aborted");
	});

	it("decodes a gzip request and serves the pack", async () => {
		const world = await capWorld();
		const { url } = await world.lane();
		const body = importerRequestBody(world.trunk);
		const gzipped = await new Response(
			new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer();
		const res = await capPost(world, url, gzipped, {
			"content-encoding": "gzip",
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("0008NAK\n");
		expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("PACK");
	});

	it("forged URLs never reach the capability state; the failure buckets throttle", async () => {
		const world = await capWorld();
		const { url } = await world.lane();
		const forged = url.replace(
			/\/([0-9a-f]{64})\//,
			(_m, mac: string) => `/${mac[0] === "a" ? "b" : "a"}${mac.slice(1)}/`,
		);
		const statuses: number[] = [];
		for (let i = 0; i < 25; i++) {
			const res = await world.route(
				new Request(`${forged}/info/refs?service=git-upload-pack`, {
					headers: { "cf-connecting-ip": "192.0.2.1" },
				}),
			);
			statuses.push(res.status);
		}
		expect(statuses.filter((s) => s === 404)).toHaveLength(20);
		expect(statuses.filter((s) => s === 429)).toHaveLength(5);
		expect(world.state.repoPorts).toBe(0);
	});
});
