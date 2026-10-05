// The fixture monorepo and its conflict scenarios: expectations hold against
// stock `git merge-file`, and seeding produces branch lanes on one base.

import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import { isPolicyPath } from "@tartan/contract";
import {
	CONFLICT_SCENARIOS,
	createFakeArtifacts,
	derivedExpectation,
	isAncestor,
	MONOREPO_FILES,
	MONOREPO_TARTAN_FILES,
	readTextFiles,
	scenario,
	scenarioSnapshots,
	seedMonorepo,
	seedScenario,
} from "../src/index.ts";

const asText = (spec: unknown): string | null =>
	spec === undefined
		? null
		: typeof spec === "string"
		? spec
		: new TextDecoder().decode(
			spec instanceof Uint8Array
				? spec
				: typeof (spec as { content: unknown }).content === "string"
				? new TextEncoder().encode((spec as { content: string }).content)
				: (spec as { content: Uint8Array }).content,
		);

/** True when stock git's three-way merge of one path conflicts. */
const gitConflicts = async (
	base: string | null,
	a: string | null,
	b: string | null,
): Promise<boolean> => {
	if (a === b) return false;
	if (a === null || b === null) {
		// modify/delete conflicts unless the surviving side kept the base.
		return (a ?? b) !== base;
	}
	const dir = await Deno.makeTempDir({ prefix: "tartan-testkit-merge-" });
	try {
		await Deno.writeTextFile(`${dir}/base`, base ?? "");
		await Deno.writeTextFile(`${dir}/a`, a);
		await Deno.writeTextFile(`${dir}/b`, b);
		const out = await new Deno.Command("git", {
			args: ["merge-file", "-p", `${dir}/a`, `${dir}/base`, `${dir}/b`],
			stdout: "null",
			stderr: "null",
		}).output();
		return out.code !== 0;
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

Deno.test("scenario expectations match their scripts and stock git merge-file", async () => {
	for (const s of CONFLICT_SCENARIOS) {
		const derived = derivedExpectation(s);
		deepStrictEqual(
			derived.sharedPaths,
			[...s.expect.sharedPaths].sort(),
			s.id,
		);
		deepStrictEqual(derived.affected, s.expect.affected, s.id);
		const snap = scenarioSnapshots(s);
		const conflicts: string[] = [];
		for (const path of derived.sharedPaths) {
			const hit = await gitConflicts(
				asText(snap.base[path]),
				asText(snap.a[path]),
				asText(snap.b[path]),
			);
			if (hit) conflicts.push(path);
		}
		deepStrictEqual(conflicts, [...s.expect.conflictPaths], s.id);
	}
});

Deno.test("seedMonorepo writes the fixture; the master variant too", async () => {
	const fake = createFakeArtifacts();
	const main = await seedMonorepo(fake, "r-main");
	const master = await seedMonorepo(fake, "r-master", {
		defaultBranch: "master",
	});
	equal(main.head, master.head, "same content, same fixture clock, same SHA");
	deepStrictEqual(Object.keys(fake.inspect.refs("r-master")), [
		"refs/heads/master",
	]);
	const files = readTextFiles(
		fake.inspect.store("r-main"),
		(await (await fake.get("r-main")).readCommit(main.head))!.treeHash,
	);
	deepStrictEqual(
		Object.keys(files).sort(),
		Object.keys(MONOREPO_FILES).sort(),
	);
});

Deno.test("seedMonorepo with tartanConfig adds the demo's root package tartan beside cuenv's env.cue", async () => {
	const fake = createFakeArtifacts();
	const plain = await seedMonorepo(fake, "r-plain");
	const seeded = await seedMonorepo(fake, "r-config", { tartanConfig: true });
	notEqual(seeded.head, plain.head);
	const files = readTextFiles(
		fake.inspect.store("r-config"),
		(await (await fake.get("r-config")).readCommit(seeded.head))!.treeHash,
	);
	deepStrictEqual(
		Object.keys(files).sort(),
		[...Object.keys(MONOREPO_FILES), ...Object.keys(MONOREPO_TARTAN_FILES)]
			.sort(),
	);
	// Every config file is a root `.cue` file (a policy path, K13.3); the
	// CLI, not the forge, picks package tartan among them.
	for (const name of Object.keys(MONOREPO_TARTAN_FILES)) {
		ok(isPolicyPath(name), name);
	}
	ok(files["ci.cue"]!.startsWith("package tartan\n"));
	ok(files["review.cue"]!.startsWith("package tartan\n"));
	ok(files["env.cue"]!.startsWith("package cuenv\n"));
	// The plain fixture (whose commit ids the git captures pin) has none.
	ok(!Object.keys(MONOREPO_FILES).some((name) => isPolicyPath(name)));
});

Deno.test("seedScenario makes two branch lanes on one base", async () => {
	const fake = createFakeArtifacts();
	const s = await seedScenario(fake, "r-conf", scenario("same-hunk-conflict"));
	const refs = fake.inspect.refs("r-conf");
	equal(refs["refs/heads/main"], s.base);
	equal(refs[s.lanes.a.ref], s.lanes.a.head);
	equal(refs[s.lanes.b.ref], s.lanes.b.head);
	ok(s.lanes.a.ref.startsWith("refs/heads/lanes/ln_"));
	const store = fake.inspect.store("r-conf");
	ok(isAncestor(store, s.base, s.lanes.a.head));
	ok(isAncestor(store, s.base, s.lanes.b.head));
	const again = await seedScenario(
		createFakeArtifacts(),
		"r-conf",
		scenario("same-hunk-conflict"),
	);
	equal(again.lanes.a.head, s.lanes.a.head, "stable SHAs");
});
