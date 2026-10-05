// The gateway's small pieces: band-2 guidance, the
// stream helpers (byte limit, drain, first-chunk peek, head capture), the
// upstream size-error translation, the isolate TTL cache and
// the views of hidden refs.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { laneId, ulid } from "@tartan/contract";
import { REF_POLICY_REASONS } from "@tartan/contract/kernel.ts";
import { createTtlCache } from "./deps.ts";
import {
	GUIDANCE_MAX_CHARS,
	GUIDANCE_MAX_LINES,
	guidanceLines,
} from "./guidance.ts";
import {
	captureHead,
	createByteCounter,
	drain,
	isUpstreamSizeError,
	peekFirstChunk,
	readCapped,
	translateSizeErrors,
} from "./streams.ts";
import {
	isV2Advertisement,
	memberLsRefs,
	memberRefs,
	publicRefs,
} from "./views.ts";
import { emptyReceiveAdvertisement } from "./upload.ts";

const LANE = laneId(ulid());

const streamOf = (...chunks: number[][]): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
			controller.close();
		},
	});

Deno.test("guidance: an agent pushing main is told its lane command; without a lane, how to get one", () => {
	const withLane = guidanceLines({
		repoPath: "acme/shop",
		caller: { kind: "agent" },
		defaultBranch: "main",
		ownLanes: [{
			laneId: LANE,
			mode: "branch",
			ref: `refs/heads/lanes/${LANE}`,
			state: "open",
		}],
		reasons: ["woven-by-tartan"],
		maxPushBytes: 95_000_000,
	});
	equal(
		withLane[0],
		"tartan ▸ main is woven by Tartan; nobody pushes it directly.",
	);
	ok(withLane[1].includes(`git push origin HEAD:refs/heads/lanes/${LANE}`));
	ok(withLane[1].includes(`(open lanes: ${LANE})`));
	const without = guidanceLines({
		repoPath: "acme/shop",
		caller: { kind: "agent" },
		defaultBranch: "trunk",
		ownLanes: [],
		reasons: ["woven-by-tartan", "agents-lanes-only"],
		maxPushBytes: 95_000_000,
	});
	equal(
		without[0],
		"tartan ▸ trunk is woven by Tartan; nobody pushes it directly.",
	);
	ok(without.some((l) => l.includes("MCP work_claim")));
	// A human without a lane gets the branch + submit hint.
	const human = guidanceLines({
		repoPath: "acme/shop",
		caller: { kind: "user" },
		defaultBranch: "main",
		ownLanes: [],
		reasons: ["woven-by-tartan"],
		maxPushBytes: 95_000_000,
	});
	ok(human[1].includes("tartan submit"));
});

Deno.test("guidance: every reason has text, at most 10 lines of at most 200 characters", () => {
	const lines = guidanceLines({
		repoPath: "acme/shop",
		caller: { kind: "agent" },
		defaultBranch: "x".repeat(400),
		ownLanes: [],
		reasons: [...REF_POLICY_REASONS],
		maxPushBytes: 95_000_000,
	});
	equal(lines.length, GUIDANCE_MAX_LINES);
	ok(lines.every((l) => l.length <= GUIDANCE_MAX_CHARS));
	for (const reason of REF_POLICY_REASONS) {
		ok(
			guidanceLines({
				repoPath: "a/b",
				caller: { kind: "user" },
				defaultBranch: "main",
				ownLanes: [],
				reasons: [reason],
				maxPushBytes: 1,
			}).length > 0,
			reason,
		);
	}
});

Deno.test("byte counter: counts, and errors the stream past the limit", async () => {
	const counter = createByteCounter(5);
	const reader = streamOf([1, 2, 3], [4, 5, 6]).pipeThrough(counter.stream)
		.getReader();
	deepStrictEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
	await rejects(() => reader.read());
	ok(counter.exceeded());
	equal(counter.bytes(), 6);
	const free = createByteCounter();
	await drain(streamOf([1], [2, 3]).pipeThrough(free.stream), 100);
	equal(free.bytes(), 3);
	ok(!free.exceeded());
});

Deno.test("drain reads to the end or cancels past its cap; readCapped returns null past its cap", async () => {
	equal(await drain(streamOf([1, 2], [3]), 10), 3);
	equal(await drain(streamOf([1, 2], [3, 4, 5], [6]), 4), 5);
	equal(await drain(null, 4), 0);
	deepStrictEqual(
		await readCapped(streamOf([1, 2], [3]), 3),
		new Uint8Array([1, 2, 3]),
	);
	equal(await readCapped(streamOf([1, 2], [3]), 2), null);
});

Deno.test("peekFirstChunk replays the first chunk; an empty stream has none", async () => {
	const peeked = await peekFirstChunk(streamOf([], [1, 2], [3]));
	deepStrictEqual(peeked.first, new Uint8Array([1, 2]));
	deepStrictEqual(
		await readCapped(peeked.rest, 10),
		new Uint8Array([1, 2, 3]),
	);
	const empty = await peekFirstChunk(streamOf());
	equal(empty.first, null);
	deepStrictEqual(await readCapped(empty.rest, 10), new Uint8Array(0));
});

Deno.test("captureHead keeps the first bytes and passes everything through", async () => {
	const capture = captureHead(3);
	const all = await readCapped(
		streamOf([1, 2], [3, 4], [5]).pipeThrough(capture.stream),
		10,
	);
	deepStrictEqual(all, new Uint8Array([1, 2, 3, 4, 5]));
	deepStrictEqual(capture.head(), new Uint8Array([1, 2, 3]));
});

Deno.test("size errors: only Artifacts' object-size forms are translated", () => {
	ok(isUpstreamSizeError("zlib member compressed data exceeds maximum"));
	ok(isUpstreamSizeError("error: ARTIFACTS_GIT_RECEIVE_PACK_OBJECT_TOO_LARGE"));
	ok(!isUpstreamSizeError("non-fast-forward"));
	equal(
		translateSizeErrors({
			unpack: "ok",
			refs: [{ ref: "refs/heads/a", ok: false, reason: "non-fast-forward" }],
		}),
		null,
	);
	deepStrictEqual(
		translateSizeErrors({
			unpack: "zlib member compressed data exceeds maximum",
			refs: [{ ref: "refs/heads/a", ok: false, reason: "unpacker error" }, {
				ref: "refs/heads/b",
				ok: true,
			}],
		}),
		{
			unpack: "object-too-large",
			refs: [
				{ ref: "refs/heads/a", ok: false, reason: "object-too-large" },
				{ ref: "refs/heads/b", ok: false, reason: "object-too-large" },
			],
		},
	);
});

Deno.test("isolate TTL cache: hits within the TTL, reloads after, never keeps null", async () => {
	let now = 0;
	let loads = 0;
	const cache = createTtlCache<string | null>(100, () => now);
	const load = (value: string | null) => () => {
		loads++;
		return Promise.resolve(value);
	};
	equal(await cache("a", load("x")), "x");
	equal(await cache("a", load("y")), "x");
	now = 150;
	equal(await cache("a", load("y")), "y");
	equal(await cache("b", load(null)), null);
	equal(await cache("b", load("z")), "z");
	equal(loads, 4);
});

Deno.test("views: hidden namespaces, own lanes, hidden prefixes; v2 detection; the synthesized receive advertisement", () => {
	const own = new Set([`refs/heads/lanes/${LANE}`]);
	ok(publicRefs("refs/heads/main") && publicRefs("HEAD"));
	ok(!publicRefs(`refs/heads/lanes/${LANE}`) && !publicRefs("refs/tartan/x"));
	ok(memberRefs(own)(`refs/heads/lanes/${LANE}`));
	ok(!memberRefs(own)("refs/heads/lanes/ln_other"));
	const prefixed = memberLsRefs(own, ["refs/heads/lanes/ln_o", "refs/heads/"]);
	ok(prefixed("refs/heads/lanes/ln_other"));
	ok(!prefixed("refs/notes/lanes/x/ai"));
	ok(!memberLsRefs(own, ["refs/"])("refs/tartan/changes/x"));
	const v2 = new TextEncoder().encode(
		"001e# service=git-upload-pack\n0000000eversion 2\n0000",
	);
	ok(isV2Advertisement(v2));
	ok(!isV2Advertisement(emptyReceiveAdvertisement()));
	const text = new TextDecoder().decode(emptyReceiveAdvertisement());
	ok(text.includes("capabilities^{}"));
	ok(text.includes("report-status") && !text.includes("push-cert"));
});
