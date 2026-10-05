// The one validator for user-influenced outbound fetches (WP2): OIDC discovery,
// JWKS, token and userinfo endpoints, the DCR `registration_endpoint` and
// `registration_client_uri`. Rules: `https:` only, port 443, no userinfo, no IP
// literals, no `localhost`/`*.localhost`/ `*.local` and no single-label hosts;
// `redirect: "manual"`, a 10 s timeout and a 1 MB response cap. The deployed
// Worker also runs with `global_fetch_strictly_public`, which refuses names
// that resolve to private addresses.

import { invalid } from "@tartan/contract";

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export const OUTBOUND_LIMITS = {
	timeoutMs: 10_000,
	maxBytes: 1_048_576,
} as const;

export type OutboundLimits = {
	readonly timeoutMs: number;
	readonly maxBytes: number;
};

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const BLOCKED_SUFFIXES = [".localhost", ".local"] as const;

/**
 * Why `input` may not be fetched, or null when it may. The WHATWG parser has
 * already normalized numeric IPv4 forms (`2130706433`, `0x7f.1`) to dotted
 * quads, so one dotted-quad test covers them.
 */
export const outboundUrlProblem = (input: string | URL): string | null => {
	let url: URL;
	try {
		url = new URL(String(input));
	} catch {
		return "not a URL";
	}
	if (url.protocol !== "https:") return "only https URLs are allowed";
	if (url.port !== "" && url.port !== "443") return "only port 443 is allowed";
	if (url.username !== "" || url.password !== "") {
		return "URLs with credentials are not allowed";
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[") || host.includes(":")) {
		return "IP address literals are not allowed";
	}
	if (IPV4_RE.test(host)) return "IP address literals are not allowed";
	if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
		return "local host names are not allowed";
	}
	if (!host.includes(".")) return "single-label host names are not allowed";
	return null;
};

/** Parses and validates `input`; throws `invalid` with the reason. */
export const checkOutboundUrl = (input: string | URL): URL => {
	const problem = outboundUrlProblem(input);
	if (problem !== null) throw invalid(`refused outbound URL: ${problem}`);
	return new URL(String(input));
};

const readCapped = async (
	response: Response,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> => {
	if (response.body === null) return null;
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > maxBytes) {
		await response.body.cancel();
		throw invalid(`outbound response exceeds ${maxBytes} bytes`);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw invalid(`outbound response exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * `fetch` behind the validator: every request URL is checked, redirects are
 * never followed (a 3xx comes back as is), the request is aborted after
 * `timeoutMs` and the body is buffered up to `maxBytes`.
 */
export const createGuardedFetch = (
	base: FetchLike = (input, init) => fetch(input, init),
	limits: OutboundLimits = OUTBOUND_LIMITS,
): FetchLike =>
async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	checkOutboundUrl(url);
	const timeout = AbortSignal.timeout(limits.timeoutMs);
	const signal = init?.signal
		? AbortSignal.any([init.signal, timeout])
		: timeout;
	const response = await base(input, { ...init, redirect: "manual", signal });
	const body = await readCapped(response, limits.maxBytes);
	return new Response(NULL_BODY_STATUS.has(response.status) ? null : body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
};
