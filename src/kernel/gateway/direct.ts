// An Owner's direct push to the default branch, as a two-step exchange with
// the git backend, because only the backend can hold the pushed objects and
// neither stock git nor Artifacts refuses a rewrite on the server:
//
// 1. Upload: the client's pack goes up under a quarantine ref
//    (`refs/tartan/direct/<id>`), so trunk does not move and nothing else does.
// 2. Check: RepoProbe walks the pushed commit: is it a fast-forward of the
//    client's `old`? A rewrite is refused here (`non-fast-forward`), and the
//    quarantine ref removed. A forced push gets no further than this.
// 3. Move: a ref-only request with the client's own commands (their `old` is the
//    compare-and-swap, so a concurrent move of trunk fails it) and the quarantine
//    ref's deletion. Its report, without that ref, is what the client sees.
//
// A crash between the steps leaves only the hidden quarantine ref. The observers
// ignore it (`repo/observe.ts`), so it never raises `ref.tampered`.

import {
	DIRECT_PUSH_PREFIX,
	type TrunkFastForward,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	DiffResult,
	PushCommand,
	Upstream,
} from "@tartan/contract/kernel.ts";
import {
	encodePktLine,
	encodeSpecialPkt,
	parseReportStatus,
	type ReportStatus,
	writePack,
} from "@tartan/gitproto";
import { readCapped, translateSizeErrors } from "./streams.ts";
import type { GatewayDeps } from "./types.ts";
import { callUpstream } from "./upstream.ts";

/** The upstream's report is a few lines per ref. */
const REPORT_MAX_BYTES = 1024 * 1024;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** A receive-pack command section; the capabilities go on its first line. */
const commandSection = (
	commands: readonly PushCommand[],
	caps: readonly string[],
): Uint8Array =>
	concat([
		...commands.map((c, i) =>
			encodePktLine(
				`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0${caps.join(" ")}` : ""}\n`,
			)
		),
		encodeSpecialPkt("flush"),
	]);

/** The stream without its first `skip` bytes. */
const skipBytes = (
	skip: number,
): TransformStream<Uint8Array, Uint8Array> => {
	let left = skip;
	return new TransformStream({
		transform(chunk, controller) {
			if (left >= chunk.length) {
				left -= chunk.length;
				return;
			}
			controller.enqueue(left === 0 ? chunk : chunk.subarray(left));
			left = 0;
		},
	});
};

const prefixed = (
	head: Uint8Array,
	rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
	const reader = rest.getReader();
	let sent = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sent) {
				sent = true;
				controller.enqueue(head);
				return;
			}
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
};

export type DirectPushInput = {
	readonly deps: GatewayDeps;
	readonly req: Request;
	readonly repoId: string;
	readonly upstream: Upstream;
	/** The push's commands, the trunk update among them. */
	readonly commands: readonly PushCommand[];
	readonly trunk: PushCommand;
	readonly capabilities: readonly string[];
	/** The whole request body from the command section on. */
	readonly body: ReadableStream<Uint8Array>;
	readonly sectionBytes: number;
	/** The client's whole body length, when it declared one. */
	readonly contentLength: number | null;
	readonly requestId: string;
	/** Counts the client's bytes and aborts at the limit (no `Content-Length`). */
	readonly counter: TransformStream<Uint8Array, Uint8Array>;
};

export type DirectPushOutcome =
	/** The upload failed; the caller decides what its sent bytes mean. */
	| { readonly kind: "upload-failed"; readonly status: number | null }
	/** The backend reported a failure; nothing moved. */
	| { readonly kind: "backend-refused"; readonly report: ReportStatus }
	/** Not a fast-forward; nothing moved. */
	| { readonly kind: "refused"; readonly why: string }
	| {
		readonly kind: "moved";
		/** The client's refs only. */
		readonly report: ReportStatus;
		readonly commits: readonly string[];
		/** The range diff for phase 2, or null when it failed. */
		readonly diff: DiffResult | null;
	};

const REPORT_CAPS = ["report-status", "agent=tartan"];

export const pushDirect = async (
	input: DirectPushInput,
): Promise<DirectPushOutcome> => {
	const { deps, req, repoId, upstream, trunk, commands } = input;
	const quarantine = `${DIRECT_PUSH_PREFIX}${input.requestId.toLowerCase()}`;
	const call = (body: BodyInit) =>
		callUpstream(deps, req, upstream, {
			method: "POST",
			path: "git-receive-pack",
			body,
		});
	const parsed = async (res: Response): Promise<ReportStatus | null> => {
		const answer = await readCapped(
			res.body ?? new Response(new Uint8Array(0)).body!,
			REPORT_MAX_BYTES,
		);
		if (answer === null) return null;
		try {
			return parseReportStatus(answer, { report: "report-status" });
		} catch {
			return null;
		}
	};
	const removeQuarantine = async (): Promise<void> => {
		try {
			const res = await call(
				commandSection(
					[{ old: trunk.new, new: ZERO_SHA, ref: quarantine }],
					REPORT_CAPS,
				) as Uint8Array<ArrayBuffer>,
			);
			await res.body?.cancel();
		} catch (error) {
			deps.log("[tartan] gateway: quarantine ref left behind", {
				repoId,
				ref: quarantine,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	// 1. Upload: the client's pack under the quarantine ref.
	const head = commandSection(
		[{ old: ZERO_SHA, new: trunk.new, ref: quarantine }],
		REPORT_CAPS,
	);
	let upload = prefixed(
		head,
		input.body.pipeThrough(skipBytes(input.sectionBytes)).pipeThrough(
			input.counter,
		),
	);
	const Fixed = (globalThis as {
		FixedLengthStream?: new (length: number) => TransformStream<
			Uint8Array,
			Uint8Array
		>;
	}).FixedLengthStream;
	if (input.contentLength !== null && Fixed !== undefined) {
		upload = upload.pipeThrough(
			new Fixed(input.contentLength - input.sectionBytes + head.length),
		);
	}
	let uploaded: Response;
	try {
		uploaded = await call(upload);
	} catch {
		return { kind: "upload-failed", status: null };
	}
	if (uploaded.status !== 200 || uploaded.body === null) {
		await uploaded.body?.cancel().catch(() => {});
		return { kind: "upload-failed", status: uploaded.status };
	}
	const received = await parsed(uploaded);
	if (received === null) return { kind: "upload-failed", status: 200 };
	const failed = translateSizeErrors(received) ?? received;
	if (failed.unpack !== "ok" || failed.refs.some((r) => !r.ok)) {
		const reason = failed.unpack !== "ok"
			? failed.unpack
			: failed.refs.find((r) => !r.ok)?.reason ?? "rejected";
		return {
			kind: "backend-refused",
			report: {
				unpack: failed.unpack,
				refs: commands.map((c) => ({ ref: c.ref, ok: false, reason })),
			},
		};
	}

	// 2. Check: the ancestry, now that the backend holds the objects.
	let check: TrunkFastForward;
	try {
		check = await deps.probe().trunkFastForward(repoId, trunk.old, trunk.new);
	} catch (error) {
		// Unverified means unmoved: a probe failure never lands a push.
		deps.log("[tartan] gateway: direct push check failed", {
			repoId,
			error: error instanceof Error ? error.message : String(error),
		});
		await removeQuarantine();
		return {
			kind: "backend-refused",
			report: {
				unpack: "ok",
				refs: commands.map((c) => ({
					ref: c.ref,
					ok: false,
					reason: "could not check the push; try again",
				})),
			},
		};
	}
	if (!check.fastForward) {
		await removeQuarantine();
		return { kind: "refused", why: check.why };
	}
	// The range diff, while `old` is still the merge base with trunk.
	let diff: DiffResult | null = null;
	try {
		diff = await deps.probe().laneDiff({ repoId }, trunk.new);
	} catch (error) {
		deps.log("[tartan] gateway: direct push diff failed", {
			repoId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// 3. Move: the client's commands, ref-only.
	const atomic = input.capabilities.some((c) => c === "atomic");
	let report: ReportStatus | null = null;
	try {
		const moved = await call(
			concat([
				commandSection(
					[...commands, { old: trunk.new, new: ZERO_SHA, ref: quarantine }],
					[...REPORT_CAPS, ...(atomic ? ["atomic"] : [])],
				),
				(await writePack([])).pack,
			]) as Uint8Array<ArrayBuffer>,
		);
		if (moved.status === 200) report = await parsed(moved);
		else await moved.body?.cancel().catch(() => {});
	} catch (error) {
		deps.log("[tartan] gateway: direct push move failed", {
			repoId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (report === null) {
		await removeQuarantine();
		return {
			kind: "backend-refused",
			report: {
				unpack: "ok",
				refs: commands.map((c) => ({
					ref: c.ref,
					ok: false,
					reason: "the git backend did not answer",
				})),
			},
		};
	}
	if (report.refs.find((r) => r.ref === quarantine)?.ok !== true) {
		await removeQuarantine();
	}
	const clientRefs = report.refs.filter((r) => r.ref !== quarantine);
	return {
		kind: "moved",
		report: { ...report, refs: clientRefs },
		commits: check.commits,
		diff,
	};
};
