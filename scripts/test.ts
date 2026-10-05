// Runs Deno unit tests (`*.test.ts`) over the given paths in one `deno test`
// invocation. Workers-runtime tests (`*.workers.test.ts`) are excluded; they run
// under vitest-pool-workers via `deno task test:workers`.
//
// Usage: deno task test [path ...] [-- deno-test-flags ...]
//   no paths: src/, packages/, extensions/, tools/ and scripts/
//   no test files found: prints a notice and exits 0

const DEFAULT_ROOTS = ["src", "packages", "extensions", "tools", "scripts"];
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".wrangler",
	"target",
	"coverage",
]);
const UNIT_TEST = /\.test\.(ts|tsx|mts)$/;
const WORKERS_TEST = /\.workers\.test\.(ts|tsx|mts)$/;

const isUnitTest = (name: string): boolean =>
	UNIT_TEST.test(name) && !WORKERS_TEST.test(name);

const stat = async (path: string): Promise<Deno.FileInfo | undefined> => {
	try {
		return await Deno.stat(path);
	} catch {
		return undefined;
	}
};

const walk = async (dir: string): Promise<string[]> => {
	const found: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await walk(path)));
		} else if (entry.isFile && isUnitTest(entry.name)) {
			found.push(path);
		}
	}
	return found;
};

const testFilesIn = async (path: string): Promise<string[]> => {
	const info = await stat(path);
	if (!info) return [];
	if (info.isFile) return isUnitTest(path) ? [path] : [];
	return info.isDirectory ? await walk(path) : [];
};

const splitArgs = (args: string[]): { paths: string[]; flags: string[] } => {
	const separator = args.indexOf("--");
	const before = separator === -1 ? args : args.slice(0, separator);
	const after = separator === -1 ? [] : args.slice(separator + 1);
	return {
		paths: before.filter((arg) => !arg.startsWith("-")),
		flags: [...before.filter((arg) => arg.startsWith("-")), ...after],
	};
};

const main = async (): Promise<number> => {
	const { paths, flags } = splitArgs(Deno.args);
	const explicit = paths.length > 0;
	const roots = explicit
		? paths.map((p) => p.replace(/\/+$/, ""))
		: DEFAULT_ROOTS;
	for (const root of explicit ? roots : []) {
		if (!(await stat(root))) {
			console.error(`test: path not found: ${root}`);
			return 1;
		}
	}
	const files = [...new Set((await Promise.all(roots.map(testFilesIn))).flat())]
		.sort();
	if (files.length === 0) {
		console.log(
			`test: no *.test.ts files under ${roots.join(", ")}, nothing to run`,
		);
		return 0;
	}
	const { code } = await new Deno.Command(Deno.execPath(), {
		args: ["test", "-A", ...flags, ...files],
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	return code;
};

Deno.exit(await main());
