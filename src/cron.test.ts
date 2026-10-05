// The cron registry: every task runs, failures are isolated.

import { deepStrictEqual, equal } from "node:assert/strict";
import type { CronTask } from "@tartan/contract/kernel.ts";
import { CRON_TASKS, runCron } from "./cron.ts";
import type { Env } from "./env.ts";

// The identity task (WP2) asks ForgeDO whether the IdP metadata is due a refresh.
const env = {
	FORGE: {
		getByName: () => ({
			identity: () => ({
				refreshIdp: () => Promise.resolve({ refreshed: false }),
			}),
		}),
	},
} as unknown as Env;
const ctx = {} as ExecutionContext;

Deno.test("cron: each owning module registers one task; the remaining stub tasks are no-ops", async () => {
	/** Implemented tasks need real bindings; their own tests cover them. */
	const IMPLEMENTED = new Set(["events", "repo", "repoBackend"]);
	deepStrictEqual(Object.keys(CRON_TASKS).sort(), [
		"bus",
		"events",
		"exthost",
		"identity",
		"repo",
		"repoBackend",
	]);
	const stubs = Object.fromEntries(
		Object.entries(CRON_TASKS).filter(([name]) => !IMPLEMENTED.has(name)),
	);
	const outcomes = await runCron(stubs, env, ctx, 0, () => {});
	equal(outcomes.every((o) => o.ok), true);
});

Deno.test("cron: one failing task never skips another", async () => {
	const ran: string[] = [];
	const logged: unknown[] = [];
	const tasks: Record<string, CronTask<Env>> = {
		failing: () => Promise.reject(new Error("boom")),
		ok: (_env, _ctx, now) => {
			ran.push(`ok@${now}`);
			return Promise.resolve();
		},
	};
	const outcomes = await runCron(tasks, env, ctx, 42, (_m, data) => {
		logged.push(data);
	});
	deepStrictEqual(outcomes, [
		{ task: "failing", ok: false, error: "boom" },
		{ task: "ok", ok: true },
	]);
	deepStrictEqual(ran, ["ok@42"]);
	deepStrictEqual(logged, [{ task: "failing", error: "boom" }]);
});
