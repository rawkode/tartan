// The capability route's profile: golden tests on the importer's request
// shape and stock git's v2 fetch, property tests (exactly one want, nothing
// outside the profile, only `HEAD` and the published name advertised, the
// trailer transform's byte rules), and stock git 2.55 end to end: clones of
// a `master` source through the synthesized advertisement end with exactly
// `HEAD` → `refs/heads/main`.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	CAP_ROUTE_AGENT,
	CAP_ROUTE_V0_CAPABILITIES,
	type CapRequest,
	decodePktLines,
	parseCapRequest,
	readUpstreamTip,
	rewriteAdvertisement,
	stripV0Trailer,
	synthCapAdvertisement,
	synthCapV2Capabilities,
	UPLOAD_DECODE_MAX_BYTES,
	UPLOAD_PACK_V0_CAPABILITIES,
	type UploadRejection,
} from "../src/index.ts";
import {
	chunked,
	dec,
	DELIM,
	enc,
	FLUSH,
	golden,
	gzip,
	join,
	pkt,
	prng,
	readAll,
	SHA_A,
	SHA_B,
	ZERO,
} from "./helpers.ts";
import {
	commitFile,
	git,
	hasGit,
	initBare,
	initWork,
	type InterceptRequest,
	revParse,
	withGitServer,
} from "./harness/git.ts";

const MAIN = "refs/heads/main";

const parse = (
	bytes: Uint8Array,
	options: {
		readonly v2?: boolean;
		readonly encoding?: string | null;
		readonly chunk?: number;
		readonly max?: number;
	} = {},
) =>
	parseCapRequest(chunked(bytes, options.chunk), {
		encoding: options.encoding ?? null,
		gitProtocol: options.v2 ? "version=2" : null,
		maxDecodedBytes: options.max ?? UPLOAD_DECODE_MAX_BYTES,
	});

const accepted = (result: CapRequest | UploadRejection): CapRequest => {
	if (result.kind !== "request") {
		throw new Error(`rejected: ${result.code} ${result.detail}`);
	}
	return result;
};

const rejected = (result: CapRequest | UploadRejection): UploadRejection => {
	if (result.kind !== "rejected") throw new Error("accepted");
	return result;
};

/** The importer's request shape: one v0 want, a flush, `done`, no side-band (73 bytes for one SHA). */
const importerRequest = (want: string) =>
	join(pkt(`want ${want} ofs-delta\n`), FLUSH, pkt("done\n"));

const v2Fetch = (lines: readonly string[]) =>
	join(
		pkt("command=fetch"),
		pkt("agent=git/2.55.0-Darwin"),
		pkt("object-format=sha1"),
		DELIM,
		...lines.map((line) => pkt(`${line}\n`)),
		FLUSH,
	);

// ---------------------------------------------------------------------------
// parseCapRequest
// ---------------------------------------------------------------------------

Deno.test("parseCapRequest: the importer's request shape (one v0 want, done, no side-band)", async () => {
	const body = importerRequest(SHA_A);
	equal(body.length, 73, "one want with ofs-delta, a flush and done");
	for (const chunk of [1, 3, 7, 1 << 20]) {
		const req = accepted(await parse(body, { chunk }));
		equal(req.protocol, "v0");
		equal(req.command, "fetch");
		equal(req.want, SHA_A);
		equal(req.sideBand, false);
		deepStrictEqual(req.capabilities, ["ofs-delta"]);
		deepStrictEqual([...req.body], [...body]);
	}
	// Gzip-encoded, decoded under the cap and forwarded as identity.
	const req = accepted(
		await parse(await gzip(body), { encoding: "gzip" }),
	);
	deepStrictEqual([...req.body], [...body]);
});

Deno.test("parseCapRequest: stock git's v2 fetch with one want, and its ls-refs", async () => {
	const clone = golden("upload-pack-v2-fetch-clone");
	// The recorded clone wanted four refs (a repo with several branches): refused.
	const many = rejected(await parse(clone.body, { v2: true }));
	equal(many.reason, "unsupported-argument");
	// The same request with the one want a capability's advertisement yields.
	const text = dec(clone.body);
	const firstWant = text.indexOf("0032want ");
	const firstEnd = firstWant + 0x32;
	const doneAt = text.indexOf("0009done\n");
	const single = join(
		enc(text.slice(0, firstEnd)),
		enc(text.slice(doneAt)),
	);
	const req = accepted(await parse(single, { v2: true }));
	equal(req.protocol, "v2");
	equal(req.command, "fetch");
	equal(req.want, "79806f67dcfd37b7f56c367d7bb82ef23f9d0bd7");
	equal(req.sideBand, false);
	const lsRefs = accepted(
		await parse(golden("upload-pack-v2-ls-refs").body, { v2: true }),
	);
	equal(lsRefs.command, "ls-refs");
	equal(lsRefs.want, null);
	equal(lsRefs.symrefs, true);
	deepStrictEqual(lsRefs.refPrefixes, ["refs/heads/", "refs/tags/", "HEAD"]);
});

Deno.test("parseCapRequest: side-band is reported only for v0 with side-band or side-band-64k", async () => {
	for (const cap of ["side-band", "side-band-64k"]) {
		const req = accepted(
			await parse(join(pkt(`want ${SHA_A} ${cap}\n`), FLUSH, pkt("done\n"))),
		);
		equal(req.sideBand, true, cap);
	}
	const plain = accepted(
		await parse(
			join(
				pkt(`want ${SHA_A} multi_ack_detailed no-done ofs-delta\n`),
				FLUSH,
				pkt("done\n"),
			),
		),
	);
	equal(plain.sideBand, false);
});

Deno.test("parseCapRequest: everything outside the profile rejects the whole request", async () => {
	const v0 = (...parts: (string | Uint8Array)[]) => parse(join(...parts));
	const cases: [string, Promise<CapRequest | UploadRejection>][] = [
		[
			"two wants",
			v0(pkt(`want ${SHA_A}\n`), pkt(`want ${SHA_B}\n`), FLUSH, pkt("done\n")),
		],
		[
			"a have",
			v0(pkt(`want ${SHA_A}\n`), FLUSH, pkt(`have ${SHA_B}\n`), pkt("done\n")),
		],
		[
			"a shallow",
			v0(
				pkt(`want ${SHA_A}\n`),
				pkt(`shallow ${SHA_B}\n`),
				FLUSH,
				pkt("done\n"),
			),
		],
		[
			"a deepen",
			v0(pkt(`want ${SHA_A}\n`), pkt("deepen 1\n"), FLUSH, pkt("done\n")),
		],
		[
			"a filter",
			v0(
				pkt(`want ${SHA_A}\n`),
				pkt("filter blob:none\n"),
				FLUSH,
				pkt("done\n"),
			),
		],
		["no done", v0(pkt(`want ${SHA_A}\n`), FLUSH, FLUSH)],
		["no want", v0(FLUSH, pkt("done\n"))],
		[
			"the shallow capability",
			v0(pkt(`want ${SHA_A} shallow\n`), FLUSH, pkt("done\n")),
		],
		[
			"allow-tip-sha1-in-want",
			v0(pkt(`want ${SHA_A} allow-tip-sha1-in-want\n`), FLUSH, pkt("done\n")),
		],
		[
			"deepen-since capability",
			v0(pkt(`want ${SHA_A} deepen-since\n`), FLUSH, pkt("done\n")),
		],
		[
			"filter capability",
			v0(pkt(`want ${SHA_A} filter\n`), FLUSH, pkt("done\n")),
		],
		[
			"data after done",
			v0(pkt(`want ${SHA_A}\n`), FLUSH, pkt("done\n"), pkt("done\n")),
		],
		[
			"an uppercase SHA",
			v0(pkt(`want ${"A".repeat(40)}\n`), FLUSH, pkt("done\n")),
		],
		[
			"v2 two wants",
			parse(v2Fetch([`want ${SHA_A}`, `want ${SHA_B}`, "done"]), { v2: true }),
		],
		["v2 no done", parse(v2Fetch([`want ${SHA_A}`]), { v2: true })],
		[
			"v2 have",
			parse(v2Fetch([`want ${SHA_A}`, `have ${SHA_B}`, "done"]), { v2: true }),
		],
		["v2 want-ref", parse(v2Fetch([`want-ref ${MAIN}`, "done"]), { v2: true })],
		[
			"v2 deepen",
			parse(v2Fetch([`want ${SHA_A}`, "deepen 1", "done"]), { v2: true }),
		],
		[
			"v2 filter",
			parse(v2Fetch([`want ${SHA_A}`, "filter blob:none", "done"]), {
				v2: true,
			}),
		],
		[
			"v2 shallow",
			parse(v2Fetch([`want ${SHA_A}`, `shallow ${SHA_B}`, "done"]), {
				v2: true,
			}),
		],
		[
			"v2 sideband-all",
			parse(v2Fetch([`want ${SHA_A}`, "sideband-all", "done"]), { v2: true }),
		],
		[
			"v2 packfile-uris",
			parse(v2Fetch([`want ${SHA_A}`, "packfile-uris https", "done"]), {
				v2: true,
			}),
		],
		[
			"v2 object-info",
			parse(join(pkt("command=object-info\n"), DELIM, pkt("size\n"), FLUSH), {
				v2: true,
			}),
		],
		[
			"v2 bundle-uri",
			parse(join(pkt("command=bundle-uri\n"), FLUSH), { v2: true }),
		],
	];
	for (const [name, pending] of cases) {
		const result = await pending;
		equal(result.kind, "rejected", name);
	}
	const command = rejected(
		await parse(join(pkt("command=object-info\n"), FLUSH), { v2: true }),
	);
	equal(command.reason, "unsupported-command");
});

Deno.test("parseCapRequest: repeated want lines of the one SHA name one object (stock git v2 wants HEAD and main)", async () => {
	const v0 = accepted(
		await parse(
			join(
				pkt(`want ${SHA_A} ofs-delta\n`),
				pkt(`want ${SHA_A}\n`),
				FLUSH,
				pkt("done\n"),
			),
		),
	);
	equal(v0.want, SHA_A);
	const v2 = accepted(
		await parse(v2Fetch([`want ${SHA_A}`, `want ${SHA_A}`, "done"]), {
			v2: true,
		}),
	);
	equal(v2.want, SHA_A);
	// Capabilities still go on the first want line only.
	const late = await parse(
		join(
			pkt(`want ${SHA_A}\n`),
			pkt(`want ${SHA_A} ofs-delta\n`),
			FLUSH,
			pkt("done\n"),
		),
	);
	equal(late.kind, "rejected");
});

Deno.test("parseCapRequest: encodings and the decoded-size cap", async () => {
	const brotli = rejected(
		await parse(importerRequest(SHA_A), { encoding: "br" }),
	);
	equal(brotli.reason, "upload-encoding");
	const bomb = await gzip(new Uint8Array(8 * 1024 * 1024));
	const capped = rejected(await parse(bomb, { encoding: "gzip" }));
	equal(capped.reason, "upload-encoding");
	const garbage = rejected(
		await parse(enc("not gzip at all"), { encoding: "gzip" }),
	);
	equal(garbage.reason, "upload-encoding");
});

// The model the property test checks against: a request is accepted iff it is
// built only from allowed parts and carries exactly one want and a done.
Deno.test("parseCapRequest property: never more or less than one want, never an argument outside the profile", async () => {
	const rand = prng(0x5eed_ca95);
	const v0Caps = [
		"ofs-delta",
		"side-band-64k",
		"thin-pack",
		"no-progress",
		"multi_ack_detailed",
		"agent=git/2",
		"shallow",
		"filter",
		"deepen-since",
		"allow-reachable-sha1-in-want",
		"object-format=sha1",
		"object-format=sha256",
	];
	const v2Args = [
		"done",
		"ofs-delta",
		"thin-pack",
		"no-progress",
		"include-tag",
		`have ${SHA_B}`,
		"deepen 2",
		"filter blob:none",
		`shallow ${SHA_B}`,
		`want-ref ${MAIN}`,
		"sideband-all",
		"wait-for-done",
	];
	const allowedV2 = new Set([
		"done",
		"ofs-delta",
		"thin-pack",
		"no-progress",
		"include-tag",
	]);
	let acceptedCount = 0;
	let rejectedCount = 0;
	for (let i = 0; i < 1500; i++) {
		if (rand.bool()) {
			// v0
			const wants = rand.int(3);
			const caps = Array.from({ length: rand.int(3) }, () => rand.pick(v0Caps));
			const withDone = rand.int(4) !== 0;
			const lines: (string | Uint8Array)[] = [];
			const distinct = new Set<string>();
			for (let w = 0; w < wants; w++) {
				const sha = w === 0 ? SHA_A : rand.pick([SHA_A, SHA_B]);
				distinct.add(sha);
				lines.push(
					pkt(
						w === 0 && caps.length > 0
							? `want ${sha} ${caps.join(" ")}\n`
							: `want ${sha}\n`,
					),
				);
			}
			lines.push(FLUSH);
			lines.push(withDone ? pkt("done\n") : FLUSH);
			const result = await parse(join(...lines), { chunk: 1 + rand.int(9) });
			const capsOk = caps.every((cap) =>
				(CAP_ROUTE_V0_CAPABILITIES as readonly string[]).includes(
					cap.split("=")[0],
				) && cap !== "object-format=sha256"
			);
			const expected = distinct.size === 1 && withDone && capsOk;
			equal(result.kind === "request", expected, `v0 case ${i}`);
			if (result.kind === "request") {
				acceptedCount++;
				equal(result.want, SHA_A);
			} else rejectedCount++;
		} else {
			const wants = rand.int(3);
			const args = Array.from({ length: rand.int(4) }, () => rand.pick(v2Args));
			const shas = Array.from(
				{ length: wants },
				(_, w) => w === 0 ? SHA_A : rand.pick([SHA_A, SHA_B]),
			);
			const lines = [...shas.map((sha) => `want ${sha}`), ...args];
			const result = await parse(v2Fetch(lines), { v2: true });
			const doneOk = args.includes("done");
			const argsOk = args.every((arg) => allowedV2.has(arg));
			const expected = new Set(shas).size === 1 && doneOk && argsOk;
			equal(result.kind === "request", expected, `v2 case ${i}: ${lines}`);
			if (result.kind === "request") {
				acceptedCount++;
				equal(result.want, SHA_A);
			} else rejectedCount++;
		}
	}
	ok(acceptedCount > 100, `accepted ${acceptedCount}`);
	ok(rejectedCount > 100, `rejected ${rejectedCount}`);
});

// ---------------------------------------------------------------------------
// synthCapAdvertisement, synthCapV2Capabilities, readUpstreamTip
// ---------------------------------------------------------------------------

const refsOf = (body: Uint8Array): string[] =>
	decodePktLines(body).lines.flatMap((line) => {
		if (line.kind !== "data") return [];
		const text = dec(line.data).replace(/\n$/, "");
		if (text.startsWith("# service=")) return [];
		return [text.split("\0")[0]];
	});

Deno.test("synthCapAdvertisement v0: HEAD → the published name at the SHA, allowlisted capabilities", () => {
	const upstream = golden("upload-pack-v0-ad").response;
	const { capabilities } = readUpstreamTip(upstream, "refs/heads/main");
	ok(capabilities.includes("shallow"), "the upstream advertises shallow");
	const body = synthCapAdvertisement({
		sha: SHA_A,
		publishedRef: MAIN,
		capabilities: [...capabilities, "symref=HEAD:refs/heads/master"],
		protocol: "v0",
	});
	deepStrictEqual(refsOf(body), [`${SHA_A} HEAD`, `${SHA_A} ${MAIN}`]);
	const text = dec(body);
	ok(text.startsWith("001e# service=git-upload-pack\n0000"));
	ok(text.endsWith("0000"));
	const caps = text.split("\0")[1].split("\n")[0].split(" ");
	ok(caps.includes(`symref=HEAD:${MAIN}`));
	for (const cap of caps) {
		ok(
			cap === `symref=HEAD:${MAIN}` ||
				(CAP_ROUTE_V0_CAPABILITIES as readonly string[]).includes(
					cap.split("=")[0],
				),
			`unexpected capability ${cap}`,
		);
	}
	for (
		const stripped of [
			"shallow",
			"deepen-since",
			"deepen-not",
			"deepen-relative",
		]
	) {
		ok(!caps.includes(stripped), `${stripped} is stripped`);
	}
	ok(!caps.includes("symref=HEAD:refs/heads/master"));
	// It parses as an advertisement (the gateway's own rewriter accepts it).
	rewriteAdvertisement(body, {
		service: "git-upload-pack",
		keepRef: () => true,
		capabilities: { protocol: "v0", names: UPLOAD_PACK_V0_CAPABILITIES },
	});
	const tip = readUpstreamTip(body, MAIN);
	equal(tip.sha, SHA_A);
});

Deno.test("synthCapAdvertisement v2-ls-refs: symref-target only when asked, ref-prefix honoured", () => {
	const plain = synthCapAdvertisement({
		sha: SHA_A,
		publishedRef: MAIN,
		capabilities: [],
		protocol: "v2-ls-refs",
	});
	equal(
		dec(plain),
		`0032${SHA_A} HEAD\n003d${SHA_A} ${MAIN}\n0000`,
	);
	const symrefs = synthCapAdvertisement({
		sha: SHA_A,
		publishedRef: MAIN,
		capabilities: [],
		protocol: "v2-ls-refs",
		symrefs: true,
		refPrefixes: ["refs/heads/", "refs/tags/", "HEAD"],
	});
	deepStrictEqual(refsOf(symrefs), [
		`${SHA_A} HEAD symref-target:${MAIN}`,
		`${SHA_A} ${MAIN}`,
	]);
	const tagsOnly = synthCapAdvertisement({
		sha: SHA_A,
		publishedRef: MAIN,
		capabilities: [],
		protocol: "v2-ls-refs",
		refPrefixes: ["refs/tags/"],
	});
	equal(dec(tagsOnly), FLUSH);
	throws(() =>
		synthCapAdvertisement({
			sha: "A".repeat(40),
			publishedRef: MAIN,
			capabilities: [],
			protocol: "v0",
		})
	);
	throws(() =>
		synthCapAdvertisement({
			sha: SHA_A,
			publishedRef: "refs/tags/v1",
			capabilities: [],
			protocol: "v0",
		})
	);
	throws(() =>
		synthCapAdvertisement({
			sha: SHA_A,
			publishedRef: "refs/heads/a b",
			capabilities: [],
			protocol: "v0",
		})
	);
});

Deno.test("synthCapAdvertisement property: never a ref other than HEAD and the published name, never a capability off the allowlist", () => {
	const rand = prng(0xadd5_0001);
	const pool = [
		...UPLOAD_PACK_V0_CAPABILITIES,
		"allow-tip-sha1-in-want",
		"allow-reachable-sha1-in-want",
		"filter",
		"deepen-not",
		"symref=HEAD:refs/heads/master",
		"object-format=sha256",
		"object-format=sha1",
		"agent=x/1",
		"push-cert=abc",
		"session-id=1",
		"packfile-uris",
		"unknown-cap",
	];
	for (let i = 0; i < 500; i++) {
		const caps = Array.from({ length: rand.int(12) }, () => rand.pick(pool));
		const published = rand.pick([MAIN, "refs/heads/trunk", "refs/heads/a/b"]);
		const body = synthCapAdvertisement({
			sha: SHA_B,
			publishedRef: published,
			capabilities: caps,
			protocol: "v0",
		});
		deepStrictEqual(refsOf(body), [`${SHA_B} HEAD`, `${SHA_B} ${published}`]);
		const advertised = dec(body).split("\0")[1].split("\n")[0].split(" ");
		for (const cap of advertised) {
			if (cap === `symref=HEAD:${published}`) continue;
			ok(
				(CAP_ROUTE_V0_CAPABILITIES as readonly string[]).includes(
					cap.split("=")[0],
				) && cap !== "object-format=sha256",
				`case ${i}: ${cap}`,
			);
		}
		const ls = synthCapAdvertisement({
			sha: SHA_B,
			publishedRef: published,
			capabilities: caps,
			protocol: "v2-ls-refs",
			symrefs: rand.bool(),
		});
		for (const ref of refsOf(ls)) {
			const name = ref.split(" ")[1];
			ok(name === "HEAD" || name === published, `case ${i}: ${ref}`);
		}
	}
});

Deno.test("synthCapV2Capabilities: version 2, ls-refs and fetch without features", () => {
	const body = synthCapV2Capabilities();
	const lines = decodePktLines(body).lines.map((line) =>
		line.kind === "data" ? dec(line.data).replace(/\n$/, "") : line.kind
	);
	deepStrictEqual(lines, [
		"version 2",
		CAP_ROUTE_AGENT,
		"ls-refs",
		"fetch",
		"object-format=sha1",
		"flush",
	]);
	const tip = readUpstreamTip(body, MAIN);
	equal(tip.sha, null);
	ok(tip.capabilities.includes("fetch"));
});

Deno.test("readUpstreamTip: v0, v1 and v2 ls-refs advertisements; empty repos; malformed input", () => {
	const v0 = readUpstreamTip(golden("upload-pack-v0-ad").response, MAIN);
	equal(v0.sha, "affd847fb820999d80bb1dfbf5194b7b2bc937d7");
	ok(v0.capabilities.includes("multi_ack"));
	const v1 = readUpstreamTip(golden("upload-pack-v1-ad").response, MAIN);
	ok(v1.sha !== null && /^[0-9a-f]{40}$/.test(v1.sha));
	const ls = readUpstreamTip(golden("upload-pack-v2-ls-refs").response, MAIN);
	equal(ls.sha, "79806f67dcfd37b7f56c367d7bb82ef23f9d0bd7");
	equal(
		readUpstreamTip(golden("upload-pack-v0-ad").response, "refs/heads/master")
			.sha,
		null,
	);
	const empty = join(
		pkt("# service=git-upload-pack\n"),
		FLUSH,
		pkt(`${ZERO} capabilities^{}\0multi_ack ofs-delta\n`),
		FLUSH,
	);
	const tip = readUpstreamTip(empty, MAIN);
	equal(tip.sha, null);
	deepStrictEqual(tip.capabilities, ["multi_ack", "ofs-delta"]);
	throws(() => readUpstreamTip(enc("garbage!"), MAIN));
	throws(() => readUpstreamTip(join(pkt(`${SHA_A} ${MAIN}\n`)), MAIN));
	throws(() =>
		readUpstreamTip(
			join(pkt(`${SHA_A} ${MAIN}\0a\n`), pkt(`${SHA_B} refs/x\0b\n`), FLUSH),
			MAIN,
		)
	);
});

// ---------------------------------------------------------------------------
// stripV0Trailer
// ---------------------------------------------------------------------------

const transform = async (
	bytes: Uint8Array,
	negotiated: { readonly sideBand: boolean; readonly v2: boolean },
	chunk: number,
): Promise<Uint8Array> =>
	await readAll(chunked(bytes, chunk).pipeThrough(stripV0Trailer(negotiated)));

Deno.test("stripV0Trailer: drops a final 0000 only for v0 without side-band", async () => {
	const body = join(pkt("NAK\n"), enc("PACK....payload....checksum"), FLUSH);
	const without = body.subarray(0, body.length - 4);
	for (const chunk of [1, 2, 3, 4, 5, 1 << 20]) {
		deepStrictEqual(
			[...await transform(body, { sideBand: false, v2: false }, chunk)],
			[...without],
			`chunk ${chunk}`,
		);
		for (
			const negotiated of [
				{ sideBand: true, v2: false },
				{ sideBand: false, v2: true },
				{ sideBand: true, v2: true },
			]
		) {
			deepStrictEqual(
				[...await transform(body, negotiated, chunk)],
				[...body],
				`${JSON.stringify(negotiated)} chunk ${chunk}`,
			);
		}
	}
	// Only exactly `0000` is dropped; short and empty bodies pass.
	for (const tail of ["0001", "000", "0000 ", "x0000y", "00\n0"]) {
		const other = join(enc("PACKxyz"), enc(tail));
		deepStrictEqual(
			[...await transform(other, { sideBand: false, v2: false }, 2)],
			[...other],
			tail,
		);
	}
	deepStrictEqual(
		[...await transform(enc(""), { sideBand: false, v2: false }, 1)],
		[],
	);
	deepStrictEqual(
		[...await transform(enc("0000"), { sideBand: false, v2: false }, 1)],
		[],
	);
});

Deno.test("stripV0Trailer property: over the caps matrix, the stream changes only by a final 0000 for v0 without side-band", async () => {
	const rand = prng(0x7a11_e700);
	for (let i = 0; i < 400; i++) {
		const length = rand.int(200);
		const bytes = new Uint8Array(length);
		for (let b = 0; b < length; b++) {
			// Lots of '0' bytes so that `0000` endings are common.
			bytes[b] = rand.int(3) === 0 ? rand.int(256) : 0x30;
		}
		const negotiated = { sideBand: rand.bool(), v2: rand.bool() };
		const out = await transform(bytes, negotiated, 1 + rand.int(8));
		const endsWithFlush = length >= 4 &&
			dec(bytes.subarray(length - 4)) === FLUSH;
		const strip = !negotiated.sideBand && !negotiated.v2 && endsWithFlush;
		deepStrictEqual(
			[...out],
			[...(strip ? bytes.subarray(0, length - 4) : bytes)],
			`case ${i}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Stock git end to end (git http-backend upstream)
// ---------------------------------------------------------------------------

/**
 * A capability-route stand-in over `git http-backend`: the synthesized
 * advertisement (the published `main` at `base`), the request parser, and
 * the forwarded identity body; the response gets the trailer transform.
 */
const capIntercept = (
	base: () => string,
	seen: CapRequest[],
	addTrailer: boolean,
) =>
async (req: InterceptRequest): Promise<Response | undefined> => {
	const gitProtocol = req.headers.get("git-protocol");
	const v2 = (gitProtocol ?? "").includes("version=2");
	if (req.op === "info/refs") {
		if (v2) {
			return new Response(synthCapV2Capabilities(), {
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
				},
			});
		}
		const upstream = new Uint8Array(await (await req.backend()).arrayBuffer());
		const { capabilities } = readUpstreamTip(upstream, "refs/heads/master");
		return new Response(
			synthCapAdvertisement({
				sha: base(),
				publishedRef: MAIN,
				capabilities,
				protocol: "v0",
			}),
			{
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
				},
			},
		);
	}
	if (req.op !== "git-upload-pack") {
		return new Response("not found", { status: 404 });
	}
	const parsed = await parseCapRequest(chunked(req.body), {
		encoding: req.headers.get("content-encoding"),
		gitProtocol,
		maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
	});
	if (parsed.kind === "rejected") {
		return new Response(join(pkt(`ERR ${parsed.reason}\n`)), {
			headers: { "content-type": "application/x-git-upload-pack-result" },
		});
	}
	seen.push(parsed);
	if (parsed.command === "ls-refs") {
		return new Response(
			synthCapAdvertisement({
				sha: base(),
				publishedRef: MAIN,
				capabilities: [],
				protocol: "v2-ls-refs",
				symrefs: parsed.symrefs,
				refPrefixes: parsed.refPrefixes,
			}),
			{ headers: { "content-type": "application/x-git-upload-pack-result" } },
		);
	}
	const headers = new Headers(req.headers);
	headers.delete("content-encoding");
	const res = await req.backend({ body: parsed.body, headers });
	const raw = new Uint8Array(await res.arrayBuffer());
	const sent = addTrailer && !parsed.sideBand && parsed.protocol === "v0"
		? join(raw, FLUSH)
		: raw;
	const out = await readAll(
		chunked(sent, 7).pipeThrough(
			stripV0Trailer({
				sideBand: parsed.sideBand,
				v2: parsed.protocol === "v2",
			}),
		),
	);
	return new Response(out, {
		headers: { "content-type": "application/x-git-upload-pack-result" },
	});
};

Deno.test({
	name:
		"stock git clones a master source through the synthesized advertisement and ends with exactly HEAD → refs/heads/main (v0, v1, v2)",
	ignore: !hasGit,
	fn: () =>
		withGitServer(async (sandbox, server) => {
			const bare = await initBare(sandbox, "src");
			const work = await initWork(sandbox, "src-work", 3);
			await git(sandbox, ["branch", "-m", "main", "master"], { cwd: work });
			await git(sandbox, ["branch", "feature"], { cwd: work });
			await commitFile(sandbox, work, "more.txt", "more\n");
			await git(sandbox, ["tag", "v1"], { cwd: work });
			await git(sandbox, ["push", "-q", bare, "master", "feature", "v1"], {
				cwd: work,
			});
			await git(sandbox, ["symbolic-ref", "HEAD", "refs/heads/master"], {
				cwd: bare,
			});
			const base = await revParse(sandbox, work, "master~1");
			const seen: CapRequest[] = [];
			server.setIntercept(capIntercept(() => base, seen, true));
			for (const version of ["0", "1", "2"]) {
				const dir = `${sandbox.root}/clone-v${version}`;
				await git(sandbox, [
					"-c",
					`protocol.version=${version}`,
					"clone",
					"-q",
					`${server.url}/src.git`,
					dir,
				]);
				const refs = (await git(sandbox, ["show-ref"], { cwd: dir })).text
					.trim().split("\n");
				deepStrictEqual(refs, [
					`${base} refs/heads/main`,
					`${base} refs/remotes/origin/HEAD`,
					`${base} refs/remotes/origin/main`,
				], `protocol ${version}`);
				await git(sandbox, ["fsck", "--strict"], { cwd: dir });
			}
			const fetches = seen.filter((r) => r.command === "fetch");
			equal(fetches.length, 3);
			for (const req of fetches) equal(req.want, base);
			ok(seen.some((r) => r.command === "ls-refs" && r.symrefs));
			// ls-remote shows only HEAD and main, at the base.
			const listed =
				(await git(sandbox, ["ls-remote", `${server.url}/src.git`]))
					.text.trim().split("\n");
			deepStrictEqual(listed, [`${base}\tHEAD`, `${base}\t${MAIN}`]);
		}),
});
