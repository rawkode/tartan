import { equal, ok } from "node:assert/strict";
import { byteLength } from "@tartan/contract";
import {
	appendTail,
	createLineRedactor,
	JOB_TAIL_BYTES,
	jobLogKey,
	safeText,
	secretSafeTail,
	tailBytes,
} from "./joblog.ts";
import { LIVE_TOKEN } from "./testing/fakes.ts";

Deno.test("redacts a live-format art_v2_x token split across chunks", () => {
	const redactor = createLineRedactor();
	const line = `Authorization: Bearer ${LIVE_TOKEN} ok\n`;
	const cut = line.indexOf("art_v2_x_") + 12;
	let out = redactor.push(line.slice(0, cut));
	equal(out, "", "a partial line is held back");
	out += redactor.push(line.slice(cut));
	out += redactor.end();
	equal(out.includes("0123456789abcdef"), false);
	equal(out.includes("expires="), false);
	ok(out.includes("art_v2_<redacted>"));
});

Deno.test("redacts capability paths and keeps ordinary lines", () => {
	const redactor = createLineRedactor();
	const out = redactor.push(
		"GET https://h/-/cap/v1/1791234567/ln_01k6aaaaaaaaaaaaaaaaaaaaaa/abcdef/0123456789abcdef/r.git\nplain line\n",
	);
	ok(out.includes("/-/cap/<redacted>/"));
	ok(out.includes("plain line\n"));
	equal(out.includes("0123456789abcdef"), false);
});

Deno.test("a very long unterminated line is flushed redacted", () => {
	const redactor = createLineRedactor(64);
	const out = redactor.push(`${"x".repeat(80)} ${LIVE_TOKEN}`);
	ok(out.length > 0);
	const all = out + redactor.end();
	equal(all.includes("expires="), false);
	ok(all.includes("art_v2_<redacted>"));
	equal(redactor.end(), "");
});

Deno.test("a forced flush never splits a token across outputs; joined tails and tail windows hold no token or token fragment", () => {
	const hexRun = /[0-9a-f]{12,}/;
	for (const split of [0, 1, 3, 5, 9, 20, 40, 60]) {
		const redactor = createLineRedactor();
		const outputs: string[] = [];
		// A line just under the cap ends where the token starts…
		outputs.push(
			redactor.push(`${"x".repeat(16_380)}${LIVE_TOKEN.slice(0, 5)}`),
		);
		// …and the rest of the token arrives in pieces, then the newline.
		const rest = `${LIVE_TOKEN.slice(5)} done\n`;
		outputs.push(redactor.push(rest.slice(0, split)));
		outputs.push(redactor.push(rest.slice(split)));
		outputs.push(redactor.end());
		for (const out of outputs) equal(hexRun.test(out), false, `split ${split}`);
		// A sink that joins the outputs (RepoDO's jobs.tail) holds no token.
		let tail = "";
		for (const out of outputs) tail = appendTail(tail, out, JOB_TAIL_BYTES);
		equal(tail.includes(LIVE_TOKEN), false);
		equal(hexRun.test(tail), false);
	}
	// Two redacted halves joined by a sink form no token either.
	const half = LIVE_TOKEN.indexOf("_x_") + 3;
	const joined = appendTail(LIVE_TOKEN.slice(0, half), LIVE_TOKEN.slice(half));
	equal(joined.includes(LIVE_TOKEN), false);
	ok(joined.includes("art_v2_<redacted>"));
	// A window that starts inside a token drops the partial token.
	const text = `line one ${LIVE_TOKEN} end`;
	for (let cut = 1; cut < text.length; cut++) {
		const window = secretSafeTail(text, text.length - cut);
		equal(hexRun.test(window), false, `cut ${cut}: ${window}`);
	}
	equal(secretSafeTail("plain\nlog line", 8), "log line", "a clean cut stays");
});

Deno.test("tails never split a code point and keep the last bytes", () => {
	const text = "ab€€€";
	const tail = tailBytes(text, 7);
	equal(tail, "€€");
	ok(byteLength(tail) <= 7);
	equal(appendTail("hello ", "world", 5), "world");
	equal(appendTail("a", "b"), "ab");
});

Deno.test("job log keys and safe text", () => {
	equal(jobLogKey("r1", "x1", "test"), "logs/r1/x1/test.log");
	const text = safeText(`boom ${LIVE_TOKEN}`, 20);
	equal(text.includes("expires"), false);
	ok(byteLength(text) <= 20);
});
