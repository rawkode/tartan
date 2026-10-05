// The facade-disposal guard for the exthost and caps wiring: a DO facade
// getter's stub must be disposed, so a chained call
// (`forge().registry().inForce(…)`, the stub left to the garbage collector)
// is refused here. Open the facade
// through `withRpc` or `disposingFacade` (`src/do/dispose.ts`) instead.
// `deps.registry()`, `deps.tree()` and `deps.identity()` are ApiDeps views
// that already dispose per call, so they are allowed.

import { deepStrictEqual } from "node:assert/strict";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["src/kernel/exthost", "src/kernel/caps"];
const GETTERS = "identity|tree|registry|events|slots|core|probe|runs|land";
const CHAINED = new RegExp(
	`(?<!\\bdeps)\\.(?:${GETTERS})\\(\\)\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(`,
	"g",
);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const sources = async function* (dir: string): AsyncGenerator<string> {
	for await (const entry of Deno.readDir(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory) yield* sources(path);
		else if (
			entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
		) yield path;
	}
};

/** Comments out of the way (line and block), so prose may show the bad form. */
const code = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Chained facade calls in `text`, as `line: match`. */
export const chainedFacadeCalls = (text: string): string[] => {
	const stripped = code(text);
	return [...stripped.matchAll(CHAINED)].map((m) =>
		`${stripped.slice(0, m.index).split("\n").length}: ${
			m[0].replace(/\s+/g, "")
		}`
	);
};

Deno.test("the guard catches chained facade calls and allows disposing forms", () => {
	deepStrictEqual(
		chainedFacadeCalls(
			[
				"const a = forge().registry().inForce(id);",
				"const b = env.REPO.getByName(n).core()",
				"\t.getLane(id);",
				"withRpc(() => forge().tree(), (t) => t.node(id));",
				"await deps.registry().installation(id);",
				"// forge().events().head() in a comment",
			].join("\n"),
		),
		["1: .registry().inForce(", "2: .core().getLane("],
	);
});

Deno.test("exthost and caps never chain a call on an undisposed facade stub", async () => {
	const found: string[] = [];
	for (const root of ROOTS) {
		for await (const path of sources(join(repoRoot, root))) {
			for (const hit of chainedFacadeCalls(await Deno.readTextFile(path))) {
				found.push(`${relative(repoRoot, path)}:${hit}`);
			}
		}
	}
	deepStrictEqual(found, []);
});
