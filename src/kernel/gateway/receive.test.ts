// Receive-pack cases a real backend cannot produce (M1): the fail-closed parser
// cases, the synthesized report across the caps matrix, Artifacts' three
// object-size answers, the final flush held until phase 1 commits, a client
// that goes away mid-relay, and a 95 MB body relayed with flat memory. The
// upstream is scripted; RepoDO is an in-memory port.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import type { RefPolicyReason } from "@tartan/contract/kernel.ts";
import {
	demuxSideband,
	encodePktLine,
	encodeSpecialPkt,
	negotiateCaps,
	parseReportStatus,
	synthReportStatus,
} from "@tartan/gitproto";
import {
	authOf,
	createUnitWorld,
	LANE,
	REMOTE,
	scriptedUpstream,
	sha,
	type UnitWorld,
	ZERO_SHA,
} from "./testing/fakes.ts";
import { handleReceivePack, rejectionResponse } from "./receive.ts";
import { handleInfoRefs } from "./upload.ts";

const CAPS = "report-status side-band-64k agent=git/2.55.0";

type Cmd = { readonly ref: string; readonly old: string; readonly new: string };

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const section = (commands: readonly Cmd[], caps = CAPS): Uint8Array[] => [
	...commands.map((c, i) =>
		encodePktLine(
			`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0${caps}` : ""}\n`,
		)
	),
	encodeSpecialPkt("flush"),
];

/** A push body: the command section and `pack` bytes standing in for the pack. */
const pushBody = (
	commands: readonly Cmd[],
	caps = CAPS,
	pack: Uint8Array = new TextEncoder().encode("PACK-fake"),
) => concat([...section(commands, caps), pack]);

const okAnswer = (refs: readonly string[], caps = CAPS) => () =>
	new Response(
		synthReportStatus(
			{ unpack: "ok", refs: refs.map((ref) => ({ ref, ok: true })) },
			negotiateCaps(caps.split(" ")),
		),
		{ headers: { "content-type": "application/x-git-receive-pack-result" } },
	);

const report = async (response: Response, caps = CAPS) => {
	const bytes = new Uint8Array(await response.arrayBuffer());
	const negotiated = negotiateCaps(caps.split(" "));
	const inner = negotiated.sideBand ? demuxSideband(bytes).band1 : bytes;
	return parseReportStatus(inner, negotiated);
};

const userPush = (
	w: UnitWorld,
	body: BodyInit,
	headers: Record<string, string> = {},
) =>
	handleReceivePack(
		w.deps(),
		w.request("POST", "git-receive-pack", {
			auth: authOf(),
			body,
			headers: {
				"content-type": "application/x-git-receive-pack-request",
				...headers,
			},
		}),
	);

const feature = (n = 1): Cmd => ({
	ref: `refs/heads/feat-${n}`,
	old: ZERO_SHA,
	new: sha(n),
});

// ---------------------------------------------------------------------------
// The fail-closed command peek; nothing is forwarded
// ---------------------------------------------------------------------------

Deno.test("gzip-encoded receive-pack is 415 and nothing is forwarded", async () => {
	const w = createUnitWorld();
	const response = await userPush(w, pushBody([feature()]), {
		"content-encoding": "gzip",
	});
	equal(response.status, 415);
	equal(w.upstream.calls.length, 0);
	deepStrictEqual(w.repo.upstreamScopes, []);
});

Deno.test("push-cert, 0001, shallow, truncated and oversized pkt-lines and duplicate refs reject the whole push", async () => {
	const pushCert = concat([
		encodePktLine(`push-cert\0${CAPS}\n`),
		encodePktLine("certificate version 0.1\n"),
		encodeSpecialPkt("flush"),
	]);
	const afterFirst = (bad: Uint8Array) =>
		concat([section([feature(1)])[0], bad, encodeSpecialPkt("flush")]);
	const cases: [string, Uint8Array<ArrayBuffer>, number | RefPolicyReason][] = [
		["push-cert block", pushCert, 400],
		[
			"0001 after a command",
			afterFirst(encodeSpecialPkt("delim")),
			"malformed-push",
		],
		[
			"shallow line",
			afterFirst(encodePktLine(`shallow ${sha(5)}\n`)),
			"malformed-push",
		],
		[
			"truncated",
			concat([section([feature(1)])[0], new TextEncoder().encode("00ff0000")]),
			"malformed-push",
		],
		[
			"oversized length",
			afterFirst(new TextEncoder().encode("fff1")),
			"malformed-push",
		],
		["0003", afterFirst(new TextEncoder().encode("0003")), "malformed-push"],
		[
			"duplicate refs",
			concat(section([feature(1), { ...feature(1), new: sha(9) }])),
			"malformed-push",
		],
		[
			"bad refname",
			concat(section([{ ...feature(1), ref: "refs/heads/a..b" }])),
			400,
		],
		[
			"push-cert capability",
			concat(section([feature(1)], `${CAPS} push-cert=abc`)),
			400,
		],
	];
	for (const [name, body, expected] of cases) {
		const w = createUnitWorld();
		const response = await userPush(w, body);
		if (typeof expected === "number") {
			equal(response.status, expected, name);
			await response.body?.cancel();
		} else {
			equal(response.status, 200, name);
			const parsed = await report(response);
			ok(parsed.refs.length > 0, name);
			for (const ref of parsed.refs) {
				ok(
					!ref.ok && ref.reason === expected,
					`${name}: ${JSON.stringify(ref)}`,
				);
			}
			await w.settle();
			equal(w.repo.rejections.length, 1, name);
		}
		equal(w.upstream.calls.length, 0, `${name}: forwarded`);
		deepStrictEqual(w.repo.upstreamScopes, [], `${name}: a token was minted`);
	}
});

Deno.test("an agent's ninth command rejects the push (too-many-commands); a user may send many", async () => {
	const w = createUnitWorld();
	const agent = authOf({
		kind: "agent",
		via: "agent-token",
		principal: "a_01k70000000000000000000001",
	});
	const nine = Array.from({ length: 9 }, (_, i) => feature(i + 1));
	const response = await handleReceivePack(
		w.deps(),
		w.request("POST", "git-receive-pack", {
			auth: agent,
			body: pushBody(nine),
		}),
	);
	const parsed = await report(response);
	equal(parsed.refs.length, 8);
	ok(parsed.refs.every((r) => !r.ok && r.reason === "too-many-commands"));
	equal(w.upstream.calls.length, 0);
	// A user's 50-ref push goes through the peek.
	const u = createUnitWorld();
	const fifty = Array.from({ length: 50 }, (_, i) => feature(i + 1));
	u.upstream = scriptedUpstream(
		okAnswer(fifty.map((c) => c.ref)),
	);
	const ok50 = await userPush(u, pushBody(fifty));
	equal((await report(ok50)).refs.filter((r) => r.ok).length, 50);
});

Deno.test("git's 0000 probe is answered by the gateway (200, empty) without RepoDO or upstream", async () => {
	const w = createUnitWorld();
	const response = await userPush(w, "0000");
	equal(response.status, 200);
	equal(
		response.headers.get("content-type"),
		"application/x-git-receive-pack-result",
	);
	equal((await response.arrayBuffer()).byteLength, 0);
	equal(w.upstream.calls.length, 0);
	deepStrictEqual(w.repo.upstreamScopes, []);
});

// ---------------------------------------------------------------------------
// The synthesized report across the caps matrix
// ---------------------------------------------------------------------------

Deno.test("synthesized rejections parse for report-status / -v2 × side-band-64k / side-band / none × quiet", async () => {
	const commands = [feature(1), {
		ref: "refs/heads/main",
		old: sha(0),
		new: sha(2),
	}];
	const reasons: (RefPolicyReason | null)[] = [null, "woven-by-tartan"];
	const band2 = [
		"tartan ▸ main is woven by Tartan.\x1b[31m",
		"  push your lane",
	];
	for (const reportCap of ["report-status", "report-status-v2"]) {
		for (const sideBand of ["side-band-64k", "side-band", ""]) {
			for (const quiet of ["quiet", ""]) {
				const caps = [reportCap, sideBand, quiet].filter((c) => c !== "").join(
					" ",
				);
				const negotiated = negotiateCaps(caps.split(" "));
				const response = rejectionResponse({
					commands,
					reasons,
					caps: negotiated,
					band2,
				});
				const bytes = new Uint8Array(await response.arrayBuffer());
				const demuxed = negotiated.sideBand ? demuxSideband(bytes) : null;
				const parsed = parseReportStatus(
					demuxed ? demuxed.band1 : bytes,
					negotiated,
				);
				deepStrictEqual(parsed.refs, [
					{
						ref: "refs/heads/feat-1",
						ok: false,
						reason: "atomic: another ref was rejected",
					},
					{ ref: "refs/heads/main", ok: false, reason: "woven-by-tartan" },
				], caps);
				if (demuxed) {
					equal(demuxed.band2.length, 2, caps);
					ok(demuxed.flushed, caps);
					ok(
						!new TextDecoder().decode(concat([...demuxed.band2])).includes(
							"\x1b",
						),
						caps,
					);
				}
			}
		}
	}
	// Without report-status the client cannot read per-ref results: HTTP 403.
	const plain = rejectionResponse({
		commands,
		reasons,
		caps: negotiateCaps(["side-band-64k"]),
		band2: [],
	});
	equal(plain.status, 403);
	match(await plain.text(), /woven-by-tartan/);
});

// ---------------------------------------------------------------------------
// Upstream object-size errors and hang-ups ([E A3])
// ---------------------------------------------------------------------------

const sizeReport = (unpack: string, ngReason?: string) => () =>
	new Response(
		synthReportStatus(
			{
				unpack,
				refs: [
					ngReason === undefined
						? { ref: "refs/heads/feat-1", ok: true }
						: { ref: "refs/heads/feat-1", ok: false, reason: ngReason },
				],
			},
			negotiateCaps(CAPS.split(" ")),
		),
	);

Deno.test("Artifacts' three object-size answers become ng object-too-large", async () => {
	const big = new Uint8Array(33_600_000);
	const forms: [
		string,
		() => Response | Promise<Response>,
		Uint8Array<ArrayBuffer>,
	][] = [
		[
			"zlib unpack error",
			sizeReport(
				"zlib member compressed data exceeds maximum",
				"unpacker error",
			),
			new Uint8Array(10),
		],
		[
			"object_too_large ng",
			sizeReport("ok", "artifacts_git_receive_pack_object_too_large"),
			new Uint8Array(10),
		],
		[
			"hang-up with no message after 32 MiB",
			() => new Response(new Uint8Array(0)),
			big,
		],
		[
			"upstream connection error after 32 MiB",
			() => Promise.reject(new Error("socket hang up")),
			big,
		],
		["upstream 500 after 32 MiB", () => new Response("", { status: 500 }), big],
		[
			"side-band text and no report after 32 MiB",
			() =>
				new Response(concat([
					encodePktLine(
						new Uint8Array([
							3,
							...new TextEncoder().encode("fatal: object too large\n"),
						]),
					),
					encodeSpecialPkt("flush"),
				])),
			big,
		],
	];
	for (const [name, answer, pack] of forms) {
		const w = createUnitWorld();
		w.upstream = scriptedUpstream(answer);
		const response = await userPush(w, pushBody([feature(1)], CAPS, pack));
		equal(response.status, 200, name);
		const parsed = await report(response);
		deepStrictEqual(parsed.refs, [{
			ref: "refs/heads/feat-1",
			ok: false,
			reason: "object-too-large",
		}], name);
		await w.settle();
		equal(w.repo.pushes.length, 0, `${name}: recorded as accepted`);
	}
	// A small push whose upstream hangs up is a 502, not a size error.
	const w = createUnitWorld();
	w.upstream = scriptedUpstream(() => new Response(new Uint8Array(0)));
	const small = await userPush(w, pushBody([feature(1)]));
	equal(small.status, 502);
	await small.body?.cancel();
	// A push over 32 MiB that upstream accepts (many smaller objects) is
	// relayed and recorded as usual.
	const large = createUnitWorld();
	large.upstream = scriptedUpstream(okAnswer(["refs/heads/feat-1"]));
	const accepted = await userPush(
		large,
		pushBody([feature(1)], CAPS, new Uint8Array(33_600_000)),
	);
	deepStrictEqual((await report(accepted)).refs, [{
		ref: "refs/heads/feat-1",
		ok: true,
	}]);
	await large.settle();
	equal(large.repo.pushes.length, 1);
});

Deno.test("upstream 401/403 is a 502 (git never sees a credential prompt for the kernel's token)", async () => {
	const w = createUnitWorld();
	w.upstream = scriptedUpstream(() => new Response("no", { status: 403 }));
	const response = await userPush(w, pushBody([feature(1)]));
	equal(response.status, 502);
	await response.body?.cancel();
	// And the upstream got the kernel's full Bearer token, not the client's.
	match(
		w.upstream.calls[0].headers.get("authorization") ?? "",
		/^Bearer art_v2_x_1+\?expires=\d+$/,
	);
	ok(w.upstream.calls[0].path.startsWith(new URL(REMOTE).pathname));
});

// ---------------------------------------------------------------------------
// Phase 1 before the final flush; disconnects
// ---------------------------------------------------------------------------

Deno.test("the final flush is not released before phase 1 has committed (a delayed RepoDO)", async () => {
	const w = createUnitWorld();
	w.upstream = scriptedUpstream(
		okAnswer(["refs/heads/feat-1"]),
	);
	const release = w.repo.holdRecord();
	const response = await userPush(w, pushBody([feature(1)]));
	let done = false;
	const body = response.arrayBuffer().then((b) => {
		done = true;
		return new Uint8Array(b);
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	equal(done, false, "the response finished before phase 1");
	equal(w.repo.pushes.length, 0);
	release();
	const bytes = await body;
	equal(w.repo.pushes.length, 1);
	const demuxed = demuxSideband(bytes);
	ok(demuxed.flushed);
	deepStrictEqual(
		parseReportStatus(demuxed.band1, negotiateCaps(CAPS.split(" "))).refs,
		[{ ref: "refs/heads/feat-1", ok: true }],
	);
	await w.settle();
	deepStrictEqual(w.repo.pushes[0].refs, [{
		ref: "refs/heads/feat-1",
		before: ZERO_SHA,
		after: sha(1),
	}]);
	equal(w.repo.pushes[0].via, "gateway");
	equal(w.repo.diffs.length, 1, "phase 2 ran");
});

Deno.test("phase 1 that never answers holds the flush only for the bound (5 s in production)", async () => {
	const w = createUnitWorld();
	w.config = { ...w.config, phase1WaitMs: 120 };
	w.upstream = scriptedUpstream(
		okAnswer(["refs/heads/feat-1"]),
	);
	const release = w.repo.holdRecord();
	const started = performance.now();
	const response = await userPush(w, pushBody([feature(1)]));
	await response.arrayBuffer();
	const elapsed = performance.now() - started;
	ok(elapsed >= 100 && elapsed < 3_000, `${elapsed} ms`);
	release();
	await w.settle();
	equal(w.repo.pushes.length, 1, "waitUntil finished the record");
});

Deno.test("a client that disconnects mid-relay: the push is still recorded", async () => {
	const w = createUnitWorld();
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const caps = negotiateCaps(CAPS.split(" "));
	const reportBytes = synthReportStatus(
		{ unpack: "ok", refs: [{ ref: "refs/heads/feat-1", ok: true }] },
		caps,
	);
	w.upstream = scriptedUpstream(() =>
		new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(
						encodePktLine(
							new Uint8Array([
								2,
								...new TextEncoder().encode("Resolving deltas\n"),
							]),
						),
					);
					await finished;
					controller.enqueue(reportBytes);
					controller.close();
				},
			}),
		)
	);
	const response = await userPush(w, pushBody([feature(1)]));
	const reader = response.body!.getReader();
	await reader.read();
	await reader.cancel("client went away");
	finish();
	await w.settle();
	equal(w.repo.pushes.length, 1);
	deepStrictEqual(w.repo.pushes[0].refs.map((r) => r.ref), [
		"refs/heads/feat-1",
	]);
});

// ---------------------------------------------------------------------------
// Memory and the receive-pack advertisement
// ---------------------------------------------------------------------------

Deno.test("a 95 MB push is relayed with flat memory (no body buffering)", async () => {
	const w = createUnitWorld();
	const total = 94_000_000;
	const chunk = 256 * 1024;
	let peak = 0;
	const sample = () => {
		const m = Deno.memoryUsage();
		peak = Math.max(peak, m.heapUsed + m.external);
	};
	w.upstream = scriptedUpstream(
		okAnswer(["refs/heads/feat-1"]),
	);
	const sectionBytes = concat(section([feature(1)]));
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === 0) {
				controller.enqueue(sectionBytes);
				sent = sectionBytes.length;
				return;
			}
			if (sent >= total) {
				controller.close();
				return;
			}
			const n = Math.min(chunk, total - sent);
			controller.enqueue(new Uint8Array(n));
			sent += n;
			if ((sent / chunk) % 16 === 0) sample();
		},
	});
	const baseline = Deno.memoryUsage();
	const response = await userPush(w, body, { "content-length": String(total) });
	await response.arrayBuffer();
	await w.settle();
	equal(w.upstream.calls[0].bodyBytes, total);
	equal(w.repo.pushes[0].bytes, total);
	const growth = peak - (baseline.heapUsed + baseline.external);
	ok(
		growth < 48 * 1024 * 1024,
		`memory grew by ${Math.round(growth / 1e6)} MB`,
	);
});

Deno.test("the receive-pack advertisement strips push-cert, push-options and unknown capabilities", async () => {
	const w = createUnitWorld();
	const advert = concat([
		encodePktLine("# service=git-receive-pack\n"),
		encodeSpecialPkt("flush"),
		encodePktLine(
			`${
				sha(0)
			} refs/heads/main\0report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-cert=nonce push-options object-format=sha1 agent=artifacts/1 frobnicate\n`,
		),
		encodePktLine(`${sha(3)} refs/heads/lanes/${LANE}\n`),
		encodePktLine(`${sha(4)} refs/tartan/changes/x\n`),
		encodeSpecialPkt("flush"),
	]);
	w.upstream = scriptedUpstream(() => new Response(advert));
	const auth = authOf();
	w.repo.read = { ownLanes: [] };
	const response = await handleInfoRefs(
		w.deps(),
		w.request("GET", "info/refs?service=git-receive-pack", { auth }),
	);
	const text = await response.text();
	ok(text.includes("report-status"));
	for (const banned of ["push-cert", "push-options", "frobnicate"]) {
		ok(!text.includes(banned), `${banned}: ${text}`);
	}
	ok(!text.includes("refs/heads/lanes/") && !text.includes("refs/tartan/"));
	// The owner of that lane sees it.
	w.repo.read = {
		ownLanes: [{
			laneId: LANE,
			ref: `refs/heads/lanes/${LANE}`,
			headSha: sha(3),
		}],
	};
	const own = await (await handleInfoRefs(
		w.deps(),
		w.request("GET", "info/refs?service=git-receive-pack", { auth }),
	)).text();
	ok(own.includes(`refs/heads/lanes/${LANE}`));
});

Deno.test("an archived repo refuses receive-pack (403) before any token is minted", async () => {
	const w = createUnitWorld();
	w.node = { ...w.node, archived: true };
	const response = await userPush(w, pushBody([feature(1)]));
	equal(response.status, 403);
	await response.body?.cancel();
	deepStrictEqual(w.repo.upstreamScopes, []);
});
