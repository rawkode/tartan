// Report-status (gitprotocol-pack "report-status" and "report-status-v2"):
// the synthesizer for gateway rejections
// and the parser the relay and the receive-pack client use.

import { invalid, stripControl } from "@tartan/contract";
import { type Bytes, concat, decodeStrict } from "./bytes.ts";
import { capabilityName } from "./capabilities.ts";
import {
	chomp,
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
} from "./pktline.ts";
import { encodeBand2Lines, encodeSideband } from "./sideband.ts";

/** The capabilities a client selected, which shape every receive-pack response. */
export type NegotiatedCaps = {
	readonly report: "report-status" | "report-status-v2" | null;
	readonly sideBand: "side-band-64k" | "side-band" | null;
	readonly quiet: boolean;
};

/** Reads the response-shaping capabilities from a first command line's list. */
export const negotiateCaps = (
	capabilities: readonly string[],
): NegotiatedCaps => {
	const names = new Set(capabilities.map(capabilityName));
	return {
		report: names.has("report-status-v2")
			? "report-status-v2"
			: names.has("report-status")
			? "report-status"
			: null,
		sideBand: names.has("side-band-64k")
			? "side-band-64k"
			: names.has("side-band")
			? "side-band"
			: null,
		quiet: names.has("quiet"),
	};
};

/** `report-status-v2` `option` lines after an `ok` (absent for plain updates). */
export type RefOptions = {
	readonly refname?: string;
	readonly oldOid?: string;
	readonly newOid?: string;
	readonly forcedUpdate?: boolean;
};

export type RefStatus =
	| {
		readonly ref: string;
		readonly ok: true;
		readonly options?: RefOptions;
	}
	| { readonly ref: string; readonly ok: false; readonly reason: string };

export type ReportStatus = {
	/** `ok`, or the upstream's unpack error. */
	readonly unpack: string;
	readonly refs: readonly RefStatus[];
};

const singleLine = (value: string, what: string): string => {
	if (/[\n\0]/.test(value)) throw invalid(`${what} contains a line break`);
	return value;
};

const optionLines = (options: RefOptions | undefined): string[] => {
	if (!options) return [];
	const out: string[] = [];
	if (options.refname) {
		out.push(`option refname ${singleLine(options.refname, "refname")}`);
	}
	if (options.oldOid) out.push(`option old-oid ${options.oldOid}`);
	if (options.newOid) out.push(`option new-oid ${options.newOid}`);
	if (options.forcedUpdate) out.push("option forced-update");
	return out;
};

/**
 * The report itself (`unpack`, `ok`/`ng` lines, flush) as pkt-lines, before
 * any side-band framing. `ng` reasons are stripped of control characters.
 */
export const encodeReport = (
	report: ReportStatus,
	caps: Pick<NegotiatedCaps, "report">,
): Bytes => {
	const lines = [`unpack ${singleLine(stripControl(report.unpack), "unpack")}`];
	for (const status of report.refs) {
		const ref = singleLine(status.ref, "ref");
		if (status.ok) {
			lines.push(`ok ${ref}`);
			if (caps.report === "report-status-v2") {
				lines.push(...optionLines(status.options));
			}
		} else {
			const reason = stripControl(status.reason).trim() || "rejected";
			lines.push(`ng ${ref} ${reason}`);
		}
	}
	return concat([
		...lines.map((line) => encodePktLine(`${line}\n`)),
		encodeSpecialPkt("flush"),
	]);
};

/**
 * A synthesized `application/x-git-receive-pack-result` body: band 1
 * report-status per `caps`, plus band-2 `lines` when side-band was
 * negotiated. Every band-2 line is stripped of control characters (ESC, so
 * no ANSI/OSC sequence survives) here as well as by the caller. `quiet` does
 * not suppress them: like hook output, they are not progress. Without
 * `report-status` the client cannot learn per-ref results, so the gateway
 * should answer such a push with an HTTP error instead.
 */
export const synthReportStatus = (
	report: ReportStatus,
	caps: NegotiatedCaps,
	band2: readonly string[] = [],
): Bytes => {
	const inner = caps.report === null
		? new Uint8Array(0)
		: encodeReport(report, caps);
	if (caps.sideBand === null) return inner;
	return concat([
		encodeSideband(1, inner, caps.sideBand),
		encodeBand2Lines(band2, caps.sideBand),
		encodeSpecialPkt("flush"),
	]);
};

const OPTION_RE = /^option (refname|old-oid|new-oid|forced-update)(?: (.+))?$/;

/** Parses a report-status body (band 1 already demuxed, or no side-band). */
export const parseReportStatus = (
	body: Uint8Array,
	caps: Pick<NegotiatedCaps, "report">,
): ReportStatus => {
	const { lines } = decodePktLines(body);
	const texts: string[] = [];
	let ended = false;
	for (const line of lines) {
		if (ended) throw invalid("report-status: data after the flush");
		if (line.kind === "flush") {
			ended = true;
			continue;
		}
		if (line.kind !== "data") {
			throw invalid(`report-status: ${line.kind} packet`);
		}
		const text = decodeStrict(chomp(line.data));
		if (text === null) throw invalid("report-status: not UTF-8");
		texts.push(text);
	}
	if (!ended) throw invalid("report-status: no flush");
	const [first, ...rest] = texts;
	if (!first?.startsWith("unpack ")) {
		throw invalid("report-status: no unpack line");
	}
	const refs: RefStatus[] = [];
	let options: Record<string, string | boolean> | null = null;
	const close = () => {
		if (options && refs.length > 0) {
			const last = refs[refs.length - 1];
			if (last.ok) {
				refs[refs.length - 1] = { ...last, options: options as RefOptions };
			}
		}
		options = null;
	};
	for (const text of rest) {
		if (text.startsWith("ok ")) {
			close();
			refs.push({ ref: text.slice(3), ok: true });
		} else if (text.startsWith("ng ")) {
			close();
			const body = text.slice(3);
			const space = body.indexOf(" ");
			refs.push(
				space < 0 ? { ref: body, ok: false, reason: "" } : {
					ref: body.slice(0, space),
					ok: false,
					reason: body.slice(space + 1),
				},
			);
		} else if (caps.report !== "report-status" && text.startsWith("option ")) {
			const match = OPTION_RE.exec(text);
			const last = refs[refs.length - 1];
			if (!match || !last?.ok) throw invalid("report-status: bad option line");
			options ??= {};
			const key = match[1] === "refname"
				? "refname"
				: match[1] === "old-oid"
				? "oldOid"
				: match[1] === "new-oid"
				? "newOid"
				: "forcedUpdate";
			options[key] = match[1] === "forced-update" ? true : match[2] ?? "";
		} else {
			throw invalid("report-status: unexpected line");
		}
	}
	close();
	return { unpack: first.slice("unpack ".length), refs };
};
