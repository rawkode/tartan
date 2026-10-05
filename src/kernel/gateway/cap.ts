// The capability route (WP4): the one unauthenticated git surface. Artifacts'
// importer pulls a lane repo's seed from
// `/-/cap/v1/<exp>/<laneId>/<nonce>/<mac>/<repoId>.git/{info/refs,
// git-upload-pack}`: one trunk at one base, read-only, while one lane is
// `opening` on one seed attempt.
//
// Verification, in this order; steps 1–3 make no Durable Object call, so
// forged URLs cost no RepoDO call and cannot create one:
// 1. syntax (`parseCapPath`, the op and `?service=git-upload-pack`);
// 2. time: `now < exp ≤ now + LANE_CAP_TTL_S + 5 s`;
// 3. a constant-time HMAC over every path segment (WP2's `CapMac`, the
//    HKDF-derived `LANE_CAP_KEY`), in the isolate;
// 4. every failure of 1–3 is a plain 404 with no detail that ticks the
//    in-isolate failure buckets (20 per minute per client IP hash, 200 per
//    isolate); past a limit, failures get 429 and a counter instead of a
//    log line. A request whose MAC verifies never touches the buckets;
// 5. only then RepoDO's `capUse` (atomic: the lane exists in that repo, is
//    `opening` on this nonce; ≤ 3 `info` uses, one `pack` request).
//
// The advertisement is synthesized: `HEAD` → `refs/heads/main` at the
// attempt's base, whatever the canonical default branch is called; the
// upstream advertisement is read only for its default-branch tip and
// capabilities. A tip that moved off the base is served anyway only when
// the kernel explains it and `pinBase` is on; otherwise 503 and
// `capReport(trunk-moved)`. The pack request carries exactly one wanted
// object, the base (WP22's parser); each upstream request gets its own trunk
// read token, revoked when the response finishes, when it is cancelled or
// aborted, and by a `waitUntil` backstop at the token's TTL. Tartan's own
// log lines never carry a capability path (`redactSecrets`, plus logging
// only the lane id and the outcome).

import {
	type CapFields,
	type CapPathOp,
	type CapPathParts,
	fromRpcError,
	LANE_REPO_HEAD_REF,
	parseCapPath,
	redactSecrets,
	repoArtifactsName,
} from "@tartan/contract";
import {
	CAP_FAILURE_LIMITS,
	type CapContext,
	type CapReport,
	type RepoCoreFacade,
	type RepoStore,
	type RepoStoreRepo,
} from "@tartan/contract/kernel.ts";
import {
	isProtocolV2,
	parseCapRequest,
	readUpstreamTip,
	stripV0Trailer,
	synthCapAdvertisement,
	synthCapV2Capabilities,
	UPLOAD_DECODE_MAX_BYTES,
} from "@tartan/gitproto";
import { authorizationFor } from "../repo/gitremote.ts";
import {
	type ControlBucket,
	createControlBucket,
	isRateLimitError,
} from "../repo/upstream.ts";
import { CONTENT_TYPE, gitBody, NO_CACHE, uploadError } from "./respond.ts";
import { readCapped } from "./streams.ts";

/** RepoDO's capability state, as the route calls it (WP5b behind WP5a's facade). */
export type CapRepo = Pick<RepoCoreFacade, "capUse" | "capReport">;

/** A per-request trunk read token on the canonical Artifacts repo. */
export type CapUpstreamToken = {
	readonly remote: string;
	readonly token: string;
	/** Revokes the token. Idempotent, never throws. */
	revoke(): Promise<void>;
};

/** The in-isolate failure buckets (`CAP_FAILURE_LIMITS`). */
export type CapFailureBuckets = {
	/** Counts one failed verification: `log` within the limits, `throttle` past either. */
	fail(clientKey: string): "log" | "throttle";
	/** Failures answered 429 without a log line since the last call (then reset). */
	takeSuppressed(): number;
};

export type CapConfig = {
	/** `LANE_CAP_TTL_S`. */
	readonly ttlS: number;
	/** `LANE_CAP_CLIENT_CHECK`: ASN 13335 and `User-Agent: artifacts/1.0` (not an authenticator). */
	readonly clientCheck: boolean;
	/** `UPSTREAM_AUTH`. */
	readonly upstreamAuth: "bearer" | "basic";
};

export type CapDeps = {
	/** WP2's MAC verification (`createCapMac(env).verify`), in the isolate. */
	readonly verifyMac: (fields: CapFields, mac: string) => Promise<boolean>;
	/** RepoDO `core()` of a repo; called only after the MAC verified. */
	readonly repo: (repoId: string) => CapRepo;
	/** Mints a trunk read token for one request (`createToken("read", ttlS)`). */
	readonly mintReadToken: (repoId: string) => Promise<CapUpstreamToken>;
	readonly fetch: (request: Request) => Promise<Response>;
	/** Epoch ms. */
	readonly now: () => number;
	readonly log: (message: string, data: Record<string, unknown>) => void;
	readonly buckets: CapFailureBuckets;
	readonly config: CapConfig;
};

/** One request on the capability route. */
export type CapRouteRequest = {
	readonly req: Request;
	readonly url: URL;
	readonly waitUntil: (promise: Promise<unknown>) => void;
};

/** Seconds of clock skew `exp` may run ahead of `now + ttl`. */
export const CAP_EXP_SKEW_S = 5;
/** The largest upstream advertisement the route reads for the tip. */
const ADVERTISEMENT_MAX_BYTES = 32 * 1024 * 1024;
/** The importer's user agent and network (`LANE_CAP_CLIENT_CHECK`). */
export const IMPORTER_USER_AGENT = "artifacts/1.0";
export const IMPORTER_ASN = 13335;

// ---------------------------------------------------------------------------
// Failure buckets
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;
/** Client keys tracked per isolate before the oldest are dropped. */
const MAX_CLIENT_KEYS = 10_000;

type Window = { start: number; count: number };

/**
 * Fixed one-minute windows per client key and per isolate. A failure that
 * takes either count past its limit is throttled (429, counted, not logged).
 */
export const createCapFailureBuckets = (
	options: {
		readonly now?: () => number;
		readonly limits?: { perIpPerMin: number; perIsolatePerMin: number };
	} = {},
): CapFailureBuckets => {
	const now = options.now ?? Date.now;
	const limits = options.limits ?? CAP_FAILURE_LIMITS;
	const clients = new Map<string, Window>();
	let isolate: Window = { start: now(), count: 0 };
	let suppressed = 0;
	const tick = (window: Window, at: number): Window =>
		at - window.start >= WINDOW_MS
			? { start: at, count: 1 }
			: { start: window.start, count: window.count + 1 };
	return {
		fail: (clientKey) => {
			const at = now();
			isolate = tick(isolate, at);
			const previous = clients.get(clientKey) ?? { start: at, count: 0 };
			const client = tick(previous, at);
			clients.delete(clientKey);
			clients.set(clientKey, client);
			if (clients.size > MAX_CLIENT_KEYS) {
				for (const [key, window] of clients) {
					if (clients.size <= MAX_CLIENT_KEYS) break;
					if (at - window.start >= WINDOW_MS || key !== clientKey) {
						clients.delete(key);
					}
				}
			}
			const over = client.count > limits.perIpPerMin ||
				isolate.count > limits.perIsolatePerMin;
			if (over) suppressed++;
			return over ? "throttle" : "log";
		},
		takeSuppressed: () => {
			const n = suppressed;
			suppressed = 0;
			return n;
		},
	};
};

/** FNV-1a of the client address: the bucket key (no raw address is kept). */
export const clientKeyOf = (req: Request): string => {
	const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
	let hash = 0x811c9dc5;
	for (let i = 0; i < ip.length; i++) {
		hash ^= ip.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The uniform refusal: no body, no detail (no oracle). */
const plain = (status: 404 | 429 | 400): Response =>
	new Response(null, { status, headers: { "cache-control": "no-store" } });

const unavailable = (status: 502 | 503, text: string): Response =>
	new Response(`${text}\n`, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			...(status === 503 ? { "retry-after": "1" } : {}),
		},
	});

const errorText = (error: unknown): string =>
	redactSecrets(error instanceof Error ? error.message : String(error));

/** A failed syntax, time or MAC check (steps 1–3): 404, or 429 past the buckets. */
const failVerification = (
	deps: CapDeps,
	c: CapRouteRequest,
	reason: "syntax" | "time" | "mac",
): Response => {
	if (deps.buckets.fail(clientKeyOf(c.req)) === "throttle") return plain(429);
	const throttled = deps.buckets.takeSuppressed();
	deps.log("[tartan] capability route: refused", {
		reason,
		method: c.req.method,
		...(throttled > 0 ? { throttledSinceLastLine: throttled } : {}),
	});
	return plain(404);
};

// ---------------------------------------------------------------------------
// Verification (no DO call before the MAC verifies)
// ---------------------------------------------------------------------------

const fieldsOf = (parts: CapPathParts): CapFields => ({
	exp: parts.exp,
	laneId: parts.laneId,
	nonce: parts.nonce,
	repoId: parts.repoId,
});

/** Steps 1–3; the parsed path, or the refusal. */
const verify = async (
	deps: CapDeps,
	c: CapRouteRequest,
	op: CapPathOp,
): Promise<CapPathParts | Response> => {
	const parts = parseCapPath(c.url.pathname);
	if (parts === null || parts.op !== op) {
		return failVerification(deps, c, "syntax");
	}
	if (op === "info/refs") {
		const params = [...c.url.searchParams.entries()];
		if (
			params.length !== 1 || params[0][0] !== "service" ||
			params[0][1] !== "git-upload-pack"
		) {
			return failVerification(deps, c, "syntax");
		}
	} else if (c.url.search !== "") {
		return failVerification(deps, c, "syntax");
	}
	const nowS = Math.floor(deps.now() / 1000);
	if (
		!(nowS < parts.exp && parts.exp <= nowS + deps.config.ttlS + CAP_EXP_SKEW_S)
	) {
		return failVerification(deps, c, "time");
	}
	let ok = false;
	try {
		ok = await deps.verifyMac(fieldsOf(parts), parts.mac);
	} catch (error) {
		// The key is unavailable (no root key yet): no capability can verify.
		// Counted like a failed MAC, so forged traffic cannot flood the log.
		if (deps.buckets.fail(clientKeyOf(c.req)) === "throttle") return plain(429);
		deps.log("[tartan] capability route: MAC key unavailable", {
			error: errorText(error),
		});
		return plain(404);
	}
	return ok ? parts : failVerification(deps, c, "mac");
};

/** `LANE_CAP_CLIENT_CHECK` (default off): defence in depth only. */
const clientAllowed = (deps: CapDeps, c: CapRouteRequest): boolean => {
	if (!deps.config.clientCheck) return true;
	const asn = (c.req as { cf?: { asn?: unknown } }).cf?.asn;
	return asn === IMPORTER_ASN &&
		c.req.headers.get("user-agent") === IMPORTER_USER_AGENT;
};

/** Step 5: RepoDO's atomic `capUse`; the context, or a refusal (404, logged). */
const use = async (
	deps: CapDeps,
	parts: CapPathParts,
	op: "info" | "pack",
): Promise<{ readonly repo: CapRepo; readonly ctx: CapContext } | Response> => {
	const repo = deps.repo(parts.repoId);
	try {
		const result = await repo.capUse(parts.laneId, parts.nonce, op);
		if (result.ok) return { repo, ctx: result.ctx };
		deps.log("[tartan] capability route: capUse refused", {
			laneId: parts.laneId,
			op,
			reason: result.reason,
		});
	} catch (error) {
		const code = fromRpcError(error).code;
		deps.log("[tartan] capability route: capUse failed", {
			laneId: parts.laneId,
			op,
			code,
			...(code === "not_found" ? {} : { error: errorText(error) }),
		});
	}
	return plain(404);
};

/** Records the route's report on a nonce; failures are logged, never thrown. */
const report = async (
	deps: CapDeps,
	repo: CapRepo,
	ctx: CapContext,
	outcome: CapReport,
): Promise<void> => {
	try {
		await repo.capReport(ctx.laneId, ctx.nonce, outcome);
	} catch (error) {
		deps.log("[tartan] capability route: capReport failed", {
			laneId: ctx.laneId,
			outcome: outcome.outcome,
			error: errorText(error),
		});
	}
};

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

const upstreamHeaders = (
	deps: CapDeps,
	token: CapUpstreamToken,
	extra: Record<string, string> = {},
): Headers =>
	new Headers({
		authorization: authorizationFor(token.token, deps.config.upstreamAuth),
		"user-agent": "tartan-gateway",
		...extra,
	});

type Tip =
	| { readonly kind: "tip"; readonly capabilities: readonly string[] }
	| { readonly kind: "response"; readonly response: Response };

/**
 * Reads the upstream default-branch tip with a fresh read token (revoked
 * when the advertisement has been read), compares it with the attempt's
 * base: equal, or kernel-explained with `pinBase`, serves; otherwise 503 and
 * `trunk-moved`.
 */
const checkTip = async (
	deps: CapDeps,
	c: CapRouteRequest,
	repo: CapRepo,
	ctx: CapContext,
): Promise<Tip> => {
	const failed = async (error: unknown, status?: number): Promise<Tip> => {
		deps.log("[tartan] capability route: upstream advertisement failed", {
			laneId: ctx.laneId,
			...(status === undefined ? { error: errorText(error) } : { status }),
		});
		await report(deps, repo, ctx, { op: "info", outcome: "upstream-error" });
		return {
			kind: "response",
			response: unavailable(503, "the trunk is unavailable; try again"),
		};
	};
	let token: CapUpstreamToken;
	try {
		token = await deps.mintReadToken(ctx.repoId);
	} catch (error) {
		return await failed(error);
	}
	let tip: {
		readonly sha: string | null;
		readonly capabilities: readonly string[];
	};
	try {
		const res = await deps.fetch(
			new Request(`${token.remote}/info/refs?service=git-upload-pack`, {
				headers: upstreamHeaders(deps, token),
				redirect: "manual",
			}),
		);
		if (res.status !== 200) {
			await res.body?.cancel().catch(() => {});
			return await failed(null, res.status);
		}
		const body = await readCapped(res.body, ADVERTISEMENT_MAX_BYTES);
		if (body === null) {
			return await failed(new Error("advertisement too large"));
		}
		tip = readUpstreamTip(body, `refs/heads/${ctx.defaultBranch}`);
	} catch (error) {
		return await failed(error);
	} finally {
		c.waitUntil(token.revoke());
	}
	const explained = tip.sha !== null && ctx.pinBase &&
		ctx.explainedTips.includes(tip.sha);
	if (tip.sha === ctx.base || explained) {
		return { kind: "tip", capabilities: tip.capabilities };
	}
	await report(deps, repo, ctx, {
		op: "info",
		outcome: "trunk-moved",
		...(tip.sha === null ? {} : { upstreamTip: tip.sha }),
	});
	deps.log("[tartan] capability route: trunk moved off the attempt's base", {
		laneId: ctx.laneId,
		attempt: ctx.attempt,
	});
	return {
		kind: "response",
		response: unavailable(503, "trunk moved; the lane is re-seeded"),
	};
};

/**
 * The pack response: counted, the trailing-flush transform applied, and the
 * read token revoked exactly once when it finishes, is cancelled, the client
 * aborts or upstream fails, with a `waitUntil` backstop at the token's TTL;
 * the outcome and the served bytes go to `capReport`.
 */
const relayPack = (
	deps: CapDeps,
	c: CapRouteRequest,
	upstream: ReadableStream<Uint8Array>,
	token: CapUpstreamToken,
	finished: (outcome: CapReport["outcome"], bytes: number) => Promise<void>,
	negotiated: { readonly sideBand: boolean; readonly v2: boolean },
): ReadableStream<Uint8Array> => {
	let bytes = 0;
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let done = false;
	const finish = (outcome: CapReport["outcome"]): void => {
		if (done) return;
		done = true;
		settle();
		c.waitUntil(
			Promise.allSettled([token.revoke(), finished(outcome, bytes)]),
		);
	};
	const reader = upstream.getReader();
	const source = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done: ended } = await reader.read();
				if (ended) {
					controller.close();
					finish("served");
					return;
				}
				bytes += value.length;
				controller.enqueue(value);
			} catch (error) {
				deps.log("[tartan] capability route: upstream pack failed", {
					error: errorText(error),
				});
				finish("upstream-error");
				controller.error(error);
			}
		},
		cancel(reason) {
			finish("aborted");
			return reader.cancel(reason).catch(() => {});
		},
	});
	const signal = (c.req as { signal?: AbortSignal }).signal;
	signal?.addEventListener("abort", () => {
		finish("aborted");
		reader.cancel("client aborted").catch(() => {});
	}, { once: true });
	// Backstop: whatever path the response takes, the token is revoked by
	// its TTL at the latest (and the TTL bounds a missed revoke anyway).
	let timer: ReturnType<typeof setTimeout> | undefined;
	c.waitUntil(
		Promise.race([
			settled,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, deps.config.ttlS * 1000);
			}),
		]).then(() => {
			clearTimeout(timer);
			return token.revoke();
		}),
	);
	return source.pipeThrough(stripV0Trailer(negotiated));
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const advertisementResponse = (body: Uint8Array): Response =>
	gitBody(body as Uint8Array<ArrayBuffer>, CONTENT_TYPE.uploadAdvertisement);

/** `GET /-/cap/v1/…/info/refs?service=git-upload-pack`. */
export const handleCapInfoRefs = async (
	deps: CapDeps,
	c: CapRouteRequest,
): Promise<Response> => {
	const parts = await verify(deps, c, "info/refs");
	if (parts instanceof Response) return parts;
	if (!clientAllowed(deps, c)) return plain(404);
	const used = await use(deps, parts, "info");
	if (used instanceof Response) return used;
	if (isProtocolV2(c.req.headers.get("git-protocol"))) {
		// The v2 capability advertisement names no ref; `ls-refs` (another
		// `info` use) carries the synthesized refs.
		return advertisementResponse(synthCapV2Capabilities());
	}
	const tip = await checkTip(deps, c, used.repo, used.ctx);
	if (tip.kind === "response") return tip.response;
	return advertisementResponse(
		synthCapAdvertisement({
			sha: used.ctx.base,
			publishedRef: LANE_REPO_HEAD_REF,
			capabilities: tip.capabilities,
			protocol: "v0",
		}),
	);
};

/** `POST /-/cap/v1/…/git-upload-pack`: a v2 `ls-refs`, or the one pack request. */
export const handleCapUploadPack = async (
	deps: CapDeps,
	c: CapRouteRequest,
): Promise<Response> => {
	const parts = await verify(deps, c, "git-upload-pack");
	if (parts instanceof Response) {
		await c.req.body?.cancel().catch(() => {});
		return parts;
	}
	if (!clientAllowed(deps, c)) {
		await c.req.body?.cancel().catch(() => {});
		return plain(404);
	}
	const body = c.req.body;
	if (body === null) return plain(400);
	const parsed = await parseCapRequest(body, {
		encoding: c.req.headers.get("content-encoding"),
		gitProtocol: c.req.headers.get("git-protocol"),
		maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
	});
	if (parsed.kind === "rejected") {
		deps.log("[tartan] capability route: request refused", {
			laneId: parts.laneId,
			reason: parsed.reason,
			code: parsed.code,
		});
		return parsed.reason === "upload-encoding"
			? new Response(null, {
				status: 415,
				headers: { "cache-control": "no-store" },
			})
			: uploadError(parsed.reason);
	}
	const used = await use(
		deps,
		parts,
		parsed.command === "ls-refs" ? "info" : "pack",
	);
	if (used instanceof Response) return used;
	const { repo, ctx } = used;
	if (parsed.command === "ls-refs") {
		const tip = await checkTip(deps, c, repo, ctx);
		if (tip.kind === "response") return tip.response;
		return gitBody(
			synthCapAdvertisement({
				sha: ctx.base,
				publishedRef: LANE_REPO_HEAD_REF,
				capabilities: [],
				protocol: "v2-ls-refs",
				symrefs: parsed.symrefs,
				refPrefixes: parsed.refPrefixes,
			}),
			CONTENT_TYPE.uploadResult,
		);
	}
	// The pack request: the nonce is consumed; exactly one want, the base.
	if (parsed.want !== ctx.base) {
		deps.log("[tartan] capability route: want is not the base", {
			laneId: ctx.laneId,
			attempt: ctx.attempt,
		});
		await report(deps, repo, ctx, { op: "pack", bytes: 0, outcome: "aborted" });
		return uploadError("want-not-advertised");
	}
	const finished = (outcome: CapReport["outcome"], bytes: number) =>
		report(deps, repo, ctx, { op: "pack", bytes, outcome });
	let token: CapUpstreamToken;
	try {
		token = await deps.mintReadToken(ctx.repoId);
	} catch (error) {
		deps.log("[tartan] capability route: token mint failed", {
			laneId: ctx.laneId,
			error: errorText(error),
		});
		await finished("upstream-error", 0);
		return unavailable(503, "the trunk is unavailable; try again");
	}
	const v2 = parsed.protocol === "v2";
	let res: Response;
	try {
		res = await deps.fetch(
			new Request(`${token.remote}/git-upload-pack`, {
				method: "POST",
				headers: upstreamHeaders(deps, token, {
					"content-type": "application/x-git-upload-pack-request",
					accept: CONTENT_TYPE.uploadResult,
					...(v2 ? { "git-protocol": "version=2" } : {}),
				}),
				body: parsed.body as Uint8Array<ArrayBuffer>,
				redirect: "manual",
			}),
		);
	} catch (error) {
		c.waitUntil(token.revoke());
		deps.log("[tartan] capability route: upstream pack request failed", {
			laneId: ctx.laneId,
			error: errorText(error),
		});
		await finished("upstream-error", 0);
		return unavailable(502, "the trunk did not answer");
	}
	if (res.status !== 200 || res.body === null) {
		await res.body?.cancel().catch(() => {});
		c.waitUntil(token.revoke());
		deps.log("[tartan] capability route: upstream pack request failed", {
			laneId: ctx.laneId,
			status: res.status,
		});
		await finished("upstream-error", 0);
		return unavailable(502, "the trunk did not answer");
	}
	return new Response(
		relayPack(deps, c, res.body, token, finished, {
			sideBand: parsed.sideBand,
			v2,
		}),
		{
			status: 200,
			headers: {
				"content-type": res.headers.get("content-type") ??
					CONTENT_TYPE.uploadResult,
				"cache-control": NO_CACHE,
			},
		},
	);
};

/**
 * Every other `/-/cap/` path, any method (another op, receive-pack, dumb
 * HTTP, a wrong method on a valid path): a syntax failure, counted in the
 * buckets like a forged MAC.
 */
export const handleCapNotFound = async (
	deps: CapDeps,
	c: CapRouteRequest,
): Promise<Response> => {
	await c.req.body?.cancel().catch(() => {});
	return failVerification(deps, c, "syntax");
};

// ---------------------------------------------------------------------------
// The production token minter (a per-isolate control bucket, WP4-owned)
// ---------------------------------------------------------------------------

const dispose = (repo: RepoStoreRepo): void => {
	try {
		repo[Symbol.dispose]?.();
	} catch {
		// Disposing an RPC stub is best effort.
	}
};

/**
 * Per request: a trunk read token on `r-<repoId>` (the repo id comes from
 * the MAC-verified path, so the name is derived, never taken from input),
 * minted with `createToken("read", ttlS)` through the isolate's control
 * bucket (`ARTIFACTS_CONTROL_PER_S_ISOLATE`; a 429 backs off), and revoked
 * by id. The remote URL is cached per isolate.
 */
export const createCapTokenMinter = (deps: {
	readonly artifacts: RepoStore;
	readonly bucket: ControlBucket;
	readonly ttlS: number;
	readonly log: (message: string, data: Record<string, unknown>) => void;
}): (repoId: string) => Promise<CapUpstreamToken> => {
	const remotes = new Map<string, string>();
	const control = async <T>(call: () => Promise<T>): Promise<T> => {
		await deps.bucket.take();
		try {
			return await call();
		} catch (error) {
			if (isRateLimitError(error)) deps.bucket.backoff();
			throw error;
		}
	};
	return async (repoId) => {
		const name = repoArtifactsName(repoId);
		const repo = await control(() => deps.artifacts.get(name));
		try {
			let remote = remotes.get(name);
			if (remote === undefined) {
				remote = (await control(() => repo.info())).remote;
				remotes.set(name, remote);
			}
			const created = await control(() => repo.createToken("read", deps.ttlS));
			let revoked: Promise<void> | null = null;
			return {
				remote,
				token: created.plaintext,
				revoke: () =>
					revoked ??= (async () => {
						try {
							await control(() => repo.revokeToken(created.id));
						} catch (error) {
							// The token's TTL bounds a missed revoke.
							deps.log("[tartan] capability route: revoke failed", {
								error: errorText(error),
							});
						} finally {
							dispose(repo);
						}
					})(),
			};
		} catch (error) {
			dispose(repo);
			throw error;
		}
	};
};

/** The per-isolate failure buckets and control bucket of the route. */
export const capFailureBuckets: CapFailureBuckets = createCapFailureBuckets();
export const createCapControlBucket = (perSecond: number): ControlBucket =>
	createControlBucket({
		clock: { now: () => Date.now() },
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		perSecond,
	});
