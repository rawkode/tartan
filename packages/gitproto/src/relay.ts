// The receive-pack response relay: a pkt-line-aware TransformStream between the
// upstream receive-pack response and the client. It demuxes band 1 and resolves
// the parsed report as soon as the report's own flush arrives, relays band 2
// and band 3 as they come, and holds back the final flush until
// `release(lines)` injects sanitized band-2 lines (when side-band was
// negotiated) and lets the flush through. Responses larger than
// `holdBackMaxBytes`, or whose framing does not parse, are relayed untouched
// (`release` is then a no-op and `report` resolves null if it was not parsed
// yet).
//
// The relay advances only while its readable side is read (as when it is
// the body of the Response the gateway returns), so `report` resolves as
// the client consumes the response; awaiting it before handing the stream
// to a reader never resolves in workerd. A client cancel settles `report`
// (null when band 1 was not complete) and frees the hold.

import { concat, createByteBuffer } from "./bytes.ts";
import { readPkt } from "./pktline.ts";
import {
	encodeReport,
	type NegotiatedCaps,
	parseReportStatus,
	type ReportStatus,
} from "./report.ts";
import { encodeBand2Lines, encodeSideband } from "./sideband.ts";

/** The relay's hold-back cap (1 MiB). */
export const RELAY_HOLD_BACK_MAX_BYTES = 1024 * 1024;
/** How long the final flush waits for `release` before it goes out anyway. */
export const RELAY_MAX_HOLD_MS = 30_000;

/**
 * The receive-pack response relay: demuxes band 1 (resolves `report`),
 * relays band 2 and holds back the final flush (up to `holdBackMaxBytes`;
 * above it everything relays untouched and `release` is a no-op) until
 * `release(lines)` injects band-2 lines and the flush.
 */
export type ReceivePackRelay = {
	readonly stream: TransformStream<Uint8Array, Uint8Array>;
	/** Band 1, parsed; null when the upstream sent none. */
	readonly report: Promise<ReportStatus | null>;
	release(band2: readonly string[]): void;
};

export type ReceivePackRelayOptions = {
	readonly caps: NegotiatedCaps;
	readonly holdBackMaxBytes: number;
	/**
	 * Rewrites the report before it reaches the client (the gateway's
	 * translation of upstream size errors). When set, band 1 is held until
	 * the report is complete; returning null keeps the upstream bytes.
	 */
	readonly rewriteReport?: (report: ReportStatus) => ReportStatus | null;
	/** Safety bound on the hold (default `RELAY_MAX_HOLD_MS`). */
	readonly maxHoldMs?: number;
};

type Mode = "detect" | "sideband" | "plain" | "passthrough";

export const createReceivePackRelay = (
	options: ReceivePackRelayOptions,
): ReceivePackRelay => {
	const { caps } = options;
	let resolveReport!: (report: ReportStatus | null) => void;
	const report = new Promise<ReportStatus | null>((resolve) => {
		resolveReport = resolve;
	});
	let reportSettled = false;
	const settleReport = (value: ReportStatus | null) => {
		if (reportSettled) return;
		reportSettled = true;
		resolveReport(value);
	};
	let resolveRelease!: () => void;
	const released = new Promise<void>((resolve) => {
		resolveRelease = resolve;
	});
	let releaseLines: readonly string[] | null = null;

	let mode: Mode = "detect";
	let total = 0;
	const pending = createByteBuffer(); // unparsed bytes (an incomplete packet)
	const heldBand1: Uint8Array[] = []; // raw band-1 packets held for rewriting
	const reportBytes: Uint8Array[] = []; // the inner report stream
	let reportDone = caps.report === null;
	let finalSeen = false;
	const heldTail: Uint8Array[] = []; // the final flush and anything after it

	const emit = (
		controller: TransformStreamDefaultController<Uint8Array>,
		bytes: Uint8Array,
	) => {
		if (bytes.length > 0) controller.enqueue(bytes);
	};

	const toPassthrough = (
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		mode = "passthrough";
		for (const part of heldBand1) emit(controller, part);
		heldBand1.length = 0;
		for (const part of heldTail) emit(controller, part);
		heldTail.length = 0;
		emit(controller, pending.view().slice());
		pending.consume(pending.length);
		settleReport(null);
	};

	/** Called with the report's inner bytes once its flush has been seen. */
	const finishReport = (
		controller: TransformStreamDefaultController<Uint8Array>,
		inner: Uint8Array,
	) => {
		reportDone = true;
		let parsed: ReportStatus | null = null;
		try {
			parsed = parseReportStatus(inner, caps);
		} catch {
			parsed = null;
		}
		settleReport(parsed);
		if (!options.rewriteReport) return;
		const rewritten = parsed ? options.rewriteReport(parsed) : null;
		if (rewritten === null) {
			for (const part of heldBand1) emit(controller, part);
		} else {
			const encoded = encodeReport(rewritten, caps);
			if (mode === "sideband" && caps.sideBand) {
				emit(controller, encodeSideband(1, encoded, caps.sideBand));
			} else {
				// Plain mode: the report's flush is the final flush, held separately.
				emit(controller, encoded.subarray(0, encoded.length - 4));
			}
		}
		heldBand1.length = 0;
	};

	/** Tries to complete the inner report (band 1, or the plain stream). */
	const scanReport = (
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		if (reportDone) return;
		const inner = concat(reportBytes);
		let offset = 0;
		for (;;) {
			const step = readPkt(inner, offset);
			if (!step.ok) return;
			offset = step.next;
			if (step.line.kind === "flush") {
				finishReport(controller, inner.subarray(0, offset));
				return;
			}
		}
	};

	const handlePacket = (
		controller: TransformStreamDefaultController<Uint8Array>,
		raw: Uint8Array,
		line: ReturnType<typeof readPkt> & { ok: true },
	): boolean => {
		const packet = line.line;
		if (mode === "detect") {
			const sidebanded = caps.sideBand !== null &&
				(packet.kind === "flush" ||
					(packet.kind === "data" && packet.data.length > 0 &&
						packet.data[0] >= 1 && packet.data[0] <= 3));
			mode = sidebanded ? "sideband" : "plain";
		}
		if (packet.kind === "flush") {
			if (mode === "plain" && !reportDone) {
				reportBytes.push(raw);
				scanReport(controller);
			}
			finalSeen = true;
			heldTail.push(raw.slice());
			return true;
		}
		if (packet.kind !== "data") return false;
		if (mode === "plain") {
			if (reportDone) {
				emit(controller, raw);
				return true;
			}
			reportBytes.push(raw);
			if (options.rewriteReport) heldBand1.push(raw.slice());
			else emit(controller, raw);
			return true;
		}
		const band = packet.data[0];
		if (band === 1) {
			if (!reportDone) {
				reportBytes.push(packet.data.slice(1));
				if (options.rewriteReport) heldBand1.push(raw.slice());
				else emit(controller, raw);
				scanReport(controller);
			} else emit(controller, raw);
			return true;
		}
		if (band === 2 || band === 3) {
			emit(controller, raw);
			return true;
		}
		return false;
	};

	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			total += chunk.length;
			if (mode === "passthrough") {
				emit(controller, chunk);
				return;
			}
			if (finalSeen) {
				// Nothing after the final flush is parsed; it waits with the flush.
				heldTail.push(chunk.slice());
				return;
			}
			if (!finalSeen && total > options.holdBackMaxBytes) {
				toPassthrough(controller);
				emit(controller, chunk);
				return;
			}
			pending.append(chunk);
			for (;;) {
				const view = pending.view();
				const step = readPkt(view, 0);
				if (!step.ok) {
					if (!step.incomplete) toPassthrough(controller);
					return;
				}
				// A copy: the buffer is reused once the packet is consumed.
				const raw = view.slice(0, step.next);
				if (!handlePacket(controller, raw, step)) {
					toPassthrough(controller);
					return;
				}
				pending.consume(step.next);
				if (finalSeen) {
					if (pending.length > 0) heldTail.push(pending.view().slice());
					pending.consume(pending.length);
					return;
				}
			}
		},
		async flush(controller) {
			if (mode === "passthrough") {
				settleReport(null);
				return;
			}
			if (!finalSeen) {
				// Upstream ended without its final flush (it hung up): relay what
				// there is; nothing is injected.
				for (const part of heldBand1) emit(controller, part);
				emit(controller, pending.view().slice());
				settleReport(null);
				return;
			}
			settleReport(null); // no-op when the report was parsed
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				released,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, options.maxHoldMs ?? RELAY_MAX_HOLD_MS);
				}),
			]);
			clearTimeout(timer);
			if (mode === "sideband" && caps.sideBand && releaseLines?.length) {
				emit(controller, encodeBand2Lines(releaseLines, caps.sideBand));
			}
			for (const part of heldTail) emit(controller, part);
		},
		cancel() {
			// The client went away: whatever was parsed stays the answer.
			settleReport(null);
			resolveRelease();
		},
	});

	return {
		stream,
		report,
		release(band2) {
			if (releaseLines !== null) return;
			releaseLines = mode === "passthrough" ? [] : [...band2];
			resolveRelease();
		},
	};
};
