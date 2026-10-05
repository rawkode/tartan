// Upload-pack on the canonical repo and both ref advertisements (WP4; U47):
//
// - `info/refs`: the upstream advertisement, filtered to the caller's view
//   and rewritten to the capability allowlists for every caller (v0/v1 for
//   upload-pack and receive-pack, the v2 capability advertisement);
// - `git-upload-pack`, public view: the fail-closed request parser on the
//   decoded body (gzip under the 4 MiB cap), wants checked against the
//   RepoDO index and the 10-minute window, forwarded as identity; nothing
//   is forwarded when it refuses;
// - `git-upload-pack`, member view: passed through undecoded (any SHA may be
//   fetched; members read every lane), except that a v2 `ls-refs` answer is
//   filtered to the member's view.

import {
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
	isProtocolV2,
	parseUploadRequest,
	PUBLIC_VIEW_PROFILE,
	RECEIVE_PACK_CAPABILITIES,
	rewriteAdvertisement,
	rewriteLsRefsResponse,
	rewriteV2Capabilities,
	UPLOAD_DECODE_MAX_BYTES,
	UPLOAD_PACK_V0_CAPABILITIES,
	UPLOAD_PACK_V2_CAPABILITIES,
} from "@tartan/gitproto";
import { decodeRequestBody } from "@tartan/gitproto/upload.ts";
import { redactSecrets, ZERO_SHA } from "@tartan/contract";
import type { AuthContext, Upstream } from "@tartan/contract/kernel.ts";
import { type RepoAccess, resolveAccess } from "./access.ts";
import { CONTENT_TYPE, gitBody, gitText, uploadError } from "./respond.ts";
import { readCapped } from "./streams.ts";
import type { GatewayDeps, GitRequest, GitService } from "./types.ts";
import { callUpstream } from "./upstream.ts";
import {
	isV2Advertisement,
	memberLsRefs,
	memberRefs,
	publicRefs,
} from "./views.ts";

/** Largest upstream advertisement or `ls-refs` answer the gateway rewrites in memory. */
export const ADVERTISEMENT_MAX_BYTES = 32 * 1024 * 1024;
/** A member v2 request larger than this is forwarded without being sniffed. */
export const MEMBER_SNIFF_MAX_BYTES = 4 * 1024 * 1024;
/** The agent string of advertisements the gateway synthesizes itself. */
export const GATEWAY_AGENT = "agent=tartan-gateway";

export const upstreamFailed = (
	deps: GatewayDeps,
	what: string,
	data: Record<string, unknown>,
): Response => {
	deps.log(`[tartan] gateway: upstream ${what} failed`, data);
	return gitText(502, "the git backend did not answer; try again");
};

const errorText = (error: unknown): string =>
	redactSecrets(error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

/**
 * The receive-pack advertisement of an agent without an own `branch` lane:
 * no refs, the allowlisted capabilities. Every push it could send is refused
 * (`agents-lanes-only`), so no canonical write token is minted for it.
 */
export const emptyReceiveAdvertisement = (): Uint8Array<ArrayBuffer> => {
	const caps = [
		"report-status",
		"report-status-v2",
		"delete-refs",
		"side-band-64k",
		"quiet",
		"atomic",
		"ofs-delta",
		"object-format=sha1",
		GATEWAY_AGENT,
	].join(" ");
	const parts = [
		encodePktLine("# service=git-receive-pack\n"),
		encodeSpecialPkt("flush"),
		encodePktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`),
		encodeSpecialPkt("flush"),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/**
 * The upstream `info/refs` body of `upstream` (the canonical repo or a lane
 * repo), at most `ADVERTISEMENT_MAX_BYTES`; a 502 response when it fails.
 */
export const readAdvertisement = async (
	deps: GatewayDeps,
	r: GitRequest,
	upstream: Upstream,
	service: GitService,
	data: Record<string, unknown>,
): Promise<Uint8Array | Response> => {
	let res: Response;
	try {
		res = await callUpstream(deps, r.req, upstream, {
			method: "GET",
			path: `info/refs?service=${service}`,
		});
	} catch (error) {
		return upstreamFailed(deps, "info/refs", {
			...data,
			error: errorText(error),
		});
	}
	if (res.status !== 200) {
		await res.body?.cancel().catch(() => {});
		return upstreamFailed(deps, "info/refs", { ...data, status: res.status });
	}
	const body = await readCapped(res.body, ADVERTISEMENT_MAX_BYTES);
	if (body === null) {
		return upstreamFailed(deps, "info/refs", {
			...data,
			reason: "advertisement too large",
		});
	}
	return body;
};

const fetchAdvertisement = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
	service: GitService,
): Promise<Uint8Array | Response> => {
	const repo = deps.repo(access.repoId);
	const upstream = await repo.upstream(
		{},
		service === "git-receive-pack" ? "write" : "read",
	);
	return await readAdvertisement(deps, r, upstream, service, {
		repoId: access.repoId,
	});
};

const uploadAdvertisement = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
): Promise<Response> => {
	const readContext = await deps.repo(access.repoId).readContext(
		access.view === "member" ? r.auth as AuthContext : "anon",
	);
	const body = await fetchAdvertisement(deps, r, access, "git-upload-pack");
	if (body instanceof Response) return body;
	const keepRef = access.view === "member"
		? memberRefs(new Set(readContext.ownLanes.map((lane) => lane.ref)))
		: publicRefs;
	try {
		const out = isV2Advertisement(body)
			? rewriteV2Capabilities(body, {
				protocol: "v2",
				commands: UPLOAD_PACK_V2_CAPABILITIES,
			})
			: rewriteAdvertisement(body, {
				service: "git-upload-pack",
				keepRef,
				capabilities: { protocol: "v0", names: UPLOAD_PACK_V0_CAPABILITIES },
			});
		return gitBody(out, CONTENT_TYPE.uploadAdvertisement);
	} catch (error) {
		return upstreamFailed(deps, "advertisement", {
			repoId: access.repoId,
			error: errorText(error),
		});
	}
};

const receiveAdvertisement = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
): Promise<Response> => {
	const auth = r.auth as AuthContext;
	const readContext = await deps.repo(access.repoId).readContext(auth);
	if (auth.kind === "agent" && readContext.ownLanes.length === 0) {
		return gitBody(
			emptyReceiveAdvertisement(),
			CONTENT_TYPE.receiveAdvertisement,
		);
	}
	const body = await fetchAdvertisement(deps, r, access, "git-receive-pack");
	if (body instanceof Response) return body;
	try {
		return gitBody(
			rewriteAdvertisement(body, {
				service: "git-receive-pack",
				keepRef: memberRefs(
					new Set(readContext.ownLanes.map((lane) => lane.ref)),
				),
				capabilities: { protocol: "v0", names: RECEIVE_PACK_CAPABILITIES },
			}),
			CONTENT_TYPE.receiveAdvertisement,
		);
	} catch (error) {
		return upstreamFailed(deps, "advertisement", {
			repoId: access.repoId,
			error: errorText(error),
		});
	}
};

/** `GET …/info/refs?service=…` (smart HTTP only; dumb HTTP is refused). */
export const handleInfoRefs = async (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => {
	const service = r.url.searchParams.get("service");
	if (service !== "git-upload-pack" && service !== "git-receive-pack") {
		return gitText(403, "only smart HTTP is served (no service given)");
	}
	const access = await resolveAccess(deps.tree, r, service);
	if (access.kind === "response") return access.response;
	return service === "git-upload-pack"
		? await uploadAdvertisement(deps, r, access)
		: await receiveAdvertisement(deps, r, access);
};

// ---------------------------------------------------------------------------
// git-upload-pack
// ---------------------------------------------------------------------------

type Sniffed = { readonly command: string; readonly refPrefixes: string[] };

/** Command and `ref-prefix` arguments of a v2 request (member view; best effort). */
const sniffV2 = async (
	bytes: Uint8Array,
	encoding: string | null,
): Promise<Sniffed | null> => {
	const decoded = await decodeRequestBody(
		new Response(bytes as Uint8Array<ArrayBuffer>).body as ReadableStream<
			Uint8Array
		>,
		encoding,
		UPLOAD_DECODE_MAX_BYTES,
	);
	if ("kind" in decoded) return null;
	let lines;
	try {
		lines = decodePktLines(decoded.bytes).lines;
	} catch {
		return null;
	}
	const decoder = new TextDecoder();
	const texts = lines.map((line) =>
		line.kind === "data" ? decoder.decode(line.data).replace(/\n$/, "") : null
	);
	const head = texts[0];
	if (head === null || head === undefined || !head.startsWith("command=")) {
		return null;
	}
	return {
		command: head.slice("command=".length),
		refPrefixes: texts.filter((t): t is string =>
			t !== null && t.startsWith("ref-prefix ")
		).map((t) => t.slice("ref-prefix ".length)),
	};
};

/** Up to `max` bytes of a body: complete (the whole body) or a replay of what was read plus the rest. */
const bufferHead = async (
	body: ReadableStream<Uint8Array>,
	max: number,
): Promise<
	| { readonly complete: true; readonly bytes: Uint8Array<ArrayBuffer> }
	| { readonly complete: false; readonly rest: ReadableStream<Uint8Array> }
> => {
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			const bytes = new Uint8Array(total);
			let at = 0;
			for (const part of parts) {
				bytes.set(part, at);
				at += part.length;
			}
			return { complete: true, bytes };
		}
		parts.push(value);
		total += value.length;
		if (total > max) break;
	}
	let index = 0;
	return {
		complete: false,
		rest: new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (index < parts.length) {
					controller.enqueue(parts[index++]);
					return;
				}
				const { value, done } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		}),
	};
};

/** Relays an upstream upload-pack answer (a v2 `ls-refs` one through `lsRefsFilter`). */
export const relayUpload = async (
	deps: GatewayDeps,
	access: Pick<RepoAccess, "repoId">,
	res: Response,
	lsRefsFilter: ((ref: string) => boolean) | null,
): Promise<Response> => {
	if (res.status !== 200) {
		await res.body?.cancel().catch(() => {});
		return upstreamFailed(deps, "upload-pack", {
			repoId: access.repoId,
			status: res.status,
		});
	}
	const contentType = res.headers.get("content-type") ??
		CONTENT_TYPE.uploadResult;
	if (lsRefsFilter === null) return gitBody(res.body, contentType);
	const body = await readCapped(res.body, ADVERTISEMENT_MAX_BYTES);
	if (body === null) {
		return upstreamFailed(deps, "ls-refs", {
			repoId: access.repoId,
			reason: "too large",
		});
	}
	try {
		return gitBody(rewriteLsRefsResponse(body, lsRefsFilter), contentType);
	} catch (error) {
		return upstreamFailed(deps, "ls-refs", {
			repoId: access.repoId,
			error: errorText(error),
		});
	}
};

const publicUpload = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
	body: ReadableStream<Uint8Array>,
): Promise<Response> => {
	const parsed = await parseUploadRequest(body, {
		encoding: r.req.headers.get("content-encoding"),
		gitProtocol: r.req.headers.get("git-protocol"),
		maxDecodedBytes: UPLOAD_DECODE_MAX_BYTES,
		profile: PUBLIC_VIEW_PROFILE,
	});
	if (parsed.kind === "rejected") {
		return parsed.reason === "upload-encoding"
			? gitText(415, `upload-encoding: ${parsed.detail}`)
			: uploadError(parsed.reason);
	}
	const repo = deps.repo(access.repoId);
	if (parsed.command === "fetch") {
		const readContext = await repo.readContext("anon");
		const allowed = new Set([
			...readContext.visibleTips,
			...readContext.recentTips,
		]);
		if (parsed.wants.some((want) => !allowed.has(want))) {
			return uploadError("want-not-advertised");
		}
	}
	const upstream = await repo.upstream({}, "read");
	let res: Response;
	try {
		res = await callUpstream(deps, r.req, upstream, {
			method: "POST",
			path: "git-upload-pack",
			body: parsed.body as Uint8Array<ArrayBuffer>,
		});
	} catch (error) {
		return upstreamFailed(deps, "upload-pack", {
			repoId: access.repoId,
			error: errorText(error),
		});
	}
	return await relayUpload(
		deps,
		access,
		res,
		parsed.command === "ls-refs" ? publicRefs : null,
	);
};

const memberUpload = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
	body: ReadableStream<Uint8Array>,
): Promise<Response> => {
	const encoding = r.req.headers.get("content-encoding");
	const repo = deps.repo(access.repoId);
	let forward: BodyInit = body;
	let filter: ((ref: string) => boolean) | null = null;
	if (isProtocolV2(r.req.headers.get("git-protocol"))) {
		const head = await bufferHead(body, MEMBER_SNIFF_MAX_BYTES);
		if (head.complete) {
			forward = head.bytes;
			const sniffed = await sniffV2(head.bytes, encoding);
			if (sniffed?.command === "ls-refs") {
				const readContext = await repo.readContext(r.auth as AuthContext);
				filter = memberLsRefs(
					new Set(readContext.ownLanes.map((lane) => lane.ref)),
					sniffed.refPrefixes,
				);
			}
		} else forward = head.rest;
	}
	const upstream = await repo.upstream({}, "read");
	let res: Response;
	try {
		res = await callUpstream(deps, r.req, upstream, {
			method: "POST",
			path: "git-upload-pack",
			body: forward,
			encoding,
		});
	} catch (error) {
		return upstreamFailed(deps, "upload-pack", {
			repoId: access.repoId,
			error: errorText(error),
		});
	}
	return await relayUpload(deps, access, res, filter);
};

/** `POST …/git-upload-pack`. */
export const handleUploadPack = async (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => {
	const access = await resolveAccess(deps.tree, r, "git-upload-pack");
	if (access.kind === "response") return access.response;
	const body = r.req.body;
	if (body === null) return gitText(400, "empty upload-pack request");
	return access.view === "public"
		? await publicUpload(deps, r, access, body)
		: await memberUpload(deps, r, access, body);
};
