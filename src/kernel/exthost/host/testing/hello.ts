// `tartan.hello`: the conformance extension of the WP7b host. TEST FIXTURE:
// production code never imports it. Every hook records what it saw, and event
// types / slots / tools switch its behaviour so one module exercises delivery,
// retries, dead letters, timers, the read-only render context, validation, caps
// denials, the mutex and the per-call capability rule.
//
// Shared module-level `helloControl` lets a test hold a tool call open
// or stash a capability (a stashed stub must fail on the next call).

import {
	type ExtCtx,
	type ExtensionModule,
	type ExtMigration,
	type KernelCaps,
	type Manifest,
	type ManifestInput,
	parseManifest,
	type SlotContext,
	type UiDoc,
} from "@tartan/contract";
import { db, defineExtension, result, ui } from "@tartan/ext-api";

export const HELLO_ID = "tartan.hello";

export const HELLO_MIGRATIONS_V1: readonly ExtMigration[] = [
	{
		n: 1,
		name: "init",
		sql: [
			"CREATE TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)",
			"CREATE TABLE deliveries (event_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, trigger_actor TEXT)",
			"CREATE TABLE fired (key TEXT NOT NULL, at INTEGER NOT NULL)",
			"CREATE TABLE greetings (actor TEXT NOT NULL, text TEXT NOT NULL)",
			"CREATE TABLE blobs (k INTEGER PRIMARY KEY, v TEXT NOT NULL)",
		].join(";\n"),
	},
];

/** Version 0.2.0 adds one migration (upgrade test). */
export const HELLO_MIGRATIONS_V2: readonly ExtMigration[] = [
	...HELLO_MIGRATIONS_V1,
	{
		n: 2,
		name: "notes",
		sql: "ALTER TABLE greetings ADD COLUMN note TEXT",
	},
];

export const helloManifestInput = (
	overrides: Partial<ManifestInput> = {},
): ManifestInput => ({
	schema: 1,
	id: HELLO_ID,
	name: "Hello",
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: HELLO_ID },
	storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
	provides: ["queue@1"],
	permissions: {
		repo: "read",
		land: ["refs/heads/main"],
		lanes: ["open"],
		notify: true,
		notes: true,
		"events.read": ["x.tartan.hello.*", "push.*"],
		"interfaces.call": ["work@1"],
	},
	subscribe: [
		{ event: "x.tartan.hello.*" },
		{ event: "review.decided", filter: { "data.decision": "approve" } },
	],
	backfill: "all",
	onError: "skip",
	gates: [
		{ point: "ref.advance", timeoutMs: 200, default: "allow" },
		{ point: "push", timeoutMs: 100, default: "veto" },
	],
	echo: [{ event: "push.accepted", timeoutMs: 300, inputs: ["added-lines"] }],
	contributes: {
		slots: [
			{ slot: "repo.sidebar", id: "greeting", dynamic: true },
			{ slot: "hud.metric", id: "metric", dynamic: true, cache: "role" },
			{ slot: "repo.sidebar", id: "effects", dynamic: true, cache: "none" },
			{ slot: "repo.sidebar", id: "bad", dynamic: true, cache: "none" },
			{ slot: "repo.sidebar", id: "slow", dynamic: true, cache: "none" },
			{ slot: "repo.sidebar", id: "stash", dynamic: true, cache: "none" },
			{ slot: "repo.sidebar", id: "use-stash", dynamic: true, cache: "none" },
			{ slot: "repo.sidebar", id: "owners", dynamic: true, role: 40 },
		],
		tools: [
			{
				name: "count",
				description: "Count greetings",
				input: { type: "object" },
				role: 20,
			},
		],
		context: [{ id: "hello", maxBytes: 64, priority: "hints" }],
	},
	limits: { effects_per_second: 500 },
	...overrides,
});

export const helloManifest = (
	overrides: Partial<ManifestInput> = {},
): Manifest => {
	const parsed = parseManifest(helloManifestInput(overrides));
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

export const deferred = (): Deferred => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

/** Shared with tests (same isolate in Deno and in the workerd pool). */
export const helloControl: {
	/** `land.submit` for this change id waits for the deferred (`holdingLandSubmit`). */
	readonly holds: Map<string, Deferred>;
	/** Order of tool starts and ends. */
	readonly trace: string[];
	stash: KernelCaps | null;
} = { holds: new Map(), trace: [], stash: null };

/** The lane hello's `queue_enqueue` lands (the fake kernel's `LANE_ID`). */
const HELLO_LANE = "ln_01k60000000000000000000301";

/**
 * A fake `land.submit` that waits on `helloControl.holds` for the batch's
 * change: install it as `FakeKernel.landSubmit` to hold a `queue_enqueue`
 * inside an awaited kernel call.
 */
export const holdingLandSubmit = async (
	request: unknown,
): Promise<{ batchId: string; created: boolean }> => {
	const r = request as { batchId: string; batch: { changeId: string }[] };
	const hold = helloControl.holds.get(r.batch[0]?.changeId ?? "");
	if (hold !== undefined) await hold.promise;
	return { batchId: r.batchId, created: true };
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const bump = (x: ExtCtx, k: string): number => {
	x.sql.exec(
		"INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT (k) DO UPDATE SET n = n + 1",
		k,
	);
	return Number(db(x.sql).value("SELECT n FROM counters WHERE k = ?", k));
};

const errorCode = async (fn: () => unknown): Promise<string> => {
	try {
		await fn();
		return "ok";
	} catch (error) {
		const e = error as { code?: string; reason?: string; message?: string };
		return e.code === "denied" ? `denied:${e.reason}` : e.code ?? "error";
	}
};

const greetingDoc = (x: ExtCtx, ctx: SlotContext): UiDoc => {
	const n = Number(
		db(x.sql).value("SELECT COUNT(*) AS n FROM greetings") ?? 0,
	);
	return ui.doc(
		ui.stack([
			ui.heading(`Hello ${x.actor.id}`),
			ui.text(`greetings: ${n}; node ${ctx.node}`),
		]),
	);
};

export const helloModule: ExtensionModule = defineExtension({
	init: (x) => {
		bump(x, "init");
		return Promise.resolve();
	},

	onEvent: async (ev, x) => {
		x.sql.exec(
			"INSERT INTO deliveries (event_id, seq, type, actor, trigger_actor) VALUES (?, ?, ?, ?, ?)",
			ev.id,
			ev.seq,
			ev.type,
			x.actor.id,
			ev.actor.id,
		);
		const data = (ev.data ?? {}) as Record<string, unknown>;
		switch (ev.type) {
			case "x.tartan.hello.fail":
				throw new Error("hello: this event always fails");
			case "x.tartan.hello.flaky": {
				const n = bump(x, `flaky:${ev.id}`);
				if (n <= Number(data.failTimes ?? 0)) {
					throw new Error(`hello: flaky attempt ${n}`);
				}
				return;
			}
			case "x.tartan.hello.slow":
				await sleep(Number(data.ms ?? 0));
				return;
			case "x.tartan.hello.emit":
				await x.caps.events.emit("x.tartan.hello.echoed", { from: ev.id });
				return;
			case "x.tartan.hello.timer":
				await x.caps.timers.set(
					String(data.key ?? "tick"),
					x.caps.clock.now() + Number(data.inMs ?? 1000),
				);
				return;
			case "x.tartan.hello.ungranted": {
				// `runs` is not granted to hello: a denied capability.
				const code = await errorCode(() =>
					x.caps.runs.get("run_1", { repo: { id: ev.repo ?? "" } })
				);
				bump(x, `ungranted:${code}`);
				return;
			}
			case "x.tartan.hello.bloat":
				for (let k = 0; k < Number(data.rows ?? 0); k++) {
					x.sql.exec(
						"INSERT INTO blobs (v) VALUES (?)",
						"x".repeat(Number(data.size ?? 1000)),
					);
				}
				return;
		}
	},

	onTimer: (key, x) => {
		x.sql.exec("INSERT INTO fired (key, at) VALUES (?, ?)", key, Date.now());
		if (key.startsWith("fail")) {
			return Promise.reject(new Error(`hello: timer ${key} fails`));
		}
		return Promise.resolve();
	},

	render: async (slot, ctx, _props, x) => {
		switch (slot) {
			case "greeting":
			case "owners":
				return greetingDoc(x, ctx);
			case "metric":
				return ui.doc(ui.stat(`metric for ${x.actor.id}`, 1));
			case "effects": {
				const attempts = {
					sql: await errorCode(() =>
						x.sql.exec("INSERT INTO greetings (actor, text) VALUES ('x', 'y')")
					),
					kv: await errorCode(() => x.kv.put("k", new Uint8Array([1]))),
					emit: await errorCode(() =>
						x.caps.events.emit("x.tartan.hello.rendered", {})
					),
					notify: await errorCode(() =>
						x.caps.notify.send(x.actor.id, {
							kind: "system",
							severity: "info",
							text: "hi",
						})
					),
					lanes: await errorCode(() =>
						x.caps.lanes.open({
							repo: { id: ctx.repo ?? ctx.node },
							owner: x.actor.id,
						})
					),
					land: await errorCode(() => x.caps.land.submit({} as never)),
					timers: await errorCode(() => x.caps.timers.set("t", 1)),
					tool: await errorCode(() =>
						x.caps.interfaces.call("work@1", "work_claim", {})
					),
				};
				return ui.doc(ui.code(JSON.stringify(attempts)));
			}
			case "bad":
				// An unknown prop and a protocol-relative link.
				return {
					v: 1,
					root: {
						t: "stack",
						children: [{ t: "link", text: "x", href: "//evil.example" }],
						innerHTML: "<b>x</b>",
					},
				} as unknown as UiDoc;
			case "slow":
				await sleep(5000);
				return ui.doc(ui.text("late"));
			case "stash":
				helloControl.stash = x.caps;
				return ui.doc(ui.text("stashed"));
			case "use-stash": {
				const stashed = helloControl.stash;
				const outcome = stashed === null
					? "none"
					: await errorCode(() => stashed.clock.now());
				return ui.doc(ui.text(`stash: ${outcome}`));
			}
		}
		return ui.doc(ui.empty(`unknown slot ${slot}`));
	},

	onAction: (action, payload, _ctx, x) => {
		if (action === "greet") {
			x.sql.exec(
				"INSERT INTO greetings (actor, text) VALUES (?, ?)",
				x.actor.id,
				String((payload as { text?: string } | null)?.text ?? "hello"),
			);
			return Promise.resolve(result.toast("success", "greeted"));
		}
		if (action === "kv") {
			const text = String((payload as { text?: string } | null)?.text ?? "");
			x.kv.put("greeting", new TextEncoder().encode(text));
			const back = x.kv.get("greeting");
			const keys = x.kv.listKeys("gree", 10).join(",");
			return Promise.resolve(
				result.toast(
					"info",
					`${new TextDecoder().decode(back ?? new Uint8Array())}|${keys}`,
				),
			);
		}
		if (action === "bad") {
			return Promise.resolve({ v: 1, navigate: "//evil.example" } as never);
		}
		return Promise.resolve(result.ok());
	},

	callTool: async (name, args, ctx, x) => {
		if (name === "count") {
			return {
				count: Number(db(x.sql).value("SELECT COUNT(*) AS n FROM greetings")),
				actor: x.actor.id,
			};
		}
		if (name === "queue_enqueue") {
			const { changeId } = args as { changeId: string };
			helloControl.trace.push(`start ${changeId}`);
			// An awaited land.submit (the mutex is held across it).
			await x.caps.land.submit({
				batchId: `lb_${x.caps.ids.ulid()}`,
				repo: { id: ctx.repo ?? ctx.node },
				ref: "refs/heads/main",
				batch: [{
					changeId,
					laneId: HELLO_LANE,
					head: "b".repeat(40),
					title: "change",
					message: "",
					trailers: [],
				}],
				reason: { events: [x.caps.ids.ulid()], summary: "approved" },
				testPolicy: "checks",
			});
			bump(x, `enqueued:${changeId}`);
			helloControl.trace.push(`end ${changeId}`);
			return {
				changeId,
				partition: ctx.repo ?? "default",
				position: 0,
				state: "waiting",
			};
		}
		if (name === "queue_status") {
			return { partitions: [] };
		}
		throw new Error(`hello: no tool ${name}`);
	},

	context: (req) =>
		Promise.resolve([
			{
				id: "hello",
				priority: "hints" as const,
				md: `hello ${req.actor.id} ${"z".repeat(200)}`,
			},
			{ id: "undeclared", priority: "protocol" as const, md: "dropped" },
		]),

	gate: (point, input) => {
		if (point === "push") {
			return Promise.resolve({
				decision: "veto" as const,
				message: "no pushes",
			});
		}
		const change = (input as { changeId?: string }).changeId ?? "";
		return Promise.resolve(
			change.startsWith("v")
				? { decision: "veto" as const, message: "vetoed by hello" }
				: { decision: "allow" as const, message: "fine" },
		);
	},

	echo: (ev) =>
		Promise.resolve([
			`saw \u001b[31m${ev.type}\u001b[0m`,
			"",
			"second line",
		]),
});
