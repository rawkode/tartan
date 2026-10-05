// Receive-pack command peek: goldens from stock git 2.55 and every fail-closed
// rejection case (push-cert, 0001, shallow, truncated and oversized lengths,
// duplicate refs), limits and re-streaming.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	MAX_COMMANDS,
	peekCommands,
	type PeekCommandsResult,
	type PeekLimits,
	RECEIVE_PACK_CAPABILITIES,
	RECEIVE_SECTION_MAX_BYTES,
} from "../src/index.ts";
import {
	chunked,
	dec,
	golden,
	join,
	pkt,
	readAll,
	SHA_A,
	SHA_B,
	SHA_C,
	ZERO,
} from "./helpers.ts";

const USER: PeekLimits = {
	maxCommands: MAX_COMMANDS.user,
	maxSectionBytes: RECEIVE_SECTION_MAX_BYTES,
	capabilities: RECEIVE_PACK_CAPABILITIES,
};
const AGENT: PeekLimits = { ...USER, maxCommands: MAX_COMMANDS.agent };
const CAPS = "report-status side-band-64k quiet agent=git/2.55.0";

const peek = (bytes: Uint8Array, limits = USER, chunk?: number) =>
	peekCommands(chunked(bytes, chunk), limits);

const rejected = (result: PeekCommandsResult) => {
	if (result.kind !== "rejected") {
		throw new Error(`expected a rejection, got ${result.kind}`);
	}
	return result;
};
const accepted = (result: PeekCommandsResult) => {
	if (result.kind !== "commands") {
		throw new Error(
			`expected commands, got ${result.kind}${
				result.kind === "rejected" ? ` (${result.code}: ${result.detail})` : ""
			}`,
		);
	}
	return result;
};

Deno.test("goldens: stock git pushes are accepted and replayed byte for byte", async () => {
	const cases: [string, number][] = [
		["receive-pack-create", 1],
		["receive-pack-multi-ref", 2],
		["receive-pack-delete", 1],
		["receive-pack-atomic-update", 1],
		["receive-pack-chunked", 1],
	];
	for (const [name, count] of cases) {
		const g = golden(name);
		for (const chunk of [1, 7, 64, 1 << 20]) {
			const result = accepted(await peek(g.body, USER, chunk));
			equal(result.commands.length, count, name);
			deepStrictEqual(await readAll(result.body), g.body, `${name} replay`);
		}
	}
	const create = accepted(await peek(golden("receive-pack-create").body));
	deepStrictEqual(create.commands[0].ref, "refs/heads/main");
	equal(create.commands[0].old, ZERO);
	deepStrictEqual(create.capabilities, [
		"report-status-v2",
		"side-band-64k",
		"quiet",
		"object-format=sha1",
		"agent=git/2.55.0-Darwin",
	]);
	const atomic = accepted(
		await peek(golden("receive-pack-atomic-update").body),
	);
	ok(atomic.capabilities.includes("atomic"));
	const del = accepted(await peek(golden("receive-pack-delete").body));
	equal(del.commands[0].new, ZERO);
	equal(del.sectionBytes, golden("receive-pack-delete").body.length);
});

Deno.test("golden: the 0000 probe passes through; anything after it rejects", async () => {
	const probe = golden("receive-pack-probe");
	equal(dec(probe.body), "0000");
	const result = await peek(probe.body);
	equal(result.kind, "probe");
	if (result.kind === "probe") equal(dec(await readAll(result.body)), "0000");
	const trailing = rejected(await peek(join("0000", "0000")));
	equal(trailing.code, "probe-trailing-data");
	equal(trailing.parsed.length, 0);
	const trailingPack = rejected(await peek(join("0000", "PACK")));
	equal(trailingPack.code, "probe-trailing-data");
});

Deno.test("golden: a push from a shallow clone (shallow line) rejects with no commands", async () => {
	const result = rejected(await peek(golden("receive-pack-from-shallow").body));
	equal(result.code, "shallow");
	equal(result.parsed.length, 0);
});

Deno.test("a push-cert block rejects the whole request", async () => {
	const body = join(
		pkt(`push-cert\0${CAPS}\n`),
		pkt("certificate version 0.1\n"),
		pkt("pusher x 0 +0000\n"),
		pkt("\n"),
		pkt(`${SHA_A} ${SHA_B} refs/heads/main\n`),
		pkt("push-cert-end\n"),
		"0000",
	);
	const result = rejected(await peek(body));
	equal(result.code, "push-cert");
	equal(result.parsed.length, 0);
	// A push-cert after a command still rejects everything parsed so far.
	const later = rejected(
		await peek(
			join(
				pkt(`${SHA_A} ${SHA_B} refs/heads/a\0${CAPS}`),
				pkt("push-cert\n"),
				"0000",
			),
		),
	);
	equal(later.code, "push-cert");
	deepStrictEqual(later.parsed.map((c) => c.ref), ["refs/heads/a"]);
	equal(later.reason, "unsupported-ref");
	// push-cert as a selected capability is refused too.
	const cap = rejected(
		await peek(
			join(pkt(`${SHA_A} ${SHA_B} refs/heads/a\0push-cert=x`), "0000"),
		),
	);
	equal(cap.code, "capability");
});

Deno.test("0001, 0002, truncated and oversized lengths reject", async () => {
	const first = pkt(`${SHA_A} ${SHA_B} refs/heads/a\0${CAPS}`);
	const cases: [string, Uint8Array, string, number][] = [
		["delim", join(first, "0001", "0000"), "delim", 1],
		["response-end", join(first, "0002", "0000"), "delim", 1],
		["0003", join(first, "0003", "0000"), "bad-length", 1],
		["non-hex", join(first, "zzzz", "0000"), "bad-length", 1],
		["oversized", join(first, "fff1"), "oversized", 1],
		["truncated header", join(first, "00"), "truncated", 1],
		["truncated packet", join(first, "0050abc"), "truncated", 1],
		["no flush", first, "truncated", 1],
		["empty packet", join(first, "0004", "0000"), "empty-line", 1],
		["empty body", new Uint8Array(0), "empty", 0],
	];
	for (const [name, bytes, code, parsed] of cases) {
		for (const chunk of [1, 5, 1 << 20]) {
			const result = rejected(await peek(bytes, USER, chunk));
			equal(result.code, code, `${name}/${chunk}`);
			equal(result.parsed.length, parsed, `${name} parsed`);
		}
	}
});

Deno.test("duplicate refs, bad refnames, bad ids and capabilities reject as a whole", async () => {
	const dup = rejected(
		await peek(join(
			pkt(`${SHA_A} ${SHA_B} refs/heads/a\0${CAPS}`),
			pkt(`${SHA_B} ${SHA_C} refs/heads/a`),
			"0000",
		)),
	);
	equal(dup.code, "duplicate-ref");
	equal(dup.reason, "invalid-ref");
	equal(dup.parsed.length, 1);
	const bad: [string, string][] = [
		[`${SHA_A} ${SHA_B} refs/heads/a..b`, "bad-refname"],
		[`${SHA_A} ${SHA_B} refs/x`, "bad-refname"],
		[`${SHA_A} ${SHA_B} HEAD`, "bad-refname"],
		[`${SHA_A} ${SHA_B} refs/heads/a b`, "bad-command"],
		[`${"ABCDEF0123".repeat(4)} ${SHA_B} refs/heads/a`, "bad-command"],
		[`${SHA_A} ${SHA_B.slice(1)} refs/heads/a`, "bad-command"],
		[`${ZERO} ${ZERO} refs/heads/a`, "zero-command"],
		[
			`${SHA_A} ${SHA_B} refs/heads/a\0report-status push-options`,
			"capability",
		],
		[`${SHA_A} ${SHA_B} refs/heads/a\0report-status unknown-cap`, "capability"],
		[`${SHA_A} ${SHA_B} refs/heads/a\0object-format=sha256`, "capability"],
		[`${SHA_A} ${SHA_B} refs/heads/a\0quiet=1`, "capability"],
		[`${SHA_A} ${SHA_B} refs/heads/a\0session-id=x`, "capability"],
	];
	for (const [line, code] of bad) {
		const result = rejected(await peek(join(pkt(line), "0000")));
		equal(result.code, code, line);
		equal(result.parsed.length, 0, line);
	}
	const nonUtf8 = rejected(
		await peek(
			join(
				pkt(
					join(`${SHA_A} ${SHA_B} refs/heads/`, new Uint8Array([0xff, 0xfe])),
				),
				"0000",
			),
		),
	);
	equal(nonUtf8.code, "bad-command");
	const capsLater = rejected(
		await peek(join(
			pkt(`${SHA_A} ${SHA_B} refs/heads/a\0${CAPS}`),
			pkt(`${SHA_A} ${SHA_B} refs/heads/b\0report-status`),
			"0000",
		)),
	);
	equal(capsLater.code, "bad-command");
});

Deno.test("command limits: 8 for agents, 1,000 for users, 64 KiB per section", async () => {
	const commands = (n: number) =>
		join(
			...Array.from({ length: n }, (_, i) =>
				pkt(`${ZERO} ${SHA_A} refs/heads/b${i}${i === 0 ? `\0${CAPS}` : ""}`)),
			"0000",
		);
	equal(accepted(await peek(commands(8), AGENT)).commands.length, 8);
	const nine = rejected(await peek(commands(9), AGENT));
	equal(nine.code, "too-many-commands");
	equal(nine.parsed.length, 8);
	equal(accepted(await peek(commands(600), USER)).commands.length, 600);
	const big = rejected(
		await peek(commands(1001), { ...USER, maxSectionBytes: 1 << 20 }),
	);
	equal(big.code, "too-many-commands");
	const section = rejected(await peek(commands(800), USER));
	equal(section.code, "section-too-large");
	ok(section.parsed.length > 0 && section.parsed.length < 800);
	// Two long commands whose flush lands past the cap.
	const long = rejected(
		await peek(join(
			pkt(`${SHA_A} ${SHA_B} refs/heads/${"a".repeat(33_000)}\0${CAPS}`),
			pkt(`${SHA_A} ${SHA_B} refs/heads/${"b".repeat(33_000)}`),
			"0000",
		)),
	);
	equal(long.code, "section-too-large");
	equal(long.parsed.length, 1);
});

Deno.test("the peek reads only the command section of a large body", async () => {
	const head = join(pkt(`${SHA_A} ${SHA_B} refs/heads/a\0${CAPS}`), "0000");
	let pulled = 0;
	const total = 64;
	const big = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled === 0) controller.enqueue(head);
			else if (pulled <= total) controller.enqueue(new Uint8Array(1 << 20));
			else controller.close();
			pulled++;
		},
	}, { highWaterMark: 0 });
	const result = accepted(await peekCommands(big, USER));
	ok(pulled <= 2, `pulled ${pulled} chunks before returning`);
	const replayed = await readAll(result.body);
	equal(replayed.length, head.length + total * (1 << 20));
});

Deno.test("a rejected peek cancels the body", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(join(pkt("shallow " + SHA_A), "0000"));
		},
		cancel() {
			cancelled = true;
		},
	});
	rejected(await peekCommands(body, USER));
	ok(cancelled);
});
