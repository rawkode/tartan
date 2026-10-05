// HTTP helpers of the hierarchy and browse routes (WP3): JSON answers that
// are never cached, the wire error mapping, bounded JSON bodies validated
// with the contract's zod schemas, and the 301 of a moved node.

import {
	fromRpcError,
	httpStatus,
	invalid,
	tartanError,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { z } from "zod";

export const NO_STORE = { "cache-control": "no-store" } as const;

/** Request bodies of the nodes API are small. */
export const MAX_JSON_BYTES = 64 * 1024;

export const json = (
	body: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response => {
	const h = new Headers(headers);
	h.set("cache-control", "no-store");
	return Response.json(body, { status, headers: h });
};

export const noContent = (): Response =>
	new Response(null, { status: 204, headers: NO_STORE });

export const failure = (error: unknown): Response => {
	const wire = toWire(error);
	if (wire.error === "internal") {
		console.error(
			"[tartan] browse: internal error",
			fromRpcError(error).message,
		);
	}
	return Response.json(wire, {
		status: httpStatus(wire.error),
		headers: NO_STORE,
	});
};

export const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

/** A JSON body validated with `schema` (`invalid` on bad JSON or shape). */
export const readJson = async <S extends z.ZodType>(
	req: Request,
	schema: S,
): Promise<z.output<S>> => {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_JSON_BYTES) {
		throw tartanError("payload_too_large", "request body too large");
	}
	const text = await req.text();
	if (text.length > MAX_JSON_BYTES) {
		throw tartanError("payload_too_large", "request body too large");
	}
	let value: unknown;
	try {
		value = text === "" ? {} : JSON.parse(text);
	} catch {
		throw invalid("the request body is not JSON");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw invalid(
			parsed.error.issues.map((i) =>
				`${i.path.join(".") || "(body)"}: ${i.message}`
			).join("; "),
		);
	}
	return parsed.data;
};

/** A required query parameter (`invalid` when missing or too long). */
export const param = (url: URL, name: string, max = 16_384): string => {
	const value = url.searchParams.get(name);
	if (value === null || value === "") throw invalid(`${name} is required`);
	if (value.length > max) throw invalid(`${name} is too long`);
	return value;
};

export const optionalParam = (
	url: URL,
	name: string,
	max = 16_384,
): string | undefined => {
	const value = url.searchParams.get(name);
	if (value === null || value === "") return undefined;
	if (value.length > max) throw invalid(`${name} is too long`);
	return value;
};

/** 301 to the same request with `name` replaced by the moved node's path. */
export const movedParam = (url: URL, name: string, to: string): Response => {
	const next = new URL(url.pathname + url.search, url.origin);
	next.searchParams.set(name, to);
	return json({ redirectTo: to }, 301, {
		location: `${next.pathname}${next.search}`,
	});
};
