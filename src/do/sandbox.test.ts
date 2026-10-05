// The TartanSandbox class neither overrides
// `alarm()` nor uses the WP0 timer helper, because `@cloudflare/containers`
// owns its alarm (it re-arms itself and drives `keepAlive`); its watchdog runs
// on `Container.schedule()`. A source lint (Deno); the workerd side checks
// the prototype in `src/index.workers.test.ts`.

import { deepStrictEqual, equal } from "node:assert/strict";

const SANDBOX = new URL("../kernel/runs/sandbox.ts", import.meta.url);

/** Source without comments, so prose may name what code may not do. */
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** What the sandbox source must never contain (code only). */
const SANDBOX_FORBIDDEN: readonly { name: string; re: RegExp }[] = [
	{ name: "an alarm() member", re: /\balarm\s*\(/ },
	{ name: "setAlarm", re: /\bsetAlarm\b/ },
	{ name: "the timers module", re: /do\/timers(?:\.ts)?["']/ },
	{ name: "createTimers", re: /\bcreateTimers\b/ },
	{ name: "the _timers table", re: /\b_timers\b|ensureTimersTable/ },
];

const sandboxViolations = (source: string): string[] => {
	const code = stripComments(source);
	return SANDBOX_FORBIDDEN.filter(({ re }) => re.test(code)).map(({ name }) =>
		name
	);
};

Deno.test("TartanSandbox neither overrides alarm() nor imports the timer helper (0.4)", async () => {
	deepStrictEqual(sandboxViolations(await Deno.readTextFile(SANDBOX)), []);
});

Deno.test("the sandbox lint catches each forbidden form and ignores comments", () => {
	equal(
		sandboxViolations(
			[
				'import { createTimers } from "../../do/timers.ts";',
				"class S { override async alarm() { this.ctx.storage.setAlarm(1); } }",
				"ensureTimersTable(sql);",
			].join("\n"),
		).length,
		SANDBOX_FORBIDDEN.length,
	);
	deepStrictEqual(
		sandboxViolations(
			"// never override alarm() or use do/timers.ts\n/* setAlarm */",
		),
		[],
	);
});
