/// <reference types="@cloudflare/vitest-pool-workers/types" />
// gitproto inside workerd (vitest-pool-workers, compat 2026-08-15): the
// platform pieces the Deno suite cannot prove, i.e. Request body streams,
// workerd's DecompressionStream/CompressionStream (gzip cap, malformed
// input), WebCrypto SHA-1, the relay as a workerd TransformStream, and the
// clients' fetch calls. Scope: the vitest pool's workerd, not the edge.

import { describe, expect, it } from "vitest";
import {
	createReceivePackRelay,
	demuxSideband,
	encodeCommit,
	encodeTree,
	hashObject,
	lsRefs,
	MAX_COMMANDS,
	parseCapRequest,
	parseUploadRequest,
	peekCommands,
	PUBLIC_VIEW_PROFILE,
	pushRefs,
	RECEIVE_PACK_CAPABILITIES,
	RECEIVE_SECTION_MAX_BYTES,
	RELAY_HOLD_BACK_MAX_BYTES,
	stripV0Trailer,
	synthCapAdvertisement,
	synthReportStatus,
	UPLOAD_DECODE_MAX_BYTES,
	writePack,
} from "@tartan/gitproto";
import { dec, enc, golden, gzip, join, pkt, readAll } from "./helpers.ts";

const requestBody = (
	bytes: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array> =>
	new Request("https://git.example.com/acme/shop.git/git-receive-pack", {
		method: "POST",
		body: bytes,
	}).body!;

describe("gitproto in workerd", () => {
	it("peeks a recorded push from a Request body and replays it byte for byte", async () => {
		const g = golden("receive-pack-create");
		const result = await peekCommands(requestBody(g.body), {
			maxCommands: MAX_COMMANDS.user,
			maxSectionBytes: RECEIVE_SECTION_MAX_BYTES,
			capabilities: RECEIVE_PACK_CAPABILITIES,
		});
		expect(result.kind).toBe("commands");
		if (result.kind !== "commands") return;
		expect(result.commands[0].ref).toBe("refs/heads/main");
		expect(await readAll(result.body)).toEqual(g.body);
		const shallow = await peekCommands(
			requestBody(golden("receive-pack-from-shallow").body),
			{
				maxCommands: MAX_COMMANDS.agent,
				maxSectionBytes: RECEIVE_SECTION_MAX_BYTES,
				capabilities: RECEIVE_PACK_CAPABILITIES,
			},
		);
		expect(shallow.kind).toBe("rejected");
	});

	it("decodes git's gzip fetch with workerd's DecompressionStream and caps a bomb", async () => {
		const g = golden("upload-pack-v2-fetch-gzip");
		const ok = await parseUploadRequest(requestBody(g.body), {
			encoding: "gzip",
			gitProtocol: "version=2",
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		});
		expect(ok.kind).toBe("request");
		const bomb = await gzip(new Uint8Array(32 * 1024 * 1024));
		const capped = await parseUploadRequest(requestBody(bomb), {
			encoding: "gzip",
			gitProtocol: "version=2",
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		});
		expect(capped).toMatchObject({
			kind: "rejected",
			reason: "upload-encoding",
			code: "too-large",
		});
		const garbage = await parseUploadRequest(
			requestBody(enc("not gzip at all")),
			{
				encoding: "gzip",
				gitProtocol: "version=2",
				maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
				profile: PUBLIC_VIEW_PROFILE,
			},
		);
		expect(garbage).toMatchObject({
			kind: "rejected",
			reason: "upload-encoding",
		});
		const zipped = await gzip(join(pkt("command=ls-refs\n"), "0000"));
		const trailing = await parseUploadRequest(
			requestBody(join(zipped, "junk")),
			{
				encoding: "gzip",
				gitProtocol: "version=2",
				maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
				profile: PUBLIC_VIEW_PROFILE,
			},
		);
		expect(trailing.kind).toBe("rejected");
	});

	it("writes packs with workerd's CompressionStream and SHA-1", async () => {
		expect(await hashObject("blob", enc("hello\n"))).toBe(
			"ce013625030ba8dba906f756967f9e9ca394464a",
		);
		const empty = await writePack([]);
		const body = golden("receive-pack-multi-ref").body;
		expect(empty.pack).toEqual(body.subarray(body.length - empty.pack.length));
		const blob = { type: "blob" as const, data: enc("# acme/shop\n") };
		const blobId = await hashObject("blob", blob.data);
		const tree = {
			type: "tree" as const,
			data: encodeTree([{ mode: "100644", name: "README.md", id: blobId }]),
		};
		const treeId = await hashObject("tree", tree.data);
		const commit = {
			type: "commit" as const,
			data: encodeCommit({
				tree: treeId,
				author: { name: "T", email: "t@x.invalid", at: 1 },
				message: "g\n",
			}),
		};
		const { pack, ids } = await writePack([blob, tree, commit]);
		expect(ids[0]).toBe(blobId);
		expect(dec(pack.subarray(0, 4))).toBe("PACK");
		const trailer = new Uint8Array(
			await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20)),
		);
		expect(pack.subarray(pack.length - 20)).toEqual(trailer);
	});

	it("relays a recorded response through a workerd TransformStream, holding the flush", async () => {
		const response = golden("receive-pack-create").response;
		const relay = createReceivePackRelay({
			caps: {
				report: "report-status-v2",
				sideBand: "side-band-64k",
				quiet: true,
			},
			holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		});
		// The relay only advances while its output is read (as when it is a
		// Response body), so read concurrently, as the runtime would.
		const reading = readAll(
			new Response(response).body!.pipeThrough(relay.stream),
		);
		const report = await relay.report;
		expect(report?.refs).toEqual([{ ref: "refs/heads/main", ok: true }]);
		relay.release(["[radar] \u001b[31mhello\u001b[0m"]);
		const bytes = await reading;
		const demuxed = demuxSideband(bytes);
		expect(demuxed.flushed).toBe(true);
		expect(dec(join(...demuxed.band2))).toBe("[radar] [31mhello[0m\n");
		expect(
			synthReportStatus(report!, {
				report: "report-status",
				sideBand: null,
				quiet: false,
			}),
		)
			.toEqual(enc("000eunpack ok\n0017ok refs/heads/main\n0000"));
	});

	it("settles the report when the client cancels mid-relay", async () => {
		const progress = new Uint8Array(200).fill(0x41);
		let pushed = false;
		const upstream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pushed) {
					// A band-2 packet, then the upstream stalls.
					controller.enqueue(join(pkt(join(new Uint8Array([2]), progress))));
					pushed = true;
				}
			},
		});
		const relay = createReceivePackRelay({
			caps: {
				report: "report-status",
				sideBand: "side-band-64k",
				quiet: false,
			},
			holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		});
		const reader = upstream.pipeThrough(relay.stream).getReader();
		await reader.read();
		await reader.cancel("client went away");
		expect(await relay.report).toBe(null);
	});

	it("parses a gzip upload-pack request body and applies the trailer transform in workerd streams", async () => {
		const want = "a".repeat(40);
		const request = join(
			pkt(`want ${want} ofs-delta\n`),
			"0000",
			pkt("done\n"),
		);
		const parsed = await parseCapRequest(
			new Request("https://git.example.com/-/cap/x", {
				method: "POST",
				body: await gzip(request),
			}).body!,
			{
				encoding: "gzip",
				gitProtocol: null,
				maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			},
		);
		expect(parsed.kind).toBe("request");
		if (parsed.kind !== "request") return;
		expect(parsed.want).toBe(want);
		expect(parsed.sideBand).toBe(false);
		expect(parsed.body).toEqual(request);
		const bomb = await parseCapRequest(
			new Request("https://git.example.com/-/cap/x", {
				method: "POST",
				body: await gzip(new Uint8Array(16 * 1024 * 1024)),
			}).body!,
			{
				encoding: "gzip",
				gitProtocol: null,
				maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			},
		);
		expect(bomb.kind).toBe("rejected");
		const pack = join(pkt("NAK\n"), "PACK", new Uint8Array(4096), "0000");
		const through = (negotiated: { sideBand: boolean; v2: boolean }) =>
			readAll(
				new Response(pack).body!.pipeThrough(stripV0Trailer(negotiated)),
			);
		expect(await through({ sideBand: false, v2: false })).toEqual(
			pack.subarray(0, pack.length - 4),
		);
		expect(await through({ sideBand: true, v2: false })).toEqual(pack);
		expect(await through({ sideBand: false, v2: true })).toEqual(pack);
		const ad = synthCapAdvertisement({
			sha: want,
			publishedRef: "refs/heads/main",
			capabilities: ["multi_ack", "shallow", "symref=HEAD:refs/heads/master"],
			protocol: "v0",
		});
		expect(dec(ad)).toContain(
			`${want} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
		);
	});

	it("runs both clients through a fetch stub (no credential echoed)", async () => {
		const seen: { url: string; auth: string | null; body: string }[] = [];
		const stub = async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const request = new Request(input, init);
			seen.push({
				url: request.url,
				auth: request.headers.get("authorization"),
				body: dec(new Uint8Array(await request.arrayBuffer())),
			});
			return request.url.endsWith("/git-upload-pack")
				? new Response(golden("upload-pack-v2-ls-refs").response, {
					headers: { "content-type": "application/x-git-upload-pack-result" },
				})
				: new Response(golden("receive-pack-delete").response, {
					headers: { "content-type": "application/x-git-receive-pack-result" },
				});
		};
		const remote = {
			url: "https://artifacts.example/ns/repo.git/",
			authorization: "Bearer art_x",
			fetch: stub as typeof fetch,
		};
		const refs = await lsRefs(remote, {
			refPrefixes: ["refs/heads/"],
			symrefs: true,
		});
		expect(refs.map((r) => r.ref)).toContain("refs/heads/main");
		const statuses = await pushRefs(remote, [{
			ref: "refs/heads/feat",
			old: "1".repeat(40),
			new: "0".repeat(40),
		}]);
		expect(statuses).toEqual([{ ref: "refs/heads/feat", ok: true }]);
		expect(seen[0].url).toBe(
			"https://artifacts.example/ns/repo.git/git-upload-pack",
		);
		expect(seen[0].auth).toBe("Bearer art_x");
		expect(seen[0].body).toContain("ref-prefix refs/heads/");
		expect(seen[1].body.endsWith("0000")).toBe(true); // delete-only: no pack
	});
});
