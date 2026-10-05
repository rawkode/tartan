// Pack writer and object encoders: object ids
// match git, the empty pack matches what stock git sends, and every pack
// passes `git index-pack --strict` (fsck of each object and its links).

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	encodeCommit,
	encodeTree,
	hashObject,
	type PackObject,
	writePack,
} from "../src/index.ts";
import { git, hasGit, makeSandbox, type Sandbox } from "./harness/git.ts";
import { dec, enc, golden, prng } from "./helpers.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const AUTHOR = {
	name: "Tartan",
	email: "kernel@tartan.invalid",
	at: 1_790_000_000,
};

Deno.test("hashObject matches git's well-known ids", async () => {
	equal(
		await hashObject("blob", new Uint8Array(0)),
		"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
	);
	equal(
		await hashObject("blob", enc("hello\n")),
		"ce013625030ba8dba906f756967f9e9ca394464a",
	);
	equal(await hashObject("tree", encodeTree([])), EMPTY_TREE);
});

Deno.test("writePack([]) is byte-identical to the empty pack stock git sends", async () => {
	const { pack, ids } = await writePack([]);
	deepStrictEqual(ids, []);
	const body = golden("receive-pack-multi-ref").body;
	const tail = body.subarray(body.length - pack.length);
	deepStrictEqual(pack, tail);
	equal(dec(pack.subarray(0, 4)), "PACK");
});

Deno.test("encodeTree sorts like git and refuses names fsck would flag", () => {
	const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
	const tree = encodeTree([
		{ mode: "40000", name: "a", id: EMPTY_TREE },
		{ mode: "100644", name: "a.b", id: blob },
		{ mode: "100755", name: "A", id: blob },
	]);
	const names = dec(tree).split("\0").map((s) => s.split(" ").pop());
	deepStrictEqual(names.slice(0, 3), ["A", "a.b", "a"]);
	for (const name of ["", ".", "..", ".git", ".GIT", "a/b", "a\0b"]) {
		throws(() => encodeTree([{ mode: "100644", name, id: blob }]), name);
	}
	throws(() => encodeTree([{ mode: "100644", name: "x", id: "zz" }]));
	throws(() =>
		encodeTree([{ mode: "040000" as "40000", name: "x", id: EMPTY_TREE }])
	);
	throws(() =>
		encodeTree([{ mode: "100644", name: "x", id: blob }, {
			mode: "100644",
			name: "x",
			id: blob,
		}])
	);
	throws(() =>
		encodeCommit({
			tree: EMPTY_TREE,
			author: { ...AUTHOR, name: "a<b" },
			message: "x\n",
		})
	);
	throws(() =>
		encodeCommit({
			tree: EMPTY_TREE,
			author: { ...AUTHOR, tz: "UTC" },
			message: "x\n",
		})
	);
});

/** A blob, a nested tree, a commit with a parent, and some random blobs. */
const sampleObjects = async (
	count: number,
): Promise<{ objects: PackObject[]; head: string }> => {
	const rand = prng(42);
	const objects: PackObject[] = [];
	const add = async (object: PackObject): Promise<string> => {
		objects.push(object);
		return await hashObject(object.type, object.data);
	};
	const entries = [];
	for (let i = 0; i < count; i++) {
		const size = [0, 1, 15, 16, 127, 128, 2047, 2048, 70_000][i % 9] +
			rand.int(3);
		const data = new Uint8Array(size).map(() => rand.int(256));
		entries.push({
			mode: "100644" as const,
			name: `blob-${i}.bin`,
			id: await add({ type: "blob", data }),
		});
	}
	const readme = await add({ type: "blob", data: enc("# genesis\n") });
	const sub = await add({ type: "tree", data: encodeTree(entries) });
	const link = await add({ type: "blob", data: enc("README.md") });
	const root = await add({
		type: "tree",
		data: encodeTree([
			{ mode: "100644", name: "README.md", id: readme },
			{ mode: "40000", name: "data", id: sub },
			{ mode: "120000", name: "link", id: link },
			{ mode: "100755", name: "run.sh", id: readme },
		]),
	});
	const first = await add({
		type: "commit",
		data: encodeCommit({
			tree: root,
			author: AUTHOR,
			message: "genesis\n\nTartan-Genesis: yes\n",
		}),
	});
	const head = await add({
		type: "commit",
		data: encodeCommit({
			tree: root,
			parents: [first],
			author: AUTHOR,
			committer: { ...AUTHOR, tz: "-0700" },
			message: "second\n",
		}),
	});
	// A duplicate is written once.
	objects.push({ type: "blob", data: enc("# genesis\n") });
	return { objects, head };
};

const indexPack = async (sandbox: Sandbox, pack: Uint8Array) => {
	const repo = `${sandbox.root}/idx-${crypto.randomUUID()}.git`;
	await git(sandbox, ["init", "-q", "--bare", repo]);
	const result = await git(sandbox, ["index-pack", "--strict", "--stdin"], {
		cwd: repo,
		stdin: pack,
		allowFail: true,
	});
	return { repo, result };
};

Deno.test({
	name:
		"git index-pack --strict accepts writePack output (and fsck the result)",
	ignore: !hasGit,
	fn: async () => {
		const sandbox = await makeSandbox();
		try {
			const { objects, head } = await sampleObjects(40);
			const { pack, ids } = await writePack(objects);
			equal(ids.length, objects.length);
			// The duplicate README blob (last) has the README's id (after 40 blobs).
			equal(ids[ids.length - 1], ids[40]);
			const { repo, result } = await indexPack(sandbox, pack);
			equal(result.code, 0, result.stderr);
			ok(result.text.startsWith("pack\t"));
			const type = await git(sandbox, ["cat-file", "-t", head], { cwd: repo });
			equal(type.text.trim(), "commit");
			const count = await git(sandbox, ["count-objects", "-v"], { cwd: repo });
			ok(count.text.includes(`in-pack: ${new Set(ids).size}`), count.text);
			await git(sandbox, ["update-ref", "refs/heads/main", head], {
				cwd: repo,
			});
			await git(sandbox, ["fsck", "--strict", "--no-dangling"], { cwd: repo });
			// The empty pack is valid too.
			const empty = await indexPack(sandbox, (await writePack([])).pack);
			equal(empty.result.code, 0, empty.result.stderr);
			// A corrupted trailer is refused.
			const broken = pack.slice();
			broken[broken.length - 1] ^= 0xff;
			equal((await indexPack(sandbox, broken)).result.code === 0, false);
		} finally {
			await sandbox.cleanup();
		}
	},
});
