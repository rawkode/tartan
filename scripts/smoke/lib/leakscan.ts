// Leak scan for smoke evidence: fails on Artifacts tokens
// in any version (`art_v1_…`, the live `art_v2_x_…?expires=…`), unredacted
// capability paths (only `/-/cap/<redacted>` may appear), credentials in URLs
// or Authorization headers, smoke keys, and on `.git/config` or `.dev.vars`
// files inside the scanned tree. Run it before sharing evidence:
//
//   deno run -A scripts/smoke/lib/leakscan.ts [dir ...]   (default: scripts/smoke/evidence)

import { CAP_PATH_SECRET_RE } from "@tartan/contract";

export type Leak = {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
};

const RULES: readonly { readonly rule: string; readonly re: RegExp }[] = [
	// A token's secret part (`art_v2_x_<40 hex>`, `art_v1_<40 hex>`); the
	// redacted forms (`art_v2_x_<redacted>`) do not match.
	{ rule: "artifacts-token", re: /art_v\d+_(?:[a-z]_)?[0-9a-f]{20,}/i },
	{ rule: "capability-path", re: CAP_PATH_SECRET_RE },
	{ rule: "url-credentials", re: /https?:\/\/[^\s/:@"']+:[^\s/@"']+@/ },
	{
		rule: "authorization-header",
		re: /authorization:\s*(?:bearer|basic)\s+[A-Za-z0-9+/=._~-]{16,}/i,
	},
	{
		rule: "smoke-secret",
		re: /(?:SMOKE_KEY|LANE_CAP_KEY|GIT_PASSWORD)=(?!$|\s|<)\S+/,
	},
];

export const FORBIDDEN_FILES: readonly RegExp[] = [
	/(^|\/)\.git\/config$/,
	/(^|\/)\.dev\.vars[^/]*$/,
];

export const scanTextForLeaks = (file: string, text: string): Leak[] =>
	text.split("\n").flatMap((line, i) =>
		RULES.filter(({ re }) => re.test(line)).map(({ rule }) => ({
			file,
			line: i + 1,
			rule,
		}))
	);

const walk = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	try {
		for await (const e of Deno.readDir(dir)) {
			const path = `${dir}/${e.name}`;
			if (e.isDirectory) out.push(...(await walk(path)));
			else if (e.isFile) out.push(path);
		}
	} catch (err) {
		if (!(err instanceof Deno.errors.NotFound)) throw err;
	}
	return out;
};

export const scanDirs = async (dirs: readonly string[]): Promise<Leak[]> => {
	const leaks: Leak[] = [];
	for (const dir of dirs) {
		for (const file of await walk(dir)) {
			if (FORBIDDEN_FILES.some((re) => re.test(file))) {
				leaks.push({ file, line: 0, rule: "forbidden-file" });
				continue;
			}
			const bytes = await Deno.readFile(file);
			if (bytes.subarray(0, 8192).includes(0)) continue;
			leaks.push(...scanTextForLeaks(file, new TextDecoder().decode(bytes)));
		}
	}
	return leaks;
};

if (import.meta.main) {
	const dirs = Deno.args.length > 0 ? Deno.args : ["scripts/smoke/evidence"];
	const leaks = await scanDirs(dirs);
	for (const l of leaks) console.error(`${l.file}:${l.line}: ${l.rule}`);
	console.log(
		leaks.length === 0
			? `leakscan: clean (${dirs.join(", ")})`
			: `leakscan: ${leaks.length} leak(s)`,
	);
	Deno.exit(leaks.length === 0 ? 0 : 1);
}
