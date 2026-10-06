// Requests to the Artifacts git remote (WP4): the
// upstream is `Upstream.remote` + the op, with the kernel's token injected
// server-side (`Authorization: Bearer <full token>`). Only the
// smart-HTTP headers are forwarded; the client's `Authorization` and cookies
// never are.
//
// A replayable read (`info/refs`, or an `upload-pack` whose request is
// already buffered) is sent again, twice at most and within a second, when
// the upstream answers a transient 5xx or the request fails: an agent's
// stock git does not retry its clone or fetch. A push (`receive-pack`) and a
// streamed request body are never resent.

import type { Upstream } from "@tartan/contract/kernel.ts";
import { authorizationFor } from "../repo/gitremote.ts";
import type { GatewayDeps } from "./types.ts";

/** Request headers forwarded upstream (`Content-Encoding` is chosen per view). */
const FORWARDED = ["content-type", "accept", "git-protocol", "user-agent"];

/** Upstream answers on which a replayable read is sent again. */
export const UPSTREAM_RETRY_STATUSES: ReadonlySet<number> = new Set([
	500,
	502,
	503,
	504,
]);
/** The wait before each resend of a replayable read (two resends). */
export const UPSTREAM_RETRY_DELAYS_MS: readonly number[] = [150, 450];

export type UpstreamCall = {
	readonly method: "GET" | "POST";
	/** `info/refs?service=…`, `git-upload-pack` or `git-receive-pack`. */
	readonly path: string;
	readonly body?: BodyInit | null;
	/** Forwarded `Content-Encoding` (member-view upload-pack only). */
	readonly encoding?: string | null;
	/** Overrides the forwarded `Content-Type`. */
	readonly contentType?: string;
};

/** A read whose request can be sent again as is: never a push, never a stream. */
export const replayable = (call: UpstreamCall): boolean =>
	!call.path.startsWith("git-receive-pack") &&
	(call.method === "GET" || call.body === undefined || call.body === null ||
		call.body instanceof Uint8Array || call.body instanceof ArrayBuffer ||
		typeof call.body === "string");

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const callUpstream = async (
	deps: Pick<GatewayDeps, "fetch" | "config" | "log">,
	req: Request,
	upstream: Upstream,
	call: UpstreamCall,
): Promise<Response> => {
	const headers = new Headers();
	for (const name of FORWARDED) {
		const value = req.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	if (call.contentType !== undefined) {
		headers.set("content-type", call.contentType);
	}
	if (call.encoding) headers.set("content-encoding", call.encoding);
	headers.set(
		"authorization",
		authorizationFor(upstream.token, deps.config.upstreamAuth),
	);
	const send = (): Promise<Response> => {
		const init: RequestInit & { duplex?: "half" } = {
			method: call.method,
			headers,
			redirect: "manual",
		};
		if (call.body !== undefined && call.body !== null) {
			init.body = call.body;
			if (call.body instanceof ReadableStream) init.duplex = "half";
		}
		return deps.fetch(new Request(`${upstream.remote}/${call.path}`, init));
	};
	if (!replayable(call)) return await send();
	const op = call.path.split("?")[0];
	for (let attempt = 0;; attempt += 1) {
		const last = attempt >= UPSTREAM_RETRY_DELAYS_MS.length;
		try {
			const res = await send();
			if (last || !UPSTREAM_RETRY_STATUSES.has(res.status)) return res;
			await res.body?.cancel().catch(() => {});
			deps.log(
				"[tartan] gateway: upstream answered a transient error; resending",
				{
					op,
					status: res.status,
					attempt: attempt + 1,
				},
			);
		} catch (error) {
			if (last) throw error;
			deps.log("[tartan] gateway: upstream request failed; resending", {
				op,
				attempt: attempt + 1,
			});
		}
		await sleep(UPSTREAM_RETRY_DELAYS_MS[attempt]);
	}
};
