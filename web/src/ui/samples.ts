// One valid sample per `tartan-ui@1` node type (the `/-/ui` gallery, the
// component tests and the contract parity test all use this table, so a new
// node type cannot be added without a sample).

import type { UiNode, UiNodeType } from "./nodeTypes.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 2, 9, 0, 0);

export const NODE_SAMPLES: { readonly [K in UiNodeType]: UiNode } = {
	stack: {
		t: "stack",
		gap: 1,
		children: [{ t: "text", text: "First" }, { t: "text", text: "Second" }],
	},
	row: {
		t: "row",
		children: [
			{ t: "badge", text: "lane", tone: "info" },
			{ t: "badge", text: "ci passed", tone: "success" },
		],
	},
	grid: {
		t: "grid",
		cols: 3,
		children: [
			{ t: "stat", label: "Active lanes", value: 12 },
			{ t: "stat", label: "Conflicts avoided", value: 4, delta: 2 },
			{ t: "stat", label: "Landed today", value: 31, delta: -3 },
		],
	},
	section: {
		t: "section",
		title: "Section title",
		children: [{ t: "text", text: "Section body." }],
	},
	card: {
		t: "card",
		title: "Card title",
		children: [{ t: "text", text: "Card body." }],
	},
	tabs: {
		t: "tabs",
		tabs: [
			{ label: "Overview", body: { t: "text", text: "Overview tab." } },
			{ label: "Details", body: { t: "text", text: "Details tab." } },
		],
	},
	divider: { t: "divider" },
	heading: { t: "heading", text: "A heading", level: 3 },
	text: { t: "text", text: "Plain text <b>stays text</b>.", tone: "neutral" },
	markdown: {
		t: "markdown",
		md:
			"Some **strong** and _emphasis_ with `code`, a [link](/acme) and an [external link](https://example.com/docs).\n\n- one\n- two\n\n```ts\nconst x = 1;\n```",
	},
	code: { t: "code", text: "git push origin HEAD:refs/heads/main", lang: "sh" },
	badge: { t: "badge", text: "shadow", tone: "warning" },
	label: { t: "label", text: "Label text" },
	avatar: { t: "avatar", principal: "u_owner" },
	icon: { t: "icon", name: "lane" },
	link: { t: "link", text: "Open the repo", href: "/acme/platform/router" },
	empty: {
		t: "empty",
		text: "Nothing here yet",
		body: "Lanes appear when agents claim work.",
	},
	progress: { t: "progress", value: 7, max: 10, label: "Checks" },
	kv: {
		t: "kv",
		items: [
			{ k: "Lane", v: "ln_01" },
			{ k: "State", v: { t: "badge", text: "open", tone: "success" } },
		],
	},
	stat: { t: "stat", label: "p50 land time", value: 42, unit: "s", delta: -5 },
	alert: {
		t: "alert",
		tone: "warning",
		title: "2 lanes edit this file",
		body: { t: "text", text: "Coordinate before you submit." },
	},
	button: {
		t: "button",
		text: "Re-run checks",
		tone: "info",
		action: { id: "ci.rerun", payload: { change: "zkqv" } },
	},
	menu: {
		t: "menu",
		text: "More",
		items: [
			{
				text: "Archive",
				action: { id: "lane.archive", confirm: "Archive this lane?" },
			},
			{ text: "Sync", action: { id: "lane.sync" } },
		],
	},
	form: {
		t: "form",
		fields: [
			{ t: "input", name: "title", label: "Title", value: "", required: true },
			{
				t: "select",
				name: "priority",
				label: "Priority",
				options: ["low", "normal", "high"],
				value: "normal",
			},
			{ t: "checkbox", name: "notify", label: "Notify reviewers", value: true },
		],
		submit: { text: "Create", action: { id: "work.create" } },
	},
	input: { t: "input", name: "query", label: "Search" },
	textarea: { t: "textarea", name: "note", label: "Note", value: "" },
	select: {
		t: "select",
		name: "mode",
		label: "Mode",
		options: [{ value: "enforce", label: "Enforce" }, {
			value: "shadow",
			label: "Shadow",
		}],
	},
	checkbox: { t: "checkbox", name: "agree", label: "I understand" },
	table: {
		t: "table",
		columns: ["Project", "Status", "Duration"],
		rows: [
			["services/api", { t: "badge", text: "passed", tone: "success" }, 74],
			["apps/web", { t: "badge", text: "running", tone: "info" }, 12],
		],
	},
	list: {
		t: "list",
		items: [{ t: "text", text: "Item one" }, { t: "text", text: "Item two" }],
	},
	timeline: {
		t: "timeline",
		items: [
			{ at: T0, text: "Lane opened", actor: "claude-1", tone: "info" },
			{ at: T0 + HOUR, text: "Pushed 3 commits", actor: "claude-1" },
			{ at: T0 + 2 * HOUR, text: "Landed", tone: "success" },
		],
	},
	diff: {
		t: "diff",
		source: "lane ln_01 vs main",
		patch:
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n",
	},
	board: {
		t: "board",
		columns: [
			{ id: "todo", title: "To do" },
			{ id: "doing", title: "Doing", wip: 2 },
			{ id: "done", title: "Done" },
		],
		cards: [
			{ id: "w1", col: "todo", title: "Add rate limits", badges: ["api"] },
			{
				id: "w2",
				col: "doing",
				title: "Fix flaky test",
				href: "/acme/platform/router/-/work/w2",
			},
		],
		moveAction: { id: "board.move" },
	},
	matrix: {
		t: "matrix",
		rows: [{ id: "a", label: "claude-1" }, { id: "b", label: "codex-1" }],
		cols: [{ id: "x", label: "router.ts" }, { id: "y", label: "auth.ts" }],
		cells: [
			{ r: "a", c: "x", level: 4, label: "4" },
			{ r: "b", c: "x", level: 2, action: { id: "radar.open" } },
			{ r: "b", c: "y", level: 0 },
		],
	},
	sparkline: { t: "sparkline", values: [3, 5, 4, 8, 6, 9, 12, 10] },
};
