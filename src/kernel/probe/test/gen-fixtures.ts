// Generates RepoProbe's git fixtures offline. Builds one real repository with a
// linear trunk and lane branches for every K17 and radar scenario, then
// exports:
//
// - every object as the Artifacts binding returns it (commit metadata, tree
//   entries, blob bytes as base64), so tests serve them from an in-memory
//   store with real SHAs;
// - per lane: `git merge-base main <head>`, `git diff --name-status
//   --find-renames=100% main...<head>` and `git diff -U0` hunk headers;
// - per scenario pair: `git merge-file` of the merge-base, ours and theirs
//   blobs of every path both lanes changed.
//
// Usage (needs git on PATH):
//   deno run -A src/kernel/probe/test/gen-fixtures.ts
// Writes src/kernel/probe/test/fixtures/histories.json.

const OUT = new URL("./fixtures/histories.json", import.meta.url);
const decoder = new TextDecoder();

let clock = 1_790_000_000; // fixed, monotonic commit dates
const baseEnv = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Tartan Fixture",
	GIT_AUTHOR_EMAIL: "fixture@tartan.test",
	GIT_COMMITTER_NAME: "Tartan Fixture",
	GIT_COMMITTER_EMAIL: "fixture@tartan.test",
};

const run = async (
	dir: string,
	args: string[],
	env: Record<string, string> = {},
	okCodes: number[] = [0],
): Promise<{ out: string; bytes: Uint8Array; code: number }> => {
	const date = `@${clock} +0000`;
	const res = await new Deno.Command("git", {
		args,
		cwd: dir,
		env: {
			...baseEnv,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
			...env,
		},
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!okCodes.includes(res.code)) {
		throw new Error(`git ${args.join(" ")}: ${decoder.decode(res.stderr)}`);
	}
	return { out: decoder.decode(res.stdout), bytes: res.stdout, code: res.code };
};

const write = async (
	dir: string,
	path: string,
	content: string | Uint8Array,
) => {
	const full = `${dir}/${path}`;
	await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
	if (typeof content === "string") await Deno.writeTextFile(full, content);
	else await Deno.writeFile(full, content);
};

const lines = (n: number, tag: string) =>
	Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}\n`).join("");

const editLine = (text: string, line: number, replacement: string): string => {
	const all = text.split("\n");
	all[line - 1] = replacement;
	return all.join("\n");
};

const commitAll = async (
	dir: string,
	message: string,
	env: Record<string, string> = {},
): Promise<string> => {
	clock += 60;
	await run(dir, ["add", "-A"]);
	await run(dir, ["commit", "-q", "--allow-empty", "-m", message], env);
	return (await run(dir, ["rev-parse", "HEAD"])).out.trim();
};

const APP = lines(30, "app");
const UTIL = lines(10, "util");
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]);

const main = async () => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-probe-fixtures-" });
	try {
		await run(dir, ["init", "-q", "-b", "main"]);
		// ---- trunk: T0..T4 (linear) -----------------------------------------
		await write(dir, "package.json", '{"name":"sample","private":true}\n');
		await write(
			dir,
			"pnpm-workspace.yaml",
			"packages:\n  - services/*\n  - apps/*\n",
		);
		await write(dir, "services/api/package.json", '{"name":"api"}\n');
		await write(dir, "services/api/a.ts", lines(5, "api-a"));
		await write(dir, "apps/web/package.json", '{"name":"web"}\n');
		await write(dir, "apps/web/main.ts", lines(5, "web"));
		await write(dir, "src/app.ts", APP);
		await write(dir, "src/util.ts", UTIL);
		await write(dir, "docs/guide.md", lines(6, "guide"));
		await write(dir, "img/logo.png", LOGO);
		const T0 = await commitAll(dir, "genesis");
		await write(dir, "trunk/t1.txt", "t1\n");
		const T1 = await commitAll(
			dir,
			"trunk 1\n\nLanded-By: tartan\nChange-Id: kkkk",
		);
		await write(dir, "trunk/t2.txt", "t2\n");
		const T2 = await commitAll(dir, "trunk 2");
		await write(dir, "apps/web/main.ts", lines(6, "web"));
		const T3 = await commitAll(dir, "trunk 3 (web)");
		await write(dir, "trunk/t4.txt", "t4\n");
		const T4 = await commitAll(dir, "trunk 4");
		const trunk = [T0, T1, T2, T3, T4];

		const lane = async (
			name: string,
			from: string,
			steps: (() => Promise<void>)[],
		): Promise<string> => {
			await run(dir, ["checkout", "-q", "-B", name, from]);
			for (const step of steps) await step();
			return (await run(dir, ["rev-parse", "HEAD"])).out.trim();
		};
		const edit =
			(path: string, content: string | Uint8Array, msg: string) => async () => {
				await write(dir, path, content);
				await commitAll(dir, msg);
			};

		// ---- K17 lanes ---------------------------------------------------------
		await lane("at-base", T2, [
			edit("services/api/a.ts", lines(6, "api-a"), "api: one more line"),
			edit(
				"services/api/b.ts",
				"b\n",
				"api: add b\n\nCo-Authored-By: agent <a@x>",
			),
		]);
		await lane("merged-trunk", T1, [
			edit("services/api/a.ts", lines(7, "api-a"), "api: two more"),
			async () => {
				clock += 60;
				await run(dir, ["merge", "-q", "--no-ff", "-m", "merge trunk", T3]);
			},
			edit("services/api/c.ts", "c\n", "api: add c"),
		]);
		await lane("rebased", T1, [
			edit("services/api/r.ts", "r1\n", "api: r1"),
			edit("services/api/r.ts", "r2\n", "api: r2"),
			async () => {
				clock += 60;
				await run(dir, ["rebase", "-q", T3]);
			},
		]);
		const stackA = await lane("stack-a", T1, [
			edit("services/api/sa.ts", "sa\n", "api: stack a"),
		]);
		await lane("stack-b", stackA, [
			edit("services/api/sb.ts", "sb\n", "api: stack b"),
		]);
		await lane("forged-dates", T2, [
			async () => {
				await write(dir, "services/api/f.ts", "old\n");
				await commitAll(dir, "dated 1990", {
					GIT_COMMITTER_DATE: "@631152000 +0000",
					GIT_AUTHOR_DATE: "@631152000 +0000",
				});
			},
			async () => {
				await write(dir, "services/api/f.ts", "future\n");
				await commitAll(dir, "dated 2100", {
					GIT_COMMITTER_DATE: "@4102444800 +0000",
					GIT_AUTHOR_DATE: "@4102444800 +0000",
				});
			},
		]);
		await run(dir, ["checkout", "-q", "--orphan", "orphan"]);
		await run(dir, ["rm", "-rq", "--cached", "."]);
		await write(dir, "orphan.txt", "unrelated\n");
		await run(dir, ["add", "orphan.txt"]);
		clock += 60;
		await run(dir, ["commit", "-q", "-m", "orphan root"]);
		await run(dir, ["checkout", "-q", "-f", "main"]);
		await run(dir, ["clean", "-qfdx"]);

		// ---- radar scenario lanes (pairs) -------------------------------------
		const pairs: [string, string, string][] = [];
		const pair = async (
			name: string,
			a: { from: string; steps: (() => Promise<void>)[] },
			b: { from: string; steps: (() => Promise<void>)[] },
		) => {
			await lane(`${name}-a`, a.from, a.steps);
			await lane(`${name}-b`, b.from, b.steps);
			pairs.push([name, `${name}-a`, `${name}-b`]);
		};
		await pair(
			"same-line",
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 10, "A edits ten"), "a")],
			},
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 10, "B edits ten"), "b")],
			},
		);
		await pair(
			"adjacent",
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 10, "A edits ten"), "a")],
			},
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 12, "B edits twelve"), "b")],
			},
		);
		await pair(
			"same-file-disjoint",
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 3, "A edits three"), "a")],
			},
			{
				from: T2,
				steps: [edit("src/app.ts", editLine(APP, 26, "B edits 26"), "b")],
			},
		);
		await pair(
			"rename",
			{
				from: T2,
				steps: [async () => {
					await run(dir, ["mv", "docs/guide.md", "docs/manual.md"]);
					await commitAll(dir, "a: rename guide");
				}],
			},
			{
				from: T2,
				steps: [edit("docs/guide.md", lines(7, "guide"), "b: extend guide")],
			},
		);
		await pair(
			"delete-vs-modify",
			{
				from: T2,
				steps: [async () => {
					await run(dir, ["rm", "-q", "src/util.ts"]);
					await commitAll(dir, "a: delete util");
				}],
			},
			{
				from: T2,
				steps: [edit("src/util.ts", editLine(UTIL, 4, "B util"), "b")],
			},
		);
		await pair(
			"binary",
			{
				from: T2,
				steps: [edit("img/logo.png", new Uint8Array([...LOGO, 1]), "a")],
			},
			{
				from: T2,
				steps: [edit("img/logo.png", new Uint8Array([...LOGO, 2]), "b")],
			},
		);
		await pair(
			"different-bases",
			{
				from: T1,
				steps: [edit("src/app.ts", editLine(APP, 20, "A on T1"), "a")],
			},
			{
				from: T3,
				steps: [edit("src/app.ts", editLine(APP, 21, "B on T3"), "b")],
			},
		);

		// ---- export objects ---------------------------------------------------
		const refs: Record<string, string> = {};
		for (
			const line of (await run(dir, [
				"for-each-ref",
				"--format=%(refname:short) %(objectname)",
				"refs/heads",
			])).out.trim().split("\n")
		) {
			const [name, sha] = line.split(" ");
			refs[name] = sha;
		}
		const shas = (await run(dir, ["rev-list", "--objects", "--all"])).out.trim()
			.split("\n").map((l) => l.split(" ")[0]);
		const commits: Record<string, unknown> = {};
		const trees: Record<string, unknown> = {};
		const blobs: Record<string, string> = {};
		const MODE_TYPE: Record<string, string> = {
			"040000": "tree",
			"100644": "blob",
			"100755": "exec",
			"120000": "symlink",
			"160000": "gitlink",
		};
		for (const sha of shas) {
			const type = (await run(dir, ["cat-file", "-t", sha])).out.trim();
			if (type === "commit") {
				const raw = (await run(dir, ["cat-file", "commit", sha])).out;
				const split = raw.indexOf("\n\n");
				const headers = raw.slice(0, split).split("\n");
				const message = raw.slice(split + 2).replace(/\n$/, "");
				const ident = (key: string) => {
					const line = headers.find((h) => h.startsWith(`${key} `))!;
					const m = /^\w+ (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line)!;
					return { name: m[1], email: m[2], at: Number(m[3]) };
				};
				const author = ident("author");
				const committer = ident("committer");
				commits[sha] = {
					hash: sha,
					treeHash: headers.find((h) => h.startsWith("tree "))!.slice(5),
					message,
					author: { name: author.name, email: author.email },
					committer: { name: committer.name, email: committer.email },
					parents: headers.filter((h) => h.startsWith("parent ")).map((h) =>
						h.slice(7)
					),
					authoredAt: author.at,
					committedAt: committer.at,
				};
			} else if (type === "tree") {
				const out = (await run(dir, ["ls-tree", sha])).out.trim();
				trees[sha] = out === "" ? [] : out.split("\n").map((l) => {
					const [meta, name] = l.split("\t");
					const [mode, , hash] = meta.split(" ");
					return {
						name,
						mode: mode === "040000" ? "40000" : mode,
						hash,
						type: MODE_TYPE[mode],
					};
				});
			} else if (type === "blob") {
				const bytes = (await run(dir, ["cat-file", "blob", sha])).bytes;
				let s = "";
				for (const b of bytes) s += String.fromCharCode(b);
				blobs[sha] = btoa(s);
			}
		}

		// ---- expectations ----------------------------------------------------
		const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
		const laneNames = Object.keys(refs).filter((n) => n !== "main");
		const lanes: Record<string, unknown> = {};
		for (const name of laneNames) {
			const head = refs[name];
			const mb = await run(dir, ["merge-base", "main", head], {}, [0, 1]);
			const mergeBase = mb.code === 0 ? mb.out.trim() : null;
			if (mergeBase === null) {
				lanes[name] = { head, mergeBase: null };
				continue;
			}
			const status = (await run(dir, [
				"diff",
				"--name-status",
				"--find-renames=100%",
				`main...${head}`,
			])).out.trim();
			const nameStatus = status === ""
				? []
				: status.split("\n").map((l) => l.split("\t"));
			const patch = (await run(dir, [
				"diff",
				"-U0",
				"--no-renames",
				"--no-color",
				`main...${head}`,
			])).out;
			const hunks: Record<string, unknown[]> = {};
			let current: string | null = null;
			for (const line of patch.split("\n")) {
				if (line.startsWith("diff --git ")) {
					current = line.split(" b/").at(-1)!;
					hunks[current] = [];
				} else if (line.startsWith("Binary files")) {
					if (current) hunks[current] = ["binary"];
				} else {
					const m = HUNK.exec(line);
					if (m && current) {
						hunks[current].push({
							oldStart: Number(m[1]),
							oldLines: m[2] === undefined ? 1 : Number(m[2]),
							newStart: Number(m[3]),
							newLines: m[4] === undefined ? 1 : Number(m[4]),
						});
					}
				}
			}
			lanes[name] = { head, mergeBase, nameStatus, hunks };
		}

		const scenarioPairs = [];
		for (const [name, a, b] of pairs) {
			const base = (await run(dir, ["merge-base", refs[a], refs[b]])).out
				.trim();
			const changed = async (head: string) =>
				(await run(dir, [
					"diff",
					"--name-only",
					"--no-renames",
					`${base}`,
					head,
				])).out
					.trim().split("\n").filter(Boolean);
			const both = await changed(refs[a]);
			const theirs = new Set(await changed(refs[b]));
			const files = [];
			for (const path of both.filter((p) => theirs.has(p))) {
				const blobAt = async (rev: string) => {
					const r = await run(
						dir,
						["rev-parse", "-q", "--verify", `${rev}:${path}`],
						{},
						[0, 1],
					);
					return r.code === 0 ? r.out.trim() : null;
				};
				const [bb, ob, tb] = [
					await blobAt(base),
					await blobAt(refs[a]),
					await blobAt(refs[b]),
				];
				let merge: { exit: number; output: string } | null = null;
				if (bb && ob && tb) {
					const tmp = await Deno.makeTempDir({ prefix: "tartan-merge-" });
					try {
						for (
							const [file, sha] of [["base", bb], ["ours", ob], ["theirs", tb]]
						) {
							await Deno.writeFile(
								`${tmp}/${file}`,
								(await run(dir, ["cat-file", "blob", sha])).bytes,
							);
						}
						const r = await run(
							tmp,
							[
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
							{},
							[0, 1, 2, 3, 255],
						);
						merge = { exit: r.code, output: r.out };
					} finally {
						await Deno.remove(tmp, { recursive: true });
					}
				}
				files.push({ path, base: bb, ours: ob, theirs: tb, merge });
			}
			scenarioPairs.push({ name, a, b, mergeBase: base, files });
		}

		const fixture = {
			generator: "src/kernel/probe/test/gen-fixtures.ts",
			git: (await run(dir, ["--version"])).out.trim(),
			trunk,
			refs,
			lanes,
			pairs: scenarioPairs,
			objects: { commits, trees, blobs },
		};
		await Deno.mkdir(new URL("./fixtures/", import.meta.url), {
			recursive: true,
		});
		await Deno.writeTextFile(OUT, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(
			`wrote ${Object.keys(commits).length} commits, ${
				Object.keys(trees).length
			} trees, ${
				Object.keys(blobs).length
			} blobs, ${laneNames.length} lanes, ${pairs.length} pairs`,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

if (import.meta.main) await main();
