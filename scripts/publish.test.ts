import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { isPublicEmail } from "./check-public.ts";
import {
	identityEnv,
	parseIdentity,
	parsePublishArgs,
	planSnapshot,
	REVIEWED_DIR,
	snapshotMessage,
} from "./publish.ts";
import { createTempRepo } from "./testing/git-repo.ts";

Deno.test("publish: arguments default to main on origin without a push", () => {
	deepStrictEqual(parsePublishArgs([]), {
		ref: "main",
		remote: "origin",
		push: false,
		identity: null,
	});
	deepStrictEqual(
		parsePublishArgs([
			"--ref",
			"v1",
			"--remote",
			"up",
			"--identity",
			"A <a@users.noreply.github.com>",
			"--push",
		]),
		{
			ref: "v1",
			remote: "up",
			push: true,
			identity: "A <a@users.noreply.github.com>",
		},
	);
	deepStrictEqual(parsePublishArgs(["--", "--push"]).push, true);
	throws(() => parsePublishArgs(["--ref"]), /needs a value/);
	throws(() => parsePublishArgs(["--ref", "--push"]), /needs a value/);
	throws(() => parsePublishArgs(["--identity"]), /needs a value/);
	throws(() => parsePublishArgs(["--force"]), /unknown argument/);
});

Deno.test("publish: the identity is a name and a noreply address, for author and committer", () => {
	const identity = parseIdentity(
		"Tartan Maintainer <maint@users.noreply.github.com>",
	);
	deepStrictEqual(identity, {
		name: "Tartan Maintainer",
		email: "maint@users.noreply.github.com",
	});
	deepStrictEqual(identityEnv(identity), {
		GIT_AUTHOR_NAME: "Tartan Maintainer",
		GIT_AUTHOR_EMAIL: "maint@users.noreply.github.com",
		GIT_COMMITTER_NAME: "Tartan Maintainer",
		GIT_COMMITTER_EMAIL: "maint@users.noreply.github.com",
	});
	equal(parseIdentity("X <noreply@example.org>").email, "noreply@example.org");
	throws(() => parseIdentity("Someone <someone@example.org>"), /noreply/);
	throws(() => parseIdentity("no address"), /Name <email>/);
	throws(
		() => parseIdentity("<maint@users.noreply.github.com>"),
		/Name <email>/,
	);
});

Deno.test("publish: only noreply addresses are public emails", () => {
	ok(isPublicEmail("12345+maint@users.noreply.github.com"));
	ok(isPublicEmail("noreply@github.com"));
	ok(!isPublicEmail("maint@example.org"));
	ok(!isPublicEmail("maint@users.noreply.github.com.example.org"));
	ok(!isPublicEmail(""));
});

Deno.test("publish: snapshot messages are neutral and carry no source commit", () => {
	const initial = snapshotMessage(true);
	equal(initial.split("\n")[0], "Tartan: initial public snapshot");
	const later = snapshotMessage(false);
	equal(later.split("\n")[0], "Tartan: public snapshot");
	ok(later.includes("Co-Authored-By: Claude Opus 5.5"));
	ok(!/[0-9a-f]{40}/.test(later));
	equal(later.split("\n").filter((line) => line.startsWith("- ")).length, 0);
});

Deno.test("publish: a snapshot is the one commit on the remote main, replacing unpushed ones", () => {
	const at = (commit: string, tree: string) => ({ commit, tree });
	const pushed = at("p", "t1");
	// Nothing published yet: the first snapshot.
	equal(
		planSnapshot({ base: null, tip: null, pending: 0, tree: "t1" }),
		"commit",
	);
	// public is the remote main.
	equal(
		planSnapshot({ base: pushed, tip: pushed, pending: 0, tree: "t1" }),
		"current",
	);
	equal(
		planSnapshot({ base: pushed, tip: pushed, pending: 0, tree: "t2" }),
		"commit",
	);
	// One unpushed snapshot of this tree stays; of another tree, is replaced.
	equal(
		planSnapshot({ base: pushed, tip: at("a", "t2"), pending: 1, tree: "t2" }),
		"current",
	);
	equal(
		planSnapshot({ base: pushed, tip: at("a", "t2"), pending: 1, tree: "t3" }),
		"commit",
	);
	// Several unpushed snapshots are replaced even when the tip tree matches.
	equal(
		planSnapshot({ base: pushed, tip: at("b", "t3"), pending: 2, tree: "t3" }),
		"commit",
	);
	// The remote main already carries the tree: drop the unpushed snapshots.
	equal(
		planSnapshot({ base: pushed, tip: at("b", "t3"), pending: 2, tree: "t1" }),
		"reset",
	);
});

Deno.test("publish: a push sends one reviewed snapshot, never an unpushed one's tree", async () => {
	const repo = await createTempRepo();
	const script = new URL("./publish.ts", import.meta.url).pathname;
	const identity = {
		TARTAN_PUBLISH_IDENTITY: "Tartan Test <noreply@example.org>",
	};
	const publish = (...args: string[]) => repo.script(script, args, identity);
	const remote = `${repo.dir}/remote.git`;
	const inRemote = async (
		object: string,
		gitDir = remote,
	): Promise<boolean> => {
		try {
			await repo.git(["--git-dir", gitDir, "cat-file", "-e", object]);
			return true;
		} catch {
			return false;
		}
	};
	const review = (tree: string) =>
		repo.writePrivate(
			`${REVIEWED_DIR.replace(/^\.private\//, "")}/${tree}`,
			"",
		);
	const treeOf = (rev: string) => repo.git(["rev-parse", `${rev}^{tree}`]);
	try {
		await repo.writePrivate(
			"public-terms.json",
			JSON.stringify({
				terms: ["plugh"],
				unpublished: { "notes/": "stand-in notes" },
			}),
		);
		await repo.git(["init", "--quiet", "--bare", remote], repo.dir);
		await repo.git(["remote", "add", "origin", remote]);
		await repo.commit(
			{ "README.md": "v1\n", "notes/plan.md": "private\n" },
			"one",
		);

		// The first snapshot: committed, but no push without a review.
		let result = await publish();
		equal(result.code, 0, result.err);
		const first = await repo.git(["rev-parse", "public"]);
		equal(await repo.git(["ls-tree", "-r", "--name-only", first]), "README.md");
		result = await publish("--push");
		equal(result.code, 2);
		ok(!(await inRemote(first)));
		await review(await treeOf(first));
		result = await publish("--push");
		equal(result.code, 0, result.err);
		equal(await repo.git(["--git-dir", remote, "rev-parse", "main"]), first);

		// Two runs before a push leave one pending commit on the remote main.
		await repo.commit({ "README.md": "v2 draft\n" }, "two");
		result = await publish();
		equal(result.code, 0, result.err);
		const draft = await repo.git(["rev-parse", "public"]);
		const draftBlob = await repo.git(["rev-parse", `${draft}:README.md`]);
		await repo.commit({ "README.md": "v3\n" }, "three");
		result = await publish();
		equal(result.code, 0, result.err);
		equal(await repo.git(["rev-list", "--count", "origin/main..public"]), "1");
		equal(await repo.git(["rev-parse", "public^"]), first);
		const reviewed = await treeOf("public");

		// An unpushed chain from before is replaced, so its trees stay local.
		const middle = await repo.git([
			"commit-tree",
			await treeOf(draft),
			"-p",
			first,
			"-m",
			"Tartan: public snapshot",
		]);
		const chain = await repo.git([
			"commit-tree",
			reviewed,
			"-p",
			middle,
			"-m",
			"Tartan: public snapshot",
		]);
		await repo.git(["update-ref", "refs/heads/public", chain]);
		await review(reviewed);
		result = await publish("--push");
		equal(result.code, 0, result.err);
		const pushed = await repo.git(["--git-dir", remote, "rev-parse", "main"]);
		equal(await repo.git(["rev-parse", "public"]), pushed);
		equal(await repo.git(["rev-parse", `${pushed}^`]), first);
		equal(await treeOf(pushed), reviewed);
		ok(!(await inRemote(middle)));
		ok(!(await inRemote(draftBlob)));

		// Every commit a push would send needs a review, not only the tip.
		const empty = `${repo.dir}/empty.git`;
		await repo.git(["init", "--quiet", "--bare", empty], repo.dir);
		await repo.git(["remote", "set-url", "origin", empty]);
		await Deno.remove(
			`${repo.work}/${REVIEWED_DIR}/${await treeOf(first)}`,
		);
		result = await publish("--push");
		equal(result.code, 2);
		ok(result.err.includes(`snapshot ${first.slice(0, 12)}`), result.err);
		ok(!(await inRemote(pushed, empty)));
		ok(!(await inRemote(first, empty)));
	} finally {
		await repo.remove();
	}
});
