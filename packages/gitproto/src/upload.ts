// Upload-pack: the fail-closed request parser.
// The body is decoded (gzip under a byte cap), every pkt-line
// is parsed, and the request is accepted only when every line, capability
// and argument is on the profile's allowlist and in the order upload-pack
// itself requires. Anything else rejects the whole request; the caller
// forwards nothing and answers `ERR <reason>`.

import type { UploadReason } from "@tartan/contract/kernel.ts";
import { SHA1_RE } from "@tartan/contract";
import { byteTransform, decodeStrict, readCapped } from "./bytes.ts";
import {
	capabilityName,
	isAllowedCapability,
	splitCapabilities,
	UPLOAD_PACK_V0_CAPABILITIES,
} from "./capabilities.ts";
import { chomp, decodePktLines, type PktLine } from "./pktline.ts";

/** The decoded-body cap of the public view and the capability route (4 MiB). */
export const UPLOAD_DECODE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What a parser profile accepts, as data: per protocol, the allowed
 * commands, arguments and first-line capabilities. `PUBLIC_VIEW_PROFILE` is
 * the public view's.
 */
export type UploadProfile = {
	readonly v0: {
		readonly lines: readonly string[];
		readonly capabilities: readonly string[];
	};
	readonly v2: Readonly<Record<string, readonly string[]>>;
	/**
	 * Capability lines a v2 request may carry before its arguments (default
	 * `V2_REQUEST_CAPABILITIES`: `agent=…`, `object-format=sha1`).
	 */
	readonly v2Capabilities?: readonly string[];
};

/** The v2 request capabilities stock git sends that the allowlist keeps. */
export const V2_REQUEST_CAPABILITIES = ["agent", "object-format"] as const;

/** The public view's upload-pack profile. */
export const PUBLIC_VIEW_PROFILE: UploadProfile = {
	v0: {
		lines: [
			"want",
			"have",
			"shallow",
			"deepen",
			"deepen-since",
			"deepen-relative",
			"done",
		],
		capabilities: UPLOAD_PACK_V0_CAPABILITIES,
	},
	v2: {
		"ls-refs": ["peel", "symrefs", "unborn", "ref-prefix"],
		fetch: [
			"want",
			"have",
			"done",
			"thin-pack",
			"no-progress",
			"include-tag",
			"ofs-delta",
			"shallow",
			"deepen",
			"deepen-since",
			"deepen-relative",
			"filter",
		],
	},
};

export type UploadRequestOptions = {
	/** The request's `Content-Encoding` (`gzip` is decoded under the cap). */
	readonly encoding: string | null;
	/** The request's `Git-Protocol` header (`version=2` ⇒ v2). */
	readonly gitProtocol: string | null;
	/** 4 MiB (`UPLOAD_DECODE_MAX_BYTES`); over it or undecodable ⇒ `upload-encoding`. */
	readonly maxDecodedBytes: number;
	readonly profile: UploadProfile;
};

/** Why an upload-pack request was rejected (diagnostics; the wire reason is `reason`). */
export type UploadErrorCode =
	| "encoding"
	| "too-large"
	| "undecodable"
	| "bad-pkt"
	| "empty"
	| "bad-line"
	| "command"
	| "capability"
	| "argument"
	| "order"
	| "truncated"
	| "trailing-data";

/** A whole-request rejection of an upload-pack request (`ERR <reason>`). */
export type UploadRejection = {
	readonly kind: "rejected";
	readonly reason: UploadReason;
	readonly code: UploadErrorCode;
	readonly detail: string;
};

export type UploadRequest = {
	readonly kind: "request";
	readonly protocol: "v0" | "v2";
	/** v2 command (`ls-refs` | `fetch`); `fetch` for v0/v1. */
	readonly command: string;
	/** Distinct wants, in request order. */
	readonly wants: readonly string[];
	/** v2 `ls-refs` `ref-prefix` arguments. */
	readonly refPrefixes: readonly string[];
	/** The accepted body, identity-encoded, for forwarding. */
	readonly body: Uint8Array;
	/** Distinct `have` ids. */
	readonly haves: readonly string[];
	/** Distinct `shallow` ids (the client's shallow boundary). */
	readonly shallows: readonly string[];
	/** v0: the first want line's capabilities; v2: the capability lines. */
	readonly capabilities: readonly string[];
	/** v2: every argument line, as sent; v0: every line keyword, in order. */
	readonly arguments: readonly string[];
	/** The request ended with `done`. */
	readonly done: boolean;
};

const reject = (
	reason: UploadReason,
	code: UploadErrorCode,
	detail: string,
): UploadRejection => ({ kind: "rejected", reason, code, detail });

const argumentError = (code: UploadErrorCode, detail: string) =>
	reject("unsupported-argument", code, detail);

/** `Git-Protocol: version=2[:…]` ⇒ v2; anything else is v0/v1. */
export const isProtocolV2 = (gitProtocol: string | null): boolean =>
	(gitProtocol ?? "").split(":").some((part) => part.trim() === "version=2");

/**
 * Decodes the body: identity or `gzip` only, never more than `maxBytes`
 * decoded bytes (a gzip bomb stops at the cap: the decoder is cancelled).
 */
export const decodeRequestBody = async (
	body: ReadableStream<Uint8Array>,
	encoding: string | null,
	maxBytes: number,
): Promise<
	| { readonly ok: true; readonly bytes: Uint8Array }
	| UploadRejection
> => {
	const name = (encoding ?? "").trim().toLowerCase();
	if (name !== "" && name !== "identity" && name !== "gzip") {
		await body.cancel("unsupported encoding").catch(() => {});
		return reject("upload-encoding", "encoding", `encoding ${name}`);
	}
	const source = name === "gzip"
		? body.pipeThrough(byteTransform(new DecompressionStream("gzip")))
		: body;
	try {
		const read = await readCapped(source, maxBytes);
		if (!read.ok) {
			return reject(
				"upload-encoding",
				"too-large",
				`decoded body over ${maxBytes} bytes`,
			);
		}
		return { ok: true, bytes: read.bytes };
	} catch {
		return reject("upload-encoding", "undecodable", "body does not decode");
	}
};

const DEEPEN_RE = /^[1-9][0-9]{0,9}$/;
const TIMESTAMP_RE = /^[0-9]{1,20}$/;
// deno-lint-ignore no-control-regex
const REF_TOKEN_RE = /^[^\u0000- \u007f]+$/;
const SIMPLE_FILTER_RE =
	/^(?:blob:none|blob:limit=[0-9]{1,20}[kmgKMG]?|tree:[0-9]{1,10}|object:type=(?:blob|tree|commit|tag))$/;

/**
 * Filter specs that never read an object named by the client: `blob:none`,
 * `blob:limit=<n>`, `tree:<depth>`, `object:type=<t>` and `combine:` of
 * those. `sparse:oid=<blob>` (it reads a blob the client names) is refused.
 */
export const isAllowedFilterSpec = (spec: string): boolean => {
	if (SIMPLE_FILTER_RE.test(spec)) return true;
	if (!spec.startsWith("combine:")) return false;
	const parts = spec.slice("combine:".length).split("+");
	if (parts.length < 2) return false;
	return parts.every((part) => {
		try {
			return SIMPLE_FILTER_RE.test(decodeURIComponent(part));
		} catch {
			return false;
		}
	});
};

const isDeepen = (value: string): boolean =>
	DEEPEN_RE.test(value) && Number(value) <= 0x7fffffff;

/** Argument value grammar; `null` = the argument takes no value. */
const VALUE_CHECKS: Readonly<
	Record<string, ((value: string) => boolean) | null>
> = {
	want: (v) => SHA1_RE.test(v),
	have: (v) => SHA1_RE.test(v),
	shallow: (v) => SHA1_RE.test(v),
	deepen: isDeepen,
	"deepen-since": (v) => TIMESTAMP_RE.test(v),
	"deepen-not": (v) => REF_TOKEN_RE.test(v),
	"want-ref": (v) => REF_TOKEN_RE.test(v),
	filter: isAllowedFilterSpec,
	"ref-prefix": (v) => REF_TOKEN_RE.test(v),
	done: null,
	"thin-pack": null,
	"no-progress": null,
	"include-tag": null,
	"ofs-delta": null,
	"deepen-relative": null,
	"wait-for-done": null,
	"sideband-all": null,
	peel: null,
	symrefs: null,
	unborn: null,
};

/** v0/v1 keywords of the first section (`receive_needs`) and the second (`get_common_commits`). */
const V0_NEEDS = new Set([
	"want",
	"shallow",
	"deepen",
	"deepen-since",
	"deepen-not",
	"filter",
]);
const V0_HAVES = new Set(["have", "done"]);

type Line = { readonly keyword: string; readonly value: string | null };

const splitLine = (data: Uint8Array): Line | null => {
	const text = decodeStrict(chomp(data));
	if (text === null || text.length === 0) return null;
	const space = text.indexOf(" ");
	return space < 0
		? { keyword: text, value: null }
		: { keyword: text.slice(0, space), value: text.slice(space + 1) };
};

/** Checks `keyword value` against the value grammar (`allowed` already checked). */
const valueOk = (keyword: string, value: string | null): boolean => {
	if (!Object.hasOwn(VALUE_CHECKS, keyword)) return false;
	const check = VALUE_CHECKS[keyword];
	return check === null ? value === null : value !== null && check(value);
};

type Acc = {
	wants: string[];
	haves: string[];
	shallows: string[];
	refPrefixes: string[];
	capabilities: string[];
	args: string[];
	done: boolean;
};

const pushUnique = (list: string[], value: string): void => {
	if (!list.includes(value)) list.push(value);
};

const record = (acc: Acc, keyword: string, value: string | null): void => {
	if (value === null) return;
	if (keyword === "want") pushUnique(acc.wants, value);
	else if (keyword === "have") pushUnique(acc.haves, value);
	else if (keyword === "shallow") pushUnique(acc.shallows, value);
	else if (keyword === "ref-prefix") acc.refPrefixes.push(value);
};

const parseV0 = (
	lines: readonly PktLine[],
	profile: UploadProfile,
	acc: Acc,
): UploadRejection | null => {
	const allowed = new Set(profile.v0.lines);
	let section: "needs" | "haves" | "end" = "needs";
	let wantLines = 0;
	for (const line of lines) {
		if (section === "end") {
			return argumentError(
				"trailing-data",
				"data after the end of the request",
			);
		}
		if (line.kind === "flush") {
			if (section === "needs") {
				if (wantLines === 0) return argumentError("empty", "no want");
				section = "haves";
			} else section = "end";
			continue;
		}
		if (line.kind !== "data") {
			return argumentError("bad-pkt", `unexpected ${line.kind} packet`);
		}
		const parsed = splitLine(line.data);
		if (!parsed) return argumentError("bad-line", "empty or non-UTF-8 line");
		const { keyword } = parsed;
		let value = parsed.value;
		const known = section === "needs" ? V0_NEEDS : V0_HAVES;
		if (
			!allowed.has(keyword) || !(V0_NEEDS.has(keyword) || V0_HAVES.has(keyword))
		) {
			return argumentError("argument", `line ${keyword} is not allowed`);
		}
		if (!known.has(keyword)) {
			return argumentError("order", `${keyword} out of order`);
		}
		if (keyword === "want" && value !== null) {
			const space = value.indexOf(" ");
			if (space >= 0) {
				if (wantLines > 0) {
					return argumentError(
						"capability",
						"capabilities after the first want",
					);
				}
				const caps = splitCapabilities(value.slice(space + 1));
				for (const cap of caps) {
					if (!isAllowedCapability(cap, profile.v0.capabilities)) {
						return argumentError(
							"capability",
							`capability ${capabilityName(cap)} is not allowed`,
						);
					}
				}
				acc.capabilities.push(...caps);
				value = value.slice(0, space);
			}
		}
		if (!valueOk(keyword, value)) {
			return argumentError("argument", `bad ${keyword} line`);
		}
		if (keyword === "want") wantLines++;
		if (keyword === "done") {
			acc.done = true;
			section = "end";
		}
		acc.args.push(keyword);
		record(acc, keyword, value);
	}
	if (section !== "end") {
		// A request ends with the flush of the haves section or with `done`.
		return argumentError("truncated", "request ends without flush or done");
	}
	return null;
};

const parseV2 = (
	lines: readonly PktLine[],
	profile: UploadProfile,
	acc: Acc,
): { readonly command: string } | UploadRejection => {
	const first = lines[0];
	if (!first || first.kind !== "data") {
		return reject("unsupported-command", "command", "no command");
	}
	const head = decodeStrict(chomp(first.data));
	if (head === null || !head.startsWith("command=")) {
		return reject("unsupported-command", "command", "no command= line");
	}
	const command = head.slice("command=".length);
	const allowedArgs = Object.hasOwn(profile.v2, command)
		? profile.v2[command]
		: undefined;
	if (!allowedArgs) {
		return reject("unsupported-command", "command", `command ${command}`);
	}
	const capNames = profile.v2Capabilities ?? V2_REQUEST_CAPABILITIES;
	let section: "caps" | "args" | "end" = "caps";
	for (const line of lines.slice(1)) {
		if (section === "end") {
			return argumentError(
				"trailing-data",
				"data after the end of the request",
			);
		}
		if (line.kind === "flush") {
			section = "end";
			continue;
		}
		if (line.kind === "delim") {
			if (section !== "caps") return argumentError("bad-pkt", "second delim");
			section = "args";
			continue;
		}
		if (line.kind !== "data") {
			return argumentError("bad-pkt", `unexpected ${line.kind} packet`);
		}
		if (section === "caps") {
			const cap = decodeStrict(chomp(line.data));
			if (cap === null || !isAllowedCapability(cap, capNames)) {
				return argumentError("capability", "capability line is not allowed");
			}
			acc.capabilities.push(cap);
			continue;
		}
		const parsed = splitLine(line.data);
		if (!parsed) return argumentError("bad-line", "empty or non-UTF-8 line");
		const { keyword, value } = parsed;
		if (!allowedArgs.includes(keyword)) {
			return argumentError("argument", `argument ${keyword} is not allowed`);
		}
		if (!valueOk(keyword, value)) {
			return argumentError("argument", `bad ${keyword} argument`);
		}
		if (keyword === "done") acc.done = true;
		acc.args.push(value === null ? keyword : `${keyword} ${value}`);
		record(acc, keyword, value);
	}
	if (section !== "end") {
		return argumentError("truncated", "request ends before the flush");
	}
	return { command };
};

/** Decodes (gzip, capped) and parses an upload-pack request against `profile`. */
export const parseUploadRequest = async (
	body: ReadableStream<Uint8Array>,
	options: UploadRequestOptions,
): Promise<UploadRequest | UploadRejection> => {
	const decoded = await decodeRequestBody(
		body,
		options.encoding,
		options.maxDecodedBytes,
	);
	if ("kind" in decoded) return decoded;
	const bytes = decoded.bytes;
	if (bytes.length === 0) return argumentError("empty", "empty body");
	let lines: readonly PktLine[];
	try {
		lines = decodePktLines(bytes).lines;
	} catch {
		return argumentError("bad-pkt", "malformed pkt-line");
	}
	const acc: Acc = {
		wants: [],
		haves: [],
		shallows: [],
		refPrefixes: [],
		capabilities: [],
		args: [],
		done: false,
	};
	const v2 = isProtocolV2(options.gitProtocol);
	let command = "fetch";
	if (v2) {
		const result = parseV2(lines, options.profile, acc);
		if ("kind" in result) return result;
		command = result.command;
	} else {
		const failure = parseV0(lines, options.profile, acc);
		if (failure) return failure;
	}
	return {
		kind: "request",
		protocol: v2 ? "v2" : "v0",
		command,
		wants: acc.wants,
		refPrefixes: acc.refPrefixes,
		body: bytes,
		haves: acc.haves,
		shallows: acc.shallows,
		capabilities: acc.capabilities,
		arguments: acc.args,
		done: acc.done,
	};
};
