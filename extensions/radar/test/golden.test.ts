// Golden path-level classification on WP8's fixture histories
// (`src/kernel/probe/test/fixtures/histories.json`, a real git repository
// recorded by WP8's generator): each lane's range is its `git diff
// --name-status <merge-base>...<head>`, each named pair is classified at
// path level, and every pair of fixture lanes is checked against the plain
// set intersection of their ranges (stacked lanes excepted).
//
// The fixture is read as data (not imported): extension files may import
// only the contract, ext-api and their own files.

import {
	conflicts,
	createRadar,
	equal,
	laneOpened,
	ok,
	pushed,
	putLane,
} from "./kit.ts";

type Fixture = {
	trunk: string[];
	lanes: Record<
		string,
		{ head: string; mergeBase: string; nameStatus: string[][] }
	>;
	pairs: { name: string; a: string; b: string; files: { path: string }[] }[];
	objects: { commits: Record<string, { parents: string[] }> };
};

const fixture: Fixture = JSON.parse(
	await Deno.readTextFile(
		new URL(
			"../../../src/kernel/probe/test/fixtures/histories.json",
			import.meta.url,
		),
	),
);

/** Paths a lane's range touches: both sides of a rename. */
const rangePaths = (name: string): string[] =>
	[...new Set(fixture.lanes[name].nameStatus.flatMap(([, ...p]) => p))].sort();

/** The commits of `head`'s range: every ancestor not on trunk (≤ 20, as push.diffed carries). */
const rangeCommits = (head: string): string[] => {
	const trunk = new Set(fixture.trunk);
	const out: string[] = [];
	const queue = [head];
	const seen = new Set<string>();
	while (queue.length > 0 && out.length < 20) {
		const sha = queue.shift()!;
		if (seen.has(sha) || trunk.has(sha)) continue;
		seen.add(sha);
		out.push(sha);
		queue.push(...(fixture.objects.commits[sha]?.parents ?? []));
	}
	return out;
};

/** Path-level severity of each named fixture pair (M2 refines with hunks/diff3). */
const GOLDEN: Record<string, { severity: string; m2: string }> = {
	"same-line": { severity: "same_file", m2: "textual" },
	"adjacent": { severity: "same_file", m2: "adjacent" },
	"same-file-disjoint": { severity: "same_file", m2: "same_file" },
	"rename": { severity: "same_file", m2: "same_file" },
	"delete-vs-modify": { severity: "same_file", m2: "textual" },
	"binary": { severity: "same_file", m2: "textual" },
	"different-bases": { severity: "same_file", m2: "textual" },
};

const load = async (names: readonly string[]) => {
	const r = createRadar();
	const ids = new Map<string, string>();
	names.forEach((name, i) => {
		const lane = putLane(r.world, {
			n: i + 1,
			base: fixture.lanes[name].mergeBase,
		});
		ids.set(name, lane.id);
	});
	for (const name of names) {
		await r.deliver(laneOpened(r.world.lanes.get(ids.get(name)!)!));
	}
	for (const name of names) {
		const l = fixture.lanes[name];
		await r.deliver(pushed(r.world, ids.get(name)!, {
			after: l.head,
			rangeBase: l.mergeBase,
			paths: rangePaths(name),
			commits: rangeCommits(l.head),
		}));
	}
	return { r, ids };
};

Deno.test("golden: every named WP8 fixture pair is same_file at path level on exactly its shared paths", async () => {
	equal(fixture.pairs.map((p) => p.name).sort(), Object.keys(GOLDEN).sort());
	for (const pair of fixture.pairs) {
		const { r, ids } = await load([pair.a, pair.b]);
		const fileRows = conflicts(r, "open").filter((c) =>
			!c.path.startsWith("project:")
		);
		equal(
			fileRows.map((c) => [c.severity, c.path]),
			pair.files.map((f) => [GOLDEN[pair.name].severity, f.path]).sort(),
			pair.name,
		);
		for (const c of fileRows) {
			equal([c.a, c.b].sort(), [ids.get(pair.a), ids.get(pair.b)].sort());
		}
	}
});

Deno.test("golden: a stacked fixture lane (stack-b on stack-a) is not in conflict with its base lane", async () => {
	ok(
		rangeCommits(fixture.lanes["stack-b"].head).includes(
			fixture.lanes["stack-a"].head,
		),
		"stack-b's range carries stack-a's head",
	);
	const { r } = await load(["stack-a", "stack-b"]);
	equal(conflicts(r, "open").filter((c) => c.severity === "same_file"), []);
});

Deno.test("golden: across all fixture lanes, same_file rows are exactly the range intersections", async () => {
	// `orphan` has no merge base with trunk (K17 truncates it): no range.
	const names = Object.keys(fixture.lanes)
		.filter((n) => fixture.lanes[n].nameStatus !== undefined)
		.sort();
	ok(names.length >= 20, `fixture lanes with a range: ${names.length}`);
	const { r, ids } = await load(names);
	const byId = new Map([...ids].map(([n, id]) => [id, n]));
	const actual = conflicts(r, "open")
		.filter((c) => c.severity === "same_file")
		.map((c) =>
			[byId.get(c.a)!, byId.get(c.b)!].sort().join(" ") + " " + c.path
		)
		.sort();
	const stacked = (x: string, y: string) =>
		rangeCommits(fixture.lanes[x].head).includes(fixture.lanes[y].head) ||
		rangeCommits(fixture.lanes[y].head).includes(fixture.lanes[x].head);
	const expected: string[] = [];
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const [x, y] = [names[i], names[j]];
			if (stacked(x, y)) continue;
			const ys = new Set(rangePaths(y));
			for (const p of rangePaths(x)) {
				if (ys.has(p)) expected.push(`${[x, y].sort().join(" ")} ${p}`);
			}
		}
	}
	equal(actual, expected.sort());
	ok(
		expected.length > 20,
		`a meaningful number of overlaps (${expected.length})`,
	);
});
