// The byte buffer behind the streaming parsers: correctness against a
// reference model, and linear cost for streams delivered in tiny chunks (a
// quadratic re-concatenation took 15 s for a 60 KB command section).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createByteBuffer } from "../src/bytes.ts";
import {
	createReceivePackRelay,
	encodeSideband,
	MAX_COMMANDS,
	peekCommands,
	RECEIVE_PACK_CAPABILITIES,
} from "../src/index.ts";
import { chunked, join, pkt, prng, readAll, SHA_A, ZERO } from "./helpers.ts";

Deno.test("createByteBuffer matches a reference model under random appends and consumes", () => {
	const rand = prng(7);
	const buffer = createByteBuffer(8);
	let model: number[] = [];
	for (let i = 0; i < 5_000; i++) {
		if (rand.int(3) === 0) {
			const n = rand.int(model.length + 2);
			buffer.consume(n);
			model = model.slice(Math.min(n, model.length));
		} else {
			const chunk = new Uint8Array(rand.int(40)).map(() => rand.int(256));
			buffer.append(chunk);
			model.push(...chunk);
		}
		equal(buffer.length, model.length);
		if (i % 97 === 0) deepStrictEqual([...buffer.view()], model);
	}
	deepStrictEqual([...buffer.view()], model);
});

Deno.test("peek and relay stay linear when the body arrives one byte at a time", async () => {
	const section = join(
		...Array.from(
			{ length: 600 },
			(_, i) =>
				pkt(
					`${ZERO} ${SHA_A} refs/heads/b${i}${
						i === 0 ? "\0report-status" : ""
					}`,
				),
		),
		"0000",
	);
	const started = performance.now();
	const peeked = await peekCommands(chunked(section, 1), {
		maxCommands: MAX_COMMANDS.user,
		maxSectionBytes: 64 * 1024,
		capabilities: RECEIVE_PACK_CAPABILITIES,
	});
	equal(peeked.kind, "commands");
	const response = join(
		encodeSideband(2, new Uint8Array(65_000).fill(0x41), "side-band-64k"),
		"0000",
	);
	const relay = createReceivePackRelay({
		caps: { report: null, sideBand: "side-band-64k", quiet: false },
		holdBackMaxBytes: 1 << 20,
		maxHoldMs: 1,
	});
	deepStrictEqual(
		await readAll(chunked(response, 1).pipeThrough(relay.stream)),
		response,
	);
	const elapsed = performance.now() - started;
	ok(elapsed < 3_000, `took ${Math.round(elapsed)} ms`);
});
