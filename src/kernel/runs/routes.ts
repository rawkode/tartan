// Runs, logs and usage HTTP API (WP9).
//
//   GET  /-/api/runs/<repoId>[?subject=<kind>:<id>&cursor=&limit=]  RunsResponse
//   GET  /-/api/runs/<repoId>/<runId>                               RunDto
//   GET  /-/api/runs/<repoId>/<runId>/jobs/<jobId>/log[?tail=]      JobLogResponse
//   POST /-/api/runs/<repoId>/<runId>/cancel                        204
//   GET  /-/api/usage[?day=YYYY-MM-DD]                              admins
//   POST /-/health/warm                                             deploy warm-up
//   GET|POST /-/dev/runs/<repoId>[/…]                               dev stages only
//
// Reads need `read` on the repo node and cancel needs `push` (WP3's
// `authorize`). Runs are started by `tartan.ci` through caps and by kernel
// git jobs, never over the API. On dev stages (`TARTAN_STAGE ^dev` and
// `TARTAN_DEV_TOOLS=1`) `/-/dev/runs/<repoId>` serves the same reads and
// cancel plus `POST {graph, idemKey}` (start a CI run) for live checks
// (`scripts/live/wp09-runs.ts`), authorized only by the dev key
// `x-tartan-dev-key: hex(HMAC-SHA256(TARTAN_SECRET, "tartan:dev:runs"))`,
// which only the operator who set the secret can compute. It is a separate
// route with the deploy-script policy (no session or token, any setup state;
// behind the API policy the key was never reached), and it
// answers 404 to anything else. Logs are redacted at the source and again
// here.

import {
	byteLength,
	CiJobGraphSchema,
	denied,
	type EntityRef,
	httpStatus,
	invalid,
	isUlid,
	type JobLogResponse,
	notFound,
	rateLimited,
	redactSecrets,
	repoDoName,
	type RunDto,
	type RunsResponse,
	toWire,
	unauthenticated,
	unavailable,
} from "@tartan/contract";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { createAuthorize } from "../tree/authz.ts";
import { JOB_TAIL_BYTES } from "./joblog.ts";
import { usageDay } from "./slots.ts";

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store", ...headers },
	});

const DEV_KEY_LABEL = "tartan:dev:runs";

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** `hex(HMAC-SHA256(secret, "tartan:dev:runs"))`. */
export const devRunsKey = async (secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(DEV_KEY_LABEL),
		),
	);
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

export const devToolsEnabled = (c: RouteContext): boolean =>
	/^dev/.test(c.env.TARTAN_STAGE) && c.env.TARTAN_DEV_TOOLS === "1";

/** The dev key header on a dev stage with dev tools (never elsewhere). */
const hasDevKey = async (c: RouteContext): Promise<boolean> => {
	const given = c.req.headers.get("x-tartan-dev-key");
	const secret = c.env.TARTAN_SECRET;
	if (!devToolsEnabled(c) || given === null || !secret) return false;
	return constantTimeEqual(given, await devRunsKey(secret));
};

/** How a caller is authorized: WP3's `authorize` at the repo node, or the dev key (checked once). */
type RunsAccess = "authorize" | "dev-key";

/** `read` (or `push`) on the repo node, unless the dev key already authorized the request. */
const authorizeRepo = async (
	c: RouteContext,
	access: RunsAccess,
	repoId: string,
	perm: "read" | "push",
): Promise<void> => {
	if (access === "dev-key") return;
	const node = await c.env.FORGE.getByName("forge").tree().node(repoId);
	if (node === null || node.kind !== "repo") throw notFound("no such repo");
	await createAuthorize(c.env)(c.auth, { node }, perm);
};

const runsOf = (c: RouteContext, repoId: string) =>
	c.env.REPO.getByName(repoDoName(repoId)).runs();

const parseSubject = (raw: string | null): EntityRef | undefined => {
	if (raw === null || raw === "") return undefined;
	const at = raw.indexOf(":");
	if (at <= 0) throw invalid("subject is <kind>:<id>");
	return { kind: raw.slice(0, at), id: raw.slice(at + 1) };
};

/** `/-/api/runs[/*]`: runs, jobs, logs and cancel for authenticated callers. */
export const handleRuns: RouteHandler = (c) => serveRuns(c, "authorize");

/**
 * `/-/dev/runs[/*]` (dev stages with dev tools only): the same, plus the CI
 * start, for a caller holding the dev key; 404 for anyone else.
 */
export const handleDevRuns: RouteHandler = async (c) => {
	if (!(await hasDevKey(c))) throw notFound("not found");
	return await serveRuns(c, "dev-key");
};

const serveRuns = async (
	c: RouteContext,
	access: RunsAccess,
): Promise<Response> => {
	const parts = (c.params.rest ?? "").split("/").filter((p) => p !== "");
	const [repoId, runId, ...tail] = parts;
	if (repoId === undefined) throw notFound("runs are listed per repo");
	if (!isUlid(repoId)) throw invalid("repo id must be a ulid");
	if (runId !== undefined && !isUlid(runId)) {
		throw invalid("run id must be a ulid");
	}
	const method = c.req.method;

	if (method === "POST" && runId === undefined) {
		if (access !== "dev-key") throw notFound("not found");
		const body = await c.req.json().catch(() => null) as {
			graph?: unknown;
			idemKey?: unknown;
		} | null;
		if (body === null || typeof body.idemKey !== "string") {
			throw invalid("body is {graph, idemKey}");
		}
		const graph = CiJobGraphSchema.safeParse(body.graph);
		if (!graph.success) {
			throw invalid(`invalid graph: ${graph.error.issues[0]?.message}`);
		}
		if (graph.data.source.repoId !== repoId) {
			throw invalid("graph.source.repoId must be the repo in the path");
		}
		const started = await runsOf(c, repoId).start({
			graph: graph.data,
			idemKey: `dev:${body.idemKey}`,
			requestedBy: "dev",
		});
		return json(started, 201);
	}

	if (method === "POST" && runId !== undefined && tail.join("/") === "cancel") {
		await authorizeRepo(c, access, repoId, "push");
		await runsOf(c, repoId).cancel(runId, c.auth?.principal ?? "sys_kernel");
		return new Response(null, {
			status: 204,
			headers: { "cache-control": "no-store" },
		});
	}

	if (method !== "GET") throw notFound("not found");
	await authorizeRepo(c, access, repoId, "read");

	if (runId === undefined) {
		const limit = c.url.searchParams.get("limit");
		const cursor = c.url.searchParams.get("cursor");
		const subject = parseSubject(c.url.searchParams.get("subject"));
		const page = await runsOf(c, repoId).list({
			...(subject ? { subject } : {}),
			...(cursor ? { cursor } : {}),
			...(limit ? { limit: Number(limit) } : {}),
		});
		const body: RunsResponse = page;
		return json(body);
	}

	const status = await runsOf(c, repoId).get(runId);
	if (status === null) throw notFound("no such run");
	if (tail.length === 0) {
		const body: RunDto = status;
		return json(body);
	}
	if (tail.length === 3 && tail[0] === "jobs" && tail[2] === "log") {
		const jobId = tail[1];
		const job = status.jobs.find((j) => j.jobId === jobId);
		if (job === undefined) throw notFound("no such job");
		const raw = c.url.searchParams.get("tail");
		const tailBytes = raw === null ? JOB_TAIL_BYTES : Number(raw);
		if (!Number.isInteger(tailBytes) || tailBytes < 1) {
			throw invalid("tail is a positive byte count");
		}
		const text = redactSecrets(
			await runsOf(c, repoId).logs(runId, jobId, tailBytes),
		);
		const body: JobLogResponse = {
			runId,
			jobId,
			text,
			truncated: byteLength(text) >= Math.min(tailBytes, 1024 * 1024),
			live: job.state === "running" || job.state === "pending",
		};
		return json(body);
	}
	throw notFound("not found");
};

/** `GET /-/api/usage`: container usage and budget (admins). */
export const handleUsage: RouteHandler = async (c) => {
	if (c.auth === null) throw unauthenticated();
	if (!c.auth.isAdmin) throw denied("role", "admins only");
	const day = c.url.searchParams.get("day") ?? usageDay(Date.now());
	const slots = c.env.FORGE.getByName("forge").slots();
	const [rows, exceeded] = await Promise.all([
		slots.usage(day),
		slots.budgetExceeded("ci"),
	]);
	return json({ day, rows, budgetExceeded: exceeded });
};

/**
 * `POST /-/health/warm` (unauthenticated; one selftest start per 10
 * minutes): starts the `selftest` sandbox after a deploy and records the
 * runner's git version and image info.
 */
export const handleHealthWarm: RouteHandler = async (c) => {
	if (c.env.SANDBOX === undefined) throw unavailable("no sandbox binding");
	const result = await c.env.SANDBOX.getByName("selftest").selftest();
	if ("limited" in result) {
		const error = rateLimited("warm-up already ran", result.retryAfterMs);
		return json(toWire(error), httpStatus(error.code), {
			"retry-after": String(Math.ceil(result.retryAfterMs / 1000)),
		});
	}
	return json(result, result.ok ? 200 : 503);
};
