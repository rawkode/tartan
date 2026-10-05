// Dispatcher for per-WP live acceptance scripts.
//
// Each WP owns exactly one `scripts/live/wpNN-<slug>.ts` (WP7a/WP7b use
// `wp07a-…`/`wp07b-…`). This file only finds that script and runs it with the
// remaining arguments; it never talks to Cloudflare itself. `all` runs every
// script in id order (the integrator's regression pass after a deploy) and
// fails if any of them fails.
//
// Usage:
//   deno task live -- --stage dev wp05 [script args ...]
//   deno task live -- --stage dev all
//   deno task live -- --list

const LIVE_DIR = new URL("./", import.meta.url);
const ID = /^wp\d{2}[ab]?$/;
const SCRIPT = /^(wp\d{2}[ab]?)-[a-z0-9-]+\.ts$/;

export type LiveScript = { readonly id: string; readonly file: string };

/** Live scripts among `names` (directory entries), sorted by file name. */
export const liveScripts = (names: readonly string[]): LiveScript[] =>
	names
		.filter((name) => !name.endsWith(".test.ts"))
		.flatMap((name) => {
			const match = SCRIPT.exec(name);
			return match ? [{ id: match[1], file: name }] : [];
		})
		.sort((a, b) => a.file.localeCompare(b.file));

export type Selection =
	| { readonly ok: true; readonly scripts: readonly LiveScript[] }
	| { readonly ok: false; readonly error: string };

/** Picks the scripts for `target` (`wpNN`, `wpNNa`, or `all`). */
export const selectScripts = (
	scripts: readonly LiveScript[],
	target: string,
): Selection => {
	const wanted = target.toLowerCase();
	if (wanted === "all") {
		return scripts.length > 0
			? { ok: true, scripts }
			: { ok: false, error: "no live scripts in scripts/live/ yet" };
	}
	if (!ID.test(wanted)) {
		return { ok: false, error: `not a WP id: ${target} (expected wpNN)` };
	}
	const found = scripts.filter((script) => script.id === wanted);
	if (found.length === 1) return { ok: true, scripts: found };
	const available = scripts.map((s) => s.file).join(", ") || "none";
	return {
		ok: false,
		error: found.length === 0
			? `no scripts/live/${wanted}-*.ts (available: ${available})`
			: `several scripts for ${wanted}: ${
				found.map((s) => s.file).join(", ")
			}; each WP owns exactly one`,
	};
};

/**
 * Splits CLI args into the target id and the args forwarded to the script.
 * A leading `--` (from `deno task live -- …`) is dropped.
 */
export const parseArgs = (
	raw: readonly string[],
): { readonly target?: string; readonly forward: readonly string[] } => {
	const args = raw[0] === "--" ? raw.slice(1) : raw;
	const index = args.findIndex((arg) =>
		arg.toLowerCase() === "all" || ID.test(arg.toLowerCase())
	);
	if (index < 0) return { forward: [...args] };
	return {
		target: args[index],
		forward: [...args.slice(0, index), ...args.slice(index + 1)],
	};
};

const readNames = async (): Promise<string[]> => {
	const names: string[] = [];
	for await (const entry of Deno.readDir(LIVE_DIR)) {
		if (entry.isFile) names.push(entry.name);
	}
	return names;
};

const run = async (
	script: LiveScript,
	forward: readonly string[],
): Promise<number> => {
	console.log(`live: ${script.file} ${forward.join(" ")}`.trimEnd());
	const { code } = await new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"-A",
			new URL(script.file, LIVE_DIR).pathname,
			...forward,
		],
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	return code;
};

const main = async (): Promise<number> => {
	const scripts = liveScripts(await readNames());
	if (Deno.args.includes("--list")) {
		for (const script of scripts) console.log(script.file);
		return 0;
	}
	const { target, forward } = parseArgs(Deno.args);
	if (target === undefined) {
		console.error(
			"usage: deno task live -- --stage <stage> <wpNN|all> [args ...]",
		);
		return 2;
	}
	const selection = selectScripts(scripts, target);
	if (!selection.ok) {
		console.error(`live: ${selection.error}`);
		return 2;
	}
	const failed: string[] = [];
	for (const script of selection.scripts) {
		if ((await run(script, forward)) !== 0) failed.push(script.file);
	}
	if (failed.length > 0) {
		console.error(`live: failed: ${failed.join(", ")}`);
		return 1;
	}
	return 0;
};

if (import.meta.main) Deno.exit(await main());
