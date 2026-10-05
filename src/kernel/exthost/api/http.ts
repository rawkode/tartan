// Small HTTP helpers for the WP7a API handlers: JSON responses that are never
// cached by shared caches, the wire error shape (`toWire`, contract
// errors.ts), bounded JSON bodies and the base64url `ctx` query parameter of
// `/-/api/slot/*`.

import {
	httpStatus,
	invalid,
	tartanError,
	toWire,
	unauthenticated,
	type WireError,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";

/** Responses differ per caller: never shared-cached. */
const PRIVATE_HEADERS = {
	"cache-control": "private, no-store",
	vary: "cookie, authorization",
} as const;

export const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response =>
	Response.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });

export const errorResponse = (error: unknown): Response => {
	const wire = toWire(error);
	return json(wire, httpStatus(wire.error));
};

/**
 * Runs a handler body and maps a thrown `TartanError` to its wire form;
 * `onError` sees every refusal (wire form, status and the raw error) before
 * it is answered, e.g. to log it.
 */
export const guard = async (
	work: () => Promise<Response>,
	onError?: (wire: WireError, status: number, error: unknown) => void,
): Promise<Response> => {
	try {
		return await work();
	} catch (error) {
		const wire = toWire(error);
		const status = httpStatus(wire.error);
		onError?.(wire, status, error);
		return json(wire, status);
	}
};

export const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

/** Default cap on JSON request bodies (actions, installs, mode changes). */
export const MAX_JSON_BYTES = 64 * 1024;

/** Reads a JSON body of at most `limit` bytes; `application/json` only. */
export const readJson = async (
	req: Request,
	limit = MAX_JSON_BYTES,
): Promise<unknown> => {
	const type = req.headers.get("content-type") ?? "";
	if (!/^application\/json\b/i.test(type)) {
		throw tartanError("unsupported_media_type", "expected application/json");
	}
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > limit) {
		throw tartanError("payload_too_large", `body exceeds ${limit} bytes`);
	}
	const text = await req.text();
	if (new TextEncoder().encode(text).byteLength > limit) {
		throw tartanError("payload_too_large", `body exceeds ${limit} bytes`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw invalid("body is not JSON");
	}
};

/** The largest accepted `ctx` query parameter (base64url of a small JSON object). */
export const MAX_CTX_PARAM = 4096;

/** Decodes the `ctx` query parameter: base64url (no padding needed) of a JSON object. */
export const decodeCtxParam = (value: string | null): unknown => {
	if (value === null || value === "") return {};
	if (value.length > MAX_CTX_PARAM) throw invalid("ctx is too large");
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
		throw invalid("ctx is not base64url");
	}
	try {
		const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (
			parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
		) {
			throw new Error("not an object");
		}
		return parsed;
	} catch {
		throw invalid("ctx is not base64url JSON");
	}
};

/** Encodes a `ctx` hint object for `/-/api/slot/*` (SPA and tests). */
export const encodeCtxParam = (ctx: unknown): string => {
	const bytes = new TextEncoder().encode(JSON.stringify(ctx));
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
		/=+$/,
		"",
	);
};
