// Shared helpers for `*.workers.test.ts` (vitest-pool-workers). The pool's
// bindings come from the inline miniflare options in vitest.config.ts; this
// types them as the hand-written `Env` (src/env.ts) instead of
// `Cloudflare.Env`.

import { env } from "cloudflare:workers";
import type { Env } from "../src/env.ts";

export const testEnv = env as unknown as Env;

/** A Durable Object name no other test uses. */
export const uniqueName = (prefix: string): string =>
	`${prefix}:${crypto.randomUUID()}`;

/**
 * Lets fire-and-forget work a file started inside Durable Objects (event
 * pokes, an extension host's catch-up reads, the ForgeDO's first boot)
 * finish before the pool closes the file's runner. Work still running then
 * fails with "Closing rpc while "resolve" was pending", an unhandled error
 * of that file. For `afterAll`. Under the full suite's load that work's
 * module resolution alone can take over a second (seen in the gateway and
 * bus files after the M2 merge), so the default wait is 3 s.
 */
export const settleBackground = (ms = 3000): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
