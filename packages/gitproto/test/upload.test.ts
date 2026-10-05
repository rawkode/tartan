// Upload-pack request parser: goldens from stock git 2.55 (v0, v1, v2, gzip),
// every rejection the public view needs (want-ref, deepen-not, object-info,
// filters, order, trailing data) and the gzip cap.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	parseUploadRequest,
	PUBLIC_VIEW_PROFILE,
	UPLOAD_DECODE_MAX_BYTES,
	type UploadProfile,
	type UploadRejection,
	type UploadRequest,
} from "../src/index.ts";
import {
	chunked,
	dec,
	DELIM,
	FLUSH,
	golden,
	gzip,
	join,
	pkt,
	SHA_A,
	SHA_B,
} from "./helpers.ts";

const parse = (
	bytes: Uint8Array,
	options: {
		readonly encoding?: string | null;
		readonly v2?: boolean;
		readonly max?: number;
		readonly profile?: UploadProfile;
		readonly chunk?: number;
	} = {},
) =>
	parseUploadRequest(chunked(bytes, options.chunk), {
		encoding: options.encoding ?? null,
		gitProtocol: options.v2 ? "version=2" : null,
		maxDecodedBytes: options.max ?? UPLOAD_DECODE_MAX_BYTES,
		profile: options.profile ?? PUBLIC_VIEW_PROFILE,
	});

const accepted = (result: UploadRequest | UploadRejection): UploadRequest => {
	if (result.kind !== "request") {
		throw new Error(`rejected: ${result.code} ${result.detail}`);
	}
	return result;
};
const rejected = (result: UploadRequest | UploadRejection): UploadRejection => {
	if (result.kind !== "rejected") throw new Error("expected a rejection");
	return result;
};

const fromGolden = (name: string, chunk?: number) => {
	const g = golden(name);
	return parseUploadRequest(chunked(g.body, chunk), {
		encoding: g.contentEncoding,
		gitProtocol: g.gitProtocol,
		maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
		profile: PUBLIC_VIEW_PROFILE,
	});
};

Deno.test("goldens: v2 ls-refs and fetch requests from stock git are accepted", async () => {
	const lsRefs = accepted(await fromGolden("upload-pack-v2-ls-refs"));
	equal(lsRefs.protocol, "v2");
	equal(lsRefs.command, "ls-refs");
	deepStrictEqual(lsRefs.refPrefixes, ["refs/heads/", "refs/tags/", "HEAD"]);
	deepStrictEqual(lsRefs.capabilities, [
		"agent=git/2.55.0-Darwin",
		"object-format=sha1",
	]);
	deepStrictEqual(lsRefs.body, golden("upload-pack-v2-ls-refs").body);

	const fetch = accepted(await fromGolden("upload-pack-v2-fetch-clone", 3));
	equal(fetch.command, "fetch");
	const sent =
		dec(golden("upload-pack-v2-fetch-clone").body).split("want ").length - 1;
	ok(
		fetch.wants.length >= 1 && fetch.wants.length < sent,
		"duplicate wants collapse",
	);
	equal(new Set(fetch.wants).size, fetch.wants.length);
	ok(fetch.done);

	const depth = accepted(await fromGolden("upload-pack-v2-fetch-depth"));
	ok(depth.arguments.includes("deepen 1"));

	const refspec = accepted(await fromGolden("upload-pack-v2-fetch-refspec"));
	ok(
		refspec.refPrefixes.includes("refs/heads/lanes/ln_x"),
		"fetch sends ref-prefix",
	);

	const pattern = accepted(
		await fromGolden("upload-pack-v2-ls-remote-pattern"),
	);
	deepStrictEqual(
		pattern.refPrefixes,
		[],
		"ls-remote <pattern> sends none",
	);
});

Deno.test("golden: a gzip-encoded v2 fetch (git 2.55) decodes and parses", async () => {
	const g = golden("upload-pack-v2-fetch-gzip");
	equal(g.contentEncoding, "gzip");
	const result = accepted(await fromGolden("upload-pack-v2-fetch-gzip", 100));
	ok(result.haves.length > 16);
	equal(result.wants.length, 1);
	ok(dec(result.body).startsWith("0011command=fetch"), "forwarded as identity");
});

Deno.test("goldens: v0 and v1 fetches are accepted (caps on the first want)", async () => {
	const clone = accepted(await fromGolden("upload-pack-v0-fetch-clone"));
	equal(clone.protocol, "v0");
	ok(clone.done);
	ok(clone.capabilities.includes("side-band-64k"));
	const v1 = accepted(await fromGolden("upload-pack-v1-fetch-clone"));
	equal(v1.protocol, "v0");
	const haves = accepted(await fromGolden("upload-pack-v0-fetch-haves"));
	ok(haves.haves.length > 0);
});

Deno.test("golden: a v0 fetch selecting deepen-not (unfiltered ad) is refused", async () => {
	// http-backend advertised deepen-not, so git selected it; Tartan's rewritten
	// advertisement never offers it, and a client that sends it anyway is refused.
	const g = golden("upload-pack-v0-fetch-raw-ad");
	ok(dec(g.body).includes("deepen-not"));
	ok(!dec(golden("upload-pack-v0-fetch-clone").body).includes("deepen-not"));
	const result = rejected(await parse(g.body));
	equal(result.code, "capability");
	equal(result.reason, "unsupported-argument");
	// A profile that allows it accepts the same body.
	const profile: UploadProfile = {
		...PUBLIC_VIEW_PROFILE,
		v0: {
			...PUBLIC_VIEW_PROFILE.v0,
			capabilities: [...PUBLIC_VIEW_PROFILE.v0.capabilities, "deepen-not"],
		},
	};
	accepted(await parse(g.body, { profile }));
});

const v2 = (command: string, ...args: string[]) =>
	join(
		pkt(`command=${command}\n`),
		pkt("agent=git/2.55.0\n"),
		DELIM,
		...args.map((a) => pkt(`${a}\n`)),
		FLUSH,
	);

Deno.test("v2 want-ref, deepen-not, object-info and unknown arguments reject", async () => {
	const cases: [Uint8Array, string, string][] = [
		[
			v2("fetch", `want-ref refs/heads/lanes/ln_x`, "done"),
			"unsupported-argument",
			"argument",
		],
		[
			v2("fetch", `want ${SHA_A}`, "deepen-not refs/heads/main", "done"),
			"unsupported-argument",
			"argument",
		],
		[
			v2("fetch", `want ${SHA_A}`, "packfile-uris https", "done"),
			"unsupported-argument",
			"argument",
		],
		[
			v2("fetch", `want ${SHA_A}`, "sideband-all", "done"),
			"unsupported-argument",
			"argument",
		],
		[
			v2("fetch", `want ${SHA_A}`, "wait-for-done", "done"),
			"unsupported-argument",
			"argument",
		],
		[
			v2("fetch", `want ${SHA_A}`, "filter sparse:oid=" + SHA_B, "done"),
			"unsupported-argument",
			"argument",
		],
		[v2("fetch", `want ${SHA_A} extra`), "unsupported-argument", "argument"],
		[v2("fetch", `want ${SHA_A.slice(2)}`), "unsupported-argument", "argument"],
		[v2("fetch", "deepen 0"), "unsupported-argument", "argument"],
		[v2("fetch", "done extra"), "unsupported-argument", "argument"],
		[
			v2("object-info", "size", `oid ${SHA_A}`),
			"unsupported-command",
			"command",
		],
		[v2("bundle-uri"), "unsupported-command", "command"],
		[v2("unknown"), "unsupported-command", "command"],
		[v2("ls-refs", "ref-prefix"), "unsupported-argument", "argument"],
		[v2("ls-refs", "symrefs please"), "unsupported-argument", "argument"],
	];
	for (const [body, reason, code] of cases) {
		const result = rejected(await parse(body, { v2: true }));
		equal(result.reason, reason, dec(body));
		equal(result.code, code, dec(body));
	}
});

Deno.test("v2 structure: capabilities, delim, flush, trailing data", async () => {
	const ok1 = accepted(
		await parse(join(pkt("command=ls-refs\n"), FLUSH), { v2: true }),
	);
	equal(ok1.command, "ls-refs");
	const cases: [Uint8Array, string][] = [
		[
			join(pkt("command=fetch\n"), pkt("server-option=x\n"), DELIM, FLUSH),
			"capability",
		],
		[
			join(pkt("command=fetch\n"), pkt("session-id=x\n"), DELIM, FLUSH),
			"capability",
		],
		[
			join(pkt("command=fetch\n"), pkt("object-format=sha256\n"), DELIM, FLUSH),
			"capability",
		],
		[
			join(pkt("command=fetch\n"), DELIM, pkt("done\n"), DELIM, FLUSH),
			"bad-pkt",
		],
		[join(pkt("command=fetch\n"), DELIM, pkt("done\n"), "0002"), "bad-pkt"],
		[join(pkt("command=fetch\n"), DELIM, pkt("done\n")), "truncated"],
		[
			join(pkt("command=ls-refs\n"), FLUSH, pkt("command=fetch\n"), FLUSH),
			"trailing-data",
		],
		[join(pkt("command=fetch\n"), DELIM, "0004", FLUSH), "bad-line"],
		[join(pkt("fetch\n"), FLUSH), "command"],
		[join(FLUSH), "command"],
		[join(pkt("command=fetch\n"), "00"), "bad-pkt"],
	];
	for (const [body, code] of cases) {
		equal(rejected(await parse(body, { v2: true })).code, code, dec(body));
	}
});

const v0 = (...lines: string[]) =>
	join(...lines.map((l) => l === FLUSH ? FLUSH : pkt(`${l}\n`)));

Deno.test("v0: order, caps only on the first want, done ends the request", async () => {
	const good = accepted(
		await parse(
			v0(
				`want ${SHA_A} side-band-64k ofs-delta`,
				`want ${SHA_B}`,
				FLUSH,
				`have ${SHA_B}`,
				"done",
			),
		),
	);
	deepStrictEqual(good.wants, [SHA_A, SHA_B]);
	deepStrictEqual(good.haves, [SHA_B]);
	const roundOnly = accepted(
		await parse(v0(`want ${SHA_A}`, FLUSH, `have ${SHA_B}`, FLUSH)),
	);
	equal(roundOnly.done, false);
	const shallow = accepted(
		await parse(
			v0(`want ${SHA_A}`, `shallow ${SHA_B}`, "deepen 3", FLUSH, "done"),
		),
	);
	deepStrictEqual(shallow.shallows, [SHA_B]);
	const cases: [Uint8Array, string][] = [
		[
			v0(`want ${SHA_A}`, `want ${SHA_B} ofs-delta`, FLUSH, "done"),
			"capability",
		],
		[v0(`want ${SHA_A} allow-tip-sha1-in-want`, FLUSH, "done"), "capability"],
		[v0(`want ${SHA_A} filter`, FLUSH, "done"), "capability"],
		[v0(`want ${SHA_A}`, `have ${SHA_B}`, FLUSH, "done"), "order"],
		[v0(`want ${SHA_A}`, FLUSH, `want ${SHA_B}`, "done"), "order"],
		[v0(`want ${SHA_A}`, "deepen-not refs/heads/x", FLUSH, "done"), "argument"],
		[v0(`want ${SHA_A}`, "filter blob:none", FLUSH, "done"), "argument"],
		[v0(`want ${SHA_A}`, "deepen-relative", FLUSH, "done"), "argument"],
		[v0(`want-ref refs/heads/x`, FLUSH, "done"), "argument"],
		[v0(`want ${SHA_A}`, FLUSH, "done", `have ${SHA_B}`), "trailing-data"],
		[
			v0(`want ${SHA_A}`, FLUSH, `have ${SHA_B}`, FLUSH, "done"),
			"trailing-data",
		],
		[v0(`want ${SHA_A}`, FLUSH), "truncated"],
		[v0(`want ${SHA_A}`), "truncated"],
		[v0(FLUSH, "done"), "empty"],
		[join(pkt(`want ${SHA_A}\n`), "0001", FLUSH), "bad-pkt"],
	];
	for (const [body, code] of cases) {
		equal(rejected(await parse(body)).code, code, dec(body));
	}
});

Deno.test("gzip: the decoded body is capped (bombs stop at the cap) and garbage rejects", async () => {
	const body = v2("fetch", `want ${SHA_A}`, "done");
	const zipped = await gzip(body);
	const ok1 = accepted(
		await parse(zipped, { v2: true, encoding: "gzip", chunk: 3 }),
	);
	deepStrictEqual(ok1.body, body);
	// 64 MiB of zeros compress to ~64 KiB; the decoder stops at 4 MiB.
	const bomb = await gzip(new Uint8Array(64 * 1024 * 1024));
	ok(bomb.length < 256 * 1024);
	const started = performance.now();
	const result = rejected(
		await parse(bomb, { v2: true, encoding: "gzip", chunk: 16_384 }),
	);
	equal(result.reason, "upload-encoding");
	equal(result.code, "too-large");
	ok(performance.now() - started < 5_000);
	equal(
		rejected(
			await parse(new Uint8Array([1, 2, 3, 4]), { v2: true, encoding: "gzip" }),
		).code,
		"undecodable",
	);
	equal(
		rejected(
			await parse(zipped.slice(0, zipped.length - 6), {
				v2: true,
				encoding: "gzip",
			}),
		).code,
		"undecodable",
	);
	equal(
		rejected(await parse(join(zipped, "junk"), { v2: true, encoding: "gzip" }))
			.code,
		"undecodable",
	);
	equal(
		rejected(await parse(body, { v2: true, encoding: "br" })).code,
		"encoding",
	);
	equal(
		rejected(await parse(body, { v2: true, encoding: "deflate" })).code,
		"encoding",
	);
	equal(
		rejected(await parse(body, { v2: true, max: body.length - 1 })).code,
		"too-large",
	);
	equal(
		accepted(await parse(body, { v2: true, encoding: "identity" })).command,
		"fetch",
	);
});

Deno.test("filter specs: only object-type and size filters", async () => {
	for (
		const spec of [
			"blob:none",
			"blob:limit=10k",
			"tree:0",
			"object:type=blob",
			"combine:blob:none+tree:1",
		]
	) {
		accepted(
			await parse(v2("fetch", `want ${SHA_A}`, `filter ${spec}`, "done"), {
				v2: true,
			}),
		);
	}
	for (
		const spec of [
			`sparse:oid=${SHA_A}`,
			"sparse:path=/x",
			"combine:blob:none+sparse%3Aoid%3Dmain",
			"blob:limit=x",
			"",
		]
	) {
		rejected(
			await parse(v2("fetch", `want ${SHA_A}`, `filter ${spec}`, "done"), {
				v2: true,
			}),
		);
	}
});
