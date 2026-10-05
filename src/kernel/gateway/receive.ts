// Receive-pack on the canonical repo and on lane remotes (WP4). In order:
//
// 1. identity `Content-Encoding` only (415), then the fail-closed command
//    peek (`peekCommands`, WP22): the probe `0000` is answered here; a
//    malformed section is refused as a whole (`ng` for every command parsed
//    so far, or 400);
// 2. a lane remote first asks `pushContext` with the lane as target (404
//    unless it is a `repo` lane of this repo); then `Content-Length` above
//    `MAX_PUSH_BYTES` → `push-too-large`;
// 3. `pushContext` (one RPC), then on the canonical URL the write precheck
//    and the ref policy, on a lane remote the lane-remote policy; any
//    rejected command rejects the whole push with a synthesized
//    report-status (`ng`, band-2 guidance only with `ECHO_ENABLED`),
//    recorded through `recordRejection`, the request body drained, nothing
//    forwarded and no write token minted;
// 4. forward with a write token scoped to the one repo the URL names (the
//    canonical repo, or the lane's current lane repo: layer 2), streamed (a
//    counting stream aborts at the limit when there is no `Content-Length`),
//    and translate Artifacts' object-size errors and hang-ups to
//    `object-too-large`;
// 5. relay the response; phase 1 of `recordPush` runs as soon as band 1 is
//    parsed (from a tee of the upstream body, so a client that disconnects
//    mid-relay is still recorded), and the held-back final flush is released
//    only after phase 1 has committed (5 s bound); phase 2 (RepoProbe's lane
//    range → `recordDiff`) follows in `waitUntil`.

import {
	ARTIFACTS_OBJECT_LIMIT_BYTES,
	fromRpcError,
	isKernelRef,
	LANE_BRANCH_PREFIX,
	redactSecrets,
	stripControl,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AuthContext,
	PushCaller,
	PushCommand,
	RecordPushResult,
	RefPolicyReason,
} from "@tartan/contract/kernel.ts";
import {
	createReceivePackRelay,
	decodePktLines,
	demuxSideband,
	isAllowedCapability,
	MAX_COMMANDS,
	negotiateCaps,
	type NegotiatedCaps,
	parseReportStatus,
	peekCommands,
	RECEIVE_PACK_CAPABILITIES,
	RECEIVE_SECTION_MAX_BYTES,
	type ReceiveErrorCode,
	RELAY_HOLD_BACK_MAX_BYTES,
	type ReportStatus,
	synthReportStatus,
} from "@tartan/gitproto";
import { laneNotFound, type RepoAccess, resolveAccess } from "./access.ts";
import { ATOMIC_REASON, guidanceLines } from "./guidance.ts";
import { laneUpstream } from "./laneremote.ts";
import {
	canonicalWritePrecheck,
	fold,
	type GatewayPushContext,
} from "./policy.ts";
import { CONTENT_TYPE, gitBody, gitText, NO_CACHE } from "./respond.ts";
import {
	captureHead,
	consume,
	createByteCounter,
	drain,
	peekFirstChunk,
	readCapped,
	translateSizeErrors,
} from "./streams.ts";
import type { GatewayDeps, GatewayRepo, GitRequest } from "./types.ts";
import { callUpstream } from "./upstream.ts";

/** Extra bytes drained past `MAX_PUSH_BYTES` before the rest of a rejected body is cancelled. */
const DRAIN_SLACK_BYTES = 1024 * 1024;

/**
 * The `ng` reason of each command-section failure. The contract's
 * `malformed-push` and `too-many-commands` replace WP22's interim mapping
 * (`RECEIVE_ERROR_REASONS`) at the gateway.
 */
export const PEEK_REASONS: Readonly<Record<ReceiveErrorCode, RefPolicyReason>> =
	{
		empty: "malformed-push",
		"bad-length": "malformed-push",
		oversized: "malformed-push",
		truncated: "malformed-push",
		"section-too-large": "malformed-push",
		delim: "malformed-push",
		"empty-line": "malformed-push",
		"push-cert": "malformed-push",
		shallow: "malformed-push",
		"bad-command": "invalid-ref",
		"zero-command": "invalid-ref",
		capability: "malformed-push",
		"bad-refname": "invalid-ref",
		"duplicate-ref": "malformed-push",
		"too-many-commands": "too-many-commands",
		"probe-trailing-data": "malformed-push",
	};

const errorText = (error: unknown): string =>
	redactSecrets(error instanceof Error ? error.message : String(error));

/** A promise that settles by `ms` at the latest (the timer is always cleared). */
const within = async (promise: Promise<unknown>, ms: number): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.then(() => {}, () => {}),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]);
	clearTimeout(timer);
};

/**
 * The capabilities on the first command line of a command section, read
 * from its captured head (for a rejection found after that line).
 */
const capsOfHead = (head: Uint8Array): NegotiatedCaps => {
	try {
		// The first packet is complete whenever a later one failed.
		const length = parseInt(new TextDecoder().decode(head.subarray(0, 4)), 16);
		const first = decodePktLines(head.subarray(0, length)).lines[0];
		if (first?.kind !== "data") return negotiateCaps([]);
		const text = new TextDecoder().decode(first.data);
		const nul = text.indexOf("\0");
		if (nul < 0) return negotiateCaps([]);
		return negotiateCaps(
			text.slice(nul + 1).trim().split(" ").filter((cap) =>
				isAllowedCapability(cap, RECEIVE_PACK_CAPABILITIES)
			),
		);
	} catch {
		return negotiateCaps([]);
	}
};

type Rejection = {
	readonly commands: readonly PushCommand[];
	/** The reason of each command; `null` = allowed but rejected with the push. */
	readonly reasons: readonly (RefPolicyReason | null)[];
	readonly caps: NegotiatedCaps;
	readonly band2: readonly string[];
};

/** The synthesized response of a rejected push. */
export const rejectionResponse = (rejection: Rejection): Response => {
	if (rejection.caps.report === null) {
		const reason = rejection.reasons.find((r) => r !== null) ?? "rejected";
		return gitText(403, `push rejected: ${reason}`);
	}
	const report: ReportStatus = {
		unpack: "ok",
		refs: rejection.commands.map((command, i) => ({
			ref: command.ref,
			ok: false,
			reason: rejection.reasons[i] ?? ATOMIC_REASON,
		})),
	};
	return gitBody(
		synthReportStatus(report, rejection.caps, rejection.band2),
		CONTENT_TYPE.receiveResult,
	);
};

type PushState = {
	readonly deps: GatewayDeps;
	readonly r: GitRequest;
	readonly auth: AuthContext;
	readonly access: RepoAccess;
	readonly repo: GatewayRepo;
	readonly requestId: string;
	/** A lane remote's lane (`repo` backend); null on the canonical URL. */
	readonly laneId: string | null;
};

/** Records a rejection (`push.rejected`, releases the push lease) without delaying the answer. */
const recordRejection = (
	s: PushState,
	commands: readonly PushCommand[],
	reason: RefPolicyReason,
): void => {
	if (commands.length === 0) return;
	s.r.waitUntil(
		s.repo.recordRejection({
			principal: s.auth.principal,
			...(s.auth.tokenId ? { tokenId: s.auth.tokenId } : {}),
			target: s.laneId ?? "repo",
			commands,
			reason,
			requestId: s.requestId,
		}).catch((error) =>
			s.deps.log("[tartan] gateway: recordRejection failed", {
				repoId: s.access.repoId,
				error: errorText(error),
			})
		),
	);
};

/** A rejection of every command: recorded, the body drained, the report synthesized. */
const reject = async (
	s: PushState,
	input: {
		readonly commands: readonly PushCommand[];
		readonly reasons: readonly (RefPolicyReason | null)[];
		readonly caps: NegotiatedCaps;
		readonly body: ReadableStream<Uint8Array> | null;
		readonly ownLanes?: GatewayPushContext["ownLanes"];
		readonly defaultBranch?: string;
	},
): Promise<Response> => {
	const reasons = input.reasons.filter((r): r is RefPolicyReason => r !== null);
	recordRejection(s, input.commands, reasons[0] ?? "malformed-push");
	await drain(input.body, s.deps.config.maxPushBytes + DRAIN_SLACK_BYTES);
	const band2 = s.deps.config.echo && input.caps.sideBand !== null
		? guidanceLines({
			repoPath: s.access.node.path,
			origin: s.r.url.origin,
			caller: { kind: s.auth.kind },
			defaultBranch: input.defaultBranch ??
				s.access.node.defaultBranch ?? "main",
			ownLanes: input.ownLanes ?? [],
			reasons,
			maxPushBytes: s.deps.config.maxPushBytes,
			...(s.laneId === null ? {} : { laneRemote: s.laneId }),
		})
		: [];
	return rejectionResponse({
		commands: input.commands,
		reasons: input.reasons,
		caps: input.caps,
		band2,
	});
};

/** Phase 2 is due for a ref RepoDO recorded as `pending` (`diffStateFor`). */
const needsDiff = (ref: string, after: string, importing: boolean): boolean =>
	!importing && after !== ZERO_SHA && ref.startsWith("refs/heads/") &&
	!isKernelRef(ref);

/** Phase 2: RepoProbe's lane range for each accepted ref, then `recordDiff`. */
const phase2 = async (
	s: PushState,
	result: RecordPushResult,
	importing: boolean,
): Promise<void> => {
	for (const event of result.events) {
		if (event.type !== "push.accepted") continue;
		const data = event.data as {
			readonly pushId: string;
			readonly target: string;
			readonly ref: string;
			readonly after: string;
		};
		if (!needsDiff(data.ref, data.after, importing)) continue;
		try {
			const source = data.target === "repo"
				? { repoId: s.access.repoId }
				: { repoId: s.access.repoId, laneId: data.target };
			const diff = await s.deps.probe().laneDiff(source, data.after);
			await s.repo.recordDiff(data.pushId, diff);
		} catch (error) {
			// RepoDO's `diff` timer completes it (backstop).
			s.deps.log("[tartan] gateway: phase 2 failed", {
				repoId: s.access.repoId,
				pushId: data.pushId,
				error: errorText(error),
			});
		}
	}
};

/**
 * Phase 1: the refs upstream accepted, I/O-free in RepoDO. A lane
 * remote's push is recorded with `target` = the lane and the lane repo's
 * current name.
 */
const phase1 = async (
	s: PushState,
	commands: readonly PushCommand[],
	report: ReportStatus | null,
	bytes: number,
	repoName: string | undefined,
): Promise<RecordPushResult | null> => {
	if (report === null) {
		s.deps.log("[tartan] gateway: no report-status from upstream", {
			repoId: s.access.repoId,
			requestId: s.requestId,
		});
		return null;
	}
	const accepted = new Set(
		report.refs.filter((ref) => ref.ok).map((ref) => ref.ref),
	);
	const refs = commands.filter((command) => accepted.has(command.ref)).map((
		command,
	) => ({ ref: command.ref, before: command.old, after: command.new }));
	if (refs.length === 0) return null;
	return await s.repo.recordPush({
		target: s.laneId ?? "repo",
		...(repoName === undefined ? {} : { repoName }),
		bytes,
		refs,
		principal: s.auth.principal,
		...(s.auth.onBehalfOf ? { onBehalfOf: s.auth.onBehalfOf } : {}),
		...(s.auth.tokenId ? { tokenId: s.auth.tokenId } : {}),
		via: "gateway",
		requestId: s.requestId,
	});
};

/**
 * Adds the exact spellings of the index's refs when a command's folded name
 * is already taken (row 0's case-collision rule needs them to tell an update
 * of that ref from another spelling of it); lane refs are lowercase by
 * construction and need no lookup.
 */
const withRefNames = async (
	repo: GatewayRepo,
	ctx: GatewayPushContext,
	commands: readonly PushCommand[],
): Promise<GatewayPushContext> => {
	const folded = new Set(ctx.caseFoldedRefs);
	const needed = commands.some((command) =>
		!command.ref.startsWith(LANE_BRANCH_PREFIX) &&
		folded.has(fold(command.ref))
	);
	if (!needed) return ctx;
	const rows = await repo.refs();
	return { ...ctx, refNames: rows.map((row) => row.ref) };
};

/** The report-status of a whole upstream answer, or null when it has none. */
const reportOf = (
	answer: Uint8Array,
	caps: NegotiatedCaps,
): ReportStatus | null => {
	try {
		const inner = caps.sideBand === null ? answer : demuxSideband(answer).band1;
		return parseReportStatus(inner, caps);
	} catch {
		return null;
	}
};

/** A log-safe shape of an upstream answer: its side-band text, sanitized and cut. */
const describeAnswer = (answer: Uint8Array): string => {
	let text: string;
	try {
		const demuxed = demuxSideband(answer);
		text = [...demuxed.band2, ...demuxed.band3].map((part) =>
			new TextDecoder().decode(part)
		).join(" ");
	} catch {
		text = new TextDecoder().decode(answer.subarray(0, 300));
	}
	return redactSecrets(stripControl(text)).slice(0, 300) ||
		`${answer.length} bytes`;
};

/** Whether the request body passed Artifacts' object limit (a hang-up then means "too large"). */
const overObjectLimit = (bytes: number): boolean =>
	bytes > ARTIFACTS_OBJECT_LIMIT_BYTES;

/**
 * `POST /<repoPath>[.git]/git-receive-pack` (the canonical repo), or, with
 * `r.laneId`, `POST /<repoPath>/-/lanes/<laneId>.git/git-receive-pack` (a lane
 * remote): the same fail-closed flow with the lane-repo table and a write token
 * scoped to the lane's current lane repo (layer 2).
 */
export const handleReceivePack = (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => receivePack(deps, r);

/** `PushContext.target` names a `repo` lane whose lane repo may exist (else 404). */
const isLaneRemoteTarget = (ctx: GatewayPushContext): boolean =>
	ctx.target !== undefined && ctx.target.mode === "repo" &&
	ctx.target.state !== "deleted";

const receivePack = async (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => {
	const access = await resolveAccess(deps.tree, r, "git-receive-pack");
	if (access.kind === "response") return access.response;
	const auth = r.auth as AuthContext;
	const laneId = r.laneId ?? null;
	const encoding = (r.req.headers.get("content-encoding") ?? "").trim()
		.toLowerCase();
	if (encoding !== "" && encoding !== "identity") {
		await r.req.body?.cancel().catch(() => {});
		return gitText(415, "receive-pack bodies must not be content-encoded");
	}
	const raw = r.req.body;
	if (raw === null) return gitText(400, "empty receive-pack request");
	const s: PushState = {
		deps,
		r,
		auth,
		access,
		repo: deps.repo(access.repoId),
		requestId: deps.requestId(),
		laneId,
	};

	// 1. The fail-closed command peek.
	const head = captureHead(RECEIVE_SECTION_MAX_BYTES + 4);
	const peeked = await peekCommands(raw.pipeThrough(head.stream), {
		maxCommands: auth.kind === "agent" ? MAX_COMMANDS.agent : MAX_COMMANDS.user,
		maxSectionBytes: RECEIVE_SECTION_MAX_BYTES,
		capabilities: RECEIVE_PACK_CAPABILITIES,
	});
	if (peeked.kind === "probe") {
		// git's `0000` probe only checks the status (its body is discarded):
		// answered here, so no write token exists for it.
		return gitBody(new Uint8Array(0), CONTENT_TYPE.receiveResult);
	}
	if (peeked.kind === "rejected") {
		if (peeked.parsed.length === 0) {
			return gitText(400, `push refused: ${PEEK_REASONS[peeked.code]}`);
		}
		const reason = PEEK_REASONS[peeked.code];
		return await reject(s, {
			commands: peeked.parsed,
			reasons: peeked.parsed.map(() => reason),
			caps: capsOfHead(head.head()),
			body: null,
		});
	}
	const { commands } = peeked;
	const caps = negotiateCaps(peeked.capabilities);
	const lengthHeader = r.req.headers.get("content-length");
	const contentLength = lengthHeader === null ? null : Number(lengthHeader);
	if (
		contentLength !== null &&
		(!Number.isSafeInteger(contentLength) || contentLength < 0)
	) {
		return gitText(400, "invalid Content-Length");
	}
	const maxBytes = deps.config.maxPushBytes;
	const lease = {
		requestId: s.requestId,
		refs: commands.map((command) => command.ref),
	};

	// A lane remote: the lane must be a `repo` lane of this repo before
	// anything is recorded against it (one RPC that is also the policy input).
	let laneContext: GatewayPushContext | null = null;
	if (laneId !== null) {
		try {
			laneContext = await s.repo.pushContext(
				auth,
				auth.laneId,
				{ laneId },
				lease,
			);
		} catch (error) {
			if (fromRpcError(error).code !== "not_found") throw error;
		}
		if (laneContext === null || !isLaneRemoteTarget(laneContext)) {
			await peeked.body.cancel().catch(() => {});
			return laneNotFound();
		}
	}

	// 2. The size check, before anything reaches upstream (and, on the
	// canonical URL, before any RPC).
	if (contentLength !== null && contentLength > maxBytes) {
		return await reject(s, {
			commands,
			reasons: commands.map(() => "push-too-large"),
			caps,
			body: peeked.body,
		});
	}

	// 3. Policy inputs, then the canonical write precheck and the ref-policy
	// table, or the lane-remote table.
	const ctx: GatewayPushContext = laneContext ?? await withRefNames(
		s.repo,
		await s.repo.pushContext(auth, auth.laneId, undefined, lease),
		commands,
	);
	const caller: PushCaller = {
		principal: auth.principal,
		kind: auth.kind,
		role: access.role,
		laneId: auth.laneId,
		forgeOwner: auth.kind === "user" &&
			ctx.importState === "importing" &&
			await deps.isForgeOwner(auth.principal),
	};
	const rejectWith = (reasons: readonly (RefPolicyReason | null)[]) =>
		reject(s, {
			commands,
			reasons,
			caps,
			body: peeked.body,
			ownLanes: ctx.ownLanes,
			defaultBranch: ctx.defaultBranch,
		});
	if (laneId === null && !canonicalWritePrecheck(ctx, caller)) {
		// An agent without an own branch lane; a user whose current role or
		// scopes no longer give a write credential.
		const reason = caller.kind === "agent"
			? "agents-lanes-only"
			: "no-write-credential";
		return await rejectWith(commands.map(() => reason));
	}
	const decisions = laneId === null
		? deps.config.policy(ctx, commands, caller)
		: deps.config.lanePolicy(ctx, commands, caller);
	if (decisions.some((decision) => !decision.allow)) {
		return await rejectWith(
			decisions.map((decision) => decision.allow ? null : decision.reason),
		);
	}

	// 4. Forward with a write token scoped to the one repo the URL names: the
	// canonical repo, or the lane's current lane repo only (layer 2: whatever
	// the policy decided, that token cannot write trunk or another lane).
	const upstream = laneId === null
		? await s.repo.upstream({}, "write")
		: await laneUpstream(s.repo, laneId, "write");
	if (upstream === null) {
		// The lane repo is gone (a race with its GC): refused as closed.
		return await rejectWith(commands.map(() => "lane-closed"));
	}
	const counter = createByteCounter(
		contentLength === null ? maxBytes : undefined,
	);
	let body = peeked.body.pipeThrough(counter.stream);
	const Fixed = (globalThis as {
		FixedLengthStream?: new (length: number) => TransformStream<
			Uint8Array,
			Uint8Array
		>;
	}).FixedLengthStream;
	if (contentLength !== null && Fixed !== undefined) {
		body = body.pipeThrough(new Fixed(contentLength));
	}
	const sent = (): number => contentLength ?? counter.bytes();
	const sizeRejection = (reason: "push-too-large" | "object-too-large") =>
		reject(s, {
			commands,
			reasons: commands.map(() => reason),
			caps,
			body: null,
			ownLanes: ctx.ownLanes,
			defaultBranch: ctx.defaultBranch,
		});
	const pending = callUpstream(deps, r.req, upstream, {
		method: "POST",
		path: "git-receive-pack",
		body,
	});
	// The client may go away; the push it uploaded still completes and is recorded.
	r.waitUntil(pending.then(() => {}, () => {}));
	let res: Response;
	try {
		res = await pending;
	} catch (error) {
		if (counter.exceeded()) return await sizeRejection("push-too-large");
		if (overObjectLimit(sent())) return await sizeRejection("object-too-large");
		deps.log("[tartan] gateway: upstream receive-pack failed", {
			repoId: access.repoId,
			error: errorText(error),
		});
		return gitText(502, "the git backend did not answer; try again");
	}
	if (res.status !== 200 || res.body === null) {
		await res.body?.cancel().catch(() => {});
		if (overObjectLimit(sent())) return await sizeRejection("object-too-large");
		deps.log("[tartan] gateway: upstream receive-pack failed", {
			repoId: access.repoId,
			status: res.status,
		});
		return gitText(502, "the git backend refused the push; try again");
	}
	let upstreamBody: ReadableStream<Uint8Array> = res.body;
	if (overObjectLimit(sent())) {
		// Above Artifacts' object limit the answer decides the message before
		// any byte reaches the client: a hang-up, a body without a parseable
		// report, or a size error in the report are all `object-too-large`.
		// The answer is small.
		const answer = await readCapped(upstreamBody, RELAY_HOLD_BACK_MAX_BYTES);
		const report = answer === null ? null : reportOf(answer, caps);
		if (report === null || translateSizeErrors(report) !== null) {
			deps.log(
				"[tartan] gateway: upstream refused a push over the object limit",
				{
					repoId: access.repoId,
					bytes: sent(),
					answer: answer === null ? "over 1 MiB" : describeAnswer(answer),
				},
			);
			return await sizeRejection("object-too-large");
		}
		upstreamBody = new Response(answer as Uint8Array<ArrayBuffer>)
			.body as ReadableStream<Uint8Array>;
	}
	const first = await peekFirstChunk(upstreamBody);
	if (first.first === null) {
		deps.log("[tartan] gateway: upstream receive-pack ended without a report", {
			repoId: access.repoId,
		});
		return gitText(502, "the git backend ended the push without a report");
	}

	// 5. Relay; phase 1 before the final flush; phase 2 after.
	const relay = createReceivePackRelay({
		caps,
		holdBackMaxBytes: RELAY_HOLD_BACK_MAX_BYTES,
		rewriteReport: translateSizeErrors,
	});
	// The sniffer's output is discarded and it holds nothing but band 1, so
	// it never gives up on a long response (the client relay does, at 1 MiB).
	const sniffer = createReceivePackRelay({
		caps,
		holdBackMaxBytes: Number.MAX_SAFE_INTEGER,
	});
	sniffer.release([]);
	const [toClient, toSniffer] = first.rest.tee();
	const sniffed = consume(toSniffer.pipeThrough(sniffer.stream));
	const recorded = sniffer.report.then((report) =>
		phase1(
			s,
			commands,
			report,
			sent(),
			laneId === null ? undefined : upstream.artifactsName,
		)
	);
	const importing = ctx.importState === "importing";
	r.waitUntil(
		Promise.allSettled([
			sniffed,
			recorded.then(
				(result) => result === null ? undefined : phase2(s, result, importing),
				(error) =>
					deps.log("[tartan] gateway: recordPush failed", {
						repoId: access.repoId,
						requestId: s.requestId,
						error: errorText(error),
					}),
			),
		]),
	);
	r.waitUntil(
		within(recorded, deps.config.phase1WaitMs).then(() => relay.release([])),
	);
	return new Response(toClient.pipeThrough(relay.stream), {
		status: 200,
		headers: {
			"content-type": res.headers.get("content-type") ??
				CONTENT_TYPE.receiveResult,
			"cache-control": NO_CACHE,
		},
	});
};
