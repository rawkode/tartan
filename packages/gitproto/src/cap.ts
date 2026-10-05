// The capability route's protocol profile: the request parser that admits
// exactly one `want` (the fail-closed twin of the public view's parser), the
// synthesized advertisement that names `HEAD` → the published branch at one SHA
// and nothing else, the reader of the upstream tip that advertisement replaces,
// and the conditional trailing-flush transform.
//
// Pure Web-platform code: no tokens, no policy, no I/O. WP4's capability
// route (`src/kernel/gateway/cap.ts`) composes these with the MAC, RepoDO's
// `capUse` and the per-request upstream token.

import { invalid, SHA1_RE } from "@tartan/contract";
import { type Bytes, concat, decodeStrict } from "./bytes.ts";
import {
	capabilityName,
	filterCapabilities,
	splitCapabilities,
} from "./capabilities.ts";
import {
	chomp,
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
	type PktLine,
} from "./pktline.ts";
import { isValidPushRefname } from "./refname.ts";
import {
	parseUploadRequest,
	type UploadProfile,
	type UploadRejection,
} from "./upload.ts";

/**
 * Capabilities the route advertises and accepts on the one `want` line
 * (v0/v1): the upstream's, minus everything that negotiates history or
 * names objects other than the base (`shallow`, `deepen-*`, `filter`,
 * `allow-*-sha1-in-want`) and anything unknown.
 */
export const CAP_ROUTE_V0_CAPABILITIES = [
	"multi_ack",
	"multi_ack_detailed",
	"side-band",
	"side-band-64k",
	"thin-pack",
	"ofs-delta",
	"no-progress",
	"include-tag",
	"no-done",
	"agent",
	"object-format",
] as const;

/** The route's synthesized v2 capability advertisement: `ls-refs`, `fetch` (no features). */
export const CAP_ROUTE_V2_CAPABILITIES = {
	"ls-refs": [],
	fetch: [],
	agent: [],
	"object-format": ["sha1"],
} as const;

/** The agent string of the advertisements the route synthesizes. */
export const CAP_ROUTE_AGENT = "agent=tartan-gateway";

/**
 * The request grammar: v0/v1 one `want` line
 * (capabilities on it), a flush, `done`; v2 `ls-refs` (answered locally) and
 * `fetch` with one `want`, `done`, `ofs-delta`, `thin-pack`, `no-progress`,
 * `include-tag`. `have`, `shallow`, `deepen*`, `filter`, `want-ref` and
 * every other command or argument are refused by the profile itself.
 */
export const CAP_ROUTE_PROFILE: UploadProfile = {
	v0: { lines: ["want", "done"], capabilities: CAP_ROUTE_V0_CAPABILITIES },
	v2: {
		"ls-refs": ["peel", "symrefs", "unborn", "ref-prefix"],
		fetch: [
			"want",
			"done",
			"ofs-delta",
			"thin-pack",
			"no-progress",
			"include-tag",
		],
	},
};

export type CapRequestOptions = {
	readonly encoding: string | null;
	readonly gitProtocol: string | null;
	readonly maxDecodedBytes: number;
};

/**
 * One accepted capability-route request. `ls-refs` (v2) carries no want;
 * `fetch` carries exactly one. The route still checks `want === base`.
 */
export type CapRequest = {
	readonly kind: "request";
	readonly protocol: "v0" | "v2";
	readonly command: "ls-refs" | "fetch";
	readonly want: string | null;
	/** Side-band (v0/v1) was negotiated: the trailer transform must not strip. */
	readonly sideBand: boolean;
	/** v2 `ls-refs` asked for `symrefs` (the synthesized answer adds `symref-target`). */
	readonly symrefs: boolean;
	/** v2 `ls-refs` `ref-prefix` arguments (the synthesized answer honours them). */
	readonly refPrefixes: readonly string[];
	/** v0: the want line's capabilities; v2: the capability lines. */
	readonly capabilities: readonly string[];
	/** The accepted body, identity-encoded, for forwarding. */
	readonly body: Uint8Array;
};

const refuse = (
	code: UploadRejection["code"],
	detail: string,
): UploadRejection => ({
	kind: "rejected",
	reason: "unsupported-argument",
	code,
	detail,
});

/**
 * v0/v1: exactly one wanted object (`want <sha>`, capabilities on the first
 * want line), `done`, flushes. v2: `command=ls-refs`, or `command=fetch`
 * with one wanted object, `done`, `ofs-delta`, `thin-pack`, `no-progress`,
 * `include-tag`. Repeated want lines of the same SHA count as one. Anything
 * else (`have`, `shallow`, `deepen*`, `filter`, `want-ref`, a want of a
 * second object, a fetch without `done`) rejects the whole request.
 */
export const parseCapRequest = async (
	body: ReadableStream<Uint8Array>,
	options: CapRequestOptions,
): Promise<CapRequest | UploadRejection> => {
	const parsed = await parseUploadRequest(body, {
		...options,
		profile: CAP_ROUTE_PROFILE,
	});
	if (parsed.kind === "rejected") return parsed;
	if (parsed.command === "ls-refs") {
		return {
			kind: "request",
			protocol: "v2",
			command: "ls-refs",
			want: null,
			sideBand: false,
			symrefs: parsed.arguments.includes("symrefs"),
			refPrefixes: parsed.refPrefixes,
			capabilities: parsed.capabilities,
			body: parsed.body,
		};
	}
	if (parsed.command !== "fetch") {
		return {
			kind: "rejected",
			reason: "unsupported-command",
			code: "command",
			detail: `command ${parsed.command}`,
		};
	}
	// One object: repeated `want` lines of the same SHA name it once (stock
	// git v2 sends one per advertised ref, here `HEAD` and the branch).
	if (parsed.wants.length !== 1) {
		return refuse(
			"argument",
			`exactly one wanted object, not ${parsed.wants.length}`,
		);
	}
	if (!parsed.done) return refuse("truncated", "a fetch must end with done");
	const names = parsed.capabilities.map(capabilityName);
	return {
		kind: "request",
		protocol: parsed.protocol,
		command: "fetch",
		want: parsed.wants[0],
		sideBand: parsed.protocol === "v0" &&
			(names.includes("side-band") || names.includes("side-band-64k")),
		symrefs: false,
		refPrefixes: [],
		capabilities: parsed.capabilities,
		body: parsed.body,
	};
};

const checkTarget = (sha: string, publishedRef: string): void => {
	if (!SHA1_RE.test(sha)) throw invalid(`not a lowercase SHA-1: ${sha}`);
	if (!publishedRef.startsWith("refs/heads/")) {
		throw invalid(`the published ref must be a branch: ${publishedRef}`);
	}
	if (!isValidPushRefname(publishedRef)) {
		throw invalid(`invalid published ref: ${publishedRef}`);
	}
};

/** Whether `ref` passes the client's `ref-prefix` arguments (none = every ref). */
const matchesPrefixes = (ref: string, prefixes: readonly string[]): boolean =>
	prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));

/**
 * The synthesized advertisement: `HEAD` as a symref to `publishedRef`
 * (`refs/heads/main` for every lane repo) and one line for `publishedRef` at
 * `sha`, nothing else. `v0` = a smart-HTTP `info/refs` body (service line,
 * flush, refs, capabilities on the first line, filtered to
 * `CAP_ROUTE_V0_CAPABILITIES`); `v2-ls-refs` = an `ls-refs` response
 * (`symref-target` when `symrefs`, filtered by `refPrefixes`).
 */
export const synthCapAdvertisement = (
	input: {
		readonly sha: string;
		readonly publishedRef: string;
		readonly capabilities: readonly string[];
		readonly protocol: "v0" | "v2-ls-refs";
		readonly symrefs?: boolean;
		readonly refPrefixes?: readonly string[];
	},
): Bytes => {
	const { sha, publishedRef } = input;
	checkTarget(sha, publishedRef);
	const flush = encodeSpecialPkt("flush");
	if (input.protocol === "v0") {
		const caps = [
			...filterCapabilities(input.capabilities, [
				...CAP_ROUTE_V0_CAPABILITIES,
			]),
			`symref=HEAD:${publishedRef}`,
		].join(" ");
		return concat([
			encodePktLine("# service=git-upload-pack\n"),
			flush,
			encodePktLine(`${sha} HEAD\0${caps}\n`),
			encodePktLine(`${sha} ${publishedRef}\n`),
			flush,
		]);
	}
	const prefixes = input.refPrefixes ?? [];
	const lines: Uint8Array[] = [];
	if (matchesPrefixes("HEAD", prefixes)) {
		lines.push(
			encodePktLine(
				input.symrefs
					? `${sha} HEAD symref-target:${publishedRef}\n`
					: `${sha} HEAD\n`,
			),
		);
	}
	if (matchesPrefixes(publishedRef, prefixes)) {
		lines.push(encodePktLine(`${sha} ${publishedRef}\n`));
	}
	return concat([...lines, flush]);
};

/**
 * The route's v2 capability advertisement (`info/refs` with `Git-Protocol:
 * version=2`): `version 2`, `agent`, `ls-refs`, `fetch` without features,
 * `object-format=sha1`. No service line, as `git http-backend` answers v2.
 */
export const synthCapV2Capabilities = (): Bytes =>
	concat([
		encodePktLine("version 2\n"),
		encodePktLine(`${CAP_ROUTE_AGENT}\n`),
		encodePktLine("ls-refs\n"),
		encodePktLine("fetch\n"),
		encodePktLine("object-format=sha1\n"),
		encodeSpecialPkt("flush"),
	]);

const lineText = (line: PktLine): string => {
	if (line.kind !== "data") throw invalid(`unexpected ${line.kind} packet`);
	const text = decodeStrict(chomp(line.data));
	if (text === null) throw invalid("advertisement line is not UTF-8");
	return text;
};

const ZERO = "0".repeat(40);
const TIP_LINE_RE = /^([0-9a-f]{40}|unborn) ([^ \0]+)(?: .*)?$/;

/**
 * Reads an upstream advertisement (v0/v1 `info/refs`, or a v2 `ls-refs`
 * response) for the tip of `ref` and the advertised capabilities. An empty
 * repository (`capabilities^{}`) or a ref that is absent gives `sha: null`.
 * A v2 capability advertisement has no refs: `sha` is null and the
 * capabilities are its lines. Malformed input throws `invalid`.
 */
export const readUpstreamTip = (
	advertisement: Uint8Array,
	ref: string,
): {
	readonly sha: string | null;
	readonly capabilities: readonly string[];
} => {
	const lines = decodePktLines(advertisement).lines;
	let i = 0;
	if (
		lines[i]?.kind === "data" && lineText(lines[i]).startsWith("# service=")
	) {
		if (lines[i + 1]?.kind !== "flush") {
			throw invalid("no flush after the service line");
		}
		i += 2;
	}
	if (lines[i]?.kind === "data") {
		const first = lineText(lines[i]);
		if (first === "version 2") {
			const capabilities: string[] = [];
			for (i++; i < lines.length && lines[i].kind === "data"; i++) {
				capabilities.push(lineText(lines[i]));
			}
			return { sha: null, capabilities };
		}
		if (first === "version 1") i++;
	}
	let capabilities: string[] | null = null;
	let sha: string | null = null;
	let ended = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.kind === "flush") {
			ended = true;
			break;
		}
		const text = lineText(line);
		const nul = text.indexOf("\0");
		if (nul >= 0) {
			if (capabilities !== null) {
				throw invalid("capabilities on a later ref line");
			}
			capabilities = splitCapabilities(text.slice(nul + 1));
		}
		const refPart = nul >= 0 ? text.slice(0, nul) : text;
		if (refPart.startsWith("shallow ")) continue;
		const match = TIP_LINE_RE.exec(refPart);
		if (!match) throw invalid("malformed ref line");
		const [, id, name] = match;
		if (name === ref && id !== "unborn" && id !== ZERO && sha === null) {
			sha = id;
		}
	}
	if (!ended) throw invalid("advertisement ends without a flush");
	return { sha, capabilities: capabilities ?? [] };
};

const FLUSH_BYTES = [0x30, 0x30, 0x30, 0x30];

const isFlushPkt = (tail: Uint8Array): boolean =>
	tail.length === 4 && tail.every((byte, i) => byte === FLUSH_BYTES[i]);

/**
 * Drops a trailing flush packet after the pack when neither side-band nor
 * protocol v2 was negotiated: holds back the last 4 bytes of the response
 * and drops them only in that case and only when they are exactly `0000`;
 * otherwise the stream is unchanged, byte for byte.
 */
export const stripV0Trailer = (
	negotiated: { readonly sideBand: boolean; readonly v2: boolean },
): TransformStream<Uint8Array, Uint8Array> => {
	if (negotiated.sideBand || negotiated.v2) {
		return new TransformStream<Uint8Array, Uint8Array>();
	}
	let tail: Uint8Array = new Uint8Array(0);
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (chunk.length === 0) return;
			if (chunk.length >= 4) {
				if (tail.length > 0) controller.enqueue(tail);
				if (chunk.length > 4) {
					controller.enqueue(chunk.subarray(0, chunk.length - 4));
				}
				tail = chunk.slice(chunk.length - 4);
				return;
			}
			const all = concat([tail, chunk]);
			if (all.length > 4) {
				controller.enqueue(all.subarray(0, all.length - 4));
				tail = all.slice(all.length - 4);
			} else tail = all;
		},
		flush(controller) {
			if (tail.length > 0 && !isFlushPkt(tail)) controller.enqueue(tail);
		},
	});
};
