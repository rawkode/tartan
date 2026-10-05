// JSON over same-origin fetch: cookies ride along
// (`credentials: "same-origin"`), unsafe requests send `Content-Type:
// application/json` (the kernel's CSRF check needs it, and the browser adds
// `Sec-Fetch-Site: same-origin`), errors arrive as `WireError` bodies, and
// every request is bounded: reads at `HTTP_TIMEOUT_MS`, writes (which the
// kernel may answer only when their work is done) at
// `HTTP_WRITE_TIMEOUT_MS`, either overridden per call.

import type { ApiError as WireError } from "@tartan/contract/api.ts";

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export type Query = Readonly<
	Record<string, string | number | boolean | undefined | null>
>;

/** A failed API call (typed error class, as the house style allows). */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly reason?: string;
	constructor(status: number, code: string, message: string, reason?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.reason = reason;
	}
}

export const isApiError = (value: unknown): value is ApiError =>
	value instanceof ApiError;

/** A user-facing message for any thrown value (never a stack). */
export const errorMessage = (value: unknown): string =>
	isApiError(value)
		? value.message
		: value instanceof Error && value.message !== ""
		? value.message
		: "Something went wrong.";

export const withQuery = (path: string, query?: Query): string => {
	if (!query) return path;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== null) params.set(key, String(value));
	}
	const qs = params.toString();
	return qs === "" ? path : `${path}?${qs}`;
};

const isWireError = (value: unknown): value is WireError =>
	typeof value === "object" && value !== null &&
	typeof (value as { error?: unknown }).error === "string" &&
	typeof (value as { message?: unknown }).message === "string";

/** One call's own bound, over the client's default for its method. */
export type CallOptions = {
	readonly timeoutMs?: number;
};

export type Http = {
	readonly get: <T>(
		path: string,
		query?: Query,
		call?: CallOptions,
	) => Promise<T>;
	readonly post: <T>(
		path: string,
		body?: unknown,
		call?: CallOptions,
	) => Promise<T>;
	readonly put: <T>(
		path: string,
		body?: unknown,
		call?: CallOptions,
	) => Promise<T>;
	readonly del: <T>(
		path: string,
		body?: unknown,
		call?: CallOptions,
	) => Promise<T>;
};

/**
 * A read, body included, settles within this long: a forge that never
 * answers fails the call (`ApiError` code `timeout`) instead of leaving a
 * page waiting forever.
 */
export const HTTP_TIMEOUT_MS = 60_000;
/**
 * A write's bound. The kernel answers some writes only when their work is
 * done (a URL import, a claim, a lane self-test with a cold container), so
 * a short bound would report a failure while the work goes on and invite a
 * retry that conflicts with it.
 */
export const HTTP_WRITE_TIMEOUT_MS = 10 * 60_000;

export type HttpOptions = {
	readonly timeoutMs?: number;
	readonly writeTimeoutMs?: number;
};

export const createHttp = (
	fetchImpl: FetchLike,
	options: HttpOptions = {},
): Http => {
	const readMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
	const writeMs = options.writeTimeoutMs ?? HTTP_WRITE_TIMEOUT_MS;
	const send = <T>(
		method: string,
		path: string,
		body?: unknown,
		call: CallOptions = {},
	): Promise<T> => {
		const timeoutMs = call.timeoutMs ??
			(method === "GET" ? readMs : writeMs);
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new ApiError(0, "timeout", "The forge did not answer in time."),
				);
				abort.abort();
			}, timeoutMs);
		});
		return Promise.race([
			exchange<T>(method, path, body, abort.signal),
			deadline,
		]).finally(() => clearTimeout(timer));
	};
	const exchange = async <T>(
		method: string,
		path: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<T> => {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		let response: Response;
		try {
			response = await fetchImpl(path, {
				method,
				headers,
				credentials: "same-origin",
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch {
			throw new ApiError(0, "network", "Could not reach the forge.");
		}
		const text = await response.text();
		let parsed: unknown = undefined;
		if (text !== "") {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = undefined;
			}
		}
		if (!response.ok) {
			if (isWireError(parsed)) {
				throw new ApiError(
					response.status,
					parsed.error,
					parsed.message,
					parsed.reason,
				);
			}
			throw new ApiError(
				response.status,
				"http",
				`Request failed (${response.status}).`,
			);
		}
		return parsed as T;
	};
	return {
		get: (path, query, call) =>
			send("GET", withQuery(path, query), undefined, call),
		post: (path, body, call) => send("POST", path, body ?? {}, call),
		put: (path, body, call) => send("PUT", path, body ?? {}, call),
		del: (path, body, call) => send("DELETE", path, body, call),
	};
};
