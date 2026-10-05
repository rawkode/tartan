// Push size limits through the gateway with stock git:
// a `Content-Length` over `MAX_PUSH_BYTES` is refused before RepoDO or
// upstream is asked anything; a chunked body (no `Content-Length`) is
// aborted at the limit; git's `0000` probe is answered by the gateway; a
// large push under the limit streams through and is recorded with its size.

import { equal, match, ok } from "node:assert/strict";
import { bareRefs, commitFile } from "./testing/git.ts";
import {
	forwardedPushes,
	gitTest as test,
	randomBytes,
	withWorld,
} from "./testing/world.ts";

test("a push over MAX_PUSH_BYTES with a Content-Length is push-too-large without contacting upstream", async () => {
	await withWorld(async (w) => {
		w.config = { ...w.config, maxPushBytes: 50_000 };
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		await commitFile(w.sandbox, dir, "big.bin", randomBytes(200_000));
		const out = await w.gitAs(user, ["push", "origin", "HEAD:refs/heads/big"], {
			cwd: dir,
			allowFail: true,
		});
		ok(out.code !== 0);
		match(out.stderr, /\(push-too-large\)/);
		equal(forwardedPushes(w).length, 0);
		// One write token: the receive-pack advertisement's; the POST asked for none.
		equal(w.upstreamCalls.filter((c) => c.scope === "write").length, 1);
		await w.settle();
		const rejected = w.h.events.ofType("push.rejected");
		equal(rejected.length, 1);
		equal((rejected[0].data as { reason: string }).reason, "push-too-large");
	});
});

test("a chunked push (no Content-Length) over the limit is aborted at the limit: push-too-large; the probe is answered locally", async () => {
	await withWorld(async (w) => {
		w.config = { ...w.config, maxPushBytes: 1_200_000 };
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		await commitFile(w.sandbox, dir, "big.bin", randomBytes(3_000_000));
		const out = await w.gitAs(user, ["push", "origin", "HEAD:refs/heads/big"], {
			cwd: dir,
			allowFail: true,
		});
		ok(out.code !== 0);
		match(out.stderr, /\(push-too-large\)/);
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/big"], undefined);
		// The `0000` probe never reached upstream.
		ok(
			!w.backend.requests.some((r) => r.method === "POST" && r.bodyBytes === 4),
		);
	});
});

test("a large push under the limit streams through (probe + chunked body) and is recorded with its byte count", async () => {
	await withWorld(async (w) => {
		const user = w.principal("user");
		const dir = await w.clone(user, "c");
		const head = await commitFile(
			w.sandbox,
			dir,
			"big.bin",
			randomBytes(3_000_000),
		);
		await w.gitAs(user, ["push", "-q", "origin", "HEAD:refs/heads/big"], {
			cwd: dir,
		});
		await w.settle();
		equal((await bareRefs(w.sandbox, w.bare))["refs/heads/big"], head);
		const pushes = forwardedPushes(w);
		equal(pushes.length, 1);
		ok(pushes[0].bodyBytes > 3_000_000);
		const row = w.h.storage.sql.exec<{ bytes: number }>(
			"SELECT bytes FROM pushes WHERE ref = 'refs/heads/big'",
		).toArray()[0];
		equal(row.bytes, pushes[0].bodyBytes);
	});
});
