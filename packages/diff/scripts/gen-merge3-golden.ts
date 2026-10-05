// Generates the merge3 golden fixture offline. Each case is a seeded random
// base text plus two independently edited sides; the expected result is what
// `git merge-file -p -L ours -L base -L theirs` prints and its exit status (the
// number of conflicts). The fixture is checked in; tests never run git.
//
// Usage (needs git on PATH):
//   deno run -A packages/diff/scripts/gen-merge3-golden.ts [count] [seed] [out]
// Writes packages/diff/test/fixtures/merge3-golden.json.

const OUT = Deno.args[2]
	? new URL(`file://${Deno.args[2]}`)
	: new URL("../test/fixtures/merge3-golden.json", import.meta.url);

/** mulberry32: a small seeded PRNG, so the cases are reproducible. */
const prng = (seed: number) => {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const WORDS = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"lane",
	"trunk",
	"merge",
	"probe",
	"radar",
	"weave",
	"tartan",
	"value",
];
// Lines that repeat in real source files (braces, blanks, returns).
const COMMON = ["\n", "}\n", "{\n", "  return x;\n", "  // ---\n", ")\n"];

type Rng = () => number;

const pick = <T>(rng: Rng, items: readonly T[]): T =>
	items[Math.floor(rng() * items.length)];
const int = (rng: Rng, lo: number, hi: number): number =>
	lo + Math.floor(rng() * (hi - lo + 1));

const freshLine = (rng: Rng, tag: string, n: number): string =>
	rng() < 0.2
		? pick(rng, COMMON)
		: `${tag}${n} ${pick(rng, WORDS)} ${pick(rng, WORDS)}\n`;

type Edit = {
	readonly at: number;
	readonly remove: number;
	readonly insert: readonly string[];
};

const randomEdit = (rng: Rng, length: number, tag: string): Edit => {
	const kind = rng();
	const at = int(rng, 0, Math.max(0, length - 1));
	const remove = kind < 0.3 ? 0 : int(rng, 1, Math.min(4, length - at));
	const inserts = kind > 0.85 ? 0 : int(rng, 1, 4);
	const insert = Array.from(
		{ length: inserts },
		(_, i) => freshLine(rng, tag, int(rng, 0, 999) + i),
	);
	return { at, remove: Math.max(0, remove), insert };
};

/** Applies edits (positions in the base) from the bottom up. */
const applyEdits = (
	base: readonly string[],
	edits: readonly Edit[],
): string[] => {
	const out = [...base];
	const sorted = [...edits].sort((x, y) => y.at - x.at);
	let floor = Infinity;
	for (const edit of sorted) {
		if (edit.at + edit.remove > floor) continue; // keep edits disjoint
		out.splice(edit.at, edit.remove, ...edit.insert);
		floor = edit.at;
	}
	return out;
};

const makeCase = (rng: Rng) => {
	const length = int(rng, 6, 24);
	const base = Array.from(
		{ length },
		(_, i) =>
			rng() < 0.25 ? pick(rng, COMMON) : `line ${i} ${pick(rng, WORDS)}\n`,
	);
	const oursEdits = Array.from(
		{ length: int(rng, 1, 3) },
		() => randomEdit(rng, length, "o"),
	);
	const theirsEdits = Array.from(
		{ length: int(rng, 1, 3) },
		() => randomEdit(rng, length, "t"),
	);
	const shape = rng();
	if (shape < 0.15) {
		// The same edit on both sides (no conflict for that region).
		theirsEdits.push(oursEdits[0]);
	} else if (shape < 0.45) {
		// Edits aimed at the same base lines (likely conflicts).
		const target = oursEdits[0].at;
		theirsEdits[0] = { ...randomEdit(rng, length, "t"), at: target };
	}
	return {
		base: base.join(""),
		ours: applyEdits(base, oursEdits).join(""),
		theirs: applyEdits(base, theirsEdits).join(""),
	};
};

const gitMergeFile = async (
	dir: string,
	files: { base: string; ours: string; theirs: string },
): Promise<{ exit: number; output: string }> => {
	for (const [name, text] of Object.entries(files)) {
		await Deno.writeTextFile(`${dir}/${name}`, text);
	}
	const { code, stdout, stderr } = await new Deno.Command("git", {
		args: [
			"merge-file",
			"-p",
			"-L",
			"ours",
			"-L",
			"base",
			"-L",
			"theirs",
			"ours",
			"base",
			"theirs",
		],
		cwd: dir,
		// No user or system config: `merge.conflictStyle` would change the markers.
		env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (code < 0 || code > 127) {
		throw new Error(
			`git merge-file failed: ${new TextDecoder().decode(stderr)}`,
		);
	}
	return { exit: code, output: new TextDecoder().decode(stdout) };
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `git diff --no-index -U0 base <side>` hunk headers as numbers. */
const gitHunks = async (dir: string, side: string) => {
	const { stdout } = await new Deno.Command("git", {
		args: ["diff", "--no-index", "--no-color", "-U0", "base", side],
		cwd: dir,
		env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "piped",
	}).output();
	return new TextDecoder().decode(stdout).split("\n").flatMap((line) => {
		const m = HUNK_HEADER.exec(line);
		return m
			? [{
				oldStart: Number(m[1]),
				oldLines: m[2] === undefined ? 1 : Number(m[2]),
				newStart: Number(m[3]),
				newLines: m[4] === undefined ? 1 : Number(m[4]),
			}]
			: [];
	});
};

const main = async () => {
	const count = Number(Deno.args[0] ?? 200);
	const seed = Number(Deno.args[1] ?? 20261002);
	const rng = prng(seed);
	const dir = await Deno.makeTempDir({ prefix: "tartan-merge3-" });
	try {
		const version = new TextDecoder().decode(
			(await new Deno.Command("git", { args: ["--version"], stdout: "piped" })
				.output()).stdout,
		).trim();
		const cases = [];
		for (let i = 0; i < count; i++) {
			const files = makeCase(rng);
			const merged = await gitMergeFile(dir, files);
			cases.push({
				id: i,
				...files,
				...merged,
				oursHunks: await gitHunks(dir, "ours"),
				theirsHunks: await gitHunks(dir, "theirs"),
			});
		}
		const fixture = {
			generator: "packages/diff/scripts/gen-merge3-golden.ts",
			git: version,
			seed,
			command: "git merge-file -p -L ours -L base -L theirs ours base theirs",
			hunks: "git diff --no-index -U0 base ours|theirs (hunk headers)",
			cases,
		};
		await Deno.writeTextFile(OUT, `${JSON.stringify(fixture, null, "\t")}\n`);
		const conflicted = cases.filter((c) => c.exit > 0).length;
		console.log(
			`wrote ${cases.length} cases (${conflicted} with conflicts) to ${OUT.pathname}`,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

if (import.meta.main) await main();
