// Component tests for every tartan-ui@1 node type, plus the invalid-node
// fallbacks (component tests for every UI node type,
// including the invalid-node fallback).

import { describe, expect, it } from "vitest";
import type { FileDiff } from "@tartan/contract/git.ts";
import DiffFiles from "../src/components/DiffFiles.vue";
import { diffLines } from "../src/ui/diffLines.ts";
import { NODE_SAMPLES } from "../src/ui/samples.ts";
import { UI_NODE_TYPES, type UiNodeType } from "../src/ui/nodeTypes.ts";
import UiDocument from "../src/ui/UiDocument.vue";
import { h } from "vue";
import {
	byAttr,
	byTag,
	byText,
	check,
	choose,
	click,
	findAll,
	flush,
	mount,
	submit,
	type TestElement,
	text,
	type,
} from "./support/renderer.ts";
import { mountNode } from "./support/ui.ts";

const hasClass = (el: TestElement, name: string): boolean =>
	(el.attrs["class"] ?? "").split(/\s+/).includes(name);

const byClass = (root: TestElement, name: string): TestElement[] =>
	findAll(root, (el) => hasClass(el, name));

const fallbacks = (root: TestElement): TestElement[] =>
	byAttr(root, "data-ui-fallback");

type Expectation = (
	root: TestElement,
	calls: { action: { id: string }; payload?: unknown }[],
) => void | Promise<void>;

const EXPECT: Record<UiNodeType, Expectation> = {
	stack: (root) => {
		const [box] = byClass(root, "ui-box--stack");
		expect(box).toBeDefined();
		expect(byTag(box!, "p").map(text)).toEqual(["First", "Second"]);
		expect(hasClass(box!, "ui-gap-1")).toBe(true);
	},
	row: (root) => {
		expect(byClass(root, "ui-box--row")).toHaveLength(1);
		expect(byClass(root, "chip").map(text)).toEqual(["lane", "ci passed"]);
	},
	grid: (root) => {
		const [grid] = byClass(root, "ui-box--grid");
		expect(hasClass(grid!, "ui-cols-3")).toBe(true);
		expect(byClass(root, "ui-stat")).toHaveLength(3);
	},
	section: (root) => {
		const [section] = byTag(root, "section");
		expect(text(byTag(section!, "h3")[0]!)).toBe("Section title");
	},
	card: (root) => {
		const [card] = byTag(root, "article");
		expect(text(byTag(card!, "h3")[0]!)).toBe("Card title");
	},
	tabs: async (root) => {
		const tabs = byAttr(root, "role", "tab");
		expect(tabs.map(text)).toEqual(["Overview", "Details"]);
		expect(tabs[0]!.attrs["aria-selected"]).toBe("true");
		expect(text(byAttr(root, "role", "tabpanel")[0]!)).toBe("Overview tab.");
		click(tabs[1]!);
		await flush();
		expect(text(byAttr(root, "role", "tabpanel")[0]!)).toBe("Details tab.");
	},
	divider: (root) => {
		expect(byTag(root, "hr")).toHaveLength(1);
	},
	heading: (root) => {
		expect(text(byTag(root, "h3")[0]!)).toBe("A heading");
	},
	text: (root) => {
		const [p] = byTag(root, "p");
		expect(text(p!)).toBe("Plain text <b>stays text</b>.");
		expect(byTag(root, "b")).toHaveLength(0);
	},
	markdown: (root) => {
		const [md] = byClass(root, "ui-markdown");
		expect(text(byTag(md!, "strong")[0]!)).toBe("strong");
		expect(text(byTag(md!, "em")[0]!)).toBe("emphasis");
		expect(byTag(md!, "li").map(text)).toEqual(["one", "two"]);
		expect(text(byTag(md!, "pre")[0]!)).toBe("const x = 1;");
		const [internal, external] = byTag(md!, "a");
		expect(internal!.attrs["href"]).toBe("/acme");
		const leaving = new URL(
			external!.attrs["href"] ?? "",
			"https://forge.test",
		);
		expect(leaving.pathname).toBe("/-/leaving");
		expect(leaving.searchParams.get("to")).toBe("https://example.com/docs");
	},
	code: (root) => {
		expect(text(byTag(root, "pre")[0]!)).toBe(
			"git push origin HEAD:refs/heads/main",
		);
		expect(text(byTag(root, "figcaption")[0]!)).toBe("sh");
	},
	badge: (root) => {
		const [chip] = byClass(root, "chip");
		expect(hasClass(chip!, "chip--warning")).toBe(true);
		expect(text(chip!)).toBe("shadow");
	},
	label: (root) => {
		expect(text(byClass(root, "ui-label")[0]!)).toBe("Label text");
	},
	avatar: (root) => {
		const [img] = byTag(root, "img");
		expect(img!.attrs["src"]).toBe("/-/avatar/u_owner");
		expect(img!.attrs["alt"]).toBe("");
	},
	icon: (root) => {
		const [svg] = byTag(root, "svg");
		expect(svg!.attrs["aria-label"]).toBe("lane");
		expect(byTag(svg!, "path")[0]!.attrs["d"]).toBeTruthy();
	},
	link: (root) => {
		const [a] = byTag(root, "a");
		expect(a!.attrs["href"]).toBe("/acme/platform/router");
		expect(text(a!)).toBe("Open the repo");
	},
	empty: (root) => {
		expect(byTag(byClass(root, "ui-empty")[0]!, "p").map(text)).toEqual([
			"Nothing here yet",
			"Lanes appear when agents claim work.",
		]);
	},
	progress: (root) => {
		const [bar] = byTag(root, "progress");
		expect(bar!.attrs["value"]).toBe("7");
		expect(bar!.attrs["max"]).toBe("10");
		expect(text(byTag(root, "label")[0]!)).toBe("Checks70%");
	},
	kv: (root) => {
		expect(byTag(root, "dt").map(text)).toEqual(["Lane", "State"]);
		expect(text(byTag(root, "dd")[0]!)).toBe("ln_01");
		expect(byClass(byTag(root, "dd")[1]!, "chip--success")).toHaveLength(1);
	},
	stat: (root) => {
		expect(text(byClass(root, "ui-stat__value")[0]!)).toBe("42s");
		const [delta] = byClass(root, "chip");
		expect(text(delta!)).toBe("−5");
		expect(hasClass(delta!, "chip--danger")).toBe(true);
	},
	alert: (root) => {
		const [alert] = byAttr(root, "role", "status");
		expect(text(alert!)).toContain("2 lanes edit this file");
		expect(text(alert!)).toContain("Coordinate before you submit.");
	},
	button: (root, calls) => {
		const [button] = byTag(root, "button");
		expect(text(button!)).toBe("Re-run checks");
		click(button!);
		expect(calls).toEqual([{
			action: { id: "ci.rerun", payload: { change: "zkqv" } },
		}]);
	},
	menu: (root, calls) => {
		expect(text(byTag(root, "summary")[0]!)).toBe("More");
		const items = byClass(root, "ui-menu__item");
		expect(items.map(text)).toEqual(["Archive", "Sync"]);
		click(items[0]!);
		expect(calls[0]?.action).toEqual({
			id: "lane.archive",
			confirm: "Archive this lane?",
		});
	},
	form: async (root, calls) => {
		const [input] = byTag(root, "input").filter((i) =>
			i.attrs["name"] === "title"
		);
		type(input!, "Rate limits");
		await flush();
		submit(byTag(root, "form")[0]!);
		await flush();
		expect(calls).toEqual([{
			action: { id: "work.create" },
			payload: { title: "Rate limits", priority: "normal", notify: true },
		}]);
	},
	input: (root) => {
		const [label] = byTag(root, "label");
		const [input] = byTag(root, "input");
		expect(text(label!)).toBe("Search");
		expect(label!.attrs["for"]).toBe(input!.attrs["id"]);
		expect(input!.attrs["name"]).toBe("query");
	},
	textarea: (root) => {
		expect(byTag(root, "textarea")[0]!.attrs["name"]).toBe("note");
	},
	select: async (root) => {
		const [select] = byTag(root, "select");
		expect(byTag(select!, "option").map(text)).toEqual(["Enforce", "Shadow"]);
		choose(select!, "Shadow");
		await flush();
		expect(select!.attrs["value"]).toBe("1");
	},
	checkbox: async (root) => {
		const [box] = byTag(root, "input");
		expect(box!.attrs["type"]).toBe("checkbox");
		check(box!);
		await flush();
		expect(box!.checked).toBe(true);
	},
	table: (root) => {
		expect(byTag(root, "th").map(text)).toEqual([
			"Project",
			"Status",
			"Duration",
		]);
		const rows = byTag(byTag(root, "tbody")[0]!, "tr");
		expect(rows).toHaveLength(2);
		expect(byTag(rows[0]!, "td").map(text)).toEqual([
			"services/api",
			"passed",
			"74",
		]);
	},
	list: (root) => {
		expect(byTag(root, "li").map(text)).toEqual(["Item one", "Item two"]);
	},
	timeline: (root) => {
		const items = byTag(root, "li");
		expect(items).toHaveLength(3);
		expect(byTag(items[0]!, "time")[0]!.attrs["datetime"]).toBe(
			"2026-10-02T09:00:00.000Z",
		);
		expect(text(items[0]!)).toContain("claude-1");
	},
	diff: (root) => {
		const lineText = (row: TestElement) => text(byClass(row, "diff__text")[0]!);
		expect(byClass(root, "diff__line--add").map(lineText)).toEqual([
			"added: +const b = 3;",
		]);
		expect(byClass(root, "diff__line--del").map(lineText)).toEqual([
			"removed: -const b = 2;",
		]);
		expect(byClass(root, "diff__line--hunk")).toHaveLength(1);
	},
	board: async (root, calls) => {
		expect(byTag(root, "h3").map((h3) => text(h3).split(" ")[0])).toEqual([
			"To",
			"Doing",
			"Done",
		]);
		const links = byTag(root, "a");
		expect(links.map((a) => a.attrs["href"])).toEqual([
			"/acme/platform/router/-/work/w2",
		]);
		const [select] = byTag(root, "select");
		choose(select!, "done");
		await flush();
		expect(calls).toEqual([{
			action: { id: "board.move" },
			payload: { card: "w1", from: "todo", to: "done" },
		}]);
	},
	matrix: (root, calls) => {
		expect(byTag(root, "th").map(text)).toEqual([
			"router.ts",
			"auth.ts",
			"claude-1",
			"codex-1",
		]);
		expect(byClass(root, "ui-heat-4")).toHaveLength(1);
		const [button] = byTag(root, "button");
		click(button!);
		expect(calls).toEqual([{ action: { id: "radar.open" } }]);
	},
	sparkline: (root) => {
		const [svg] = byTag(root, "svg");
		expect(svg!.attrs["aria-label"]).toBe(
			"trend of 8: min 3, max 12, last 10",
		);
		expect(byTag(svg!, "polyline")[0]!.attrs["points"]?.split(" "))
			.toHaveLength(8);
	},
};

describe("tartan-ui@1 renderer: every node type", () => {
	it("has an expectation for every node type", () => {
		expect(Object.keys(EXPECT).sort()).toEqual([...UI_NODE_TYPES].sort());
	});

	for (const t of UI_NODE_TYPES) {
		it(`renders ${t}`, async () => {
			const { root, calls, unmount } = await mountNode(NODE_SAMPLES[t]);
			expect(fallbacks(root)).toEqual([]);
			await EXPECT[t](root, calls);
			unmount();
		});
	}
});

describe("tartan-ui@1 renderer: fallbacks (the page never breaks)", () => {
	const unsupported = async (node: unknown): Promise<TestElement> => {
		const { root } = await mountNode(node);
		const [chip] = fallbacks(root);
		expect(chip?.attrs["data-ui-fallback"]).toBe("unsupported");
		expect(text(chip!)).toBe("unsupported node");
		return root;
	};

	it("renders an unknown node type as a chip", async () => {
		await unsupported({ t: "iframe", src: "https://evil.example" });
	});

	it("renders a node missing a required prop as a chip", async () => {
		await unsupported({ t: "text" });
		await unsupported({ t: "link", text: "x" });
		await unsupported({ t: "alert", title: "no tone" });
	});

	it("renders a node with an undeclared prop as a chip", async () => {
		await unsupported({ t: "text", text: "x", innerHTML: "<b>x</b>" });
		await unsupported({
			t: "board",
			columns: [],
			cards: [{ id: "a", col: "b", title: "c", onClick: "x" }],
		});
	});

	it("renders non-objects as chips", async () => {
		await unsupported(null);
		await unsupported("text");
		await unsupported([{ t: "text", text: "x" }]);
	});

	it("renders the host error chip as a danger chip", async () => {
		const { root } = await mountNode({
			t: "error-chip",
			text: "acme.radar: render failed",
		});
		const [chip] = fallbacks(root);
		expect(chip!.attrs["data-ui-fallback"]).toBe("error");
		expect(hasClass(chip!, "chip--danger")).toBe(true);
		expect(text(chip!)).toBe("acme.radar: render failed");
	});

	it("keeps valid siblings when one child is invalid", async () => {
		const { root } = await mountNode({
			t: "stack",
			children: [
				{ t: "text", text: "before" },
				{ t: "text", text: "bad", style: "x" },
				{ t: "text", text: "after" },
			],
		});
		expect(byTag(root, "p").map(text)).toEqual(["before", "after"]);
		expect(fallbacks(root)).toHaveLength(1);
	});

	it("stops below the host depth limit (16)", async () => {
		let node: unknown = { t: "text", text: "deep" };
		for (let i = 0; i < 16; i += 1) node = { t: "stack", children: [node] };
		const { root } = await mountNode(node);
		expect(byTag(root, "p")).toHaveLength(0);
		expect(fallbacks(root)).toHaveLength(1);
		let ok: unknown = { t: "text", text: "deep" };
		for (let i = 0; i < 15; i += 1) ok = { t: "stack", children: [ok] };
		const shallow = await mountNode(ok);
		expect(byTag(shallow.root, "p").map(text)).toEqual(["deep"]);
	});

	it("renders buttons disabled without a host action runner", async () => {
		const { root } = await mountNode(NODE_SAMPLES.button, { runner: false });
		expect("disabled" in byTag(root, "button")[0]!.attrs).toBe(true);
	});

	it("renders a whole document, or a chip for anything that is not one", () => {
		const doc = mount({
			render: () =>
				h(UiDocument, { doc: { v: 1, root: { t: "text", text: "hi" } } }),
		});
		expect(text(doc.root)).toBe("hi");
		const bad = mount({
			render: () => h(UiDocument, { doc: { v: 2, root: {} } }),
		});
		expect(text(bad.root)).toBe("unsupported document");
	});

	it("fetches a repo diff through the host diff source, filtered by paths", async () => {
		const requests: unknown[] = [];
		const { root } = await mountNode(
			{ t: "diff", repo: "acme/r", base: "a", head: "b", paths: ["x.ts"] },
			{
				diff: (request) => {
					requests.push(request);
					return Promise.resolve([
						{
							path: "x.ts",
							change: "modified",
							binary: false,
							additions: 1,
							deletions: 0,
							hunks: [],
							patch: "@@ -1 +1 @@\n+x",
						},
						{
							path: "y.ts",
							change: "modified",
							binary: false,
							additions: 1,
							deletions: 0,
							hunks: [],
						},
					]);
				},
			},
		);
		expect(requests).toEqual([{
			repo: "acme/r",
			base: "a",
			head: "b",
			paths: ["x.ts"],
		}]);
		expect(byTag(byTag(root, "summary")[0]!, "code").map(text)).toEqual([
			"x.ts",
		]);
		expect(byTag(root, "summary")).toHaveLength(1);
		expect("open" in byTag(root, "details")[0]!.attrs).toBe(true);
		expect(byText(root, "td", "+x")).not.toBeNull();
	});
});

describe("DiffFiles: a missing patch says why only as the kernel did", () => {
	const file = (extra: Partial<FileDiff>): FileDiff => ({
		path: "f.md",
		change: "modified",
		binary: false,
		additions: 1,
		deletions: 1,
		hunks: [],
		...extra,
	});
	const shown = (files: FileDiff[]): string[] =>
		byTag(mount(DiffFiles, { props: { files } }).root, "details").map((d) =>
			byTag(d, "p").map(text).join(" ") ||
			String(
				findAll(d, (el) => (el.attrs["class"] ?? "").includes("diff__line "))
					.length,
			)
		);

	it("shows lines when there is a patch, and each reason otherwise", () => {
		expect(shown([
			file({ path: "a.md", patch: "@@ -1 +1 @@\n-a\n+b\n" }),
			file({
				path: "b.md",
				change: "renamed",
				oldPath: "old.md",
				patch:
					"diff --git a/old.md b/b.md\nrename from old.md\nrename to b.md\n",
			}),
			file({ path: "c.md", patchOmitted: "too-large" }),
			file({ path: "d.md", patchOmitted: "budget" }),
			file({ path: "e.md", patchOmitted: "path-level" }),
			file({ path: "f.md" }),
			file({ path: "g.png", binary: true }),
		])).toEqual([
			"3",
			"No content changes.",
			"Patch too large to show inline.",
			"Not shown: this diff is too large to show every patch inline.",
			"Only the file name is known for this change.",
			"No patch available.",
			"Binary file not shown.",
		]);
	});

	it("reads `--- x` and `+++ x` inside a hunk as content, not headers", () => {
		const lines = diffLines(
			[
				"diff --git a/n.md b/n.md",
				"--- a/n.md",
				"+++ b/n.md",
				"@@ -1,2 +1,2 @@",
				"--- a removed line that began with two dashes",
				"+++ an added line that began with two pluses",
				" kept",
			].join("\n"),
		);
		expect(lines.map((l) => l.kind)).toEqual([
			"meta",
			"meta",
			"meta",
			"hunk",
			"del",
			"add",
			"context",
		]);
		expect(lines.map((l) => [l.oldNo, l.newNo])).toEqual([
			[null, null],
			[null, null],
			[null, null],
			[null, null],
			[1, null],
			[null, 1],
			[2, 2],
		]);
	});
});
