// Repo create and import (WP3; K11, [E A2]): the index row before `A.create`, a
// cloneable repo with one genesis commit on its default branch, the K1 genesis
// intent, case folding refused before any Artifacts call, public URL imports
// ended through WP5a's `importComplete`, the Owner-only import mode, rollbacks
// and the stale-create timer.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	fromRpcError,
	repoArtifactsName,
	ROLE,
	SYS_KERNEL,
	type TartanError,
} from "@tartan/contract";
import { fetchPack } from "@tartan/testkit";
import { CREATE_GRACE_MS, CREATE_TIMER_PREFIX } from "./repos.ts";
import { createTreeHarness, publicUrl } from "./testing/harness.ts";

const code = async (p: Promise<unknown>): Promise<TartanError> => {
	try {
		await p;
	} catch (error) {
		return fromRpcError(error);
	}
	throw new Error("expected a rejection");
};

const artifactsOps = (h: ReturnType<typeof createTreeHarness>) =>
	h.fake.calls.map((c) => c.op);

Deno.test("createRepo: index pending before A.create, then a cloneable repo with one genesis commit on main", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const edge = await h.groups(owner, "acme", "platform/edge");
	let pendingAtCreate: string | undefined;
	const create = h.fake.create.bind(h.fake);
	h.fake.create = ((name: string, opts?: { setDefaultBranch?: string }) => {
		pendingAtCreate = h.storage.sql.exec<{ state: string }>(
			"SELECT state FROM artifacts_index WHERE name = ?",
			name,
		).toArray()[0]?.state;
		return create(name, opts);
	}) as typeof h.fake.create;
	const repo = await h.facade.createRepo(owner, {
		parentId: edge.id,
		slug: "router",
		description: "edge router",
	});
	equal(pendingAtCreate, "pending");
	equal(repo.path, "acme/platform/edge/router");
	equal(repo.kind, "repo");
	equal(repo.defaultBranch, "main");
	equal(repo.description, "edge router");
	const name = repoArtifactsName(repo.id);
	equal(name, name.toLowerCase());
	equal((await h.facade.lookupArtifacts(name))?.state, "live");
	// RepoDO init with the node's identity.
	deepStrictEqual(h.repos.inits, [{
		repoId: repo.id,
		nodeId: repo.id,
		path: "acme/platform/edge/router",
		defaultBranch: "main",
	}]);
	// One genesis commit on main, registered as a K1 `genesis` intent first.
	const refs = h.fake.inspect.refs(name);
	deepStrictEqual(Object.keys(refs), ["refs/heads/main"]);
	const head = refs["refs/heads/main"];
	const handle = await h.fake.get(name);
	const commit = await handle.readCommit(head);
	deepStrictEqual(commit?.parents, []);
	equal(commit?.message, "Initial commit");
	const tree = await handle.readTree(commit!.treeHash);
	deepStrictEqual(tree?.map((e) => [e.name, e.type]).sort(), [
		["README.md", "blob"],
	]);
	equal(h.repos.writes.length, 1);
	equal(h.repos.writes[0].purpose, "genesis");
	equal(h.repos.writes[0].ref, "refs/heads/main");
	equal(h.repos.writes[0].new_sha, head);
	deepStrictEqual(h.repos.writes[0].marks, ["pushed"]);
	// Cloneable: a read token fetches the whole pack of main.
	const token = await handle.createToken("read", 60);
	const fetched = await fetchPack(h.fake.fetch, h.fake.remote(name), [head], {
		auth: { bearer: token.plaintext },
	});
	equal(fetched.status, 200);
	ok(fetched.objects.has(head));
	// README.md blob, the root tree and the commit.
	equal(fetched.objects.size, 3);
	// Forge events after the index went live.
	deepStrictEqual(h.events.types().slice(-2), ["node.created", "repo.created"]);
	equal(h.timers.size, 0);
	// The create token is never kept (K11): only the genesis write token and
	// the clone's read token were minted besides it.
	ok(h.fake.inspect.issuedTokens().some((t) => t.origin === "create"));
});

Deno.test("createRepo: a custom default branch is the genesis branch", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "g");
	const repo = await h.facade.createRepo(owner, {
		parentId: g.id,
		slug: "svc",
		defaultBranch: "trunk",
	});
	deepStrictEqual(
		Object.keys(h.fake.inspect.refs(repoArtifactsName(repo.id))),
		[
			"refs/heads/trunk",
		],
	);
	equal(repo.defaultBranch, "trunk");
	for (const bad of ["refs/heads/x", "has space", "", "a..b"]) {
		equal(
			(await code(h.facade.createRepo(owner, {
				parentId: g.id,
				slug: "svc2",
				defaultBranch: bad,
			}))).reason,
			"branch",
			bad,
		);
	}
});

Deno.test("createRepo: Acme-X after acme-x, a taken path and a low role are refused before A.create", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "g");
	await h.facade.createRepo(owner, { parentId: g.id, slug: "acme-x" });
	const before = artifactsOps(h).filter((op) => op === "create").length;
	const folded = await code(
		h.facade.createRepo(owner, { parentId: g.id, slug: "Acme-X" }),
	);
	equal(folded.code, "invalid");
	const taken = await code(
		h.facade.createRepo(owner, { parentId: g.id, slug: "acme-x" }),
	);
	equal(taken.reason, "path-taken");
	const dev = h.identity.user("dev");
	await h.facade.grant(owner, g.id, dev, ROLE.developer);
	equal(
		(await code(h.facade.createRepo(dev, { parentId: g.id, slug: "y" }))).code,
		"denied",
	);
	const repo = (await h.facade.resolvePath("acme/g/acme-x"))!.node;
	equal(
		(await code(h.facade.createRepo(owner, { parentId: repo.id, slug: "z" })))
			.code,
		"invalid",
	);
	equal(artifactsOps(h).filter((op) => op === "create").length, before);
});

Deno.test("createRepo: a failure after A.create rolls back the repo, the node and the index row", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "g");
	h.repos.failNext("init", new Error("repo DO unavailable"));
	equal(
		(await code(h.facade.createRepo(owner, { parentId: g.id, slug: "svc" })))
			.code,
		"internal",
	);
	equal(await h.facade.resolvePath("acme/g/svc").then((r) => r?.rest), "svc");
	const rows = h.storage.sql.exec<{ name: string; state: string }>(
		"SELECT name, state FROM artifacts_index",
	).toArray();
	equal(rows.length, 1);
	equal(rows[0].state, "deleted");
	deepStrictEqual(h.fake.inspect.names(), []);
	equal(h.timers.size, 0);
	// The path is free again.
	const again = await h.facade.createRepo(owner, {
		parentId: g.id,
		slug: "svc",
	});
	equal(again.path, "acme/g/svc");
	// A genesis failure rolls back too.
	h.repos.failNext("upstream", new Error("no token"));
	await code(h.facade.createRepo(owner, { parentId: g.id, slug: "svc2" }));
	equal((await h.facade.resolvePath("acme/g/svc2"))?.rest, "svc2");
});

Deno.test("stale create: the tree timer rolls back a pending create that is not running", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "g");
	// A genesis that never answers: the create stays in flight.
	let release: () => void = () => {};
	const hung = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h2 = createTreeHarness({
		genesis: async () => {
			await hung;
			throw new Error("gave up");
		},
	});
	const { id: owner2 } = await h2.owner("acme");
	const g2 = await h2.groups(owner2, "acme", "g");
	const pending = h2.facade.createRepo(owner2, { parentId: g2.id, slug: "svc" })
		.catch(fromRpcError);
	await new Promise((r) => setTimeout(r, 10));
	const [key, at] = [...h2.timers.entries()][0];
	ok(key.startsWith(CREATE_TIMER_PREFIX));
	equal(at, h2.clock.now() + CREATE_GRACE_MS);
	// Still running here: the timer only reschedules.
	await h2.onTimer(key);
	ok(h2.timers.has(key));
	equal((await h2.facade.resolvePath("acme/g/svc"))?.node.kind, "repo");
	release();
	equal(((await pending) as TartanError).code, "internal");
	// A pending row left behind by a restart: the timer rolls it back.
	const orphan = h.ulid();
	h.storage.sql.exec(
		"INSERT INTO nodes (id, parent_id, kind, slug, path, depth, visibility, artifacts_name, default_branch, created_by, created_at) VALUES (?, ?, 'repo', 'orphan', 'acme/g/orphan', 2, 'private', ?, 'main', ?, 0)",
		orphan,
		g.id,
		repoArtifactsName(orphan),
		owner,
	);
	await h.facade.indexArtifacts({
		name: repoArtifactsName(orphan),
		kind: "repo",
		repoId: orphan,
		state: "pending",
	});
	await h.onTimer(`${CREATE_TIMER_PREFIX}${orphan}`);
	equal(await h.facade.node(orphan), null);
	equal(
		(await h.facade.lookupArtifacts(
			repoArtifactsName(orphan),
		))?.state,
		"deleted",
	);
	// A live repo is never touched by a late timer.
	const live = await h.facade.createRepo(owner, { parentId: g.id, slug: "ok" });
	await h.onTimer(`${CREATE_TIMER_PREFIX}${live.id}`);
	equal((await h.facade.node(live.id))?.path, "acme/g/ok");
});

Deno.test("importRepo (URL): A.import, import mode ended by importComplete as the kernel, refs from the source", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "imports");
	const source = await h.fake.seed("upstream-src", {
		files: { "README.md": "hello\n", "src/a.ts": "export {}\n" },
		defaultBranch: "master",
	});
	const repo = await h.facade.importRepo(owner, {
		parentId: g.id,
		slug: "mirror",
		import: { url: `${publicUrl("upstream-src")}?ref=x#frag` },
		visibility: "public",
	});
	equal(repo.defaultBranch, "master");
	equal(repo.visibility, "public");
	const name = repoArtifactsName(repo.id);
	equal(h.fake.inspect.refs(name)["refs/heads/master"], source.head);
	deepStrictEqual(h.repos.inits.at(-1), {
		repoId: repo.id,
		nodeId: repo.id,
		path: "acme/imports/mirror",
		defaultBranch: "master",
		importState: "importing",
	});
	// The repo stream's `repo.imported` names the redacted origin too.
	deepStrictEqual(h.repos.completes, [{
		repoId: repo.id,
		by: SYS_KERNEL,
		defaultBranch: "master",
		source: publicUrl("upstream-src"),
	}]);
	equal(h.repos.writes.length, 0);
	const event = h.events.appends.at(-1)!;
	equal(event.type, "repo.imported");
	deepStrictEqual(event.data, {
		repoId: repo.id,
		path: "acme/imports/mirror",
		artifactsName: name,
		source: publicUrl("upstream-src"),
	});
	equal((await h.facade.lookupArtifacts(name))?.state, "live");
	// The import token is never kept (K11, U53): only issued, never reused.
	ok(h.fake.inspect.issuedTokens().some((t) => t.origin === "import"));
});

Deno.test("importRepo (URL): credentials, capability paths, non-https and a missing source are refused", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "imports");
	for (
		const url of [
			"https://user:pw@example.test/r.git",
			"https://code.example.test/-/cap/v1/1/ln_x/n/m/r.git",
			"http://example.test/r.git",
		]
	) {
		equal(
			(await code(h.facade.importRepo(owner, {
				parentId: g.id,
				slug: "x",
				import: { url },
			}))).reason,
			"import-url",
			url,
		);
	}
	equal(artifactsOps(h).filter((op) => op === "import").length, 0);
	const missing = await code(h.facade.importRepo(owner, {
		parentId: g.id,
		slug: "x",
		import: { url: publicUrl("does-not-exist") },
	}));
	ok(missing.code !== "invalid" || missing.reason !== "import-url");
	equal((await h.facade.resolvePath("acme/imports/x"))?.rest, "x");
});

Deno.test("importRepo (push mode): forge Owner only, importing, no genesis; importCompleted sets the branch", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "big");
	const m = h.identity.user("m");
	await h.facade.grant(owner, g.id, m, ROLE.maintainer);
	equal(
		(await code(h.facade.importRepo(m, {
			parentId: g.id,
			slug: "mono",
			import: { mode: "push" },
		}))).code,
		"denied",
	);
	const repo = await h.facade.importRepo(owner, {
		parentId: g.id,
		slug: "mono",
		import: { mode: "push" },
	});
	const name = repoArtifactsName(repo.id);
	deepStrictEqual(h.fake.inspect.refs(name), {});
	equal(h.repos.inits.at(-1)?.importState, "importing");
	equal(h.repos.writes.length, 0);
	deepStrictEqual(h.events.appends.at(-1)?.data, {
		repoId: repo.id,
		path: "acme/big/mono",
		artifactsName: name,
		source: "import-mode",
	});
	const done = await h.facade.importCompleted(owner, repo.id, "develop");
	equal(done.defaultBranch, "develop");
	equal(h.events.appends.at(-1)?.type, "repo.imported");
});

Deno.test("moves refresh the RepoDO path cache of every live repo in the subtree", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "platform/edge");
	const repo = await h.facade.createRepo(owner, {
		parentId: g.id,
		slug: "router",
	});
	const platform = (await h.facade.resolvePath("acme/platform"))!.node;
	await h.facade.moveNode(owner, platform.id, { slug: "core" });
	await Promise.all(h.waits);
	deepStrictEqual(h.repos.inits.at(-1), {
		repoId: repo.id,
		nodeId: repo.id,
		path: "acme/core/edge/router",
		defaultBranch: "main",
	});
});
