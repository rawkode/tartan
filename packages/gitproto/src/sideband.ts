// Side-band multiplexing (gitprotocol-pack): band 1 data, band 2 progress
// text (`remote: …` on the client), band 3 a fatal error. `side-band-64k`
// packets carry up to 65,515 payload bytes, `side-band` up to 995.

import { invalid, stripControl } from "@tartan/contract";
import { type Bytes, concat, utf8 } from "./bytes.ts";
import { encodePktLine, readPkt, SIDE_BAND_MAX_DATA } from "./pktline.ts";

export type SideBand = keyof typeof SIDE_BAND_MAX_DATA;

/** Frames `data` as band-`band` packets no larger than the negotiated size. */
export const encodeSideband = (
	band: 1 | 2 | 3,
	data: Uint8Array,
	sideBand: SideBand,
): Bytes => {
	const max = SIDE_BAND_MAX_DATA[sideBand];
	const parts: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += max) {
		const chunk = data.subarray(offset, Math.min(offset + max, data.length));
		const payload = new Uint8Array(chunk.length + 1);
		payload[0] = band;
		payload.set(chunk, 1);
		parts.push(encodePktLine(payload));
	}
	return concat(parts);
};

/**
 * One band-2 line as the client will print it: control characters (C0, C1,
 * DEL, ESC, so no ANSI/OSC sequence), bidi overrides and line breaks
 * removed. Idempotent, so callers may sanitize first.
 */
export const sanitizeBand2Line = (line: string): string => stripControl(line);

/** Band-2 packets for `lines`, each sanitized and terminated by `\n`. */
export const encodeBand2Lines = (
	lines: readonly string[],
	sideBand: SideBand,
): Bytes =>
	concat(
		lines.map((line) =>
			encodeSideband(2, utf8(`${sanitizeBand2Line(line)}\n`), sideBand)
		),
	);

export type Demuxed = {
	/** Band-1 payloads, concatenated. */
	readonly band1: Bytes;
	/** Band-2 payloads, one per packet. */
	readonly band2: readonly Uint8Array[];
	/** Band-3 payloads (fatal errors), one per packet. */
	readonly band3: readonly Uint8Array[];
	/** The stream ended with its flush. */
	readonly flushed: boolean;
};

/** Demultiplexes a whole side-band response; malformed framing throws. */
export const demuxSideband = (bytes: Uint8Array): Demuxed => {
	const band1: Uint8Array[] = [];
	const band2: Uint8Array[] = [];
	const band3: Uint8Array[] = [];
	let offset = 0;
	let flushed = false;
	while (offset < bytes.length) {
		const step = readPkt(bytes, offset);
		if (!step.ok) {
			throw invalid(
				`side-band: malformed pkt-line at byte ${offset}`,
				{ code: step.incomplete ? "truncated" : step.code },
			);
		}
		offset = step.next;
		const line = step.line;
		if (line.kind === "flush") {
			flushed = true;
			break;
		}
		if (line.kind !== "data" || line.data.length === 0) {
			throw invalid("side-band: unexpected packet");
		}
		const payload = line.data.subarray(1);
		if (line.data[0] === 1) band1.push(payload);
		else if (line.data[0] === 2) band2.push(payload);
		else if (line.data[0] === 3) band3.push(payload);
		else throw invalid(`side-band: unknown band ${line.data[0]}`);
	}
	if (offset < bytes.length) throw invalid("side-band: data after the flush");
	return { band1: concat(band1), band2, band3, flushed };
};
