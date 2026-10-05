// Property and fuzz tests: no input makes either
// parser accept a command, argument or capability outside its allowlist;
// truncated and oversized lengths always reject; mutated goldens never
// crash a parser. Seeded, so failures reproduce.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	decodePktLines,
	isAllowedCapability,
	isValidPushRefname,
	MAX_COMMANDS,
	parseUploadRequest,
	peekCommands,
	type PeekLimits,
	PUBLIC_VIEW_PROFILE,
	RECEIVE_PACK_CAPABILITIES,
	UPLOAD_DECODE_MAX_BYTES,
	type UploadRequest,
} from "../src/index.ts";
import {
	chunked,
	dec,
	enc,
	golden,
	goldenNames,
	join,
	pkt,
	prng,
	readAll,
	ZERO,
} from "./helpers.ts";

const ITERATIONS = 1_500;
const LIMITS: PeekLimits = {
	maxCommands: MAX_COMMANDS.agent,
	maxSectionBytes: 4 * 1024,
	capabilities: RECEIVE_PACK_CAPABILITIES,
};

const HEX = "0123456789abcdef";
const sha = (rand: ReturnType<typeof prng>) =>
	Array.from({ length: 40 }, () => HEX[rand.int(16)]).join("");

const GOOD_REFS = [
	"refs/heads/main",
	"refs/heads/lanes/ln_01k6x",
	"refs/tags/v1",
	"refs/notes/x",
	"refs/heads/a/b",
];
const BAD_REFS = [
	"HEAD",
	"refs/x",
	"refs/heads/a..b",
	"refs/heads/a.lock",
	"refs/heads/a b",
	"refs/heads/",
	"refs/heads/a@{1}",
	"main",
];
const GOOD_CAPS = [
	"report-status",
	"report-status-v2",
	"side-band-64k",
	"side-band",
	"quiet",
	"delete-refs",
	"ofs-delta",
	"atomic",
	"agent=git/2.55",
	"object-format=sha1",
];
const BAD_CAPS = [
	"push-cert=1-2",
	"push-options",
	"session-id=x",
	"object-format=sha256",
	"quiet=1",
	"future",
	"agent",
];

type Line = {
	readonly bytes: Uint8Array;
	readonly valid: boolean;
	readonly ref?: string;
};

Deno.test("property: receive-pack peek accepts exactly the well-formed command sections", async () => {
	const rand = prng(0x5eed);
	const seen = { accepted: 0, rejected: 0 };
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const count = rand.int(11);
		const lines: Line[] = [];
		for (let i = 0; i < count; i++) {
			const kind = rand.int(12);
			const caps = i === 0 && rand.bool()
				? Array.from(
					{ length: 1 + rand.int(4) },
					() => rand.int(5) === 0 ? rand.pick(BAD_CAPS) : rand.pick(GOOD_CAPS),
				)
				: [];
			const capsOk = caps.every((c) =>
				isAllowedCapability(c, RECEIVE_PACK_CAPABILITIES)
			);
			const suffix = caps.length ? `\0${caps.join(" ")}` : "";
			const lf = rand.bool() ? "\n" : "";
			if (kind < 7) {
				const ref = rand.pick(GOOD_REFS) +
					(rand.bool() ? `/${rand.int(4)}` : "");
				const old = rand.int(4) === 0 ? ZERO : sha(rand);
				const next = rand.int(4) === 0 ? ZERO : sha(rand);
				lines.push({
					bytes: pkt(`${old} ${next} ${ref}${suffix}${lf}`),
					valid: capsOk && !(old === ZERO && next === ZERO),
					ref,
				});
			} else if (kind === 7) {
				const ref = rand.pick(BAD_REFS);
				lines.push({
					bytes: pkt(`${sha(rand)} ${sha(rand)} ${ref}${suffix}`),
					valid: false,
				});
			} else if (kind === 8) {
				lines.push({ bytes: pkt(`shallow ${sha(rand)}\n`), valid: false });
			} else if (kind === 9) {
				lines.push({ bytes: pkt(`push-cert${suffix}\n`), valid: false });
			} else if (kind === 10) {
				lines.push({
					bytes: enc(
						rand.pick(["0001", "0002", "0003", "0004", "zzzz", "fff1"]),
					),
					valid: false,
				});
			} else {
				// A later line carrying capabilities is malformed.
				lines.push({
					bytes: pkt(`${sha(rand)} ${sha(rand)} refs/heads/x${i}\0quiet`),
					valid: i === 0,
				});
			}
		}
		const truncate = rand.int(6) === 0;
		const body = join(
			...lines.map((l) => l.bytes),
			truncate ? "" : "0000",
			rand.bool() ? "PACK" : "",
		);
		const refs = lines.map((l) => l.ref);
		const duplicates = refs.some((r, i) =>
			r !== undefined && refs.indexOf(r) !== i
		);
		const expectAccept = !truncate && count > 0 &&
			count <= LIMITS.maxCommands &&
			lines.every((l) => l.valid) && !duplicates;
		const result = await peekCommands(chunked(body, 1 + rand.int(40)), LIMITS);
		if (result.kind === "commands") {
			ok(
				expectAccept,
				`accepted an invalid section #${iteration}: ${
					JSON.stringify(dec(body))
				}`,
			);
			for (const command of result.commands) {
				ok(isValidPushRefname(command.ref));
				ok(
					/^[0-9a-f]{40}$/.test(command.old) &&
						/^[0-9a-f]{40}$/.test(command.new),
				);
			}
			ok(
				result.capabilities.every((c) =>
					isAllowedCapability(c, LIMITS.capabilities)
				),
			);
			ok(result.commands.length <= LIMITS.maxCommands);
			equal(
				new Set(result.commands.map((c) => c.ref)).size,
				result.commands.length,
			);
			deepStrictEqual(await readAll(result.body), body);
			seen.accepted++;
		} else if (result.kind === "rejected") {
			ok(
				!expectAccept,
				`rejected a valid section #${iteration} (${result.code}): ${
					JSON.stringify(dec(body))
				}`,
			);
			ok(result.parsed.length <= LIMITS.maxCommands);
			seen.rejected++;
		} else {
			equal(dec(body), "0000");
		}
	}
	assertMixed(seen);
});

/** Both outcomes must be common, or the generator is not testing anything. */
const assertMixed = (seen: { accepted: number; rejected: number }) => {
	ok(seen.accepted > ITERATIONS / 20, `accepted only ${seen.accepted}`);
	ok(seen.rejected > ITERATIONS / 20, `rejected only ${seen.rejected}`);
};

Deno.test("property: every truncation of a golden command section rejects", async () => {
	for (
		const name of [
			"receive-pack-create",
			"receive-pack-multi-ref",
			"receive-pack-delete",
			"receive-pack-atomic-update",
		]
	) {
		const body = golden(name).body;
		const first = await peekCommands(chunked(body), {
			...LIMITS,
			maxSectionBytes: 64 * 1024,
		});
		if (first.kind !== "commands") throw new Error(name);
		for (let cut = 0; cut < first.sectionBytes; cut++) {
			const result = await peekCommands(chunked(body.subarray(0, cut), 3), {
				...LIMITS,
				maxSectionBytes: 64 * 1024,
			});
			equal(result.kind, "rejected", `${name} cut at ${cut}`);
		}
	}
});

const V2_ARGS: Record<string, string[]> = {
	"ls-refs": [
		"peel",
		"symrefs",
		"unborn",
		"ref-prefix refs/heads/",
		"ref-prefix HEAD",
	],
	fetch: [
		`want ${"a".repeat(40)}`,
		`have ${"b".repeat(40)}`,
		"done",
		"thin-pack",
		"no-progress",
		"include-tag",
		"ofs-delta",
		`shallow ${"c".repeat(40)}`,
		"deepen 3",
		"deepen-since 1700000000",
		"deepen-relative",
		"filter blob:none",
	],
};
const V2_BAD_ARGS = [
	"want-ref refs/heads/main",
	"deepen-not refs/heads/x",
	"sideband-all",
	"wait-for-done",
	"packfile-uris https",
	"filter sparse:oid=main",
	"want zz",
	"deepen 0",
	"done now",
	"",
	"server-option=x",
];
const V2_COMMANDS = ["ls-refs", "fetch"];
const V2_BAD_COMMANDS = ["object-info", "bundle-uri", "push", "", "LS-REFS"];

Deno.test("property: the upload-pack parser never accepts outside the public-view profile (v2)", async () => {
	const rand = prng(0xfeed);
	const seen = { accepted: 0, rejected: 0 };
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const goodCommand = rand.int(6) !== 0;
		const command = goodCommand
			? rand.pick(V2_COMMANDS)
			: rand.pick(V2_BAD_COMMANDS);
		const caps = rand.int(5) === 0
			? ["server-option=x"]
			: rand.bool()
			? ["agent=git/2.55", "object-format=sha1"]
			: [];
		const capsOk = caps.every((c) => c !== "server-option=x");
		const args: { text: string; valid: boolean }[] = [];
		for (let i = rand.int(6); i > 0; i--) {
			const bad = rand.int(7) === 0;
			const pool = goodCommand ? V2_ARGS[command] : V2_ARGS.fetch;
			args.push(
				bad
					? { text: rand.pick(V2_BAD_ARGS), valid: false }
					: { text: rand.pick(pool), valid: true },
			);
		}
		const truncated = rand.int(8) === 0;
		const trailing = rand.int(10) === 0;
		const body = join(
			pkt(`command=${command}\n`),
			...caps.map((c) => pkt(`${c}\n`)),
			"0001",
			...args.map((a) => a.text === "" ? enc("0004") : pkt(`${a.text}\n`)),
			truncated ? "" : "0000",
			trailing ? pkt("command=fetch\n") : "",
		);
		const expectAccept = goodCommand && capsOk && args.every((a) => a.valid) &&
			!truncated && !trailing;
		const result = await parseUploadRequest(chunked(body, 1 + rand.int(64)), {
			encoding: null,
			gitProtocol: "version=2",
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		});
		if (result.kind === "request") {
			ok(expectAccept, `accepted #${iteration}: ${JSON.stringify(dec(body))}`);
			checkAccepted(result);
			seen.accepted++;
		} else {
			ok(
				!expectAccept,
				`rejected #${iteration} (${result.code}): ${JSON.stringify(dec(body))}`,
			);
			seen.rejected++;
		}
	}
	assertMixed(seen);
});

const checkAccepted = (request: UploadRequest) => {
	const allowed = request.protocol === "v2"
		? PUBLIC_VIEW_PROFILE.v2[request.command]
		: PUBLIC_VIEW_PROFILE.v0.lines;
	ok(allowed, `command ${request.command}`);
	for (const arg of request.arguments) {
		ok(allowed.includes(arg.split(" ")[0]), arg);
	}
	for (const id of [...request.wants, ...request.haves, ...request.shallows]) {
		ok(/^[0-9a-f]{40}$/.test(id));
	}
	if (request.protocol === "v0") {
		ok(
			request.capabilities.every((c) =>
				isAllowedCapability(c, PUBLIC_VIEW_PROFILE.v0.capabilities)
			),
		);
	}
};

const V0_CAPS = [
	"multi_ack_detailed",
	"side-band-64k",
	"thin-pack",
	"ofs-delta",
	"no-done",
	"agent=git/2.55",
	"include-tag",
];
const V0_BAD_CAPS = [
	"allow-tip-sha1-in-want",
	"filter",
	"deepen-not",
	"session-id=1",
	"sideband-all",
];

Deno.test("property: the upload-pack parser never accepts outside the public-view profile (v0)", async () => {
	const rand = prng(0xbeef);
	const seen = { accepted: 0, rejected: 0 };
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const wants = 1 + rand.int(3);
		const parts: Uint8Array[] = [];
		let valid = true;
		for (let i = 0; i < wants; i++) {
			const caps = i === 0 && rand.bool()
				? Array.from(
					{ length: 1 + rand.int(3) },
					() => rand.int(6) === 0 ? rand.pick(V0_BAD_CAPS) : rand.pick(V0_CAPS),
				)
				: [];
			if (caps.some((c) => V0_BAD_CAPS.includes(c))) valid = false;
			const lateCaps = i > 0 && rand.int(10) === 0;
			if (lateCaps) valid = false;
			parts.push(
				pkt(
					`want ${sha(rand)}${caps.length ? ` ${caps.join(" ")}` : ""}${
						lateCaps ? " ofs-delta" : ""
					}\n`,
				),
			);
		}
		if (rand.int(4) === 0) parts.push(pkt(`shallow ${sha(rand)}\n`));
		if (rand.int(4) === 0) parts.push(pkt("deepen 2\n"));
		if (rand.int(8) === 0) {
			parts.push(
				pkt(
					rand.pick([
						"deepen-not refs/heads/x\n",
						"filter blob:none\n",
						`have ${sha(rand)}\n`,
						"want-ref refs/heads/x\n",
					]),
				),
			);
			valid = false;
		}
		parts.push(enc("0000"));
		for (let i = rand.int(4); i > 0; i--) {
			parts.push(pkt(`have ${sha(rand)}\n`));
		}
		const ending = rand.int(6);
		if (ending === 0) {
			valid = false; // no flush, no done
		} else if (ending === 1) {
			parts.push(enc("0000"));
		} else {
			parts.push(pkt("done\n"));
			if (ending === 2) {
				parts.push(pkt(`have ${sha(rand)}\n`));
				valid = false;
			}
		}
		const body = join(...parts);
		const result = await parseUploadRequest(chunked(body, 1 + rand.int(64)), {
			encoding: null,
			gitProtocol: rand.bool() ? null : "version=1",
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		});
		if (result.kind === "request") {
			ok(valid, `accepted #${iteration}: ${JSON.stringify(dec(body))}`);
			checkAccepted(result);
			seen.accepted++;
		} else {
			ok(
				!valid,
				`rejected #${iteration} (${result.code}): ${JSON.stringify(dec(body))}`,
			);
			seen.rejected++;
		}
	}
	assertMixed(seen);
});

Deno.test("property: truncated or oversized lengths in golden upload requests always reject", async () => {
	for (const name of goldenNames()) {
		const g = golden(name);
		if (g.op !== "git-upload-pack" || g.contentEncoding !== null) continue;
		const options = {
			encoding: null,
			gitProtocol: g.gitProtocol,
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		};
		const whole = await parseUploadRequest(chunked(g.body), options);
		if (whole.kind !== "request") continue; // e.g. the raw-ad golden
		for (let cut = 0; cut < g.body.length; cut++) {
			const result = await parseUploadRequest(
				chunked(g.body.subarray(0, cut), 7),
				options,
			);
			equal(result.kind, "rejected", `${name} cut at ${cut}`);
		}
		const { lines } = decodePktLines(g.body);
		let offset = 0;
		for (const line of lines) {
			for (const header of ["fff1", "ffff", "0003", "00g0"]) {
				const mutated = g.body.slice();
				mutated.set(enc(header), offset);
				const result = await parseUploadRequest(chunked(mutated), options);
				equal(result.kind, "rejected", `${name} header ${header} at ${offset}`);
			}
			offset += line.kind === "data" ? line.data.length + 4 : 4;
		}
	}
});

Deno.test("fuzz: byte mutations of every golden request never crash either parser", async () => {
	const rand = prng(0xc0ffee);
	const names = goldenNames().filter((n) => golden(n).body.length > 0);
	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const g = golden(rand.pick(names));
		const body = g.body.slice();
		for (let flips = 1 + rand.int(4); flips > 0; flips--) {
			const at = rand.int(Math.min(body.length, 600));
			body[at] = rand.int(4) === 0
				? rand.pick([0x30, 0x66, 0x00, 0x0a, 0x20])
				: rand.int(256);
		}
		const receive = await peekCommands(chunked(body, 1 + rand.int(50)), {
			...LIMITS,
			maxSectionBytes: 64 * 1024,
		});
		if (receive.kind === "commands") {
			for (const command of receive.commands) {
				ok(isValidPushRefname(command.ref));
			}
			ok(
				receive.capabilities.every((c) =>
					isAllowedCapability(c, RECEIVE_PACK_CAPABILITIES)
				),
			);
		}
		const upload = await parseUploadRequest(chunked(body, 1 + rand.int(50)), {
			encoding: g.contentEncoding,
			gitProtocol: g.gitProtocol,
			maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
			profile: PUBLIC_VIEW_PROFILE,
		});
		if (upload.kind === "request") checkAccepted(upload);
	}
});
