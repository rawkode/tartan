// The genesis commit (WP3 until WP10's job; K1): object ids and layout, the K1
// intent order (register before the push, `pushed` after it, `abandoned` when
// the push fails), a refused push, and, when a `git` binary is on PATH, stock
// git's `fsck --strict` on the pack and a clone-shaped `log` of it.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { repoArtifactsName, ZERO_SHA } from "@tartan/contract";
import { createFakeArtifacts } from "@tartan/testkit";
import { writePack } from "@tartan/gitproto";
import {
	buildGenesisCommit,
	createGenesis,
	upstreamAuthorization,
} from "./genesis.ts";
import { createClock, createFakeRepos } from "./testing/harness.ts";

const INPUT = {
	defaultBranch: "main",
	message: "Initial commit",
	author: { name: "Tartan", email: "kernel@tartan.invalid" },
	title: "router",
} as const;

const hasGit = (() => {
	try {
		return new Deno.Command("git", { args: ["--version"], stdout: "null" })
			.outputSync().success;
	} catch {
		return false;
	}
})();

const git = async (
	cwd: string,
	args: string[],
	stdin?: Uint8Array,
): Promise<{ code: number; out: string; err: string }> => {
	const child = new Deno.Command("git", {
		args,
		cwd,
		stdin: stdin ? "piped" : "null",
		stdout: "piped",
		stderr: "piped",
		env: {
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			HOME: cwd,
			LC_ALL: "C",
		},
	}).spawn();
	if (stdin) {
		const writer = child.stdin.getWriter();
		await writer.write(stdin);
		await writer.close();
	}
	const result = await child.output();
	return {
		code: result.code,
		out: new TextDecoder().decode(result.stdout),
		err: new TextDecoder().decode(result.stderr),
	};
};

Deno.test("genesis objects: README.md only (no .tartan tree, ADR repo config) in a root commit with fixed ids for fixed input", async () => {
	const a = await buildGenesisCommit(INPUT, 1_790_000_000);
	const b = await buildGenesisCommit(INPUT, 1_790_000_000);
	equal(a.commit, b.commit);
	equal(a.objects.length, 3);
	deepStrictEqual(a.objects.map((o) => o.type), ["blob", "tree", "commit"]);
	const commit = new TextDecoder().decode(a.objects[2].data);
	ok(
		commit.startsWith(
			`tree ${a.tree}\nauthor Tartan <kernel@tartan.invalid> 1790000000 +0000\n`,
		),
	);
	ok(!commit.includes("\nparent "));
	ok(commit.endsWith("\n\nInitial commit\n"));
	const later = await buildGenesisCommit(INPUT, 1_790_000_001);
	ok(later.commit !== a.commit);
	equal(later.tree, a.tree);
});

Deno.test({
	name:
		"genesis objects pass stock git's fsck --strict and read back as one root commit",
	ignore: !hasGit,
	fn: async () => {
		const dir = await Deno.makeTempDir({ prefix: "wp03-genesis-" });
		try {
			const built = await buildGenesisCommit(INPUT, 1_790_000_000);
			const { pack } = await writePack(built.objects);
			equal((await git(dir, ["init", "--bare", "-q", "repo.git"])).code, 0);
			const bare = `${dir}/repo.git`;
			const unpacked = await git(bare, ["unpack-objects", "-q"], pack);
			equal(unpacked.code, 0, unpacked.err);
			equal(
				(await git(bare, ["update-ref", "refs/heads/main", built.commit])).code,
				0,
			);
			const fsck = await git(bare, ["fsck", "--strict", "--no-dangling"]);
			equal(fsck.code, 0, fsck.err);
			const log = await git(bare, ["log", "--format=%H %P|%s", "main"]);
			equal(log.out.trim(), `${built.commit} |Initial commit`);
			const files = await git(bare, ["ls-tree", "-r", "--name-only", "main"]);
			deepStrictEqual(files.out.trim().split("\n"), ["README.md"]);
			const readme = await git(bare, ["show", "main:README.md"]);
			ok(readme.out.startsWith("# router\n"));
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});

Deno.test("createGenesis: K1 intent before the push, pushed after; the ref holds the commit", async () => {
	const clock = createClock();
	const fake = createFakeArtifacts({ now: () => clock.now() });
	const repoId = "01k6a00000000000000000000a";
	const name = repoArtifactsName(repoId);
	await fake.create(name, { setDefaultBranch: "main" });
	const repos = createFakeRepos(() => fake, clock);
	const order: string[] = [];
	fake.onPush(() => order.push("push"));
	const core = repos.core(repoId);
	const genesis = createGenesis({
		core: () => ({
			...core,
			registerKernelWrite: (intent) => {
				order.push("intent");
				return core.registerKernelWrite(intent);
			},
			markKernelWrite: (id, state) => {
				order.push(`mark:${state}`);
				return core.markKernelWrite(id, state);
			},
		}),
		clock,
		fetch: (input, init) => fake.fetch(new Request(input, init)),
	});
	const { commit } = await genesis(repoId, INPUT);
	deepStrictEqual(order, ["intent", "push", "mark:pushed"]);
	deepStrictEqual(fake.inspect.refs(name), { "refs/heads/main": commit });
	equal(repos.writes[0].expect_old, ZERO_SHA);
	equal(repos.writes[0].new_sha, commit);
	equal(repos.writes[0].owner_id, `genesis:${repoId}`);
	// A second genesis on a repo whose main exists is refused and abandoned.
	await rejects(() => genesis(repoId, INPUT));
	deepStrictEqual(repos.writes[1].marks, ["abandoned"]);
	deepStrictEqual(fake.inspect.refs(name), { "refs/heads/main": commit });
});

Deno.test("upstreamAuthorization: Bearer with the full token (UPSTREAM_AUTH)", () => {
	equal(
		upstreamAuthorization("art_v2_x_abc?expires=1"),
		"Bearer art_v2_x_abc?expires=1",
	);
});
