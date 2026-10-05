// `when` expressions: the grammar, and failing closed.

import { equal } from "node:assert/strict";
import type { WhenContext } from "@tartan/contract";
import { evalWhen } from "./when.ts";

const repoDev: WhenContext = {
	viewer: { role: 30 },
	node: { kind: "repo" },
	entity: { kind: "change" },
};
const groupGuest: WhenContext = {
	viewer: { role: 10 },
	node: { kind: "group" },
};

Deno.test("when: comparisons, boolean logic and parentheses", () => {
	const cases: [string | undefined, WhenContext, boolean][] = [
		[undefined, groupGuest, true],
		["", groupGuest, true],
		["node.kind == 'repo'", repoDev, true],
		["node.kind == 'repo'", groupGuest, false],
		['node.kind != "repo"', groupGuest, true],
		["viewer.role >= 30", repoDev, true],
		["viewer.role >= 30", groupGuest, false],
		["viewer.role > 10 && node.kind == 'repo'", repoDev, true],
		["node.kind == 'group' || viewer.role >= 40", repoDev, false],
		["!(node.kind == 'group')", repoDev, true],
		["entity.kind == 'change'", repoDev, true],
		["entity.kind == 'change'", groupGuest, false],
		["(viewer.role < 20) && !(entity.kind == 'lane')", groupGuest, true],
	];
	for (const [expr, ctx, expected] of cases) {
		equal(evalWhen(expr, ctx), expected, String(expr));
	}
});

Deno.test("when: malformed or unknown expressions fail closed", () => {
	for (
		const expr of [
			"node.kind ==",
			"node.kind == 'repo",
			"viewer.secret == 1",
			"constructor.name == 'Object'",
			"node.kind = 'repo'",
			"alert(1)",
			"node.kind == 'repo' extra",
			"((node.kind == 'repo')",
		]
	) {
		equal(evalWhen(expr, repoDev), false, expr);
	}
});
