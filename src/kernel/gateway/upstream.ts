// Requests to the Artifacts git remote (WP4): the
// upstream is `Upstream.remote` + the op, with the kernel's token injected
// server-side (`Authorization: Bearer <full token>`, U3). Only the
// smart-HTTP headers are forwarded; the client's `Authorization` and cookies
// never are.

import type { Upstream } from "@tartan/contract/kernel.ts";
import { authorizationFor } from "../repo/gitremote.ts";
import type { GatewayDeps } from "./types.ts";

/** Request headers forwarded upstream (`Content-Encoding` is chosen per view). */
const FORWARDED = ["content-type", "accept", "git-protocol", "user-agent"];

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

export const callUpstream = (
	deps: Pick<GatewayDeps, "fetch" | "config">,
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
