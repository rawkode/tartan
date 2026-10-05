// pkt-line codec: strict lengths, specials, encoder bounds.

import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import {
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
	PKT_MAX_LENGTH,
	type PktLine,
} from "../src/index.ts";
import { dec, enc, golden, goldenNames, join } from "./helpers.ts";

const codeOf = (error: unknown): unknown => fromRpcError(error).details?.code;

Deno.test("encodePktLine writes a 4-hex length that counts itself", () => {
	equal(dec(encodePktLine("a\n")), "0006a\n");
	equal(dec(encodePktLine("")), "0004");
	equal(
		encodePktLine(new Uint8Array(PKT_MAX_LENGTH - 4)).length,
		PKT_MAX_LENGTH,
	);
	throws(
		() => encodePktLine(new Uint8Array(PKT_MAX_LENGTH - 3)),
		(e) => codeOf(e) === "oversized",
	);
});

Deno.test("encodeSpecialPkt: flush, delim, response-end", () => {
	equal(dec(encodeSpecialPkt("flush")), "0000");
	equal(dec(encodeSpecialPkt("delim")), "0001");
	equal(dec(encodeSpecialPkt("response-end")), "0002");
});

Deno.test("decodePktLines round-trips data and specials", () => {
	const bytes = join(
		encodePktLine("one\n"),
		"0001",
		encodePktLine("two"),
		"0002",
		"0000",
	);
	const { lines, rest } = decodePktLines(bytes);
	const kinds = lines.map((l: PktLine) => l.kind);
	deepStrictEqual(kinds, ["data", "delim", "data", "response-end", "flush"]);
	equal(dec((lines[0] as { data: Uint8Array }).data), "one\n");
	equal(rest.length, 0);
});

Deno.test("decodePktLines rejects malformed, truncated and oversized lengths", () => {
	const cases: [string, Uint8Array, string][] = [
		["non-hex", enc("00zzabc"), "bad-length"],
		["0003", enc("0003"), "bad-length"],
		["truncated header", enc("00"), "truncated"],
		["truncated payload", enc("000aabc"), "truncated"],
		["over 65520", enc("fff1"), "oversized"],
		["ffff", enc("ffff"), "oversized"],
		["sign", enc("-001abc"), "bad-length"],
		["spaces", enc(" 006abcd"), "bad-length"],
	];
	for (const [name, bytes, code] of cases) {
		throws(() => decodePktLines(bytes), (e) => codeOf(e) === code, name);
	}
});

Deno.test("decodePktLines allowRest returns the trailing partial packet", () => {
	const { lines, rest } = decodePktLines(join("0006a\n", "000aab"), {
		allowRest: true,
	});
	equal(lines.length, 1);
	equal(dec(rest), "000aab");
	const limited = decodePktLines(join("0000", "0000", "0000"), {
		maxLines: 2,
		allowRest: true,
	});
	equal(limited.lines.length, 2);
	equal(dec(limited.rest), "0000");
	throws(() => decodePktLines(join("0000", "0000", "0000"), { maxLines: 2 }));
});

Deno.test("every recorded advertisement and v2 request decodes strictly", () => {
	for (const name of goldenNames()) {
		const g = golden(name);
		if (g.op.startsWith("info/refs")) decodePktLines(g.response);
		if (
			g.gitProtocol === "version=2" && g.contentEncoding === null &&
			g.body.length
		) {
			decodePktLines(g.body);
		}
	}
});
