// The gateway resends a replayable read when the upstream answers a
// transient 5xx or the request fails (an agent's stock git does not retry);
// a push or a streamed body is sent once.

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { Upstream } from "@tartan/contract/kernel.ts";
import {
	callUpstream,
	replayable,
	UPSTREAM_RETRY_DELAYS_MS,
} from "./upstream.ts";

const UPSTREAM = {
	remote: "https://artifacts.invalid/git/repo",
	token: "tok",
} as unknown as Upstream;

/** A fetch answering `script` in order (a status, or a thrown error). */
const scripted = (script: readonly (number | "throw")[]) => {
	const seen: { method: string; url: string; body: string }[] = [];
	const logs: string[] = [];
	let i = 0;
	return {
		seen,
		logs,
		deps: {
			config: { upstreamAuth: "bearer" as const },
			log: (message: string) => void logs.push(message),
			fetch: async (request: Request): Promise<Response> => {
				seen.push({
					method: request.method,
					url: request.url,
					body: request.body === null ? "" : await request.text(),
				});
				const next = script[Math.min(i++, script.length - 1)];
				if (next === "throw") throw new Error("connection reset");
				return new Response(`answer ${next}`, { status: next });
			},
		} as unknown as Parameters<typeof callUpstream>[0],
	};
};

const REQ = new Request("https://forge.invalid/acme/app.git/info/refs");

Deno.test("info/refs: a transient 503 then 500 is resent; the third answer is relayed", async () => {
	const f = scripted([503, 500, 200]);
	const res = await callUpstream(f.deps, REQ, UPSTREAM, {
		method: "GET",
		path: "info/refs?service=git-upload-pack",
	});
	equal(res.status, 200);
	equal(await res.text(), "answer 200");
	equal(f.seen.length, 3);
	equal(f.logs.length, 2, "each resend is logged");
});

Deno.test("a buffered upload-pack request is resent with the same bytes after a failed request", async () => {
	const f = scripted(["throw", 200]);
	const body = new TextEncoder().encode("0011command=fetch0000");
	const res = await callUpstream(f.deps, REQ, UPSTREAM, {
		method: "POST",
		path: "git-upload-pack",
		body,
	});
	equal(res.status, 200);
	deepStrictEqual(f.seen.map((s) => s.body), [
		"0011command=fetch0000",
		"0011command=fetch0000",
	]);
});

Deno.test("resends are bounded: the last transient answer is relayed, the last failure thrown", async () => {
	const f = scripted([502]);
	const res = await callUpstream(f.deps, REQ, UPSTREAM, {
		method: "GET",
		path: "info/refs?service=git-upload-pack",
	});
	equal(res.status, 502);
	equal(f.seen.length, UPSTREAM_RETRY_DELAYS_MS.length + 1);
	const g = scripted(["throw"]);
	await rejects(
		callUpstream(g.deps, REQ, UPSTREAM, {
			method: "GET",
			path: "info/refs?service=git-upload-pack",
		}),
		/connection reset/,
	);
	equal(g.seen.length, UPSTREAM_RETRY_DELAYS_MS.length + 1);
});

Deno.test("a push and a streamed body are sent once; a 4xx or 200 is never resent", async () => {
	const push = scripted([503, 200]);
	const res = await callUpstream(push.deps, REQ, UPSTREAM, {
		method: "POST",
		path: "git-receive-pack",
		body: new TextEncoder().encode("push"),
	});
	equal(res.status, 503, "a push answer is relayed as is");
	equal(push.seen.length, 1);
	const stream = scripted([503, 200]);
	const streamed = await callUpstream(stream.deps, REQ, UPSTREAM, {
		method: "POST",
		path: "git-upload-pack",
		body: new Blob(["0000"]).stream(),
	});
	equal(streamed.status, 503);
	equal(stream.seen.length, 1);
	const denied = scripted([404, 200]);
	equal(
		(await callUpstream(denied.deps, REQ, UPSTREAM, {
			method: "GET",
			path: "info/refs?service=git-upload-pack",
		})).status,
		404,
	);
	equal(denied.seen.length, 1);
	equal(
		replayable({ method: "GET", path: "info/refs?service=git-receive-pack" }),
		true,
		"the receive-pack advertisement is a read",
	);
});
