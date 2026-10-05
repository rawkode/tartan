// Small HTTP helpers for kernel handlers (WP2): JSON in and out, the client
// address hash, a minimal HTML error page for browser navigations, and the
// `return_to` check that keeps redirects on the forge.

import { invalid, tartanError } from "@tartan/contract";
import type { z } from "zod";
import { ipHash } from "../identity/crypto.ts";
import { parseInput } from "../identity/input.ts";

/** Request bodies of the identity and setup APIs are small. */
export const MAX_JSON_BYTES = 64 * 1024;

export const json = (
	body: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response => {
	const h = new Headers(headers);
	if (!h.has("cache-control")) h.set("cache-control", "no-store");
	return Response.json(body, { status, headers: h });
};

export const noContent = (): Response =>
	new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** Reads and validates a JSON body (`invalid` on bad JSON, `payload_too_large` past the cap). */
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
	return parseInput(schema, value);
};

/** The rate-limit key of the caller's address (`CF-Connecting-IP`). */
export const clientIpHash = (req: Request): Promise<string> =>
	ipHash(req.headers.get("cf-connecting-ip") ?? "unknown");

const escapeHtml = (text: string): string =>
	text.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);

/** A plain page for a failed browser navigation (login callback, invite). */
export const errorPage = (
	status: number,
	title: string,
	message: string,
	headers: HeadersInit = {},
): Response => {
	const h = new Headers(headers);
	h.set("content-type", "text/html; charset=utf-8");
	h.set("cache-control", "no-store");
	h.set("referrer-policy", "no-referrer");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
			escapeHtml(title)
		} · Tartan</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${
			escapeHtml(message)
		}</p><p><a href="/">Back to the forge</a></p></main></body></html>`,
		{ status, headers: h },
	);
};

const RETURN_BASE = "https://return.invalid";
// deno-lint-ignore no-control-regex
const UNSAFE_PATH_CHARS = /[\\\u0000-\u001f\u007f]/;

/** A path a browser could read as scheme-relative (`//host`, `/\host`) or that carries control characters. */
const unsafePath = (path: string): boolean =>
	!path.startsWith("/") || /^\/[/\\]/.test(path) ||
	UNSAFE_PATH_CHARS.test(path);

/**
 * A same-origin path to return to after login, or `/`. Refuses absolute and
 * scheme-relative URLs (`//evil`, `/\evil`), backslashes, control
 * characters and anything that does not resolve to the forge itself. The
 * checks run again on the normalized result: dot-segment removal turns
 * `/..//evil.com` (or `/%2e%2e//evil.com`) into `//evil.com`.
 */
export const safeReturnTo = (raw: string | null): string => {
	if (raw === null || raw === "" || raw.length > 2048) return "/";
	if (unsafePath(raw)) return "/";
	let url: URL;
	try {
		url = new URL(raw, RETURN_BASE);
	} catch {
		return "/";
	}
	if (url.origin !== RETURN_BASE) return "/";
	const path = `${url.pathname}${url.search}${url.hash}`;
	return unsafePath(path) ? "/" : path;
};
