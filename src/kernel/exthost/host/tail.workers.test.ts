/// <reference types="@cloudflare/vitest-pool-workers/types" />
// ExtTail on workerd: a batch of tail events becomes tagged Workers Logs
// lines; a batch without props or events is a no-op.

import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { testEnv as env } from "../../../../test/env.ts";
import { ExtTail } from "./tail.ts";

describe("ExtTail (workerd)", () => {
	it("writes tagged lines for outcomes, exceptions and logs; an empty batch is a no-op", async () => {
		const ctx = createExecutionContext();
		const tail = new ExtTail(ctx, env);
		await expect(tail.tail([])).resolves.toBeUndefined();
		const withProps = Object.assign(createExecutionContext(), {
			props: {
				inst: "i_1",
				extId: "acme.x",
				version: "0.1.0",
				scopeKey: "repo",
			},
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await new ExtTail(withProps, env).tail([{
				eventTimestamp: 1,
				outcome: "exception",
				event: { rpcMethod: "invoke" },
				exceptions: [{ name: "Error", message: "boom" }],
				logs: [],
			}] as unknown as TraceItem[]);
			expect(errors.mock.calls.map((c) => c[0])).toEqual([
				"[ext i_1 acme.x@0.1.0 repo] tail invoke exception: Error: boom",
				"[ext i_1 acme.x@0.1.0 repo] tail invoke outcome: exception",
			]);
		} finally {
			errors.mockRestore();
		}
	});
});
