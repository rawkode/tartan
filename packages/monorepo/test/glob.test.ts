// Glob matching never backtracks: globs come from pushed
// repository content, so a crafted one must not burn CPU. The NFA matcher
// agrees with the RegExp translation it replaced on a generated corpus.

import { equal, ok } from "node:assert/strict";
import { globMatcher, normaliseGlob } from "../src/glob.ts";

/** The RegExp translation the NFA replaced (reference only, backtracking). */
const referenceSource = (pattern: string): string => {
	const escapeRe = (ch: string) => /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				const slashAfter = pattern[i + 2] === "/";
				const atSegmentStart = i === 0 || pattern[i - 1] === "/";
				if (atSegmentStart && slashAfter) {
					re += "(?:[^/]+/)*";
					i += 2;
				} else if (atSegmentStart && i + 2 === pattern.length) {
					re += ".*";
					i += 1;
				} else {
					re += "[^/]*";
					i += 1;
				}
			} else re += "[^/]*";
		} else if (ch === "?") re += "[^/]";
		else if (ch === "[") {
			const end = pattern.indexOf("]", i + 1);
			if (end === -1) re += "\\[";
			else {
				const body = pattern.slice(i + 1, end).replace(/^!/, "^");
				re += `[${body.replaceAll("\\", "\\\\")}]`;
				i = end;
			}
		} else if (ch === "{") {
			const end = pattern.indexOf("}", i + 1);
			if (end === -1) re += "\\{";
			else {
				re += `(?:${
					pattern.slice(i + 1, end).split(",").map(referenceSource).join("|")
				})`;
				i = end;
			}
		} else re += escapeRe(ch);
	}
	return re;
};
const reference = (pattern: string) => {
	const re = new RegExp(`^${referenceSource(normaliseGlob(pattern))}$`);
	return (path: string) => re.test(path);
};

Deno.test("the NFA glob matcher agrees with the RegExp translation on a generated corpus", () => {
	let seed = 42;
	const rand = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	const patternParts = [
		"a",
		"b",
		"/",
		"*",
		"**",
		"**/",
		"?",
		"[ab]",
		"[!a]",
		"{a,b/c}",
		".",
		"x",
		"-",
	];
	const pathParts = ["a", "b", "c", "/", "x", ".", "-", "ab", "a/b"];
	const patterns = [
		"packages/*",
		"apps/**",
		"**/test/**",
		"{apps,libs}/*",
		"./crates/*/",
		"**/*.lock",
		"a/**/b",
		"**",
		"*",
		"[",
		"{a",
	];
	for (let i = 0; i < 400; i++) {
		let p = "";
		for (let j = 1 + rand(6); j > 0; j--) {
			p += patternParts[rand(patternParts.length)];
		}
		patterns.push(p);
	}
	const paths = ["", "a", "a/b", "a/b/c", "packages/a", "x.lock", "a/x/b"];
	for (let i = 0; i < 200; i++) {
		let p = "";
		for (let j = 1 + rand(6); j > 0; j--) {
			p += pathParts[rand(pathParts.length)];
		}
		paths.push(p);
	}
	for (const pattern of patterns) {
		const nfa = globMatcher(pattern);
		const re = reference(pattern);
		for (const path of paths) {
			equal(nfa(path), re(path), `${pattern} vs ${path}`);
		}
	}
});

Deno.test("crafted globs from repository content match in linear time", () => {
	const started = performance.now();
	ok(
		!globMatcher("**/**/**/**/**/**/**/**/**/**/**/**/x")(
			`${"a/".repeat(26)}y`,
		),
	);
	ok(!globMatcher("*a*a*a*a*a*a*a*a*a*a*a*a*b")("a".repeat(40)));
	ok(globMatcher("*a*a*a*a*a*a*a*a*a*a*a*a*b")(`${"a".repeat(40)}b`));
	ok(!globMatcher("{*a,*a}*{*a,*a}*{*a,*a}*{*a,*a}*b")("a".repeat(4000)));
	const ms = performance.now() - started;
	ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});
