// Dev-only global log routes (WP26), for the live acceptance on a `dev-*`
// stage with dev tools (`TARTAN_STAGE ^dev`, `TARTAN_DEV_TOOLS=1`),
// before any Owner exists:
//
//   GET  /-/dev/k2/status        LogStatusResponse (as the Owner's route)
//   POST /-/dev/k2/conformance   the K2 conformance suite, live, in this
//                                Worker (its binding and Secrets Store token)
//   GET  /-/dev/k2/relay/<repo>  one repo's relay status
//
// Authorized only by the dev key `x-tartan-dev-key: hex(HMAC-SHA256(
// TARTAN_SECRET, "tartan:dev:k2"))`, which only the operator who set the
// secret can compute; 404 to anyone else and on every other stage. The
// suite's own records carry a tag header and are skipped by the consumer.

import {
	httpStatus,
	isUlid,
	notFound,
	repoDoName,
	toWire,
	unavailable,
} from "@tartan/contract";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { runConformance } from "./conformance.ts";
import { envClient } from "./consumer.ts";
import { type BusRelayStub, k2Env } from "./k2.ts";
import { envStatusPorts, readLogStatus } from "./status.ts";

export const DEV_K2_KEY_LABEL = "tartan:dev:k2";

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** `hex(HMAC-SHA256(secret, "tartan:dev:k2"))`. */
export const devK2Key = async (secret: string): Promise<string> => {
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
			new TextEncoder().encode(DEV_K2_KEY_LABEL),
		),
	);
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

export const devK2Allowed = async (
	req: Request,
	env: Pick<Env, "TARTAN_STAGE" | "TARTAN_DEV_TOOLS" | "TARTAN_SECRET">,
): Promise<boolean> => {
	const given = req.headers.get("x-tartan-dev-key");
	const secret = env.TARTAN_SECRET;
	if (
		!/^dev/.test(env.TARTAN_STAGE) || env.TARTAN_DEV_TOOLS !== "1" ||
		given === null || !secret
	) {
		return false;
	}
	return constantTimeEqual(given, await devK2Key(secret));
};

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serve = async (c: RouteContext): Promise<Response> => {
	if (!(await devK2Allowed(c.req, c.env))) throw notFound("not found");
	const parts = (c.params.rest ?? "").split("/").filter(Boolean);
	if (c.req.method === "GET" && parts.join("/") === "status") {
		return json(await readLogStatus(envStatusPorts(c.env)));
	}
	if (c.req.method === "GET" && parts[0] === "relay" && parts.length === 2) {
		if (!isUlid(parts[1])) throw notFound("not found");
		const relay =
			(c.env.REPO.getByName(repoDoName(parts[1])) as unknown as BusRelayStub)
				.bus();
		return json(await relay.status());
	}
	if (c.req.method === "POST" && parts.join("/") === "conformance") {
		const producer = k2Env(c.env).EVENT_LOG;
		const client = envClient(c.env);
		if (producer === undefined || client === null) {
			throw unavailable("needs the EVENT_LOG binding and the K2 token");
		}
		const started = Date.now();
		const results = await runConformance({
			producer,
			client,
			prefix: `conformance-${c.env.TARTAN_STAGE}`,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		});
		return json({ results, ms: Date.now() - started });
	}
	throw notFound("not found");
};

/** `/-/dev/k2[/…]` (dev stages with dev tools and the dev key only). */
export const handleDevK2: RouteHandler = async (c) => {
	try {
		return await serve(c);
	} catch (error) {
		const wire = toWire(error);
		return Response.json(wire, {
			status: httpStatus(wire.error),
			headers: { "cache-control": "no-store" },
		});
	}
};
