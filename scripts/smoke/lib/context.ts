// What every smoke suite receives: where the smoke Workers are (live
// workers.dev URLs, or in-process apps on loopback ports with FakeArtifacts),
// the driver key, a scratch directory, a hermetic git environment and the
// evidence recorder.

import type { Recorder } from "./evidence.ts";
import type { GitEnv } from "./git.ts";

export type WorkerTarget = {
	/** Base URL, e.g. `https://tartan-smoke-git.<sub>.workers.dev`. */
	readonly base: string;
	/** The drivers' key (Bearer for /api, Basic password for /git). */
	readonly key: string;
};

export type SmokeContext = {
	readonly mode: "local" | "live";
	readonly stage: string;
	/** Small sizes and counts (always in local mode). */
	readonly small: boolean;
	/** Unique per run; part of every repo name. */
	readonly tag: string;
	readonly only: ReadonlySet<string> | null;
	readonly rec: Recorder;
	readonly tmp: string;
	readonly env: GitEnv;
	readonly git?: WorkerTarget;
	readonly lanes?: WorkerTarget;
};

export const wants = (ctx: SmokeContext, id: string): boolean =>
	ctx.only === null || ctx.only.has(id);

export type ApiResult<T = unknown> = {
	readonly status: number;
	readonly body: T;
};

/** Calls a smoke Worker's `/api/*` with the driver key. */
export const api = async <T = unknown>(
	target: WorkerTarget,
	path: string,
	body?: unknown,
): Promise<T> => {
	const res = await fetch(`${target.base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${target.key}`,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
	}
};

export type OpResult<T = unknown> =
	| { readonly ok: true; readonly ms: number; readonly result: T }
	| {
		readonly ok: false;
		readonly ms: number;
		readonly error: { code?: string; numericCode?: number; message: string };
	};

/** One binding call through `/api/op`. */
export const op = <T = unknown>(
	target: WorkerTarget,
	name: string | undefined,
	opName: string,
	args: Record<string, unknown> = {},
): Promise<OpResult<T>> =>
	api<OpResult<T>>(target, "/api/op", { op: opName, name, args });
