// The markdown subset parser (no raw HTML; the tree renders as text nodes).

import { describe, expect, it } from "vitest";
import {
	MARKDOWN_MAX,
	parseInline,
	parseMarkdown,
} from "../src/ui/markdown.ts";

describe("markdown blocks", () => {
	it("parses headings, paragraphs, lists, quotes, code and rules", () => {
		const blocks = parseMarkdown(
			"# Title\n\nPara one\ncontinues.\n\n- a\n- b\n\n3. x\n4. y\n\n> quote\n> more\n\n```ts\nconst a = 1;\n```\n\n---",
		);
		expect(blocks.map((b) => b.t)).toEqual([
			"h",
			"p",
			"ul",
			"ol",
			"quote",
			"code",
			"hr",
		]);
		expect(blocks[0]).toEqual({
			t: "h",
			level: 1,
			c: [{ t: "text", v: "Title" }],
		});
		expect(blocks[1]).toEqual({
			t: "p",
			c: [{ t: "text", v: "Para one continues." }],
		});
		expect(blocks[3]).toMatchObject({ t: "ol", start: 3 });
		expect(blocks[5]).toEqual({ t: "code", lang: "ts", v: "const a = 1;" });
	});

	it("keeps raw HTML as text", () => {
		expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
			{ t: "p", c: [{ t: "text", v: "<script>alert(1)</script>" }] },
		]);
	});

	it("handles an unclosed fence and deep quotes without throwing", () => {
		expect(parseMarkdown("```\ncode")).toEqual([{
			t: "code",
			lang: "",
			v: "code",
		}]);
		const deep = parseMarkdown("> > > > > > deep");
		expect(JSON.stringify(deep)).toContain("deep");
	});

	it("truncates input at the contract maximum", () => {
		const blocks = parseMarkdown("a".repeat(MARKDOWN_MAX + 500));
		expect(JSON.stringify(blocks).length).toBeLessThan(MARKDOWN_MAX + 100);
	});
});

describe("markdown inlines", () => {
	it("parses code, strong, emphasis, strikethrough and links", () => {
		expect(parseInline("a `b` **c** _d_ ~~e~~ [f](/g)")).toEqual([
			{ t: "text", v: "a " },
			{ t: "code", v: "b" },
			{ t: "text", v: " " },
			{ t: "strong", c: [{ t: "text", v: "c" }] },
			{ t: "text", v: " " },
			{ t: "em", c: [{ t: "text", v: "d" }] },
			{ t: "text", v: " " },
			{ t: "del", c: [{ t: "text", v: "e" }] },
			{ t: "text", v: " " },
			{ t: "link", href: "/g", c: [{ t: "text", v: "f" }] },
		]);
	});

	it("does not treat snake_case as emphasis and honours escapes", () => {
		expect(parseInline("snake_case_name \\*not em\\*")).toEqual([
			{ t: "text", v: "snake_case_name *not em*" },
		]);
	});

	it("turns images into their alt text", () => {
		expect(parseInline("![alt text](https://x/y.png)")).toEqual([
			{ t: "text", v: "alt text" },
		]);
	});

	it("keeps the link target as data for the renderer to classify", () => {
		expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({
			t: "link",
			href: "javascript:alert(1",
		});
	});

	it("renders hard line breaks", () => {
		expect(parseInline("a  \nb")).toEqual([
			{ t: "text", v: "a" },
			{ t: "br" },
			{ t: "text", v: "b" },
		]);
	});

	it("bounds nesting", () => {
		const nested = "**".repeat(40) + "x" + "**".repeat(40);
		expect(() => parseInline(nested)).not.toThrow();
	});
});
