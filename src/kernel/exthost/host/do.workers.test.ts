/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The real ExtensionDO in workerd (vitest-pool-workers): the host wired to
// this DO's SQLite storage, alarm and RPC surface, with fake kernel ports and
// registry (`ExtensionDO.rewire`, through `runInDurableObject`). Covers what
// the Deno tests cannot: RPC between the test and the DO, real
// `transactionSync`/`storage.sync()`/`storage.kv`, the alarm, and two
// installations in two DOs (a runaway never blocks another installation).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
	createUlid,
	extDoName,
	fromRpcError,
	SESSION_BOUNDS,
	type ToolContext,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../test/env.ts";
import { loopback } from "../../../exports.ts";
import { createKernelPorts } from "../../caps/ports.ts";
import { ExtensionDO } from "./do.ts";
import { createModuleRuntime } from "./runtime.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	type FakeKernel,
	NODES,
	PRINCIPALS,
	userActor,
} from "./testing/fakes.ts";
import {
	deferred,
	HELLO_MIGRATIONS_V1,
	helloControl,
	helloManifest,
	helloModule,
	holdingLandSubmit,
} from "./testing/hello.ts";

const ulid = createUlid();

type Wired = {
	readonly name: string;
	readonly installationId: string;
	readonly kernel: FakeKernel;
	readonly stub: DurableObjectStub<ExtensionDO>;
};

/** A fresh installation in its own ExtensionDO, wired to fakes. */
const wire = async (
	options: { readonly kernel?: FakeKernel } = {},
): Promise<Wired> => {
	const installationId = `i_${ulid()}`;
	const name = extDoName(installationId, {
		kind: "repo",
		repoId: NODES.router.id,
	});
	const kernel = options.kernel ?? createFakeKernel();
	// `queue_enqueue` awaits land.submit, held per change by the test.
	kernel.landSubmit = holdingLandSubmit;
	const installations = createFakeInstallations(helloManifest(), {
		id: installationId,
	});
	const stub = env.EXT.getByName(name);
	await runInDurableObject(stub, async (instance, state) => {
		expect(state.id.name).toBe(name);
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			kernel: kernel.ports,
			installations,
			packages: () =>
				Promise.resolve({
					runtime: createModuleRuntime(() => helloModule),
					migrations: HELLO_MIGRATIONS_V1,
				}),
			budgets: { hold: 100 },
		}));
	});
	return { name, installationId, kernel, stub };
};

const ctx = {
	node: NODES.router.id,
	repo: NODES.router.id,
	mode: "enforce" as const,
};
const viewer = (id: string) => ({
	actor: userActor(id),
	role: 30,
	kind: "user" as const,
});
const toolCtx = (actor = userActor(PRINCIPALS.dev)): ToolContext => ({
	...ctx,
	scope: NODES.router.path,
	actor,
});
const stream = `repo:${NODES.router.id}` as const;

const sqlRows = <T>(stub: DurableObjectStub<ExtensionDO>, query: string) =>
	runInDurableObject(
		stub,
		(_instance, state) => state.storage.sql.exec(query).toArray() as T[],
	);

describe("ExtensionDO (workerd)", () => {
	it("migrates host tables, activates the builtin and drains a poke in order, once", async () => {
		const w = await wire();
		w.kernel.addEvent(NODES.router.id, { type: "x.tartan.hello.note" });
		w.kernel.addEvent(NODES.router.id, { type: "x.tartan.hello.note" });
		await w.stub.poke({ stream, head: 2 });
		await w.stub.poke({ stream, head: 2 });
		const delivered = await sqlRows<{ seq: number; actor: string }>(
			w.stub,
			"SELECT seq, actor FROM deliveries ORDER BY rowid",
		);
		expect(delivered.map((d) => d.seq)).toEqual([1, 2]);
		expect(delivered[0].actor).toBe(`x_${w.installationId}`);
		const tables = await sqlRows<{ name: string }>(
			w.stub,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_%' ESCAPE '\\' ORDER BY name",
		);
		expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining([
			"_console",
			"_cursors",
			"_dead",
			"_ext_migrations",
			"_host",
			"_inflight",
			"_migrations",
			"_render_cache",
			"_retry",
			"_seen",
			"_strikes",
			"_timers",
		]));
	});

	it("renders per viewer, denies writes in render, and a write invalidates the cache", async () => {
		const w = await wire();
		const a = await w.stub.render("greeting", ctx, viewer(PRINCIPALS.dev));
		const b = await w.stub.render(
			"greeting",
			ctx,
			viewer(PRINCIPALS.maintainer),
		);
		expect(JSON.stringify(a)).toContain(PRINCIPALS.dev);
		expect(JSON.stringify(b)).toContain(PRINCIPALS.maintainer);
		const effects = await w.stub.render("effects", ctx, viewer(PRINCIPALS.dev));
		const attempts = JSON.parse((effects.root as { text: string }).text);
		expect(Object.values(attempts)).toEqual(Array(8).fill("denied:read-only"));
		await w.stub.action(
			"greeting",
			"greet",
			{ text: "hi" },
			ctx,
			userActor(PRINCIPALS.dev),
			SESSION_BOUNDS,
		);
		const after = await w.stub.render("greeting", ctx, viewer(PRINCIPALS.dev));
		expect(JSON.stringify(after)).toContain("greetings: 1");
	});

	it("a queue_enqueue during an awaited land.submit is serialized over RPC; queue_status is not blocked", async () => {
		const w = await wire();
		helloControl.trace.length = 0;
		const changeA = "k".repeat(32);
		const changeB = "m".repeat(32);
		const hold = deferred();
		helloControl.holds.set(changeA, hold);
		const first = w.stub.callTool(
			"queue_enqueue",
			{ changeId: changeA },
			toolCtx(),
			SESSION_BOUNDS,
		);
		await new Promise((r) => setTimeout(r, 20));
		const second = w.stub.callTool(
			"queue_enqueue",
			{ changeId: changeB },
			toolCtx(),
			SESSION_BOUNDS,
		);
		const status = await w.stub.callTool(
			"queue_status",
			{ repo: NODES.router.path },
			toolCtx(),
			SESSION_BOUNDS,
		);
		expect(status).toEqual({ partitions: [] });
		expect(helloControl.trace).toEqual([`start ${changeA}`]);
		hold.resolve();
		await Promise.all([first, second]);
		expect(helloControl.trace).toEqual([
			`start ${changeA}`,
			`end ${changeA}`,
			`start ${changeB}`,
			`end ${changeB}`,
		]);
		helloControl.holds.clear();
	});

	it("one installation's stuck call never blocks another installation's ExtensionDO", async () => {
		const kernel = createFakeKernel();
		const a = await wire({ kernel });
		const b = await wire({ kernel });
		const hold = deferred();
		const change = "n".repeat(32);
		helloControl.holds.set(change, hold);
		const stuck = a.stub.callTool(
			"queue_enqueue",
			{ changeId: change },
			toolCtx(),
			SESSION_BOUNDS,
		);
		await new Promise((r) => setTimeout(r, 20));
		const other = await b.stub.callTool(
			"queue_enqueue",
			{ changeId: "p".repeat(32) },
			toolCtx(),
			SESSION_BOUNDS,
		);
		expect((other as { changeId: string }).changeId).toBe("p".repeat(32));
		hold.resolve();
		await stuck;
		helloControl.holds.clear();
	});

	it("caps are per call: the actor changes between calls, and a stashed capability fails", async () => {
		const w = await wire();
		const first = await w.stub.callTool(
			"count",
			{},
			toolCtx(userActor(PRINCIPALS.dev)),
			SESSION_BOUNDS,
		);
		const second = await w.stub.callTool(
			"count",
			{},
			toolCtx(userActor(PRINCIPALS.maintainer)),
			SESSION_BOUNDS,
		);
		expect((first as { actor: string }).actor).toBe(PRINCIPALS.dev);
		expect((second as { actor: string }).actor).toBe(PRINCIPALS.maintainer);
		helloControl.stash = null;
		await w.stub.render("stash", ctx, viewer(PRINCIPALS.dev));
		const used = await w.stub.render("use-stash", ctx, viewer(PRINCIPALS.dev));
		expect(JSON.stringify(used)).toContain("stash: unavailable");
		helloControl.stash = null;
	});

	it("a failed event is retried by the DO alarm, then dead-lettered", async () => {
		const w = await wire();
		w.kernel.addEvent(NODES.router.id, { type: "x.tartan.hello.fail" });
		await w.stub.poke({ stream, head: 1 });
		for (let attempt = 2; attempt <= 6; attempt++) {
			// Time travel: make the pending retry due now, then run the alarm.
			await runInDurableObject(w.stub, async (_i, state) => {
				state.storage.sql.exec("UPDATE _retry SET next_at = 0");
				state.storage.sql.exec("UPDATE _timers SET at = 0");
				// Far enough ahead not to fire by itself; runDurableObjectAlarm runs it now.
				await state.storage.setAlarm(Date.now() + 60_000);
			});
			expect(await runDurableObjectAlarm(w.stub)).toBe(true);
		}
		const dead = await w.stub.deadLetters(10);
		expect(dead.map((d) => d.attempts)).toEqual([6]);
		const errors = w.kernel.forgeAppended as { type: string }[];
		expect(errors.some((e) => e.type === "extension.error")).toBe(true);
		const console = await w.stub.console(0, 100);
		expect(console.some((line) => line.msg.includes("attempt 6"))).toBe(true);
	});

	it("ExtCtx.kv is the DO's synchronous storage.kv", async () => {
		const w = await wire();
		const out = await w.stub.action(
			"greeting",
			"kv",
			{ text: "hi there" },
			ctx,
			userActor(PRINCIPALS.dev),
			SESSION_BOUNDS,
		);
		expect(out).toEqual({
			v: 1,
			toast: { tone: "info", text: "hi there|greeting" },
		});
		const stored = await runInDurableObject(
			w.stub,
			(_i, state) => state.storage.kv.get<Uint8Array>("greeting"),
		);
		expect(new TextDecoder().decode(stored)).toBe("hi there");
	});

	it("RepoProbe is reachable through a DO's ctx.exports and the module exports", async () => {
		const w = await wire();
		const source = { repoId: NODES.router.id };
		const viaDo = await runInDurableObject(
			w.stub,
			(_i, state) =>
				createKernelPorts(env, state).probe.diffPaths(
					source,
					"a".repeat(40),
					"b".repeat(40),
				)
					.then(() => "ok", (e: unknown) => fromRpcError(e).code),
		);
		// The RepoProbe entrypoint (WP8) is reached: it resolves the source
		// through RepoDO core (WP5a), which answers not_found for a repo never
		// initialized.
		expect(viaDo).toBe("not_found");
		const viaModule = await loopback({ exports }).RepoProbe.diffPaths(
			source,
			"a".repeat(40),
			"b".repeat(40),
		).then(() => "ok", (e: unknown) => fromRpcError(e).code);
		expect(viaModule).toBe("not_found");
	});

	it("the kill switch refuses calls at once", async () => {
		const w = await wire();
		await w.stub.render("greeting", ctx, viewer(PRINCIPALS.dev));
		await w.stub.abort("disabled");
		const chip = await w.stub.render("greeting", ctx, viewer(PRINCIPALS.dev));
		expect(chip.root.t).toBe("error-chip");
		const error = await (w.stub.callTool(
			"count",
			{},
			toolCtx(),
			SESSION_BOUNDS,
		) as Promise<unknown>).catch((e: unknown) => e);
		expect(fromRpcError(error).reason).toBe("disabled");
	});
});
