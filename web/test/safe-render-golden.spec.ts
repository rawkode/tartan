// The safe-rendering golden test:
// nodes carrying `innerHTML`, `style`, `onClick`, `href` on non-link nodes,
// and `//evil` hrefs are rejected by the contract's `validateUi()`, AND when
// fed straight to the renderer (as if the kernel had let them through) no
// injected element, attribute, listener or URL reaches the rendered tree.

import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import { createMemoryHistory } from "vue-router";
import { describe, expect, it } from "vitest";
import { validateUi } from "@tartan/contract/ui.ts";
import { createAppRouter } from "../src/router/index.ts";
import { NODE_SAMPLES } from "../src/ui/samples.ts";
import { UI_NODE_TYPES } from "../src/ui/nodeTypes.ts";
import UiNode from "../src/ui/UiNode.vue";
import { findAll, html, type TestElement } from "./support/renderer.ts";
import { mountNode } from "./support/ui.ts";

const EVIL = "evil.example";
const PAYLOAD_IMG = `<img src=x onerror=alert(1)>`;

const injections = (
	node: Record<string, unknown>,
): [string, Record<string, unknown>][] => [
	["innerHTML", { ...node, innerHTML: PAYLOAD_IMG }],
	["style", { ...node, style: `background:url(https://${EVIL}/x)` }],
	["onClick", { ...node, onClick: `fetch('https://${EVIL}')` }],
	...(node["t"] === "link"
		? [
			["href //evil", { ...node, href: `//${EVIL}/x` }] as [
				string,
				Record<string, unknown>,
			],
		]
		: [
			["href on non-link", { ...node, href: `https://${EVIL}/x` }] as [
				string,
				Record<string, unknown>,
			],
		]),
];

/** Everything an injection could leave behind in the rendered tree. */
const leaks = (root: TestElement): string[] => {
	const found: string[] = [];
	for (const el of findAll(root, () => true)) {
		for (const [name, value] of Object.entries(el.attrs)) {
			if (name === "style") found.push(`style attr on <${el.tag}>`);
			if (/^on/i.test(name)) found.push(`${name} attr on <${el.tag}>`);
			if (/innerhtml/i.test(name)) found.push(`innerHTML attr on <${el.tag}>`);
			if (value.includes(EVIL)) found.push(`${name}=${value} on <${el.tag}>`);
			if (/javascript:/i.test(value)) found.push(`javascript: in ${name}`);
		}
		for (const [event, listener] of Object.entries(el.listeners)) {
			if (typeof listener !== "function") {
				found.push(`non-function ${event} listener`);
			}
		}
		if (el.tag === "img" && !(el.attrs["src"] ?? "").startsWith("/-/avatar/")) {
			found.push(`img src=${el.attrs["src"]}`);
		}
		if (el.tag === "script" || el.tag === "iframe" || el.tag === "object") {
			found.push(`<${el.tag}>`);
		}
	}
	return found;
};

const ssr = async (node: unknown): Promise<string> => {
	const router = createAppRouter({ history: createMemoryHistory() });
	await router.push("/-/ui");
	const app = createSSRApp({ render: () => h(UiNode, { node }) });
	app.use(router);
	return renderToString(app);
};

describe("safe-render golden: injected props", () => {
	for (const t of UI_NODE_TYPES) {
		const sample = NODE_SAMPLES[t] as unknown as Record<string, unknown>;
		for (const [label, injected] of injections(sample)) {
			it(`${t} + ${label}: rejected by validateUi and inert in the renderer`, async () => {
				expect(validateUi({ v: 1, root: injected }).ok).toBe(false);
				const { root } = await mountNode(injected);
				expect(leaks(root)).toEqual([]);
				expect(html(root)).not.toContain(EVIL);
				const markup = await ssr(injected);
				expect(markup).not.toContain(EVIL);
				expect(markup).not.toMatch(/<img[^>]*src="x"/);
				expect(markup).not.toMatch(/\sstyle=/);
				expect(markup).not.toMatch(/\sonclick=/i);
				expect(markup).not.toContain("onerror");
			});
		}
	}

	it("rejects and neutralizes injections inside nested objects", async () => {
		const nested: unknown[] = [
			{
				t: "tabs",
				tabs: [{ label: "x", body: { t: "text", text: "y" }, onClick: "x" }],
			},
			{ t: "kv", items: [{ k: "a", v: "b", style: "x" }] },
			{
				t: "menu",
				text: "m",
				items: [{ text: "a", action: { id: "a" }, href: `//${EVIL}` }],
			},
			{
				t: "board",
				columns: [{ id: "a", title: "A", innerHTML: PAYLOAD_IMG }],
				cards: [],
			},
			{
				t: "board",
				columns: [{ id: "a", title: "A" }],
				cards: [{ id: "c", col: "a", title: "C", href: `//${EVIL}` }],
			},
			{
				t: "matrix",
				rows: [],
				cols: [],
				cells: [{ r: "a", c: "b", level: 1, style: "x" }],
			},
			{ t: "timeline", items: [{ at: 1, text: "x", href: `https://${EVIL}` }] },
			{
				t: "form",
				fields: [],
				submit: { text: "go", action: { id: "a" }, onClick: "x" },
			},
			{ t: "button", text: "b", action: { id: "a", href: `https://${EVIL}` } },
		];
		for (const node of nested) {
			expect(validateUi({ v: 1, root: node }).ok).toBe(false);
			const { root } = await mountNode(node);
			expect(leaks(root)).toEqual([]);
			expect(html(root)).not.toContain(EVIL);
			expect(findAll(root, (el) => "data-ui-fallback" in el.attrs))
				.toHaveLength(1);
		}
	});
});

describe("safe-render golden: links", () => {
	const BAD_HREFS = [
		`//${EVIL}/x`,
		`/\\${EVIL}/x`,
		`/\t/${EVIL}/x`,
		`/\n/${EVIL}/x`,
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		`http://${EVIL}/x`,
		`data:text/html,<script>alert(1)</script>`,
		`https://user:pass@${EVIL}/x`,
		` https://${EVIL}`,
	];

	for (const href of BAD_HREFS) {
		it(`refuses link href ${JSON.stringify(href)}`, async () => {
			const node = { t: "link", text: "click", href };
			const { root } = await mountNode(node);
			expect(findAll(root, (el) => el.tag === "a")).toHaveLength(0);
			expect(html(root)).not.toContain(EVIL);
			expect(html(root)).not.toMatch(/javascript:|data:text/i);
		});
	}

	it("rejects //evil hrefs in validateUi (link and board card)", () => {
		expect(
			validateUi({ v: 1, root: { t: "link", text: "x", href: `//${EVIL}` } })
				.ok,
		)
			.toBe(false);
		expect(
			validateUi({
				v: 1,
				root: {
					t: "board",
					columns: [{ id: "a", title: "A" }],
					cards: [{ id: "c", col: "a", title: "C", href: `//${EVIL}` }],
				},
			}).ok,
		).toBe(false);
	});

	it("routes https links through the leaving interstitial, never directly", async () => {
		const { root } = await mountNode({
			t: "link",
			text: "docs",
			href: `https://${EVIL}/docs`,
		});
		const [a] = findAll(root, (el) => el.tag === "a");
		const url = new URL(a!.attrs["href"] ?? "", "https://forge.test");
		expect(url.origin).toBe("https://forge.test");
		expect(url.pathname).toBe("/-/leaving");
		expect(url.searchParams.get("to")).toBe(`https://${EVIL}/docs`);
	});

	it("keeps markdown raw HTML as text and refuses its unsafe links", async () => {
		const md = [
			"<script>alert(1)</script>",
			PAYLOAD_IMG,
			`[a](//${EVIL}/x) [b](javascript:alert(1)) [c](/\\${EVIL}) ![i](https://${EVIL}/i.png)`,
			`<a href="https://${EVIL}">raw</a>`,
		].join("\n\n");
		const { root } = await mountNode({ t: "markdown", md });
		expect(
			findAll(root, (el) => ["script", "img", "a", "iframe"].includes(el.tag)),
		)
			.toEqual([]);
		expect(leaks(root)).toEqual([]);
		const markup = await ssr({ t: "markdown", md });
		expect(markup).not.toMatch(/<script|<img|<a\s/);
		expect(markup).toContain("&lt;script&gt;");
	});

	it("never renders an avatar URL other than /-/avatar/<principal>", async () => {
		for (
			const principal of [
				"../../x",
				`https://${EVIL}/a.png`,
				"u_ok?x=1",
				"U_UPPER",
			]
		) {
			const { root } = await mountNode({ t: "avatar", principal });
			expect(findAll(root, (el) => el.tag === "img")).toHaveLength(0);
		}
		const { root } = await mountNode({ t: "avatar", principal: "u_ok" });
		expect(findAll(root, (el) => el.tag === "img")[0]!.attrs["src"]).toBe(
			"/-/avatar/u_ok",
		);
	});
});
