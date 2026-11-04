// Static audit of the SPA sources: the renderer and
// views never use raw HTML sinks, object-spread bindings or style bindings,
// and the shell HTML is CSP-compliant (no inline scripts).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cspProblems, SHELL_CSP } from "../csp.ts";

// Not `new URL("..", import.meta.url)`: Vite's client transform rewrites it.
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..") + "/";

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});

const SOURCES = walk(join(WEB, "src")).filter((p) => /\.(vue|ts)$/.test(p));

const FORBIDDEN: [string, RegExp][] = [
	["v-html", /\bv-html\s*=/],
	["innerHTML/outerHTML assignment", /\.(?:inner|outer)HTML\b/],
	["insertAdjacentHTML", /insertAdjacentHTML/],
	["object-spread v-bind", /\bv-bind\s*=\s*"/],
	["style binding", /(?:\s:style|v-bind:style)\s*=/],
	["eval", /\beval\s*\(/],
	["new Function", /\bnew\s+Function\s*\(/],
	["document.write", /document\.write/],
	["javascript: URL", /["']javascript:/i],
	["target=_blank without rel", /target="_blank"(?![^>]*rel=)/],
];

describe("SPA source audit", () => {
	it("finds the sources", () => {
		expect(SOURCES.length).toBeGreaterThan(40);
	});

	for (const [label, pattern] of FORBIDDEN) {
		it(`has no ${label}`, () => {
			const hits = SOURCES.filter((file) =>
				pattern.test(readFileSync(file, "utf8"))
			)
				.map((file) => file.slice(WEB.length));
			expect(hits).toEqual([]);
		});
	}

	it("binds tartan-ui@1 node props one by one in UiNode.vue", () => {
		const source = readFileSync(join(WEB, "src/ui/UiNode.vue"), "utf8");
		expect(source).not.toMatch(/v-bind="/);
		expect(source).not.toMatch(/v-bind:\[/);
	});
});

describe("forge shell", () => {
	const shell = SOURCES.filter((p) =>
		p.includes("/src/forge/") || p.includes("/src/design-system/")
	);
	const read = (file: string): string => readFileSync(file, "utf8");
	const rel = (file: string): string => file.slice(WEB.length);

	it("finds the shell", () => {
		expect(shell.length).toBeGreaterThan(20);
	});

	it("reaches the data only through forge/data/index.ts", () => {
		const outside = SOURCES.filter((p) => !p.includes("/src/forge/data/"));
		const hits = outside.filter((file) =>
			/["'][^"']*forge\/data\/(?!index\.ts)|["'][^"']*\.\/data\/(?!index\.ts)/
				.test(read(file))
		).map(rel);
		expect(hits).toEqual([]);
	});

	it("has no leftovers of the old project model, name or mock controls", () => {
		const stale = [
			/\bt21\b/i,
			/projects\.cue/,
			/package forge/,
			/cueFile/,
			/RoleSelect/,
			/this is a mockup/i,
			/\/register/,
		];
		const hits = shell.filter((file) =>
			stale.some((pattern) => pattern.test(read(file)))
		).map(rel);
		expect(hits).toEqual([]);
	});

	it("keeps Panda's element rules and preflight scoped to the shell", () => {
		const config = readFileSync(join(WEB, "panda.config.ts"), "utf8");
		expect(config).toMatch(/preflight: \{ scope: "\[data-forge\]"/);
		const base = readFileSync(join(WEB, "src/styles/base.css"), "utf8");
		expect(base.indexOf("@layer tartan-base {")).toBeGreaterThan(-1);
		expect(base.indexOf("@layer tartan-base {")).toBeLessThan(
			base.indexOf("body {"),
		);
	});
});

describe("CSP", () => {
	it("uses the shell CSP", () => {
		expect(SHELL_CSP).toBe(
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
	});

	it("index.html has no inline script, handler or style", () => {
		expect(cspProblems(readFileSync(join(WEB, "index.html"), "utf8"))).toEqual(
			[],
		);
	});

	it("detects violations", () => {
		expect(cspProblems("<script>alert(1)</script>")).toEqual([
			"inline <script>",
		]);
		expect(cspProblems('<script type="module" src="/a.js"></script>')).toEqual(
			[],
		);
		expect(cspProblems('<div onclick="x()"></div>')).toEqual([
			"inline event handler attribute",
		]);
		expect(cspProblems('<div style="color:red"></div>')).toEqual([
			"style attribute",
		]);
	});

	it("the built index.html (when present) is CSP-compliant", () => {
		const built = join(WEB, "dist/index.html");
		let source: string | null = null;
		try {
			source = readFileSync(built, "utf8");
		} catch {
			source = null;
		}
		if (source !== null) expect(cspProblems(source)).toEqual([]);
	});
});
