// The `@tartan/*` workspace mapping lives in three places (AGENTS.md
// "Dependencies"): deno.json `imports`, tsconfig.json `paths` and the
// vitest.config.ts aliases. They must name the same packages, and every one
// must exist under packages/ (a package mapped in all three that never
// existed went unnoticed before).

import { deepStrictEqual, ok } from "node:assert/strict";

const root = new URL("../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

/** JSON with whole-line `//` comments and trailing commas (tsconfig.json). */
const jsonc = (text: string): Record<string, unknown> =>
	JSON.parse(
		text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
	);

const names = (keys: Iterable<string>): string[] =>
	[
		...new Set(
			[...keys].flatMap((key) => {
				const m = /^@tartan\/([a-z0-9-]+)(?:\/\*?)?$/.exec(key);
				return m ? [m[1]] : [];
			}),
		),
	].sort();

Deno.test("deno.json, tsconfig.json and vitest.config.ts map the same @tartan packages, and each exists", async () => {
	const deno = names(Object.keys(JSON.parse(await read("deno.json")).imports));
	const compiler = jsonc(await read("tsconfig.json")).compilerOptions as {
		paths: Record<string, unknown>;
	};
	const tsconfig = names(Object.keys(compiler.paths));
	const vitest = await read("vitest.config.ts");
	const list = /const TARTAN_PACKAGES = \[([^\]]*)\]/.exec(vitest)?.[1] ?? "";
	const aliases = [...list.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
	deepStrictEqual(tsconfig, deno, "tsconfig.json paths");
	deepStrictEqual(aliases, deno, "vitest.config.ts TARTAN_PACKAGES");
	for (const name of deno) {
		const entry = new URL(`packages/${name}/src/index.ts`, root);
		ok(
			await Deno.stat(entry).then(() => true, () => false),
			`packages/${name}/src/index.ts exists`,
		);
	}
});

Deno.test("AGENTS.md names the vitest projects vitest.config.ts defines, and no other", async () => {
	const vitest = await read("vitest.config.ts");
	const table = /const PROJECTS[^=]*= \{([\s\S]*?)\n\};/.exec(vitest)?.[1] ??
		"";
	const projects = [...table.matchAll(/^\t"?([a-z-]+)"?: \[/gm)].map((m) =>
		m[1]
	);
	ok(projects.length > 10, "the PROJECTS table was read");
	const agents = await read("AGENTS.md");
	const layout =
		/vitest projects partition them([\s\S]*?)\n\n/.exec(agents)?.[1] ??
			"";
	for (const project of projects) {
		ok(layout.includes(`\`${project}\``), `AGENTS.md names ${project}`);
	}
	// A project AGENTS.md lists that vitest does not run (an empty `wasm`
	// project passed with no tests, and looked like WASM evidence).
	for (const listed of ["wasm"]) {
		ok(
			!layout.includes(`\`${listed}\` (`) || projects.includes(listed),
			`AGENTS.md lists ${listed}, which vitest.config.ts does not define`,
		);
	}
});

Deno.test("the design overview lists every migration range the contract declares", async () => {
	const overview = await read("docs/design/OVERVIEW.md");
	const { MIGRATION_RANGES } = await import(
		"../packages/contract/src/do/common.ts"
	);
	const table = /\| Durable Object \| Module ranges +\|([\s\S]*?)\n\n/.exec(
		overview,
	)?.[1] ?? "";
	const rowOf = (label: string) =>
		table.split("\n").find((line) => line.startsWith(`| ${label} `)) ?? "";
	const labels: Record<string, string> = {
		forge: "`ForgeDO`",
		repo: "`RepoDO`",
		inbox: "`InboxDO`",
		bus: "`BusDO`",
		ext: "`ExtensionDO`",
	};
	const [lo, hi] = MIGRATION_RANGES.common;
	ok(rowOf("every object").includes(`${lo}–${hi}`), `common ${lo}–${hi}`);
	for (const [dob, label] of Object.entries(labels)) {
		const row = rowOf(label);
		ok(row, `${label} has a row in the design overview`);
		const modules =
			MIGRATION_RANGES[dob as keyof typeof MIGRATION_RANGES] as Record<
				string,
				readonly [number, number]
			>;
		for (const [module, [lo, hi]] of Object.entries(modules)) {
			ok(
				row.includes(`${lo}–${hi}`),
				`${dob}.${module} ${lo}–${hi} in the design overview`,
			);
		}
	}
	ok(
		Object.keys(MIGRATION_RANGES).every((dob) =>
			dob === "common" || dob in labels
		),
		"every Durable Object of MIGRATION_RANGES is checked",
	);
});
