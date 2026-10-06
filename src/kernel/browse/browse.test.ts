// The repo browse API (WP3): tree, blob, log, commit, compare and raw, over a
// real genesis repo in FakeArtifacts (whose reads resolve no full refname,
// K15). Every binding read takes a SHA; `refs/heads/main`, a tag and a lane
// head browse fine anyway; the public view never reaches hidden refs or another
// repo's objects; raw files carry the sandbox CSP.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type BlobResponse,
	type CommitResponse,
	type CompareResponse,
	isSha,
	laneId as laneIdOf,
	type LogResponse,
	repoArtifactsName,
	type TreeResponse,
	type WhyNote,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { createRawHandler, RAW_CSP } from "./raw.ts";
import {
	BLOB_INLINE_MAX,
	createBlobHandler,
	createCommitHandler,
	createCompareHandler,
	createLogHandler,
	createTreeHandler,
	LOG_PAGE,
} from "./repo.ts";
import {
	type BrowseHarness,
	createBrowseHarness,
	pat,
	session,
} from "./testing/harness.ts";

type Fixture = {
	readonly b: BrowseHarness;
	readonly owner: string;
	readonly outsider: string;
	readonly pub: { id: string; path: string; name: string };
	readonly priv: { id: string; path: string; name: string };
	readonly genesis: string;
	readonly main: string;
	readonly lane: string;
	readonly laneHead: string;
	readonly tag: string;
	readonly privHead: string;
	readonly privBlob: string;
};

const fixture = async (): Promise<Fixture> => {
	const b = createBrowseHarness();
	const { id: owner } = await b.owner("acme");
	const outsider = b.identity.user("outsider");
	const g = await b.groups(owner, "acme", "platform");
	const pubNode = await b.facade.createRepo(owner, {
		parentId: g.id,
		slug: "router",
	});
	const privNode = await b.facade.createRepo(owner, {
		parentId: g.id,
		slug: "secret",
	});
	// Make `router` public after the fact (visibility is a node column).
	b.storage.sql.exec(
		"UPDATE nodes SET visibility = 'public' WHERE id = ?",
		pubNode.id,
	);
	const pubName = repoArtifactsName(pubNode.id);
	const privName = repoArtifactsName(privNode.id);
	const genesis = b.fake.inspect.refs(pubName)["refs/heads/main"];
	const main = b.fake.commit(pubName, "refs/heads/main", {
		"src/a.ts": "export const a = 1;\n",
		"src/b.ts": "export const b = 2;\n",
		"docs/guide.md": "# Guide\n",
		"bin/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
		"web/index.html": "<script>alert(1)</script>\n",
	}, { message: "Add code\n\nTartan-Change: zkqv\n", quiet: true });
	const second = b.fake.commit(pubName, "refs/heads/main", {
		"src/a.ts": "export const a = 2;\n",
	}, { message: "Bump a", quiet: true });
	b.fake.setRef(pubName, "refs/tags/v1", main, { quiet: true });
	b.fake.setRef(pubName, "refs/heads/release/1.x", main, { quiet: true });
	// A lane head (branch backend) with a commit only the lane holds.
	const laneHead = b.fake.commit(pubName, "refs/heads/main", {
		"src/lane-secret.ts": "export const secret = 42;\n",
	}, { message: "WIP on a lane", quiet: true });
	b.fake.setRef(pubName, "refs/heads/main", second, { quiet: true });
	const lane = laneIdOf(b.ulid());
	b.addLane(pubNode.id, lane, laneHead);
	// The private repo's own content.
	const privHead = b.fake.commit(privName, "refs/heads/main", {
		"keys.txt": "private material\n",
	}, { message: "secret", quiet: true });
	const privTree = (await (await b.fake.get(privName)).readCommit(privHead))!
		.treeHash;
	const privBlob = (await (await b.fake.get(privName)).readTree(privTree))!
		.find((e) => e.name === "keys.txt")!.hash;
	return {
		b,
		owner,
		outsider,
		pub: { id: pubNode.id, path: pubNode.path, name: pubName },
		priv: { id: privNode.id, path: privNode.path, name: privName },
		genesis,
		main: second,
		lane,
		laneHead,
		tag: main,
		privHead,
		privBlob,
	};
};

const get = async <T>(
	f: Fixture,
	handler: ReturnType<typeof createTreeHandler>,
	path: string,
	auth: AuthContext | null,
): Promise<{ status: number; body: T; headers: Headers }> => {
	const res = await f.b.call(handler, "GET", path, auth);
	const text = await res.text();
	return {
		status: res.status,
		body: (text ? JSON.parse(text) : null) as T,
		headers: res.headers,
	};
};

const q = (params: Record<string, string>): string =>
	new URLSearchParams(params).toString();

/** Every binding read named a SHA (K15): `log`/`readFile` refs and object reads. */
const onlyShaReads = (f: Fixture): void => {
	for (const call of f.b.fake.calls) {
		if (call.op === "repo.log") {
			const ref = JSON.parse(call.detail.slice(call.detail.indexOf("{"))).ref;
			ok(isSha(ref), `log by ${ref}`);
		}
		if (call.op === "repo.readFile") {
			const ref = JSON.parse(call.detail.slice(call.detail.indexOf("{"))).ref;
			ok(isSha(ref), `readFile by ${ref}`);
		}
	}
};

Deno.test("tree: main, refs/heads/main, a tag, a lane head and a SHA browse, though the binding resolves no refname", async () => {
	const f = await fixture();
	const tree = createTreeHandler(f.b.depsFor);
	const owner = session(f.owner);
	for (
		const [ref, sha] of [
			["main", f.main],
			["refs/heads/main", f.main],
			["v1", f.tag],
			["refs/tags/v1", f.tag],
			[f.lane, f.laneHead],
			["refs/heads/lanes/" + f.lane, f.laneHead],
			[f.tag, f.tag],
		]
	) {
		const res = await get<TreeResponse>(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, ref })}`,
			owner,
		);
		equal(res.status, 200, ref);
		equal(res.body.sha, sha, ref);
		equal(res.body.ref, ref);
		ok(res.body.entries.some((e) => e.name === "README.md"), ref);
	}
	// The default ref and a subdirectory.
	const src = await get<TreeResponse>(
		f,
		tree,
		`/-/api/tree?${q({ repo: f.pub.path, path: "src" })}`,
		owner,
	);
	equal(src.body.ref, "refs/heads/main");
	deepStrictEqual(
		src.body.entries.map((e) => [e.path, e.type]),
		[["src/a.ts", "blob"], ["src/b.ts", "blob"]],
	);
	equal(
		(await get(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, path: "nope" })}`,
			owner,
		))
			.status,
		404,
	);
	equal(
		(await get(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, path: "src/a.ts" })}`,
			owner,
		))
			.status,
		404,
	);
	equal(
		(await get(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, path: "../x" })}`,
			owner,
		))
			.status,
		400,
	);
	equal(
		(await get(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, ref: "nope" })}`,
			owner,
		))
			.status,
		404,
	);
	onlyShaReads(f);
});

Deno.test("public view: anonymous and roleless readers see visible refs only, never a lane head or its commits", async () => {
	const f = await fixture();
	const tree = createTreeHandler(f.b.depsFor);
	for (const auth of [null, session(f.outsider)]) {
		equal(
			(await get(f, tree, `/-/api/tree?${q({ repo: f.pub.path })}`, auth))
				.status,
			200,
		);
		// An older trunk commit is reachable from the visible tip.
		equal(
			(await get(
				f,
				tree,
				`/-/api/tree?${q({ repo: f.pub.path, ref: f.genesis })}`,
				auth,
			))
				.status,
			200,
		);
		for (
			const ref of [
				f.lane,
				`refs/heads/lanes/${f.lane}`,
				`lanes/${f.lane}`,
				f.laneHead,
				f.privHead,
			]
		) {
			const res = await get(
				f,
				tree,
				`/-/api/tree?${q({ repo: f.pub.path, ref })}`,
				auth,
			);
			equal(res.status, 404, `${auth?.principal ?? "anonymous"} ${ref}`);
		}
	}
	// A member sees the lane.
	equal(
		(await get(
			f,
			tree,
			`/-/api/tree?${q({ repo: f.pub.path, ref: f.laneHead })}`,
			session(f.owner),
		))
			.status,
		200,
	);
	// A private repo is 404 to anonymous and roleless callers (never 401/403: existence hidden).
	for (const auth of [null, session(f.outsider)]) {
		equal(
			(await get(f, tree, `/-/api/tree?${q({ repo: f.priv.path })}`, auth))
				.status,
			404,
		);
	}
});

Deno.test("a public repo with a private repo's commit or blob hash is refused, for anyone", async () => {
	const f = await fixture();
	const blob = createBlobHandler(f.b.depsFor);
	const tree = createTreeHandler(f.b.depsFor);
	for (const auth of [null, session(f.outsider), session(f.owner)]) {
		for (const ref of [f.privHead, f.privBlob]) {
			equal(
				(await get(
					f,
					blob,
					`/-/api/blob?${q({ repo: f.pub.path, ref, path: "keys.txt" })}`,
					auth,
				)).status,
				404,
			);
			equal(
				(await get(
					f,
					tree,
					`/-/api/tree?${q({ repo: f.pub.path, ref })}`,
					auth,
				))
					.status,
				404,
			);
		}
	}
	// A blob hash of the public repo itself is not a ref either.
	const own = await get<BlobResponse>(
		f,
		blob,
		`/-/api/blob?${q({ repo: f.pub.path, path: "README.md" })}`,
		null,
	);
	equal(own.status, 200);
	equal(
		(await get(
			f,
			blob,
			`/-/api/blob?${
				q({ repo: f.pub.path, ref: own.body.blob, path: "README.md" })
			}`,
			session(f.owner),
		))
			.status,
		404,
	);
});

Deno.test("blob: text inline, binary flagged, large files truncated, the raw URL", async () => {
	const f = await fixture();
	const blob = createBlobHandler(f.b.depsFor);
	const owner = session(f.owner);
	const text = await get<BlobResponse>(
		f,
		blob,
		`/-/api/blob?${q({ repo: f.pub.path, path: "src/a.ts" })}`,
		owner,
	);
	equal(text.status, 200);
	equal(text.body.text, "export const a = 2;\n");
	equal(text.body.binary, false);
	equal(text.body.truncated, false);
	equal(text.body.sha, f.main);
	equal(text.body.rawUrl, `/${f.pub.path}/-/raw/refs/heads/main/src/a.ts`);
	const bin = await get<BlobResponse>(
		f,
		blob,
		`/-/api/blob?${q({ repo: f.pub.path, path: "bin/logo.png", ref: "v1" })}`,
		owner,
	);
	equal(bin.body.binary, true);
	equal(bin.body.text, undefined);
	equal(bin.body.size, 8);
	const big = "x".repeat(BLOB_INLINE_MAX + 10);
	f.b.fake.commit(f.pub.name, "refs/heads/main", { "big.txt": big }, {
		message: "big",
		quiet: true,
	});
	const large = await get<BlobResponse>(
		f,
		blob,
		`/-/api/blob?${q({ repo: f.pub.path, path: "big.txt" })}`,
		owner,
	);
	equal(large.body.truncated, true);
	equal(large.body.text, undefined);
	equal(large.body.size, big.length);
	equal(
		(await get(
			f,
			blob,
			`/-/api/blob?${q({ repo: f.pub.path, path: "src" })}`,
			owner,
		))
			.status,
		404,
	);
	equal(
		(await get(f, blob, `/-/api/blob?${q({ repo: f.pub.path })}`, owner))
			.status,
		400,
	);
});

Deno.test("log: first-parent pages with a cursor, path filters, by SHA", async () => {
	const f = await fixture();
	const log = createLogHandler(f.b.depsFor);
	const owner = session(f.owner);
	const all = await get<LogResponse>(
		f,
		log,
		`/-/api/log?${q({ repo: f.pub.path })}`,
		owner,
	);
	deepStrictEqual(all.body.commits.map((c) => c.subject), [
		"Bump a",
		"Add code",
		"Initial commit",
	]);
	equal(all.body.cursor, undefined);
	deepStrictEqual(all.body.commits[1].trailers, [
		{ key: "Tartan-Change", value: "zkqv" },
	]);
	equal(all.body.commits[2].parents.length, 0);
	const a = await get<LogResponse>(
		f,
		log,
		`/-/api/log?${q({ repo: f.pub.path, path: "src/a.ts" })}`,
		owner,
	);
	deepStrictEqual(a.body.commits.map((c) => c.subject), ["Bump a", "Add code"]);
	const docs = await get<LogResponse>(
		f,
		log,
		`/-/api/log?${q({ repo: f.pub.path, path: "docs" })}`,
		owner,
	);
	deepStrictEqual(docs.body.commits.map((c) => c.subject), ["Add code"]);
	// Paging past LOG_PAGE.
	let head = f.main;
	for (let i = 0; i < LOG_PAGE + 5; i++) {
		head = f.b.fake.commit(f.pub.name, "refs/heads/main", {
			"counter.txt": `${i}\n`,
		}, { message: `c${i}`, quiet: true });
	}
	const page1 = await get<LogResponse>(
		f,
		log,
		`/-/api/log?${q({ repo: f.pub.path })}`,
		owner,
	);
	equal(page1.body.commits.length, LOG_PAGE);
	equal(page1.body.commits[0].sha, head);
	equal(page1.body.cursor, String(LOG_PAGE));
	const page2 = await get<LogResponse>(
		f,
		log,
		`/-/api/log?${q({ repo: f.pub.path, cursor: page1.body.cursor! })}`,
		owner,
	);
	equal(page2.body.commits.length, 8);
	equal(page2.body.commits.at(-1)?.subject, "Initial commit");
	equal(
		(await get(
			f,
			log,
			`/-/api/log?${q({ repo: f.pub.path, cursor: "-1" })}`,
			owner,
		))
			.status,
		400,
	);
	onlyShaReads(f);
});

Deno.test("commit: metadata, the diff from RepoProbe against the first parent, root commits list their files, why notes", async () => {
	const f = await fixture();
	const commit = createCommitHandler(f.b.depsFor);
	const owner = session(f.owner);
	const res = await get<CommitResponse>(
		f,
		commit,
		`/-/api/commit?${q({ repo: f.pub.path, sha: f.main })}`,
		owner,
	);
	equal(res.status, 200);
	equal(res.body.commit.subject, "Bump a");
	deepStrictEqual(f.b.probeCalls.at(-1), {
		a: { repoId: f.pub.id, sha: f.tag },
		b: { repoId: f.pub.id, sha: f.main },
		patch: false,
	});
	equal(res.body.files[0].path, "README.md");
	equal(res.body.note, undefined);
	// `patch=1` asks RepoProbe for the patches (the SPA always does).
	const patched = await get<CommitResponse>(
		f,
		commit,
		`/-/api/commit?${q({ repo: f.pub.path, sha: f.main, patch: "1" })}`,
		owner,
	);
	equal(patched.status, 200);
	equal(f.b.probeCalls.at(-1)?.patch, true);
	equal(
		(await get(
			f,
			commit,
			`/-/api/commit?${q({ repo: f.pub.path, sha: f.main, patch: "yes" })}`,
			owner,
		)).status,
		400,
	);
	const root = await get<CommitResponse>(
		f,
		commit,
		`/-/api/commit?${q({ repo: f.pub.path, sha: f.genesis })}`,
		null,
	);
	deepStrictEqual(
		root.body.files.map((x) => [x.path, x.change]).sort(),
		[["README.md", "added"]],
	);
	equal(root.body.files[0].patchOmitted, undefined);
	// A root commit is listed by path: asked for patches, it says so.
	const rootPatched = await get<CommitResponse>(
		f,
		commit,
		`/-/api/commit?${q({ repo: f.pub.path, sha: f.genesis, patch: "1" })}`,
		null,
	);
	deepStrictEqual(
		rootPatched.body.files.map((x) => [x.path, x.patchOmitted]),
		[["README.md", "path-level"]],
	);
	// A why note on refs/notes/tartan at the commit's path.
	const note: WhyNote = {
		v: 1,
		kernel: {
			advance: "adv_01k6aaaaaaaaaaaaaaaaaaaaaa_1",
			ref: "refs/heads/main",
			batch: "lb_01k6aaaaaaaaaaaaaaaaaaaaaa",
			landedBy: "i_01k6aaaaaaaaaaaaaaaaaaaaaa",
			actor: f.owner,
			change: "zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
			lane: f.lane,
			laneHead: f.laneHead,
			laneMode: "branch",
			laneHeadRef: "refs/tartan/changes/zkqvzkqvzkqvzkqvzkqvzkqvzkqvzkqv",
			rangeBase: f.tag,
			firstPushers: [],
			provenance: "complete",
			reason: { summary: "landed", events: ["01k6aaaaaaaaaaaaaaaaaaaaaa"] },
			gates: [],
			checks: { state: "success", runs: [], evidenceReused: false },
			chain: { seq: 3, head: "a".repeat(64) },
		},
		ext: {},
	};
	f.b.fake.commit(f.pub.name, "refs/notes/tartan", {
		[f.main]: JSON.stringify(note),
	}, { message: "Notes", quiet: true });
	const noted = await get<CommitResponse>(
		f,
		commit,
		`/-/api/commit?${q({ repo: f.pub.path, sha: f.main })}`,
		owner,
	);
	deepStrictEqual(noted.body.note, note);
	equal(
		(await get(
			f,
			commit,
			`/-/api/commit?${q({ repo: f.pub.path, sha: f.laneHead })}`,
			null,
		))
			.status,
		404,
	);
	onlyShaReads(f);
});

Deno.test("compare: commits on head since the merge base, the three-dot diff from RepoProbe", async () => {
	const f = await fixture();
	const compare = createCompareHandler(f.b.depsFor);
	const owner = session(f.owner);
	const res = await get<CompareResponse>(
		f,
		compare,
		`/-/api/compare?${q({ repo: f.pub.path, base: "main", head: f.lane })}`,
		owner,
	);
	equal(res.status, 200);
	// The lane starts at main's tip.
	deepStrictEqual(res.body.commits.map((c) => c.subject), ["WIP on a lane"]);
	equal(res.body.mergeBase, f.main);
	equal(res.body.truncated, false);
	deepStrictEqual(f.b.probeCalls.at(-1), {
		a: { repoId: f.pub.id, sha: f.main },
		b: { repoId: f.pub.id, sha: f.laneHead },
		patch: false,
	});
	await get<CompareResponse>(
		f,
		compare,
		`/-/api/compare?${
			q({ repo: f.pub.path, base: "main", head: f.lane, patch: "1" })
		}`,
		owner,
	);
	equal(f.b.probeCalls.at(-1)?.patch, true);
	const back = await get<CompareResponse>(
		f,
		compare,
		`/-/api/compare?${q({ repo: f.pub.path, base: "v1", head: "main" })}`,
		null,
	);
	deepStrictEqual(back.body.commits.map((c) => c.subject), ["Bump a"]);
	equal(back.body.mergeBase, f.tag);
	const same = await get<CompareResponse>(
		f,
		compare,
		`/-/api/compare?${q({ repo: f.pub.path, base: "main", head: "main" })}`,
		owner,
	);
	deepStrictEqual(same.body.commits, []);
	equal(
		(await get(
			f,
			compare,
			`/-/api/compare?${q({ repo: f.pub.path, base: "main", head: f.lane })}`,
			null,
		))
			.status,
		404,
	);
});

Deno.test("compare with lane=<id> reads both sides from that lane, for members only (e2e: a repo lane's Diff tab)", async () => {
	const f = await fixture();
	const compare = createCompareHandler(f.b.depsFor);
	const owner = session(f.owner);
	const laneId = "ln_01k6aaaaaaaaaaaaaaaaaaaaaa";
	const res = await get<CompareResponse>(
		f,
		compare,
		`/-/api/compare?${
			q({
				repo: f.pub.path,
				base: f.main,
				head: f.laneHead,
				lane: laneId,
				patch: "1",
			})
		}`,
		owner,
	);
	equal(res.status, 200);
	equal(res.body.mergeBase, f.main);
	deepStrictEqual(res.body.commits, []);
	deepStrictEqual(f.b.probeCalls.at(-1), {
		a: { repoId: f.pub.id, laneId, sha: f.main },
		b: { repoId: f.pub.id, laneId, sha: f.laneHead },
		patch: true,
	});
	// Lanes have no public view; a lane needs SHAs; a malformed lane id is 404.
	equal(
		(await get(
			f,
			compare,
			`/-/api/compare?${
				q({ repo: f.pub.path, base: f.main, head: f.laneHead, lane: laneId })
			}`,
			null,
		)).status,
		404,
	);
	equal(
		(await get(
			f,
			compare,
			`/-/api/compare?${
				q({ repo: f.pub.path, base: "main", head: f.laneHead, lane: laneId })
			}`,
			owner,
		)).status,
		400,
	);
	equal(
		(await get(
			f,
			compare,
			`/-/api/compare?${
				q({ repo: f.pub.path, base: f.main, head: f.laneHead, lane: "LN_X" })
			}`,
			owner,
		)).status,
		404,
	);
});

Deno.test("moved repos answer 301 with the new path", async () => {
	const f = await fixture();
	const tree = createTreeHandler(f.b.depsFor);
	const platform = (await f.b.facade.resolvePath("acme/platform"))!.node;
	await f.b.facade.moveNode(f.owner, platform.id, { slug: "core" });
	const res = await f.b.call(
		tree,
		"GET",
		`/-/api/tree?${q({ repo: "acme/platform/router", path: "src" })}`,
		null,
	);
	equal(res.status, 301);
	equal(
		res.headers.get("location"),
		`/-/api/tree?${q({ repo: "acme/core/router", path: "src" })}`,
	);
});

Deno.test("raw: text/plain or attachment, always CSP sandbox and nosniff; refs with slashes, SHAs, the public view", async () => {
	const f = await fixture();
	const raw = createRawHandler(f.b.depsFor);
	const fetchRaw = (
		rest: string,
		auth: AuthContext | null,
		repo = f.pub.path,
	) =>
		f.b.call(raw, "GET", `/${repo}/-/raw/${rest}`, auth, {
			params: { repo, rest },
		});
	const html = await fetchRaw("main/web/index.html", null);
	equal(html.status, 200);
	equal(html.headers.get("content-type"), "text/plain; charset=utf-8");
	equal(html.headers.get("content-security-policy"), RAW_CSP);
	equal(html.headers.get("x-content-type-options"), "nosniff");
	equal(html.headers.get("content-disposition"), null);
	equal(await html.text(), "<script>alert(1)</script>\n");
	const png = await fetchRaw("v1/bin/logo.png", null);
	equal(png.headers.get("content-type"), "application/octet-stream");
	ok(
		png.headers.get("content-disposition")?.startsWith(
			'attachment; filename="logo.png"',
		),
	);
	equal(png.headers.get("content-security-policy"), RAW_CSP);
	deepStrictEqual(
		new Uint8Array(await png.arrayBuffer()),
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
	);
	equal(
		await (await fetchRaw("release/1.x/src/a.ts", null)).text(),
		"export const a = 1;\n",
	);
	equal(
		await (await fetchRaw(`${f.tag}/src/a.ts`, null)).text(),
		"export const a = 1;\n",
	);
	equal(
		await (await fetchRaw("refs/heads/main/src/a.ts", null)).text(),
		"export const a = 2;\n",
	);
	// Hidden refs and lane commits: 404 in the public view, readable by members.
	equal((await fetchRaw(`${f.laneHead}/src/lane-secret.ts`, null)).status, 404);
	equal(
		(await fetchRaw(`lanes/${f.lane}/src/lane-secret.ts`, null)).status,
		404,
	);
	equal(
		(await fetchRaw(`${f.laneHead}/src/lane-secret.ts`, session(f.owner)))
			.status,
		200,
	);
	// Private repo: 404 for anonymous callers, 200 with a PAT that covers it.
	equal((await fetchRaw("main/keys.txt", null, f.priv.path)).status, 404);
	const withPat = await fetchRaw("main/keys.txt", pat(f.owner), f.priv.path);
	equal(withPat.status, 200);
	equal(await withPat.text(), "private material\n");
	const noRead = await fetchRaw(
		"main/keys.txt",
		pat(f.owner, { scopes: ["api"] }),
		f.priv.path,
	);
	equal(noRead.status, 403);
	equal(noRead.headers.get("content-security-policy"), RAW_CSP);
	// Bad paths and directories.
	equal((await fetchRaw("main/src", null)).status, 404);
	equal((await fetchRaw("main", null)).status, 404);
	equal((await fetchRaw("main/%2e%2e/x", null)).status, 400);
	// Moved: 301 to the new raw path.
	const platform = (await f.b.facade.resolvePath("acme/platform"))!.node;
	await f.b.facade.moveNode(f.owner, platform.id, { slug: "core" });
	const moved = await fetchRaw("main/src/a.ts", null, "acme/platform/router");
	equal(moved.status, 301);
	equal(moved.headers.get("location"), "/acme/core/router/-/raw/main/src/a.ts");
	onlyShaReads(f);
});
