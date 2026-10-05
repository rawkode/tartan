// @tartan/ext-api: the ui builders produce valid tartan-ui@1, the SQL
// helpers, defineExtension, the K12 actor helper and the Deno harness.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import {
	type ExtCtx,
	fromRpcError,
	validateActionResult,
	validateUi,
} from "@tartan/contract";
import {
	action,
	bool,
	db,
	defineExtension,
	inList,
	isBackground,
	json,
	requireInteractiveActor,
	result,
	ui,
} from "../src/index.ts";
import { createTestCaps, createTestHarness } from "../src/testing.ts";

Deno.test("ui builders produce valid tartan-ui@1 documents with only declared props", () => {
	const doc = ui.doc(
		ui.stack([
			ui.heading("Board", 2),
			ui.text("hello", { tone: "muted" }),
			ui.badge("new", "info"),
			ui.link("docs", "/acme/docs"),
			ui.link("site", "https://example.com"),
			ui.kv([{ k: "a", v: "1" }, { k: "b", v: ui.code("x", "ts") }]),
			ui.table(["name", "n"], [["a", 1], ["b", ui.badge("2")]]),
			ui.button("Go", action("go", { id: 1 }, "Sure?"), "danger"),
			ui.menu("More", [{ text: "x", action: action("x") }]),
			ui.form([ui.input("title", { label: "Title", required: true })], {
				text: "Save",
				action: action("save"),
			}),
			ui.select("pick", ["a", { value: 1, label: "One" }]),
			ui.checkbox("ok", { value: true }),
			ui.timeline([{ at: 1, text: "t" }]),
			ui.board([{ id: "c", title: "C" }], [{ id: "x", col: "c", title: "X" }]),
			ui.matrix([{ id: "r", label: "R" }], [{ id: "c", label: "C" }], [
				{ r: "r", c: "c", level: 1 },
			]),
			ui.sparkline([1, 2, 3]),
			ui.progress(1, 2),
			ui.stat("n", 3, { unit: "x" }),
			ui.alert("warning", "careful", ui.markdown("**md**")),
			ui.tabs([{ label: "a", body: ui.empty("none") }]),
			ui.divider(),
			ui.avatar("u_1"),
			ui.icon("git-merge"),
			ui.diff({ repo: "r", base: "a", head: "b" }),
		]),
		{ refreshOn: ["changes.*"] },
	);
	const checked = validateUi(doc);
	ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	ok(!JSON.stringify(doc).includes("undefined"));
	strictEqual(JSON.stringify(doc).includes('"tone":null'), false);
	ok(validateActionResult(result.toast("success", "done")).ok);
	ok(validateActionResult(result.navigate("/acme")).ok);
	ok(
		!validateActionResult(result.navigate("//evil.example")).ok,
		"never protocol-relative",
	);
});

Deno.test("defineExtension rejects unknown hooks and freezes the module", () => {
	throws(() => defineExtension({ nope: () => Promise.resolve() } as never));
	const m = defineExtension({ init: () => Promise.resolve() });
	ok(Object.isFrozen(m));
});

Deno.test("K12: requireInteractiveActor refuses a background actor unless the precondition holds", () => {
	const background = {
		actor: { kind: "ext" as const, id: "x_i_01k60000000000000000000201" },
	};
	ok(isBackground(background));
	const e = (() => {
		try {
			requireInteractiveActor(background, "queue_enqueue");
		} catch (error) {
			return fromRpcError(error);
		}
	})();
	strictEqual(e?.reason, "actor");
	requireInteractiveActor(background, "queue_enqueue", () => true);
	requireInteractiveActor({
		actor: { kind: "user", id: "u_01k60000000000000000000101" },
	}, "x");
});

Deno.test("harness: migrations and init once, guarded sql, db helpers, read-only render, test caps policy", async () => {
	const h = createTestHarness({
		module: defineExtension({
			init: (x: ExtCtx) => {
				x.sql.exec(
					"INSERT INTO items (name, tags, done) VALUES (?, ?, ?)",
					"a",
					json.encode(["x"]),
					bool.encode(true),
				);
				return Promise.resolve();
			},
			render: (_slot, _ctx, _props, x) => {
				const d = db(x.sql);
				const rows = d.all<{ name: string }>(
					`SELECT name FROM items WHERE name IN ${inList.sql}`,
					inList.binding(["a", "b"]),
				);
				const write = (() => {
					try {
						x.sql.exec("DELETE FROM items");
						return "ok";
					} catch (error) {
						return fromRpcError(error).reason ?? "error";
					}
				})();
				return Promise.resolve(
					ui.doc(ui.text(`${rows.map((r) => r.name).join(",")}:${write}`)),
				);
			},
			onEvent: async (_ev, x) => {
				await x.caps.events.emit("x.acme.test.seen", {});
			},
		}),
		migrations: [{
			n: 1,
			name: "init",
			sql:
				"CREATE TABLE items (name TEXT PRIMARY KEY, tags TEXT, done INTEGER)",
		}],
		grants: { repo: "none" },
	});
	try {
		await h.init();
		await h.init();
		const d = db(h.ctx().sql);
		strictEqual(d.value("SELECT COUNT(*) FROM items"), 1);
		deepStrictEqual(
			json.decode(d.one<{ tags: string }>("SELECT tags FROM items").tags, []),
			["x"],
		);
		strictEqual(
			bool.decode(d.first<{ done: number }>("SELECT done FROM items")!.done),
			true,
		);
		const doc = await h.render("s", { node: "n", mode: "enforce" });
		deepStrictEqual(doc.root, { t: "text", text: "a:read-only" });
		await h.event({} as never);
		deepStrictEqual(h.recorder.emitted.map((e) => e.type), [
			"x.acme.test.seen",
		]);
		const { caps } = createTestCaps({ readOnly: true });
		const denied = await caps.events.emit("x.acme.test.a", {}).catch((e) =>
			fromRpcError(e).reason
		);
		strictEqual(denied, "read-only");
		const ungranted = await caps.repo.info({ id: "01k60000000000000000000001" })
			.catch((e) => fromRpcError(e).reason);
		strictEqual(ungranted, "grant");
	} finally {
		h.close();
	}
});
