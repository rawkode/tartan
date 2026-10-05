// Report-status synthesizer and parser across report-status/-v2 ×
// side-band-64k/side-band/none × quiet, on recorded receive-pack responses,
// plus band-2 sanitizing.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	decodePktLines,
	demuxSideband,
	encodePktLine,
	negotiateCaps,
	type NegotiatedCaps,
	parseReportStatus,
	type ReportStatus,
	sanitizeBand2Line,
	SIDE_BAND_MAX_DATA,
	synthReportStatus,
} from "../src/index.ts";
import { dec, golden, join } from "./helpers.ts";

export const CAPS_MATRIX: NegotiatedCaps[] =
	(["report-status", "report-status-v2"] as const)
		.flatMap((report) =>
			([null, "side-band", "side-band-64k"] as const).flatMap((sideBand) =>
				[false, true].map((quiet) => ({ report, sideBand, quiet }))
			)
		);

const REJECTION: ReportStatus = {
	unpack: "ok",
	refs: [
		{ ref: "refs/heads/main", ok: false, reason: "woven-by-tartan" },
		{
			ref: "refs/heads/feat",
			ok: false,
			reason: "atomic: another ref was rejected",
		},
	],
};

const ESC_LINE =
	"tartan \x1b]0;pwned\x07 main is \x1b[31mwoven\x1b[0m\r\nby Tartan‮";

Deno.test("negotiateCaps reads what the client selected", () => {
	deepStrictEqual(
		negotiateCaps(["report-status-v2", "side-band-64k", "quiet", "agent=x"]),
		{
			report: "report-status-v2",
			sideBand: "side-band-64k",
			quiet: true,
		},
	);
	deepStrictEqual(negotiateCaps(["report-status", "side-band"]), {
		report: "report-status",
		sideBand: "side-band",
		quiet: false,
	});
	deepStrictEqual(negotiateCaps([]), {
		report: null,
		sideBand: null,
		quiet: false,
	});
});

Deno.test("synthReportStatus: every caps combination round-trips through the parser", () => {
	for (const caps of CAPS_MATRIX) {
		const body = synthReportStatus(REJECTION, caps, [
			ESC_LINE,
			"push your lane",
		]);
		let inner = body;
		if (caps.sideBand) {
			const demuxed = demuxSideband(body);
			ok(demuxed.flushed);
			inner = demuxed.band1;
			const band2 = demuxed.band2.map(dec).join("");
			ok(
				!band2.includes("\x1b") && !band2.includes("\x07") &&
					!band2.includes("\r"),
			);
			ok(!band2.includes("‮"));
			equal(
				band2,
				"tartan ]0;pwned main is [31mwoven[0mby Tartan\npush your lane\n",
			);
			// Packet sizes respect the negotiated side-band.
			for (const line of decodePktLines(body).lines) {
				if (line.kind === "data") {
					ok(line.data.length - 1 <= SIDE_BAND_MAX_DATA[caps.sideBand]);
				}
			}
		} else {
			ok(!dec(body).includes("push your lane"), "no band 2 without side-band");
		}
		deepStrictEqual(
			parseReportStatus(inner, caps),
			REJECTION,
			JSON.stringify(caps),
		);
	}
});

Deno.test("synthReportStatus: exact bytes for report-status without side-band", () => {
	const body = synthReportStatus(REJECTION, {
		report: "report-status",
		sideBand: null,
		quiet: false,
	});
	equal(
		dec(body),
		"000eunpack ok\n" + "0027ng refs/heads/main woven-by-tartan\n" +
			"0038ng refs/heads/feat atomic: another ref was rejected\n" + "0000",
	);
	// No report-status negotiated: nothing to say on band 1.
	equal(
		synthReportStatus(REJECTION, { report: null, sideBand: null, quiet: false })
			.length,
		0,
	);
});

Deno.test("side-band (1000-byte packets) splits a long report", () => {
	const many: ReportStatus = {
		unpack: "ok",
		refs: Array.from({ length: 60 }, (_, i) => ({
			ref: `refs/heads/branch-${i}`,
			ok: false as const,
			reason: "agents push only to their lanes",
		})),
	};
	const caps: NegotiatedCaps = {
		report: "report-status",
		sideBand: "side-band",
		quiet: false,
	};
	const body = synthReportStatus(many, caps);
	const packets = decodePktLines(body).lines.filter((l) => l.kind === "data");
	ok(packets.length > 1);
	deepStrictEqual(parseReportStatus(demuxSideband(body).band1, caps), many);
});

Deno.test("ng reasons and unpack text are stripped of control characters", () => {
	const caps: NegotiatedCaps = {
		report: "report-status",
		sideBand: null,
		quiet: false,
	};
	const body = synthReportStatus({
		unpack: "ok",
		refs: [{ ref: "refs/heads/a", ok: false, reason: "bad\x1b[2J\nreason" }],
	}, caps);
	deepStrictEqual(parseReportStatus(body, caps).refs, [{
		ref: "refs/heads/a",
		ok: false,
		reason: "bad[2Jreason",
	}]);
	throws(() =>
		synthReportStatus({
			unpack: "ok",
			refs: [{ ref: "refs/heads/a\nok x", ok: true }],
		}, caps)
	);
	equal(sanitizeBand2Line("\x1b[1mhi\x1b[0m"), "[1mhi[0m");
});

Deno.test("goldens: real receive-pack responses parse (side-band-64k, report-status-v2)", () => {
	const caps: NegotiatedCaps = {
		report: "report-status-v2",
		sideBand: "side-band-64k",
		quiet: true,
	};
	const create = parseReportStatus(
		demuxSideband(golden("receive-pack-create").response).band1,
		caps,
	);
	deepStrictEqual(create, {
		unpack: "ok",
		refs: [{ ref: "refs/heads/main", ok: true }],
	});
	const multi = parseReportStatus(
		demuxSideband(golden("receive-pack-multi-ref").response).band1,
		caps,
	);
	deepStrictEqual(multi.refs.map((r) => r.ref), [
		"refs/heads/feat",
		"refs/tags/v1",
	]);
});

Deno.test("report-status-v2 option lines parse onto their ok line", () => {
	const caps = { report: "report-status-v2" } as const;
	const body = join(
		encodePktLine("unpack ok\n"),
		encodePktLine("ok refs/for/main\n"),
		encodePktLine("option refname refs/changes/1\n"),
		encodePktLine(`option old-oid ${"0".repeat(40)}\n`),
		encodePktLine(`option new-oid ${"1".repeat(40)}\n`),
		encodePktLine("option forced-update\n"),
		encodePktLine("ng refs/heads/x hook declined\n"),
		"0000",
	);
	const parsed = parseReportStatus(body, caps);
	deepStrictEqual(parsed.refs[0], {
		ref: "refs/for/main",
		ok: true,
		options: {
			refname: "refs/changes/1",
			oldOid: "0".repeat(40),
			newOid: "1".repeat(40),
			forcedUpdate: true,
		},
	});
	deepStrictEqual(parsed.refs[1], {
		ref: "refs/heads/x",
		ok: false,
		reason: "hook declined",
	});
	// Round trip through the synthesizer.
	const again = synthReportStatus(parsed, {
		report: "report-status-v2",
		sideBand: null,
		quiet: false,
	});
	deepStrictEqual(parseReportStatus(again, caps), parsed);
	throws(() =>
		parseReportStatus(join(encodePktLine("ok refs/heads/a\n"), "0000"), caps)
	);
	throws(() =>
		parseReportStatus(
			join(
				encodePktLine("unpack ok\n"),
				encodePktLine("option refname x\n"),
				"0000",
			),
			caps,
		)
	);
	throws(() => parseReportStatus(encodePktLine("unpack ok\n"), caps));
	throws(() =>
		parseReportStatus(
			join(encodePktLine("unpack ok\n"), encodePktLine("what\n"), "0000"),
			caps,
		)
	);
});
