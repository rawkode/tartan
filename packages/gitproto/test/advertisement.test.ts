// Advertisement rewriters: ref filtering, capability allowlists, the
// placeholder, peeled tags, symrefs, v2 capability lines and ls-refs responses,
// on recorded advertisements.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	type CapabilityAllowlist,
	decodePktLines,
	encodePktLine,
	RECEIVE_PACK_CAPABILITIES,
	rewriteAdvertisement,
	rewriteLsRefsResponse,
	rewriteV2Capabilities,
	UPLOAD_PACK_V0_CAPABILITIES,
	UPLOAD_PACK_V2_CAPABILITIES,
} from "../src/index.ts";
import { dec, golden, join, SHA_A, SHA_B, SHA_C, ZERO } from "./helpers.ts";

const V0_UPLOAD: CapabilityAllowlist = {
	protocol: "v0",
	names: UPLOAD_PACK_V0_CAPABILITIES,
};
const V0_RECEIVE: CapabilityAllowlist = {
	protocol: "v0",
	names: RECEIVE_PACK_CAPABILITIES,
};
const V2: CapabilityAllowlist = {
	protocol: "v2",
	commands: UPLOAD_PACK_V2_CAPABILITIES,
};

/** Data lines of a pkt-line body, newline-chomped, with `|` for specials. */
const lines = (bytes: Uint8Array): string[] =>
	decodePktLines(bytes).lines.map((line) =>
		line.kind === "data" ? dec(line.data).replace(/\n$/, "") : `|${line.kind}`
	);

const capsOf = (line: string): string[] => line.split("\0")[1].split(" ");

const hidden = (ref: string) =>
	!ref.startsWith("refs/heads/lanes/") && !ref.startsWith("refs/tartan/");

const adWith = (service: string, refs: string[], caps: string) =>
	join(
		encodePktLine(`# service=${service}\n`),
		"0000",
		...refs.map((r, i) =>
			encodePktLine(i === 0 ? `${r}\0${caps}\n` : `${r}\n`)
		),
		"0000",
	);

Deno.test("golden: the v0 upload-pack advertisement keeps only allowlisted caps", () => {
	const out = rewriteAdvertisement(golden("upload-pack-v0-ad").response, {
		service: "git-upload-pack",
		keepRef: () => true,
		capabilities: V0_UPLOAD,
	});
	const text = lines(out);
	equal(text[0], "# service=git-upload-pack");
	equal(text[1], "|flush");
	const caps = capsOf(text[2]);
	for (const stripped of ["deepen-not", "filter", "allow-tip-sha1-in-want"]) {
		ok(!caps.includes(stripped), stripped);
	}
	ok(caps.includes("symref=HEAD:refs/heads/main"));
	ok(caps.includes("multi_ack_detailed"));
	ok(caps.includes("object-format=sha1"));
	ok(caps.some((c) => c.startsWith("agent=")));
	equal(text[text.length - 1], "|flush");
	// Ref lines other than the first are unchanged.
	const original = lines(golden("upload-pack-v0-ad").response);
	deepStrictEqual(text.slice(3), original.slice(3));
});

Deno.test("golden: v1 keeps its version line; receive-pack drops nothing it allows", () => {
	const v1 = lines(
		rewriteAdvertisement(golden("upload-pack-v1-ad").response, {
			service: "git-upload-pack",
			keepRef: () => true,
			capabilities: V0_UPLOAD,
		}),
	);
	equal(v1[2], "version 1");
	const receive = lines(
		rewriteAdvertisement(golden("receive-pack-ad").response, {
			service: "git-receive-pack",
			keepRef: () => true,
			capabilities: V0_RECEIVE,
		}),
	);
	deepStrictEqual(capsOf(receive[2]), [
		"report-status",
		"report-status-v2",
		"delete-refs",
		"side-band-64k",
		"quiet",
		"atomic",
		"ofs-delta",
		"object-format=sha1",
		capsOf(receive[2])[8],
	]);
	ok(capsOf(receive[2])[8].startsWith("agent=git/2.55.0"));
	const empty = lines(
		rewriteAdvertisement(golden("receive-pack-ad-empty").response, {
			service: "git-receive-pack",
			keepRef: () => true,
			capabilities: V0_RECEIVE,
		}),
	);
	ok(empty[2].startsWith(`${ZERO} capabilities^{}\0report-status`));
});

Deno.test("push-cert, push-options and unknown receive-pack caps are stripped", () => {
	const ad = adWith(
		"git-receive-pack",
		[`${SHA_A} refs/heads/main`],
		"report-status push-cert=1234-abcd push-options atomic future-cap side-band-64k session-id agent=x",
	);
	const out = lines(
		rewriteAdvertisement(ad, {
			service: "git-receive-pack",
			keepRef: () => true,
			capabilities: V0_RECEIVE,
		}),
	);
	deepStrictEqual(capsOf(out[2]), [
		"report-status",
		"atomic",
		"side-band-64k",
		"agent=x",
	]);
});

Deno.test("hidden refs are filtered; caps move to the first kept line or the placeholder", () => {
	const ad = adWith(
		"git-upload-pack",
		[
			`${SHA_A} refs/heads/lanes/ln_a`,
			`${SHA_B} refs/heads/main`,
			`${SHA_C} refs/tags/v1`,
			`${SHA_A} refs/tags/v1^{}`,
			`${SHA_B} refs/tartan/attic/x`,
		],
		"multi_ack side-band-64k symref=HEAD:refs/heads/main allow-tip-sha1-in-want",
	);
	const out = lines(
		rewriteAdvertisement(ad, {
			service: "git-upload-pack",
			keepRef: hidden,
			capabilities: V0_UPLOAD,
		}),
	);
	deepStrictEqual(out.slice(2), [
		`${SHA_B} refs/heads/main\0multi_ack side-band-64k symref=HEAD:refs/heads/main`,
		`${SHA_C} refs/tags/v1`,
		`${SHA_A} refs/tags/v1^{}`,
		"|flush",
	]);
	const none = lines(
		rewriteAdvertisement(ad, {
			service: "git-upload-pack",
			keepRef: () => false,
			capabilities: V0_UPLOAD,
		}),
	);
	deepStrictEqual(none.slice(2), [
		`${ZERO} capabilities^{}\0multi_ack side-band-64k`,
		"|flush",
	]);
	// A peeled line shares its tag's fate.
	const noTags = lines(
		rewriteAdvertisement(ad, {
			service: "git-upload-pack",
			keepRef: (ref) => hidden(ref) && !ref.startsWith("refs/tags/"),
			capabilities: V0_UPLOAD,
		}),
	);
	ok(!noTags.some((l) => l.includes("refs/tags/")));
	// A symref to a hidden ref is dropped.
	const hiddenHead = lines(
		rewriteAdvertisement(
			adWith("git-upload-pack", [
				`${SHA_A} HEAD`,
				`${SHA_A} refs/heads/lanes/x`,
			], "symref=HEAD:refs/heads/lanes/x"),
			{ service: "git-upload-pack", keepRef: hidden, capabilities: V0_UPLOAD },
		),
	);
	deepStrictEqual(hiddenHead[2], `${SHA_A} HEAD\0`);
});

Deno.test("malformed advertisements throw instead of passing through", () => {
	const opts = {
		service: "git-upload-pack" as const,
		keepRef: () => true,
		capabilities: V0_UPLOAD,
	};
	throws(() =>
		rewriteAdvertisement(
			join(
				encodePktLine("# service=git-upload-pack\n"),
				"0000",
				encodePktLine(`${SHA_A} refs/heads/main\n`),
			),
			opts,
		)
	);
	throws(() =>
		rewriteAdvertisement(
			adWith("git-receive-pack", [`${SHA_A} refs/heads/main`], ""),
			opts,
		)
	);
	throws(() =>
		rewriteAdvertisement(join(encodePktLine("garbage\n"), "0000"), opts)
	);
	throws(() =>
		rewriteAdvertisement(
			join(adWith("git-upload-pack", [`${SHA_A} refs/heads/main`], ""), "0000"),
			opts,
		)
	);
	throws(() =>
		rewriteAdvertisement(golden("upload-pack-v2-caps").response, opts)
	);
	throws(() =>
		rewriteAdvertisement(golden("upload-pack-v0-ad").response, {
			...opts,
			capabilities: V2,
		})
	);
});

Deno.test("golden: the v2 capability advertisement keeps the allowlist only", () => {
	const out = lines(
		rewriteV2Capabilities(golden("upload-pack-v2-caps").response, V2),
	);
	equal(out[0], "version 2");
	ok(out[1].startsWith("agent=git/2.55.0"));
	deepStrictEqual(out.slice(2), [
		"ls-refs=unborn",
		"fetch=shallow",
		"object-format=sha1",
		"|flush",
	]);
});

Deno.test("v2: Artifacts-shaped and hostile capability lines", () => {
	const ad = join(
		encodePktLine("# service=git-upload-pack\n"),
		"0000",
		encodePktLine("version 2\n"),
		encodePktLine("agent=artifacts/1.0\n"),
		encodePktLine("ls-refs=unborn\n"),
		encodePktLine(
			"fetch=shallow filter sideband-all packfile-uris wait-for-done\n",
		),
		encodePktLine("server-option\n"),
		encodePktLine("object-info\n"),
		encodePktLine("bundle-uri\n"),
		encodePktLine("session-id=abc\n"),
		encodePktLine("object-format=sha256\n"),
		encodePktLine("promisor-remote=x\n"),
		"0000",
	);
	deepStrictEqual(lines(rewriteV2Capabilities(ad, V2)), [
		"# service=git-upload-pack",
		"|flush",
		"version 2",
		"agent=artifacts/1.0",
		"ls-refs=unborn",
		"fetch=shallow filter",
		"|flush",
	]);
	throws(() => rewriteV2Capabilities(golden("upload-pack-v0-ad").response, V2));
	throws(() =>
		rewriteV2Capabilities(golden("upload-pack-v2-caps").response, V0_UPLOAD)
	);
});

Deno.test("golden: ls-refs responses are filtered, symref targets to hidden refs dropped", () => {
	const g = golden("upload-pack-v2-ls-refs").response;
	deepStrictEqual(lines(rewriteLsRefsResponse(g, () => true)), lines(g));
	const body = join(
		encodePktLine(`${SHA_A} HEAD symref-target:refs/heads/main\n`),
		encodePktLine(`${SHA_A} refs/heads/main\n`),
		encodePktLine(`${SHA_B} refs/heads/lanes/ln_x\n`),
		encodePktLine(`${SHA_C} refs/tags/v1 peeled:${SHA_A}\n`),
		encodePktLine(`unborn refs/heads/x symref-target:refs/tartan/y\n`),
		"0000",
	);
	deepStrictEqual(lines(rewriteLsRefsResponse(body, hidden)), [
		`${SHA_A} HEAD symref-target:refs/heads/main`,
		`${SHA_A} refs/heads/main`,
		`${SHA_C} refs/tags/v1 peeled:${SHA_A}`,
		"unborn refs/heads/x",
		"|flush",
	]);
	throws(() =>
		rewriteLsRefsResponse(join(encodePktLine("nonsense\n"), "0000"), hidden)
	);
	throws(() =>
		rewriteLsRefsResponse(encodePktLine(`${SHA_A} refs/heads/main\n`), hidden)
	);
});
