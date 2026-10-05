// Binding operations the smoke Workers expose to their drivers (`/api/op`),
// shared by `worker-git` and `worker-lanes`. Every repo name must carry the
// Worker's prefix, so a driver bug can never touch another namespace's repos.
// Runs inside a Worker (live) and in Deno with FakeArtifacts (local).

import { redactSecrets } from "@tartan/contract";

export type OpRequest = {
	readonly op: string;
	readonly name?: string;
	readonly args?: Record<string, unknown>;
};

export type Timed<T> =
	| { readonly ok: true; readonly ms: number; readonly result: T }
	| {
		readonly ok: false;
		readonly ms: number;
		readonly error: {
			readonly name?: string;
			readonly code?: string;
			readonly numericCode?: number;
			readonly message: string;
		};
	};

export const errInfo = (e: unknown) => {
	const x = e as {
		name?: string;
		code?: string;
		numericCode?: number;
		message?: string;
	};
	return {
		name: x?.name,
		code: x?.code,
		numericCode: x?.numericCode,
		message: redactSecrets(String(x?.message ?? e)),
	};
};

export const timedOp = async <T>(fn: () => Promise<T>): Promise<Timed<T>> => {
	const t0 = performance.now();
	try {
		const result = await fn();
		return { ok: true, ms: Math.round(performance.now() - t0), result };
	} catch (e) {
		return {
			ok: false,
			ms: Math.round(performance.now() - t0),
			error: errInfo(e),
		};
	}
};

const blobInfo = async (b: Blob | null) =>
	b
		? {
			type: b.type,
			size: b.size,
			text: b.size <= 65536 ? await b.text() : null,
		}
		: null;

export const withRepo = async <T>(
	artifacts: Artifacts,
	name: string,
	fn: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> => {
	const repo = await artifacts.get(name);
	try {
		return await fn(repo);
	} finally {
		(repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
	}
};

export const requirePrefixed = (prefix: string, name: unknown): string => {
	if (typeof name !== "string" || !name.toLowerCase().startsWith(prefix)) {
		throw new Error(`refusing repo name without prefix ${prefix}`);
	}
	return name;
};

const str = (v: unknown): string => String(v ?? "");

/** One binding call; the result is JSON-safe (Blobs become `{type,size,text}`). */
export const runOp = (
	artifacts: Artifacts,
	prefix: string,
	req: OpRequest,
): Promise<unknown> => {
	const a = req.args ?? {};
	if (req.op === "list") {
		return artifacts.list(a as { limit?: number; cursor?: string });
	}
	const name = requirePrefixed(prefix, req.name);
	const on = <T>(fn: (r: ArtifactsRepo) => Promise<T>) =>
		withRepo(artifacts, name, fn);
	switch (req.op) {
		case "create":
			return artifacts.create(
				name,
				a.opts as Parameters<Artifacts["create"]>[1],
			);
		case "delete":
			return artifacts.delete(name);
		case "get-info":
			return on((r) => r.info());
		case "token":
			return on((r) =>
				r.createToken(a.scope as "read" | "write", a.ttl as number)
			);
		case "listTokens":
			return on((r) => r.listTokens());
		case "revokeToken":
			return on((r) => r.revokeToken(str(a.tokenOrId)));
		case "readFile":
			return on(async (r) =>
				blobInfo(await r.readFile({ ref: str(a.ref), path: str(a.path) }))
			);
		case "readBlob":
			return on(async (r) => blobInfo(await r.readBlob(str(a.hash))));
		case "readTree":
			return on((r) => r.readTree(str(a.hash)));
		case "readCommit":
			return on((r) => r.readCommit(str(a.hash)));
		case "log":
			return on((r) =>
				r.log(a as { ref?: string; limit?: number; offset?: number })
			);
		default:
			return Promise.reject(new Error(`unknown op ${req.op}`));
	}
};

/** Deletes every repo whose name starts with `startsWith` (itself prefixed). */
export const cleanupRepos = async (
	artifacts: Artifacts,
	prefix: string,
	startsWith: string,
) => {
	requirePrefixed(prefix, startsWith);
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await artifacts.list({ limit: 200, cursor });
		names.push(
			...page.repos.map((r) => r.name).filter((n) =>
				n.toLowerCase().startsWith(startsWith.toLowerCase())
			),
		);
		cursor = page.cursor;
	} while (cursor);
	const results = [];
	for (const n of names) {
		results.push({ name: n, ...(await timedOp(() => artifacts.delete(n))) });
	}
	return { matched: names.length, results };
};

/**
 * A JSON answer to the driver. Not redacted: the driver needs tokens and
 * capability URLs to act; its evidence recorder redacts before writing.
 */
export const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Constant-time string comparison for the driver's bearer key. */
export const sameSecret = (a: string, b: string): boolean => {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length || ea.length === 0) return false;
	let d = 0;
	for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
	return d === 0;
};

export const checkBearer = (request: Request, key: string): boolean => {
	const h = request.headers.get("authorization") ?? "";
	return h.startsWith("Bearer ") && sameSecret(h.slice(7), key);
};
