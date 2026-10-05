// runExtension drives a module like the host: background hooks with effects,
// read-only renders (SELECT-only, effects denied), tools as the actor.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { ExtensionModule, UiDoc } from "@tartan/contract";
import {
	createFakeExtDispatch,
	gateAnswer,
	makeEvent,
	runExtension,
} from "../src/index.ts";
import { createSqliteSql } from "../src/ext/sqlite.ts";

const toy: ExtensionModule = {
	init: (x) => {
		x.sql.exec("INSERT INTO seen (n) VALUES (0)");
		return Promise.resolve();
	},
	onEvent: async (ev, x) => {
		x.sql.exec("UPDATE seen SET n = n + 1");
		await x.caps.events.emit("toy.counted", { from: ev.id });
		await x.caps.timers.set("flush", 1000);
	},
	onTimer: (key, x) => {
		x.log.info("timer", { key });
		return Promise.resolve();
	},
	render: async (slot, _ctx, _props, x) => {
		const n = x.sql.exec<{ n: number }>("SELECT n FROM seen").one().n;
		if (slot === "sneaky") {
			await x.caps.events.emit("toy.sneaky", {});
		}
		if (slot === "writer") x.sql.exec("UPDATE seen SET n = 99");
		const doc: UiDoc = { v: 1, root: { t: "text", text: `seen ${n}` } };
		return doc;
	},
	callTool: (name, args, ctx, x) =>
		Promise.resolve({ name, args, actor: x.actor.id, mode: ctx.mode }),
};

Deno.test("runExtension: migrations, init, events, timers, renders, tools", async () => {
	const sql = createSqliteSql();
	const result = await runExtension(
		toy,
		[makeEvent("push.accepted", {}), makeEvent("push.accepted", {})],
		{
			sql,
			migrations: [{
				n: 1,
				name: "init",
				sql: "CREATE TABLE seen (n INTEGER NOT NULL)",
			}],
			timers: ["flush"],
			renders: [
				{
					slot: "count",
					ctx: { node: "01k6rrrrrrrrrrrrrrrrrrrrrr", mode: "enforce" },
				},
				{
					slot: "sneaky",
					ctx: { node: "01k6rrrrrrrrrrrrrrrrrrrrrr", mode: "enforce" },
				},
				{
					slot: "writer",
					ctx: { node: "01k6rrrrrrrrrrrrrrrrrrrrrr", mode: "enforce" },
				},
			],
			tools: [{
				name: "toy_count",
				args: { q: 1 },
				ctx: {
					node: "01k6rrrrrrrrrrrrrrrrrrrrrr",
					scope: "/acme",
					actor: { kind: "agent", id: "a_01k6aaaaaaaaaaaaaaaaaaaaaa" },
					mode: "enforce",
				},
			}],
		},
	);
	deepStrictEqual(result.events.map((e) => e.outcome.ok), [true, true]);
	deepStrictEqual(
		result.effects.map((c) => c.method),
		["events.emit", "timers.set", "events.emit", "timers.set"],
	);
	const [count, sneaky, writer] = result.renders;
	ok(count.outcome.ok);
	deepStrictEqual(count.uiErrors, []);
	deepStrictEqual(
		count.outcome.ok && count.outcome.value,
		{ v: 1, root: { t: "text", text: "seen 2" } },
	);
	ok(!sneaky.outcome.ok && sneaky.outcome.error.includes("read-only"));
	ok(!writer.outcome.ok && writer.outcome.error.includes("read-only"));
	equal(result.denials.length, 1, "the render's emit was denied");
	const tool = result.tools[0];
	ok(tool.outcome.ok);
	deepStrictEqual(tool.outcome.value, {
		name: "toy_count",
		args: { q: 1 },
		actor: "a_01k6aaaaaaaaaaaaaaaaaaaaaa",
		mode: "enforce",
	});
	deepStrictEqual(result.logs, [{
		level: "info",
		msg: "timer",
		data: { key: "flush" },
	}]);
	equal(sql.exec<{ n: number }>("SELECT n FROM seen").one().n, 2);
	sql.close();
});

Deno.test("runExtension reports invalid UI documents", async () => {
	const bad: ExtensionModule = {
		render: () =>
			Promise.resolve({ v: 1, root: { t: "marquee" } } as unknown as UiDoc),
	};
	const result = await runExtension(bad, [], {
		renders: [{
			slot: "x",
			ctx: { node: "01k6rrrrrrrrrrrrrrrrrrrrrr", mode: "enforce" },
		}],
	});
	ok(result.renders[0].outcome.ok);
	ok(result.renders[0].uiErrors.length > 0);
});

Deno.test("FakeExtDispatch: K8 aggregation and truncation from the contract", async () => {
	const dispatch = createFakeExtDispatch({
		gates: {
			"ref.advance": [
				gateAnswer("acme.ci", "allow"),
				gateAnswer("acme.review", "veto", { mode: "shadow" }),
			],
			push: [gateAnswer("acme.no-secrets", "allow", { onTruncated: "veto" })],
		},
	});
	const at = {
		nodeId: "01k6rrrrrrrrrrrrrrrrrrrrrr",
		repoId: "01k6rrrrrrrrrrrrrrrrrrrrrr",
	};
	const advance = await dispatch.gates("ref.advance", {} as never, at);
	equal(advance.blocked, false, "a shadow veto never blocks");
	const truncated = await dispatch.gates(
		"push",
		{ truncated: true } as never,
		at,
	);
	equal(truncated.blocked, true);
	equal(truncated.effective[0].basis, "truncated");
	dispatch.scriptGates("ref.advance", [gateAnswer("acme.ci", "veto")]);
	equal((await dispatch.gates("ref.advance", {} as never, at)).blocked, true);
	deepStrictEqual(await dispatch.echo({} as never, at), []);
	equal(await dispatch.resolveTool("n", "x", {} as never), null);
	equal(dispatch.calls.length, 5);
});
