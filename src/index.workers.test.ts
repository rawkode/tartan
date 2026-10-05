/// <reference types="@cloudflare/vitest-pool-workers/types" />
// src/index.ts exports every class from its module
// file, and the runtime instantiates each one from the inline miniflare
// bindings (vitest.config.ts mirrors wrangler.jsonc).

import {
	createExecutionContext,
	introspectWorkflowInstance,
	runInDurableObject,
} from "cloudflare:test";
import {
	DurableObject,
	WorkerEntrypoint,
	WorkflowEntrypoint,
} from "cloudflare:workers";
import { fromRpcError } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../test/env.ts";
import * as worker from "./index.ts";

const CLASS_EXPORTS = [
	"BusDO",
	"ExtTail",
	"ExtensionDO",
	"ForgeDO",
	"InboxDO",
	"IngestWorkflow",
	"KernelCaps",
	"LandWorkflow",
	"RepoDO",
	"RepoProbe",
	"RunWorkflow",
	"SwarmWorkflow",
	"TartanSandbox",
];

describe("src/index.ts", () => {
	it("exports exactly the thirteen classes and a default fetch/scheduled handler", () => {
		const names = Object.keys(worker).filter((name) => name !== "default")
			.sort();
		expect(names).toEqual(CLASS_EXPORTS);
		expect(typeof worker.default.fetch).toBe("function");
		expect(typeof worker.default.scheduled).toBe("function");
	});
});

describe("TartanSandbox", () => {
	it("leaves alarm() to the container library", () => {
		expect(Object.hasOwn(worker.TartanSandbox.prototype, "alarm")).toBe(false);
	});
});

describe("every class instantiates", () => {
	const durableObjects = [
		["FORGE", worker.ForgeDO],
		["REPO", worker.RepoDO],
		["INBOX", worker.InboxDO],
		["EXT", worker.ExtensionDO],
		["SANDBOX", worker.TartanSandbox],
		["BUS", worker.BusDO],
	] as const;

	it.each(durableObjects)("Durable Object %s", async (binding, Class) => {
		const stub = env[binding].getByName(uniqueName(`instantiate-${binding}`));
		const result = await runInDurableObject(stub, (instance: unknown) => ({
			isClass: instance instanceof Class,
			isDurableObject: instance instanceof DurableObject,
		}));
		expect(result).toEqual({ isClass: true, isDurableObject: true });
	});

	it("Workflow RUNS (implemented, WP9) runs and rejects invalid params", async () => {
		const id = `instantiate-${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(env.RUNS, id);
		try {
			const workflow = env.RUNS as Workflow<unknown>;
			await workflow.create({ id, params: { repoId: "x", runId: "y" } });
			await instance.waitForStatus("errored");
			expect((await instance.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await instance.dispose();
		}
	});

	it("Workflow INGEST (WP5a) drops an event that names no Tartan repo", async () => {
		const id = `instantiate-${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(env.INGEST, id);
		try {
			await env.INGEST.create({ id, params: { repoId: "x" } });
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				dropped: "missing source or payload",
			});
		} finally {
			await instance.dispose();
		}
	});

	it("Workflow LAND (implemented, WP10) rejects invalid params", async () => {
		const id = `instantiate-${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(env.LAND, id);
		try {
			const workflow = env.LAND as Workflow<unknown>;
			await workflow.create({ id, params: { repoId: "x", batchId: "z" } });
			await instance.waitForStatus("errored");
			expect((await instance.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await instance.dispose();
		}
	});

	it("Workflow SWARM (implemented, WP20) rejects invalid params", async () => {
		const id = `instantiate-${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(env.SWARM, id);
		try {
			const workflow = env.SWARM as Workflow<unknown>;
			await workflow.create({ id, params: { repoId: "x", swarmId: "s" } });
			await instance.waitForStatus("errored");
			expect((await instance.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await instance.dispose();
		}
	});

	it("Workflow classes extend WorkflowEntrypoint", () => {
		// The runtime constructs them (above); a test cannot, because
		// WorkflowEntrypoint requires the runtime's own ExecutionContext.
		for (
			const Class of [
				worker.RunWorkflow,
				worker.LandWorkflow,
				worker.IngestWorkflow,
				worker.SwarmWorkflow,
			]
		) {
			expect(Class.prototype).toBeInstanceOf(WorkflowEntrypoint);
		}
	});

	it("WorkerEntrypoints KernelCaps, RepoProbe and ExtTail construct", async () => {
		const ctx = createExecutionContext();
		for (
			const Class of [worker.KernelCaps, worker.RepoProbe, worker.ExtTail]
		) {
			expect(new Class(ctx, env)).toBeInstanceOf(WorkerEntrypoint);
		}
		const tail = new worker.ExtTail(ctx, env);
		await expect(tail.tail([])).resolves.toBeUndefined();
	});

	it("RepoProbe declares the RepoProbeApi methods; each refuses an uninitialized repo", async () => {
		const probe = new worker.RepoProbe(createExecutionContext(), env);
		const source = { repoId: "01k6aaaaaaaaaaaaaaaaaaaaaa" };
		const calls = [
			() => probe.laneDiff(source, "b".repeat(40)),
			() => probe.diffPaths(source, "a".repeat(40), "b".repeat(40)),
			() => probe.affected(source.repoId, "a".repeat(40), "b".repeat(40)),
			() => probe.addedLines(source, "a".repeat(40), "b".repeat(40)),
		];
		// WP8 implemented RepoProbe; it resolves sources through WP5a's core.
		for (const call of calls) {
			const error = await call().catch((e: unknown) => e);
			expect(fromRpcError(error).code).toBe("not_found");
		}
	});
});

describe("scheduled", () => {
	it("runs every registered cron task; M0 tasks are quiet no-ops", async () => {
		const ctx = createExecutionContext();
		const controller = {
			scheduledTime: Date.now(),
			cron: "*/5 * * * *",
			noRetry: () => {},
		} as ScheduledController;
		await expect(worker.default.scheduled(controller, env, ctx)).resolves
			.toBeUndefined();
	});
});
