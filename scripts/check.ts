// Type-checks every TypeScript unit with `deno check`, one unit per invocation.
//
// A unit is `src/`, each `packages/<name>/`, each `extensions/<name>/`, each
// `tools/<name>/`, each `containers/<name>/`, the shared workerd test helpers
// (`test/`), the e2e suites and their support code (`e2e/`, without its run
// output `e2e/.e2e/`), and the repo tooling (`scripts/` plus root config
// files).
// Every `.ts` file in a unit is passed as an entrypoint so stub modules that
// nothing imports yet are still checked. Empty or missing units are skipped.
// `web/` is checked by `deno task check:web` (vue-tsc), not here.
//
// Usage: deno task check [path ...]   (paths narrow the run to matching units)

const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".wrangler",
	"target",
	"coverage",
	".e2e",
]);
const SOURCE = /\.(ts|tsx|mts)$/;
const ROOT_CONFIG_FILES = ["vitest.config.ts"];

type Unit = { readonly name: string; readonly files: readonly string[] };

const isDir = async (path: string): Promise<boolean> => {
	try {
		return (await Deno.stat(path)).isDirectory;
	} catch {
		return false;
	}
};

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await Deno.stat(path)).isFile;
	} catch {
		return false;
	}
};

const walk = async (dir: string): Promise<string[]> => {
	if (!(await isDir(dir))) return [];
	const found: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await walk(path)));
		} else if (entry.isFile && SOURCE.test(entry.name)) {
			found.push(path);
		}
	}
	return found.sort();
};

const childDirs = async (dir: string): Promise<string[]> => {
	if (!(await isDir(dir))) return [];
	const names: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			names.push(`${dir}/${entry.name}`);
		}
	}
	return names.sort();
};

const unitFor = async (name: string): Promise<Unit> => ({
	name,
	files: await walk(name),
});

const toolingUnit = async (): Promise<Unit> => {
	const configs: string[] = [];
	for (const file of ROOT_CONFIG_FILES) {
		if (await isFile(file)) configs.push(file);
	}
	return { name: "scripts", files: [...configs, ...(await walk("scripts"))] };
};

const discoverUnits = async (): Promise<Unit[]> => {
	const grouped = [
		...(await childDirs("packages")),
		...(await childDirs("extensions")),
		...(await childDirs("tools")),
		...(await childDirs("containers")),
	];
	const units = [
		await unitFor("src"),
		...(await Promise.all(grouped.map(unitFor))),
		await unitFor("test"),
		await unitFor("e2e"),
		await toolingUnit(),
	];
	return units.filter((unit) => unit.files.length > 0);
};

const normalise = (path: string): string =>
	path.replace(/^\.\//, "").replace(/\/+$/, "");

const selectUnits = (units: Unit[], filters: string[]): Unit[] => {
	if (filters.length === 0) return units;
	const wanted = filters.map(normalise);
	return units
		.map((unit) => ({
			name: unit.name,
			files: unit.files.filter((file) =>
				wanted.some((w) => file === w || file.startsWith(`${w}/`))
			),
		}))
		.filter((unit) => unit.files.length > 0);
};

const denoCheck = async (unit: Unit): Promise<boolean> => {
	console.log(`check ${unit.name} (${unit.files.length} files)`);
	const { code } = await new Deno.Command(Deno.execPath(), {
		args: ["check", "--quiet", ...unit.files],
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	return code === 0;
};

const main = async (): Promise<number> => {
	const units = selectUnits(await discoverUnits(), Deno.args);
	if (units.length === 0) {
		console.log("check: no TypeScript units found, nothing to check");
		return 0;
	}
	const failed: string[] = [];
	for (const unit of units) {
		if (!(await denoCheck(unit))) failed.push(unit.name);
	}
	if (failed.length > 0) {
		console.error(`check: failed in ${failed.join(", ")}`);
		return 1;
	}
	console.log(`check: ${units.length} unit(s) passed`);
	return 0;
};

Deno.exit(await main());
