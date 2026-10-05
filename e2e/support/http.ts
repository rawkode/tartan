// The forge's HTTP API from a test, two ways:
//
// - `tokenApi(origin, token)`: Node `fetch` with a Bearer token (the run's
//   PATs and the developer agent token). Tokens are used from Node only:
//   never in `browser.evaluate`, a route handler or a URL.
// - `pageApi(browser)`: `fetch` inside the page, so a persona's session
//   cookie stays in the browser and never enters Node, a report or a log.
//
// A reply carries the status, the parsed body and the API's error fields.
// `ApiError` (thrown by `ok`) names the method, the path without its query,
// the status and the API's error code and reason only: never a header, a
// body or a token, so a failed token-minting call cannot print its token.

// No e2e import: the Deno unit tests load this module without the e2e
// packages. `PageRunner` is the part of `@e2e-dev/web`'s `Browser` it uses.

type Json =
	| string
	| number
	| boolean
	| null
	| { readonly [key: string]: Json }
	| readonly Json[];

export type PageRunner = {
	evaluate<T extends Json, Arg extends Json>(
		fn: (arg: Arg) => T | Promise<T>,
		arg: Arg,
	): Promise<T>;
};

export type ApiFailure = {
	readonly code: string;
	readonly reason: string;
	readonly message: string;
};

export type Reply<T> = {
	readonly status: number;
	readonly body: T | null;
	readonly error: ApiFailure | null;
};

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly method: string,
		readonly path: string,
		readonly status: number,
		readonly failure: ApiFailure | null,
	) {
		super(
			`${method} ${path.split("?")[0]}: HTTP ${status}${
				failure === null
					? ""
					: ` ${safe(failure.code)}${
						failure.reason ? ` (${safe(failure.reason)})` : ""
					}`
			}`,
		);
	}
}

const safe = (value: string): string =>
	/^[A-Za-z0-9 ._:/()-]{1,80}$/.test(value) ? value : "";

const parse = <T>(status: number, text: string): Reply<T> => {
	let body: unknown = null;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {
		body = null;
	}
	const e = body as
		| { error?: unknown; reason?: unknown; message?: unknown }
		| null;
	const error = status >= 400 && e !== null && typeof e === "object" &&
			typeof e.error === "string"
		? {
			code: e.error,
			reason: typeof e.reason === "string" ? e.reason : "",
			message: typeof e.message === "string" ? e.message : "",
		}
		: null;
	return { status, body: body as T | null, error };
};

/** The body of a 2xx reply, or `ApiError`. */
export const ok = <T>(method: string, path: string, reply: Reply<T>): T => {
	if (reply.status < 200 || reply.status >= 300 || reply.body === null) {
		throw new ApiError(method, path, reply.status, reply.error);
	}
	return reply.body;
};

export type Api = {
	readonly get: <T>(path: string) => Promise<Reply<T>>;
	readonly send: <T>(
		method: "POST" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
	) => Promise<Reply<T>>;
};

/** How long one Node-side request to the forge may take, body included. */
export const NODE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetch` from Node with a bound: a request that gets no complete answer in
 * `NODE_REQUEST_TIMEOUT_MS` is aborted and fails as `<what>: no answer after
 * 30 s`, so one request that never ends cannot stall the requests after it.
 * `read` consumes the body inside the bound.
 */
export const boundedFetch = async <T>(
	url: string,
	init: RequestInit,
	what: string,
	read: (response: Response) => Promise<T>,
): Promise<T> => {
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(NODE_REQUEST_TIMEOUT_MS),
		});
		return await read(response);
	} catch (error) {
		if ((error as Error).name === "TimeoutError") {
			throw new Error(
				`${what}: no answer after ${NODE_REQUEST_TIMEOUT_MS / 1000} s`,
			);
		}
		throw error;
	}
};

/** Bearer calls from Node. `origin` is the forge (checked by the config). */
export const tokenApi = (origin: string, token: string): Api => {
	const call = async <T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<Reply<T>> => {
		if (!path.startsWith("/")) throw new Error("a path on the forge");
		const headers = new Headers({
			accept: "application/json",
			authorization: `Bearer ${token}`,
		});
		if (method !== "GET") headers.set("origin", origin);
		if (body !== undefined) headers.set("content-type", "application/json");
		return await boundedFetch(
			`${origin}${path}`,
			{
				method,
				headers,
				redirect: "manual",
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			`${method} ${path.split("?")[0]}`,
			async (response) => parse<T>(response.status, await response.text()),
		);
	};
	return {
		get: (path) => call("GET", path),
		send: (method, path, body) => call(method, path, body),
	};
};

type PageRequest = {
	readonly method: string;
	readonly path: string;
	readonly body: string | null;
};

/** Same-origin calls from the page, with the persona's own session. */
export const pageApi = (browser: PageRunner): Api => {
	const call = async <T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<Reply<T>> => {
		if (!path.startsWith("/")) throw new Error("a path on the forge");
		const reply = await browser.evaluate(
			async (r: PageRequest) => {
				const response = await fetch(r.path, {
					method: r.method,
					credentials: "same-origin",
					headers: r.body === null ? { accept: "application/json" } : {
						accept: "application/json",
						"content-type": "application/json",
					},
					...(r.body === null ? {} : { body: r.body }),
				});
				return { status: response.status, text: await response.text() };
			},
			{
				method,
				path,
				body: body === undefined ? null : JSON.stringify(body),
			},
		);
		return parse<T>(reply.status, reply.text);
	};
	return {
		get: (path) => call("GET", path),
		send: (method, path, body) => call(method, path, body),
	};
};

export const query = (params: Readonly<Record<string, string>>): string =>
	new URLSearchParams(params).toString();

/** A raw smart-HTTP exchange (the gateway probes): status, content type, text. */
export type GitHttpReply = {
	readonly status: number;
	readonly type: string;
	readonly text: string;
};

/**
 * Smart HTTP from Node with a Bearer token, for the probes stock git cannot
 * send: `GET <repo>.git/info/refs?service=…` or a hand-built `POST
 * <repo>.git/<service>` body. Bounded like every Node-side request.
 */
export const gitHttp = async (
	origin: string,
	token: string,
	repoPath: string,
	request:
		| { readonly kind: "advertisement"; readonly service: string }
		| {
			readonly kind: "post";
			readonly service: string;
			readonly body: string;
			readonly headers?: Readonly<Record<string, string>>;
		},
): Promise<GitHttpReply> => {
	const url = request.kind === "advertisement"
		? `${origin}/${repoPath}.git/info/refs?service=${request.service}`
		: `${origin}/${repoPath}.git/${request.service}`;
	const headers = new Headers({ authorization: `Bearer ${token}` });
	if (request.kind === "post") {
		headers.set("content-type", `application/x-${request.service}-request`);
		for (const [k, v] of Object.entries(request.headers ?? {})) {
			headers.set(k, v);
		}
	}
	return await boundedFetch(
		url,
		{
			method: request.kind === "post" ? "POST" : "GET",
			headers,
			redirect: "manual",
			...(request.kind === "post" ? { body: request.body } : {}),
		},
		`${request.kind === "post" ? "POST" : "GET"} ${repoPath}.git/${
			request.kind === "post" ? request.service : "info/refs"
		}`,
		async (response) => ({
			status: response.status,
			type: response.headers.get("content-type") ?? "",
			text: await response.text(),
		}),
	);
};

/**
 * True when a reply says the route itself is missing or wrong: 405, 501, or
 * a 404 whose message is the router's "no route for …" or a handler's
 * `notFound("route")`. A 404 for an unknown thing is a served route.
 */
export const isUnrouted = (reply: Reply<unknown>): boolean =>
	reply.status === 405 || reply.status === 501 ||
	(reply.status === 404 &&
		/^(?:no route for |route$)/.test(reply.error?.message ?? ""));

/**
 * Why a reply says a route is broken, or null when it was served: unrouted
 * (above), or a server error (5xx: the route exists but crashed). A 4xx for
 * a thing or a permission is a served route.
 */
export const routeProblem = (reply: Reply<unknown>): string | null =>
	isUnrouted(reply) ? "unrouted" : reply.status >= 500 ? "server error" : null;
