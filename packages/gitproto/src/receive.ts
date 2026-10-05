// Receive-pack: the fail-closed command peek.
//
// Accepts only git's probe (a body that is exactly `0000`) or a command
// section of well-formed `<old40> <new40> <refname>` pkt-lines (capabilities
// after a NUL on the first, all on the advertised allowlist) closed by one
// flush, within the command and byte limits. Anything else (a push-cert
// block, `shallow` lines, `0001`/`0002`, a bad, truncated or oversized
// length, a duplicate ref, an empty packet, invalid UTF-8) rejects the whole
// request. The peek never forwards anything: on acceptance it hands back a
// stream that replays every byte it read, followed by the rest of the body.

import type { PushCommand, RefPolicyReason } from "@tartan/contract/kernel.ts";
import { ZERO_SHA } from "@tartan/contract";
import { createByteBuffer, decodeStrict, streamOf } from "./bytes.ts";
import {
	capabilityName,
	isAllowedCapability,
	splitCapabilities,
} from "./capabilities.ts";
import { chomp, readPkt } from "./pktline.ts";
import { isValidPushRefname } from "./refname.ts";

/** Command limits. */
export const MAX_COMMANDS = { user: 1_000, agent: 8 } as const;
/** The largest command section, flush included (64 KiB). */
export const RECEIVE_SECTION_MAX_BYTES = 64 * 1024;

export type PeekLimits = {
	/** 1,000 for users, 8 for agents. */
	readonly maxCommands: number;
	/** 64 KiB. */
	readonly maxSectionBytes: number;
	/** The advertised receive-pack capabilities the first command may select. */
	readonly capabilities: readonly string[];
};

/** Why a command section was rejected (diagnostics; the wire reason is `reason`). */
export type ReceiveErrorCode =
	| "empty"
	| "bad-length"
	| "oversized"
	| "truncated"
	| "section-too-large"
	| "delim"
	| "empty-line"
	| "push-cert"
	| "shallow"
	| "bad-command"
	| "zero-command"
	| "capability"
	| "bad-refname"
	| "duplicate-ref"
	| "too-many-commands"
	| "probe-trailing-data";

/**
 * The `ng` reason each parse failure carries. The contract has no dedicated
 * code for a malformed section yet, so name
 * and command errors use `invalid-ref` and protocol features and limits use
 * `unsupported-ref`.
 */
export const RECEIVE_ERROR_REASONS: Readonly<
	Record<ReceiveErrorCode, RefPolicyReason>
> = {
	empty: "unsupported-ref",
	"bad-length": "unsupported-ref",
	oversized: "unsupported-ref",
	truncated: "unsupported-ref",
	"section-too-large": "unsupported-ref",
	delim: "unsupported-ref",
	"empty-line": "unsupported-ref",
	"push-cert": "unsupported-ref",
	shallow: "unsupported-ref",
	"bad-command": "invalid-ref",
	"zero-command": "invalid-ref",
	capability: "unsupported-ref",
	"bad-refname": "invalid-ref",
	"duplicate-ref": "invalid-ref",
	"too-many-commands": "unsupported-ref",
	"probe-trailing-data": "unsupported-ref",
};

/** A whole-request rejection of a receive-pack command section. */
export type ReceiveRejection = {
	readonly kind: "rejected";
	readonly reason: RefPolicyReason;
	/** The parse failure behind `reason`. */
	readonly code: ReceiveErrorCode;
	readonly detail: string;
	/** The commands parsed before the failure (each gets `ng <ref> <reason>`); empty ⇒ 400. */
	readonly parsed: readonly PushCommand[];
};

export type PeekCommandsResult =
	| {
		/** The body is exactly `0000` (git's probe); passes through. */
		readonly kind: "probe";
		readonly body: ReadableStream<Uint8Array>;
	}
	| {
		readonly kind: "commands";
		readonly commands: readonly PushCommand[];
		/** The capabilities the client selected on the first command line. */
		readonly capabilities: readonly string[];
		/** Bytes of the command section, flush included. */
		readonly sectionBytes: number;
		/** The command section re-streamed with the rest of the body. */
		readonly body: ReadableStream<Uint8Array>;
	}
	| ReceiveRejection;

const COMMAND_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) ([^ ]+)$/;

type LineResult =
	| {
		readonly ok: true;
		readonly command: PushCommand;
		readonly caps: string[];
	}
	| {
		readonly ok: false;
		readonly code: ReceiveErrorCode;
		readonly detail: string;
	};

const parseCommandLine = (
	payload: Uint8Array,
	first: boolean,
	limits: PeekLimits,
): LineResult => {
	const text = decodeStrict(chomp(payload));
	if (text === null) {
		return { ok: false, code: "bad-command", detail: "not UTF-8" };
	}
	if (text.length === 0) {
		return { ok: false, code: "empty-line", detail: "empty command line" };
	}
	if (text.startsWith("push-cert")) {
		return {
			ok: false,
			code: "push-cert",
			detail: "signed pushes are not accepted",
		};
	}
	if (text.startsWith("shallow ")) {
		return {
			ok: false,
			code: "shallow",
			detail: "shallow pushes are not accepted",
		};
	}
	const nul = text.indexOf("\0");
	if (nul >= 0 && !first) {
		return {
			ok: false,
			code: "bad-command",
			detail: "capabilities after the first command",
		};
	}
	const commandText = nul >= 0 ? text.slice(0, nul) : text;
	const caps = nul >= 0 ? splitCapabilities(text.slice(nul + 1)) : [];
	const match = COMMAND_RE.exec(commandText);
	if (!match) {
		return { ok: false, code: "bad-command", detail: "not <old> <new> <ref>" };
	}
	const [, old, next, ref] = match;
	if (old === ZERO_SHA && next === ZERO_SHA) {
		return {
			ok: false,
			code: "zero-command",
			detail: `${ref}: both ids are zero`,
		};
	}
	if (!isValidPushRefname(ref)) {
		return { ok: false, code: "bad-refname", detail: "invalid refname" };
	}
	for (const cap of caps) {
		if (!isAllowedCapability(cap, limits.capabilities)) {
			return {
				ok: false,
				code: "capability",
				detail: `capability ${capabilityName(cap)} is not allowed`,
			};
		}
	}
	return { ok: true, command: { ref, old, new: next }, caps };
};

/** Replays `head`, then the rest of `reader`. */
const replay = (
	head: Uint8Array,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> => {
	let headSent = head.length === 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!headSent) {
				headSent = true;
				controller.enqueue(head);
				return;
			}
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
};

/**
 * Reads pkt-lines up to the first flush and accepts only the probe or
 * well-formed `<old40> <new40> <refname>` commands (caps on the first, ⊆
 * `limits.capabilities`) within the limits; a push-cert block, `shallow`,
 * `0001`/`0002`, truncated or oversized lengths, duplicate refs or anything
 * else rejects the whole request. Never forwards anything itself.
 */
export const peekCommands = async (
	body: ReadableStream<Uint8Array>,
	limits: PeekLimits,
): Promise<PeekCommandsResult> => {
	const reader = body.getReader();
	const accumulated = createByteBuffer();
	let buffer = accumulated.view();
	let ended = false;
	const more = async (): Promise<boolean> => {
		if (ended) return false;
		const { value, done } = await reader.read();
		if (done) {
			ended = true;
			return false;
		}
		if (value.length > 0) {
			accumulated.append(value);
			buffer = accumulated.view();
		}
		return true;
	};
	const commands: PushCommand[] = [];
	const seen = new Set<string>();
	let capabilities: string[] = [];
	const reject = async (
		code: ReceiveErrorCode,
		detail: string,
	): Promise<ReceiveRejection> => {
		await reader.cancel("rejected").catch(() => {});
		return {
			kind: "rejected",
			reason: RECEIVE_ERROR_REASONS[code],
			code,
			detail,
			parsed: [...commands],
		};
	};

	let offset = 0;
	for (;;) {
		const step = readPkt(buffer, offset);
		if (!step.ok) {
			if (!step.incomplete) {
				return await reject(step.code, `malformed pkt-line at byte ${offset}`);
			}
			if (buffer.length > limits.maxSectionBytes) {
				return await reject(
					"section-too-large",
					`command section over ${limits.maxSectionBytes} bytes`,
				);
			}
			if (!(await more())) {
				return await reject(
					buffer.length === 0 ? "empty" : "truncated",
					buffer.length === 0 ? "empty body" : "body ends before the flush",
				);
			}
			continue;
		}
		if (step.next > limits.maxSectionBytes) {
			return await reject(
				"section-too-large",
				`command section over ${limits.maxSectionBytes} bytes`,
			);
		}
		const line = step.line;
		if (line.kind === "flush") {
			offset = step.next;
			break;
		}
		if (line.kind !== "data") {
			return await reject("delim", `unexpected ${line.kind} packet`);
		}
		if (commands.length >= limits.maxCommands) {
			return await reject(
				"too-many-commands",
				`more than ${limits.maxCommands} commands`,
			);
		}
		const parsed = parseCommandLine(line.data, commands.length === 0, limits);
		if (!parsed.ok) return await reject(parsed.code, parsed.detail);
		if (seen.has(parsed.command.ref)) {
			return await reject(
				"duplicate-ref",
				`${parsed.command.ref} appears twice`,
			);
		}
		seen.add(parsed.command.ref);
		if (commands.length === 0) capabilities = parsed.caps;
		commands.push(parsed.command);
		offset = step.next;
	}

	if (commands.length === 0) {
		// The probe: exactly `0000`, nothing after it.
		while (buffer.length === offset && (await more())) {
			// Skip empty chunks until data or the end.
		}
		if (buffer.length > offset) {
			return await reject("probe-trailing-data", "data after the probe flush");
		}
		reader.releaseLock();
		return { kind: "probe", body: streamOf(buffer) };
	}
	return {
		kind: "commands",
		commands,
		capabilities,
		sectionBytes: offset,
		body: replay(buffer, reader),
	};
};
