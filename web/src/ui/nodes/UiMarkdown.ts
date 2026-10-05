// `markdown` node: the parsed tree (`../markdown.ts`) as VNodes. Every string
// becomes a text child, so Vue escapes it; no `innerHTML`, no `v-html`.
// Markdown headings sit below the page and slot headings (`#` → h3).

import { defineComponent, h, type PropType, type VNode } from "vue";
import { RouterLink } from "vue-router";
import { classifyHref, linkLocation } from "../links.ts";
import { type Block, type Inline, parseMarkdown } from "../markdown.ts";

const inline = (nodes: readonly Inline[]): (VNode | string)[] =>
	nodes.map((node): VNode | string => {
		switch (node.t) {
			case "text":
				return node.v;
			case "code":
				return h("code", node.v);
			case "strong":
				return h("strong", inline(node.c));
			case "em":
				return h("em", inline(node.c));
			case "del":
				return h("del", inline(node.c));
			case "br":
				return h("br");
			case "link": {
				const target = classifyHref(node.href);
				const to = linkLocation(target);
				if (to === null) {
					return h(
						"span",
						{ class: "ui-link ui-link--refused", title: "link refused" },
						inline(node.c),
					);
				}
				return h(
					RouterLink,
					{
						to,
						class: target.kind === "external"
							? "ui-link ui-link--external"
							: "ui-link",
					},
					() => inline(node.c),
				);
			}
		}
	});

const HEADINGS = ["h3", "h4", "h5", "h6", "h6", "h6"] as const;

const block = (node: Block): VNode => {
	switch (node.t) {
		case "p":
			return h("p", inline(node.c));
		case "h":
			return h(HEADINGS[node.level - 1] ?? "h6", inline(node.c));
		case "code":
			return h("pre", { class: "ui-code__pre" }, [
				h("code", node.lang ? { "data-lang": node.lang } : {}, node.v),
			]);
		case "quote":
			return h("blockquote", node.c.map(block));
		case "ul":
			return h("ul", node.items.map((item) => h("li", inline(item))));
		case "ol":
			return h(
				"ol",
				node.start === 1 ? {} : { start: node.start },
				node.items.map((item) => h("li", inline(item))),
			);
		case "hr":
			return h("hr");
	}
};

export default defineComponent({
	name: "UiMarkdown",
	props: {
		md: { type: String as PropType<string>, required: true },
	},
	setup: (props) => () =>
		h("div", { class: "ui-markdown" }, parseMarkdown(props.md).map(block)),
});
