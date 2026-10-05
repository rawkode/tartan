// Advertisement rewriters: filter the ref lines to the caller's view and
// rewrite every capability list to an allowlist, for v0/v1 `info/refs`, the v2
// capability advertisement and v2 `ls-refs` responses. Input that does not
// parse as the expected shape throws `invalid` (the gateway answers 502);
// nothing is passed through unparsed.

import { invalid } from "@tartan/contract";
import { type Bytes, concat, decodeStrict } from "./bytes.ts";
import {
	type CapabilityAllowlist,
	capabilityName,
	capabilityValue,
	filterCapabilities,
	OBJECT_FORMAT,
	splitCapabilities,
} from "./capabilities.ts";
import {
	chomp,
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
	type PktLine,
} from "./pktline.ts";

export type AdvertisementOptions = {
	readonly service: "git-upload-pack" | "git-receive-pack";
	/** The caller's view: keep a ref line or drop it (hidden namespaces, own lanes). */
	readonly keepRef: (ref: string) => boolean;
	readonly capabilities: CapabilityAllowlist;
	/**
	 * Keep `symref=A:B` capabilities whose both ends pass `keepRef`, so v0/v1
	 * clones learn the default branch as v2 clones do through `ls-refs
	 * symrefs`. Default: true for upload-pack, false for receive-pack (which
	 * advertises none).
	 */
	readonly symrefs?: boolean;
};

const CAPS_PLACEHOLDER = "capabilities^{}";
const ZERO = "0".repeat(40);
const REF_LINE_RE = /^([0-9a-f]{40}) ([^ \0]+)$/;

const text = (line: PktLine, what: string): string => {
	if (line.kind !== "data") throw invalid(`${what}: unexpected ${line.kind}`);
	const decoded = decodeStrict(chomp(line.data));
	if (decoded === null) throw invalid(`${what}: not UTF-8`);
	return decoded;
};

const flush = () => encodeSpecialPkt("flush");

/** The base name a peeled line (`refs/tags/v1^{}`) belongs to. */
const peeledBase = (ref: string): string | null =>
	ref.endsWith("^{}") ? ref.slice(0, -3) : null;

/**
 * Rewrites a v0/v1 `info/refs` advertisement: filters ref lines, rewrites the
 * capability list on the first remaining line (or the `capabilities^{}`
 * placeholder when none remains).
 */
export const rewriteAdvertisement = (
	body: Uint8Array,
	options: AdvertisementOptions,
): Bytes => {
	if (options.capabilities.protocol !== "v0") {
		throw invalid("rewriteAdvertisement takes a v0 capability allowlist");
	}
	const names = options.capabilities.names;
	const lines = decodePktLines(body).lines;
	const out: Uint8Array[] = [];
	let i = 0;
	// Smart-HTTP service header.
	if (
		lines[i]?.kind === "data" &&
		text(lines[i], "header").startsWith("# service=")
	) {
		const service = text(lines[i], "header").slice("# service=".length);
		if (service !== options.service) {
			throw invalid(`advertisement is for ${service}, not ${options.service}`);
		}
		if (lines[i + 1]?.kind !== "flush") {
			throw invalid("no flush after the service line");
		}
		out.push(encodePktLine(`# service=${service}\n`), flush());
		i += 2;
	}
	if (lines[i]?.kind === "data") {
		const first = text(lines[i], "version");
		if (first === "version 2") {
			throw invalid("a v2 advertisement: use rewriteV2Capabilities");
		}
		if (first === "version 1") {
			out.push(encodePktLine("version 1\n"));
			i++;
		}
	}
	let capabilities: string[] | null = null;
	const kept: { readonly sha: string; readonly ref: string }[] = [];
	const extra: string[] = [];
	let previous: { readonly ref: string; readonly kept: boolean } | null = null;
	let ended = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.kind === "flush") {
			ended = true;
			i++;
			break;
		}
		const raw = text(line, "ref line");
		const nul = raw.indexOf("\0");
		const refPart = nul >= 0 ? raw.slice(0, nul) : raw;
		if (nul >= 0) {
			if (capabilities !== null) {
				throw invalid("capabilities on a later ref line");
			}
			capabilities = splitCapabilities(raw.slice(nul + 1));
		}
		if (refPart.startsWith("shallow ")) {
			extra.push(refPart);
			continue;
		}
		const match = REF_LINE_RE.exec(refPart);
		if (!match) throw invalid("malformed ref line");
		const [, sha, ref] = match;
		if (ref === CAPS_PLACEHOLDER) {
			if (sha !== ZERO) throw invalid("capabilities^{} with a non-zero id");
			continue;
		}
		const base = peeledBase(ref);
		if (base !== null) {
			// A peeled line follows its tag and shares its fate.
			const keep = previous?.ref === base
				? previous.kept
				: options.keepRef(base);
			if (keep) kept.push({ sha, ref });
			continue;
		}
		previous = { ref, kept: options.keepRef(ref) };
		if (previous.kept) kept.push({ sha, ref });
	}
	if (!ended) throw invalid("advertisement ends without a flush");
	if (i < lines.length) throw invalid("data after the advertisement");
	const keepSymrefs = options.symrefs ?? options.service === "git-upload-pack";
	const caps = filterCapabilities(
		capabilities ?? [],
		names,
		keepSymrefs
			? (from, to) => options.keepRef(from) && options.keepRef(to)
			: undefined,
	).join(" ");
	if (kept.length === 0) {
		out.push(encodePktLine(`${ZERO} ${CAPS_PLACEHOLDER}\0${caps}\n`));
	} else {
		kept.forEach(({ sha, ref }, index) => {
			out.push(
				encodePktLine(
					index === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`,
				),
			);
		});
	}
	for (const line of extra) out.push(encodePktLine(`${line}\n`));
	out.push(flush());
	return concat(out);
};

/**
 * Filters one v2 capability line: commands keep only their listed features,
 * `agent` keeps its value, `object-format` only listed values; any other
 * name is dropped.
 */
const filterV2Capability = (
	line: string,
	commands: Readonly<Record<string, readonly string[]>>,
): string | null => {
	const name = capabilityName(line);
	if (!Object.hasOwn(commands, name)) return null;
	const allowed = commands[name];
	const value = capabilityValue(line);
	if (name === "agent") return value ? line : null;
	if (name === "object-format") {
		return value === OBJECT_FORMAT && allowed.includes(value) ? line : null;
	}
	if (value === null) return name;
	const features = value.split(" ").filter((f) => allowed.includes(f));
	return features.length > 0 ? `${name}=${features.join(" ")}` : name;
};

/** Rewrites a v2 capability advertisement (`info/refs` with `version 2`). */
export const rewriteV2Capabilities = (
	body: Uint8Array,
	allowlist: CapabilityAllowlist,
): Bytes => {
	if (allowlist.protocol !== "v2") {
		throw invalid("rewriteV2Capabilities takes a v2 capability allowlist");
	}
	const lines = decodePktLines(body).lines;
	const out: Uint8Array[] = [];
	let i = 0;
	if (
		lines[i]?.kind === "data" &&
		text(lines[i], "header").startsWith("# service=")
	) {
		if (lines[i + 1]?.kind !== "flush") {
			throw invalid("no flush after the service line");
		}
		out.push(encodePktLine(`${text(lines[i], "header")}\n`), flush());
		i += 2;
	}
	if (!lines[i] || text(lines[i], "version") !== "version 2") {
		throw invalid("not a v2 capability advertisement");
	}
	out.push(encodePktLine("version 2\n"));
	i++;
	let ended = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.kind === "flush") {
			ended = true;
			i++;
			break;
		}
		const kept = filterV2Capability(
			text(line, "capability"),
			allowlist.commands,
		);
		if (kept !== null) out.push(encodePktLine(`${kept}\n`));
	}
	if (!ended) throw invalid("advertisement ends without a flush");
	if (i < lines.length) throw invalid("data after the advertisement");
	out.push(flush());
	return concat(out);
};

const LS_REF_RE = /^([0-9a-f]{40}|unborn) ([^ ]+)((?: [^ ]+)*)$/;

/** Filters a v2 `ls-refs` response to `keepRef`. */
export const rewriteLsRefsResponse = (
	body: Uint8Array,
	keepRef: (ref: string) => boolean,
): Bytes => {
	const lines = decodePktLines(body).lines;
	const out: Uint8Array[] = [];
	let ended = false;
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.kind === "flush") {
			ended = true;
			i++;
			break;
		}
		const raw = text(line, "ls-refs line");
		if (raw.startsWith("ERR ")) {
			out.push(encodePktLine(`${raw}\n`));
			continue;
		}
		const match = LS_REF_RE.exec(raw);
		if (!match) throw invalid("malformed ls-refs line");
		const [, sha, ref, attrText] = match;
		if (!keepRef(ref)) continue;
		const attrs = attrText.split(" ").filter((a) => a.length > 0).filter(
			(attr) =>
				!attr.startsWith("symref-target:") ||
				keepRef(attr.slice("symref-target:".length)),
		);
		out.push(encodePktLine(`${[sha, ref, ...attrs].join(" ")}\n`));
	}
	if (!ended) throw invalid("ls-refs response ends without a flush");
	if (i < lines.length) throw invalid("data after the ls-refs response");
	out.push(flush());
	return concat(out);
};
