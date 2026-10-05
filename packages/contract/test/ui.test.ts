// tartan-ui@1 golden cases: strict zod mirror and
// the normative JSON Schema agree; validateUi() enforces host limits and
// returns the parsed value.

import { deepStrictEqual, equal, notStrictEqual, ok } from "node:assert/strict";
import {
	ActionResultSchema,
	errorChipDoc,
	measureUi,
	UI_NODE_TYPES,
	type UiNode,
	uiOrErrorChip,
	validateActionResult,
	validateUi,
} from "../src/ui.ts";
import { clone, loadSchema } from "./helpers.ts";

const schema = await loadSchema("schema/ui-1.json");

const doc = (root: unknown, extra: Record<string, unknown> = {}) => ({
	v: 1,
	root,
	...extra,
});

const action = { id: "queue.enqueue", payload: { changeId: "zkqv" } };

/** One node of every type, with the props each allows. */
const EVERY_NODE: UiNode = {
	t: "stack",
	id: "root",
	gap: 2,
	title: "All nodes",
	children: [
		{ t: "row", children: [{ t: "divider" }] },
		{ t: "grid", cols: 3, children: [] },
		{ t: "section", title: "Section" },
		{ t: "card", children: [{ t: "text", text: "in a card", tone: "muted" }] },
		{
			t: "tabs",
			tabs: [{ label: "One", body: { t: "markdown", md: "**bold**" } }],
		},
		{ t: "heading", text: "Weave", level: 2 },
		{ t: "label", text: "api", mono: true },
		{ t: "badge", text: "textual", tone: "danger" },
		{ t: "empty", text: "Nothing yet", body: "Push to a lane to start" },
		{ t: "code", text: "pnpm test", lang: "sh" },
		{ t: "avatar", principal: "a_01k6aaaaaaaaaaaaaaaaaaaaaa" },
		{ t: "icon", name: "git-merge" },
		{ t: "link", text: "change", href: "/acme/platform/-/changes/zkqv" },
		{ t: "link", text: "docs", href: "https://example.com/docs?x=1" },
		{ t: "progress", value: 3, max: 10, label: "jobs" },
		{ t: "stat", value: 41, delta: 2, unit: "/h", label: "landed" },
		{
			t: "kv",
			items: [
				{ k: "risk", v: "0.18" },
				{ k: "route", v: { t: "badge", text: "auto", tone: "success" } },
			],
		},
		{
			t: "alert",
			tone: "warning",
			title: "Landing paused",
			body: { t: "text", text: "ref.tampered on main" },
		},
		{ t: "button", text: "Enqueue", action, tone: "info" },
		{
			t: "menu",
			text: "More",
			items: [{ text: "Withdraw", action: { id: "queue.withdraw" } }],
		},
		{
			t: "form",
			fields: [
				{
					t: "input",
					name: "title",
					label: "Title",
					value: "x",
					required: true,
				},
				{ t: "textarea", name: "why", value: null },
				{
					t: "select",
					name: "mode",
					value: "auto",
					options: ["auto", 2, { value: true, label: "Yes" }],
				},
				{ t: "checkbox", name: "bisect", value: true },
				{ t: "select", name: "labels", value: ["a", "b"] },
			],
			submit: {
				text: "Save",
				action: { id: "settings.save", confirm: "Sure?" },
			},
		},
		{
			t: "table",
			columns: ["path", "lines", "who"],
			rows: [["limit.ts", 18, { t: "avatar", principal: "a_x" }]],
		},
		{ t: "list", items: [{ t: "text", text: "one" }] },
		{
			t: "timeline",
			items: [{
				at: 1790000000000,
				text: "submitted",
				actor: "codex-2",
				tone: "info",
			}],
		},
		{
			t: "diff",
			repo: "01k6",
			base: "a".repeat(40),
			head: "b".repeat(40),
			paths: ["x"],
		},
		{ t: "diff", patch: "--- a\n+++ b\n" },
		{
			t: "board",
			columns: [{ id: "todo", title: "To do", wip: 5 }],
			cards: [{
				id: "c1",
				col: "todo",
				title: "#42",
				href: "/acme/platform/-/work/42",
				badges: ["claimed"],
			}],
			moveAction: { id: "board.move" },
		},
		{
			t: "matrix",
			rows: [{ id: "ln_a", label: "claude" }],
			cols: [{ id: "ln_b", label: "codex" }],
			cells: [{ r: "ln_a", c: "ln_b", level: 4, label: "textual", action }],
		},
		{ t: "sparkline", values: [1, 2, 3, 5, 8] },
	],
};

Deno.test("ui: the golden document covers every node type", () => {
	const seen = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value !== null && typeof value === "object") {
			const t = (value as { t?: unknown }).t;
			if (typeof t === "string") seen.add(t);
			Object.values(value).forEach(walk);
		}
	};
	walk(EVERY_NODE);
	deepStrictEqual([...UI_NODE_TYPES].filter((t) => !seen.has(t)), []);
});

Deno.test("ui: valid documents pass zod, validateUi and the JSON Schema", () => {
	const cases = {
		every: doc(EVERY_NODE, { refreshOn: ["queue.*"], refreshMs: 5000 }),
		minimal: doc({ t: "text", text: "hi" }),
		divider: doc({ t: "divider", id: "d" }),
	};
	for (const [name, input] of Object.entries(cases)) {
		const result = validateUi(input);
		ok(result.ok, `${name}: ${result.ok ? "" : result.errors.join("; ")}`);
		const json = schema(input);
		ok(json.valid, `${name} (json schema): ${json.errors.join("; ")}`);
	}
});

Deno.test("ui: validateUi returns the parsed value, never its input", () => {
	const input = doc(EVERY_NODE);
	const result = validateUi(input);
	ok(result.ok);
	notStrictEqual(result.doc, input);
	notStrictEqual(result.doc.root, input.root);
	deepStrictEqual(result.doc, input);
});

const link = (href: string) => doc({ t: "link", text: "x", href });

/** Golden cases plus nested-closure cases: all must fail zod AND the JSON Schema. */
const REJECTED: Record<string, unknown> = {
	"innerHTML on text": doc({ t: "text", text: "x", innerHTML: "<img src=x>" }),
	"style on card": doc({ t: "card", style: "position:fixed" }),
	"onClick on button": doc({ t: "button", text: "x", onClick: "alert(1)" }),
	"href on a text node": doc({ t: "text", text: "x", href: "/a" }),
	"href on a button": doc({ t: "button", text: "x", href: "https://e.com" }),
	"src on avatar": doc({ t: "avatar", src: "https://evil/x.png" }),
	"link //evil": link("//evil.example"),
	"link /\\evil": link("/\\evil.example"),
	"link /<TAB>/evil (browsers strip TAB)": link("/\t/evil.example"),
	"link /<LF>/evil (browsers strip LF)": link("/\n/evil.example"),
	"link javascript:": link("javascript:alert(1)"),
	"link http:": link("http://example.com"),
	"link data:": link("data:text/html,<script>"),
	"link relative": link("evil.example/x"),
	"link leading space": link(" https://example.com"),
	"link empty": link(""),
	"board card href //evil": doc({
		t: "board",
		columns: [],
		cards: [{ id: "c", col: "x", title: "t", href: "//evil" }],
	}),
	"board card href https (same-origin only)": doc({
		t: "board",
		columns: [],
		cards: [{ id: "c", col: "x", title: "t", href: "https://e.com" }],
	}),
	"avatar principal path traversal": doc({ t: "avatar", principal: "../../x" }),
	"unknown node type": doc({ t: "iframe", src: "https://e.com" }),
	"script node": doc({ t: "script", text: "alert(1)" }),
	"error-chip from an extension": doc({ t: "error-chip", text: "x" }),
	"missing t": doc({ text: "x" }),
	"text missing text": doc({ t: "text" }),
	"extra prop on tab item": doc({
		t: "tabs",
		tabs: [{ label: "a", body: { t: "divider" }, onClick: "x" }],
	}),
	"extra prop on kv item": doc({
		t: "kv",
		items: [{ k: "a", v: "b", html: "<b>" }],
	}),
	"extra prop on menu item": doc({
		t: "menu",
		text: "m",
		items: [{ text: "a", action: { id: "a" }, href: "/x" }],
	}),
	"extra prop on action": doc({
		t: "button",
		text: "x",
		action: { id: "a", url: "https://e.com" },
	}),
	"bad action id": doc({ t: "button", text: "x", action: { id: "A B" } }),
	"extra prop on board column": doc({
		t: "board",
		columns: [{ id: "a", title: "A", color: "red" }],
		cards: [],
	}),
	"extra prop on board card": doc({
		t: "board",
		columns: [],
		cards: [{ id: "c", col: "a", title: "t", style: "x" }],
	}),
	"extra prop on matrix row": doc({
		t: "matrix",
		rows: [{ id: "a", label: "A", html: "<b>" }],
		cols: [],
		cells: [],
	}),
	"extra prop on matrix cell": doc({
		t: "matrix",
		rows: [],
		cols: [],
		cells: [{ r: "a", c: "b", level: 1, onClick: "x" }],
	}),
	"matrix level 6": doc({
		t: "matrix",
		rows: [],
		cols: [],
		cells: [{ r: "a", c: "b", level: 6 }],
	}),
	"extra prop on timeline item": doc({
		t: "timeline",
		items: [{ at: 1, text: "x", html: "<b>" }],
	}),
	"extra prop on form submit": doc({
		t: "form",
		fields: [],
		submit: { text: "Go", action: { id: "go" }, formaction: "https://e" },
	}),
	"select option object with extra prop": doc({
		t: "select",
		name: "m",
		options: [{ value: "a", label: "A", html: "<b>" }],
	}),
	"field value object": doc({ t: "input", name: "n", value: { a: 1 } }),
	"field name with dash": doc({ t: "input", name: "bad-name" }),
	"nested invalid child": doc({
		t: "stack",
		children: [{ t: "text", text: "ok" }, { t: "text", text: "x", style: "y" }],
	}),
	"heading level 1": doc({ t: "heading", text: "x", level: 1 }),
	"gap 4": doc({ t: "stack", gap: 4 }),
	"cols 7": doc({ t: "grid", cols: 7 }),
	"refreshMs below 5000": doc({ t: "divider" }, { refreshMs: 1000 }),
	"root extra prop": doc({ t: "divider" }, { css: "x" }),
	"v 2": { v: 2, root: { t: "divider" } },
	"button text too long": doc({ t: "button", text: "x".repeat(61) }),
	"tabs over 12": doc({
		t: "tabs",
		tabs: Array.from(
			{ length: 13 },
			() => ({ label: "a", body: { t: "divider" } }),
		),
	}),
};

Deno.test("ui: injected props and unsafe hrefs fail zod, validateUi and the JSON Schema", () => {
	for (const [name, input] of Object.entries(REJECTED)) {
		const result = validateUi(input);
		equal(result.ok, false, `${name}: validateUi accepted it`);
		equal(schema(input).valid, false, `${name}: JSON Schema accepted it`);
	}
});

Deno.test("ui: host limits (nodes, depth, bytes) are enforced by validateUi", () => {
	const many = doc({
		t: "list",
		items: Array.from({ length: 200 }, () => ({
			t: "row",
			children: [{ t: "divider" }, { t: "divider" }],
		})),
	});
	const r1 = validateUi(many);
	equal(r1.ok, false);
	ok(!r1.ok && r1.errors.some((e) => e.includes("nodes exceeds 500")));

	const nest = (depth: number): unknown =>
		depth === 1
			? { t: "divider" }
			: { t: "stack", children: [nest(depth - 1)] };
	ok(validateUi(doc(nest(16))).ok, "depth 16 is allowed");
	const r2 = validateUi(doc(nest(17)));
	equal(r2.ok, false);
	ok(!r2.ok && r2.errors.some((e) => e.includes("depth 17")));

	const big = doc({ t: "code", text: "x".repeat(19_000) });
	ok(validateUi(big).ok);
	const tooBig = doc({
		t: "stack",
		children: Array.from(
			{ length: 4 },
			() => ({ t: "code", text: "x".repeat(19_000) }),
		),
	});
	const r3 = validateUi(tooBig);
	equal(r3.ok, false);
	ok(!r3.ok && r3.errors.some((e) => e.includes("bytes")));

	const deepJson = doc({
		t: "button",
		text: "x",
		action: { id: "a", payload: nest(200) },
	});
	equal(validateUi(deepJson).ok, false);

	equal(measureUi(nest(5) as UiNode).depth, 5);
});

Deno.test("ui: non-JSON input and the host error chip", () => {
	const cyclic: Record<string, unknown> = { v: 1 };
	cyclic.root = cyclic;
	equal(validateUi(cyclic).ok, false);
	equal(validateUi(undefined).ok, false);
	const chip = uiOrErrorChip({
		v: 1,
		root: { t: "text", text: "x", style: "y" },
	}, "acme.no-secrets");
	deepStrictEqual(chip, errorChipDoc("acme.no-secrets"));
	deepStrictEqual(chip.root, {
		t: "error-chip",
		text: "acme.no-secrets: render failed",
	});
	equal(errorChipDoc("<script>").root.t, "error-chip");
	ok(!JSON.stringify(errorChipDoc("<b>x</b>")).includes("<"));
});

Deno.test("ui: action results", () => {
	ok(
		validateActionResult({ v: 1, toast: { tone: "success", text: "Enqueued" } })
			.ok,
	);
	ok(
		validateActionResult({ v: 1, navigate: "/acme/x", refresh: ["position"] })
			.ok,
	);
	ok(validateActionResult({ v: 1, render: doc({ t: "divider" }) }).ok);
	equal(validateActionResult({ v: 1, navigate: "//evil" }).ok, false);
	equal(validateActionResult({ v: 1, navigate: "https://e.com" }).ok, false);
	equal(validateActionResult({ v: 1, eval: "x" }).ok, false);
	equal(
		validateActionResult({
			v: 1,
			render: doc({ t: "text", text: "x", innerHTML: "y" }),
		}).ok,
		false,
	);
	equal(
		ActionResultSchema.safeParse({ v: 1, refresh: ["Bad Id"] }).success,
		false,
	);
	const input = clone({ v: 1, render: doc({ t: "divider" }) });
	const r = validateActionResult(input);
	ok(r.ok && r.result.render !== input.render);
});
