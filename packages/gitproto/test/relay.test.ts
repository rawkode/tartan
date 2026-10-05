// The receive-pack response relay: band-1 demux, held-back final flush,
// sanitized band-2 injection, the hold-back cap, report rewriting and malformed
// upstreams.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	createReceivePackRelay,
	demuxSideband,
	encodePktLine,
	encodeSideband,
	type NegotiatedCaps,
	type ReceivePackRelay,
	RELAY_HOLD_BACK_MAX_BYTES,
} from "../src/index.ts";
import { chunked, dec, golden, join, readAll } from "./helpers.ts";

const SB64: NegotiatedCaps = {
	report: "report-status-v2",
	sideBand: "side-band-64k",
	quiet: true,
};
const PLAIN: NegotiatedCaps = {
	report: "report-status",
	sideBand: null,
	quiet: false,
};

/** Pipes `input` through the relay; `release` runs once the input is written. */
const run = async (
	relay: ReceivePackRelay,
	input: Uint8Array,
	chunk: number,
	release?: readonly string[],
): Promise<Uint8Array> => {
	const output = readAll(chunked(input, chunk).pipeThrough(relay.stream));
	if (release) {
		await relay.report;
		relay.release(release);
	}
	return await output;
};

Deno.test("golden side-band response: report parsed, flush held, lines injected before it", async () => {
	const response = golden("receive-pack-create").response;
	for (const chunk of [1, 3, 1 << 20]) {
		const relay = createReceivePackRelay({
			caps: SB64,
			holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		});
		const out = await run(relay, response, chunk, [
			"[radar] \x1b]8;;http://x\x07link\x1b[0m overlaps ln_01",
		]);
		deepStrictEqual(await relay.report, {
			unpack: "ok",
			refs: [{ ref: "refs/heads/main", ok: true }],
		});
		const expected = join(
			response.subarray(0, response.length - 4),
			encodeSideband(
				2,
				new TextEncoder().encode(
					"[radar] ]8;;http://xlink[0m overlaps ln_01\n",
				),
				"side-band-64k",
			),
			"0000",
		);
		deepStrictEqual(out, expected, `chunk ${chunk}`);
		ok(!dec(out).includes("\x1b"));
		ok(demuxSideband(out).flushed);
	}
});

Deno.test("the final flush is not released before release() is called", async () => {
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	const response = golden("receive-pack-multi-ref").response;
	const reader = chunked(response, 5).pipeThrough(relay.stream).getReader();
	const received: Uint8Array[] = [];
	let done = false;
	const pump = (async () => {
		for (;;) {
			const r = await reader.read();
			if (r.done) break;
			received.push(r.value);
		}
		done = true;
	})();
	const report = await relay.report;
	equal(report?.refs.length, 2);
	await new Promise((resolve) => setTimeout(resolve, 30));
	equal(done, false, "stream still open");
	deepStrictEqual(join(...received), response.subarray(0, response.length - 4));
	relay.release([]);
	await pump;
	deepStrictEqual(join(...received), response);
});

Deno.test("no side-band: the report's flush is held; band-2 lines cannot be injected", async () => {
	const response = join(
		encodePktLine("unpack ok\n"),
		encodePktLine("ok refs/heads/main\n"),
		"0000",
	);
	const relay = createReceivePackRelay({
		caps: PLAIN,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	const out = await run(relay, response, 2, ["ignored"]);
	deepStrictEqual(out, response);
	deepStrictEqual(await relay.report, {
		unpack: "ok",
		refs: [{ ref: "refs/heads/main", ok: true }],
	});
	// The client asked for side-band but the upstream answered plain: detected.
	const mixed = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	deepStrictEqual(await run(mixed, response, 1, ["x"]), response);
	equal((await mixed.report)?.refs[0].ref, "refs/heads/main");
});

Deno.test("over the hold-back cap the response relays untouched and release is a no-op", async () => {
	const progress = encodeSideband(
		2,
		new TextEncoder().encode("Resolving deltas: 100%\r".repeat(10)),
		"side-band-64k",
	);
	const response = join(progress, golden("receive-pack-create").response);
	const relay = createReceivePackRelay({ caps: SB64, holdBackMaxBytes: 64 });
	const out = await run(relay, response, 16);
	relay.release(["never injected"]);
	deepStrictEqual(out, response);
	equal(await relay.report, null);
});

Deno.test("rewriteReport translates an upstream size error before the client sees it", async () => {
	const inner = join(
		encodePktLine("unpack artifacts_git_receive_pack_object_too_large\n"),
		encodePktLine("ng refs/heads/main unpacker error\n"),
		"0000",
	);
	const response = join(encodeSideband(1, inner, "side-band-64k"), "0000");
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		rewriteReport: (report) =>
			report.unpack.includes("object_too_large")
				? {
					unpack: "ok",
					refs: report.refs.map((r) => ({
						ref: r.ref,
						ok: false as const,
						reason: "object-too-large",
					})),
				}
				: null,
	});
	const out = await run(relay, response, 7, [
		"objects of 32 MiB or more are refused",
	]);
	const demuxed = demuxSideband(out);
	equal(
		dec(demuxed.band1),
		"000eunpack ok\n" + "0028ng refs/heads/main object-too-large\n" + "0000",
	);
	equal(dec(join(...demuxed.band2)), "objects of 32 MiB or more are refused\n");
	equal(
		(await relay.report)?.unpack,
		"artifacts_git_receive_pack_object_too_large",
	);
	// Returning null keeps the upstream bytes.
	const keep = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		rewriteReport: () => null,
	});
	deepStrictEqual(await run(keep, response, 3, []), response);
});

Deno.test("malformed or truncated upstream responses pass through and resolve null", async () => {
	const garbage = new TextEncoder().encode("<html>502 Bad Gateway</html>");
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	deepStrictEqual(await run(relay, garbage, 4), garbage);
	equal(await relay.report, null);
	// A hang-up before the report completes: relayed as is, nothing injected.
	const cut = golden("receive-pack-create").response.subarray(0, 20);
	const hung = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	const out = await run(hung, cut, 3);
	hung.release(["late"]);
	deepStrictEqual(out, cut);
	equal(await hung.report, null);
	// Band 3 (a fatal upstream error) is relayed as it comes.
	const fatal = join(
		encodeSideband(
			3,
			new TextEncoder().encode("fatal: out of space"),
			"side-band-64k",
		),
		"0000",
	);
	const band3 = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	deepStrictEqual(await run(band3, fatal, 5, []), fatal);
	equal(await band3.report, null);
});

Deno.test("a client cancel mid-relay settles the report (null when not yet parsed)", async () => {
	let pushed = false;
	const upstream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!pushed) {
				controller.enqueue(
					encodeSideband(2, new Uint8Array(200).fill(0x41), "side-band-64k"),
				);
				pushed = true;
			}
		},
	});
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	const reader = upstream.pipeThrough(relay.stream).getReader();
	await reader.read();
	await reader.cancel("client went away");
	equal(await relay.report, null);
});

Deno.test("maxHoldMs releases the flush when release() never comes", async () => {
	const response = golden("receive-pack-delete").response;
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		maxHoldMs: 20,
	});
	const started = performance.now();
	deepStrictEqual(await run(relay, response, 1 << 20), response);
	ok(performance.now() - started >= 15);
});

Deno.test("release before the end of the upstream applies when the flush arrives", async () => {
	const response = golden("receive-pack-delete").response;
	const relay = createReceivePackRelay({
		caps: SB64,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
	});
	relay.release(["early"]);
	relay.release(["second call ignored"]);
	const out = await run(relay, response, 2);
	equal(dec(join(...demuxSideband(out).band2)), "early\n");
});
