// The repo itself and the Artifacts seams of RepoDO core (WP5a; K11, K15, K17):
// init, info, resolveRef without the binding, import mode's end,
// `trunk_commits` and the size estimate, the memory-only token cache and the
// control bucket, `laneFetchSpecs` and `trunkSeqs`.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	fromRpcError,
	laneArtifactsName,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import type { LaneOpActor } from "@tartan/contract/kernel.ts";
import {
	MAX_ACTIVE_LANES,
	MAX_ACTIVE_LANES_REPO_BACKEND,
	MAX_LANE_REPOS_FORGE,
} from "../../constants.ts";
import { ROLE_CACHE_MS } from "./roles.ts";
import {
	createClock,
	createHarness,
	fakeRepoBackend,
	principals,
	sha,
	TRUNK,
} from "./testing/harness.ts";
import { createControlBucket } from "./upstream.ts";

const agent = (id: string): LaneOpActor => ({ kind: "agent", id });

Deno.test("init is idempotent per repo, refuses another repo, and info reads meta plus the node", async () => {
	const h = await createHarness();
	const info = await h.facade.info();
	deepStrictEqual(info, {
		id: h.repoId,
		nodeId: h.nodeId,
		path: "acme/shop",
		defaultBranch: "main",
		visibility: "private",
		trunkSha: TRUNK,
		landingPaused: false,
	});
	equal(h.events.ofType("repo.created").length, 1);
	await h.facade.init({
		repoId: h.repoId,
		nodeId: h.nodeId,
		path: "acme/shop-renamed",
		defaultBranch: "main",
	});
	equal(h.internal.metaSync("path"), "acme/shop-renamed");
	equal(h.events.ofType("repo.created").length, 1);
	await rejects(
		() =>
			h.facade.init({
				repoId: h.ulid(),
				nodeId: h.nodeId,
				path: "acme/other",
				defaultBranch: "main",
			}),
		(e: unknown) => fromRpcError(e).code === "conflict",
	);
	const fresh = await createHarness({ noInit: true });
	await rejects(
		() => fresh.facade.info(),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
	await rejects(
		() =>
			fresh.facade.openLane({
				owner: "a_01k6c0ffee0000000000000000",
				actor: agent("a_01k6c0ffee0000000000000000"),
			}),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
});

Deno.test("resolveRef answers refs/heads/main, a short name, a tag (peeled), a lane head and a SHA without the binding", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	h.storage.sql.exec(
		"INSERT INTO refs (ref, sha, updated_at, peeled) VALUES ('refs/tags/v1', ?, 0, ?)",
		sha(1000),
		sha(1001),
	);
	const lane = await h.facade.openLane({ owner: a, actor: agent(a) });
	h.artifactsCalls.length = 0;
	equal(await h.facade.resolveRef("refs/heads/main"), TRUNK);
	equal(await h.facade.resolveRef("main"), TRUNK);
	equal(await h.facade.resolveRef("HEAD"), TRUNK);
	equal(await h.facade.resolveRef("refs/tags/v1"), sha(1001));
	equal(await h.facade.resolveRef("v1"), sha(1001));
	equal(
		await h.facade.resolveRef(lane.id),
		TRUNK,
		"an unpushed lane is at its base",
	);
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(1002) }],
		principal: a,
		via: "gateway",
		requestId: "r1",
	});
	equal(await h.facade.resolveRef(lane.id), sha(1002));
	equal(await h.facade.resolveRef(lane.ref), sha(1002));
	equal(await h.facade.resolveRef(sha(5)), sha(5));
	equal(await h.facade.resolveRef("refs/heads/nope"), null);
	equal(await h.facade.resolveRef("ln_01k6c0ffee0000000000000000"), null);
	deepStrictEqual(h.artifactsCalls, []);
	deepStrictEqual(h.upstream.lsRefsCalls, []);
});

Deno.test("import mode: importComplete reconciles refs, sets the default branch, seeds trunk_commits and turns protection on", async () => {
	const h = await createHarness({ noInit: true });
	const { user: owner } = principals(h);
	await h.facade.init({
		repoId: h.repoId,
		nodeId: h.nodeId,
		path: "acme/imported",
		defaultBranch: "main",
		importState: "importing",
	} as never);
	const ctx = await h.facade.pushContext({
		principal: owner,
		kind: "user",
		via: "pat",
		scopes: ["repo:write"],
		nodeId: null,
		laneId: null,
		maxRole: 50,
		isAdmin: true,
	}, null);
	equal(ctx.importState, "importing");
	deepStrictEqual(ctx.protectedPatterns, [], "no protection while importing");
	await rejects(
		() => h.facade.openLane({ owner, actor: { kind: "user", id: owner } }),
		(e: unknown) => fromRpcError(e).code === "conflict",
		"no lanes while importing",
	);
	// The Owner pushed history in segments.
	h.upstream.set(h.canonical, "refs/heads/trunk", sha(1100));
	h.upstream.set(h.canonical, "refs/heads/old", sha(1101));
	h.upstream.set(h.canonical, "refs/tags/v1", sha(1102));
	await rejects(
		() => h.facade.importComplete(owner, { defaultBranch: "trunk" }),
		(e: unknown) => fromRpcError(e).code === "denied",
	);
	h.tree.roles.set(owner, ROLE.owner);
	h.clock.advance(ROLE_CACHE_MS + 1);
	await rejects(
		() => h.facade.importComplete(owner, { defaultBranch: "nope" }),
		(e: unknown) => fromRpcError(e).code === "invalid",
	);
	const done = await h.facade.importComplete(owner, { defaultBranch: "trunk" });
	deepStrictEqual(done, {
		repoId: h.repoId,
		defaultBranch: "trunk",
		trunkSha: sha(1100),
		refs: 3,
		trunkCommits: 3,
	});
	deepStrictEqual(
		h.storage.sql.exec<{ sha: string; seq: number; source: string }>(
			"SELECT sha, seq, source FROM trunk_commits ORDER BY seq DESC",
		).toArray(),
		[
			{ sha: sha(1100), seq: 0, source: "import" },
			{ sha: sha(9001), seq: -1, source: "import" },
			{ sha: sha(9002), seq: -2, source: "import" },
		],
	);
	equal(h.internal.metaSync("import_state"), "none");
	equal(h.internal.metaSync("trunk_sha"), sha(1100));
	const imported = h.events.ofType("repo.imported");
	equal(imported.length, 1);
	// An Owner push import names no origin.
	equal((imported[0].data as { source?: string }).source, "import-mode");
	const after = await h.facade.pushContext({
		principal: owner,
		kind: "user",
		via: "pat",
		scopes: ["repo:write"],
		nodeId: null,
		laneId: null,
		maxRole: 50,
		isAdmin: true,
	}, null);
	deepStrictEqual(after.protectedPatterns, ["refs/heads/trunk"]);
	await rejects(
		() => h.facade.importComplete(owner, {}),
		(e: unknown) => fromRpcError(e).code === "conflict",
	);
});

Deno.test("importComplete: a kernel caller's source names a URL import's origin in repo.imported", async () => {
	const h = await createHarness({ noInit: true });
	const { user: owner } = principals(h);
	await h.facade.init({
		repoId: h.repoId,
		nodeId: h.nodeId,
		path: "acme/mirror",
		defaultBranch: "main",
		importState: "importing",
	} as never);
	h.upstream.set(h.canonical, "refs/heads/main", sha(1200));
	h.tree.roles.set(owner, ROLE.owner);
	await h.facade.importComplete(
		owner,
		{},
		"https://code.example.test/upstream.git",
	);
	const imported = h.events.ofType("repo.imported");
	equal(imported.length, 1);
	equal(
		(imported[0].data as { source?: string }).source,
		"https://code.example.test/upstream.git",
	);
});

Deno.test("K17: genesis is seq 0, each landing appends in trunk order; trunkSeqs batches; landed lanes' gateway bytes grow the size estimate", async () => {
	const h = await createHarness({ noInit: true });
	const { agent: a, user: u } = principals(h);
	await h.facade.init({
		repoId: h.repoId,
		nodeId: h.nodeId,
		path: "acme/shop",
		defaultBranch: "main",
	});
	const genesis = await h.facade.registerKernelWrite({
		target: "repo",
		ref: "refs/heads/main",
		expectOld: ZERO_SHA,
		newSha: TRUNK,
		purpose: "genesis",
		ownerKind: "kernel",
		ownerId: "genesis",
	});
	await h.facade.markKernelWrite(genesis.id, "pushed");
	equal(h.internal.metaSync("trunk_sha"), TRUNK);
	const lane = await h.facade.openLane({ owner: a, actor: agent(a) });
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(1200) }],
		principal: a,
		via: "gateway",
		requestId: "r1",
		bytes: 5000,
	});
	await h.facade.recordPush({
		target: "repo",
		refs: [{ ref: "refs/heads/human", before: ZERO_SHA, after: sha(1201) }],
		principal: u,
		via: "gateway",
		requestId: "r2",
		bytes: 9_999_999,
	});
	h.storage.sql.exec(
		"INSERT INTO meta (k, v) VALUES ('trunk_pack_bytes', '1000')",
	);
	h.storage.transactionSync(() =>
		h.internal.recordLandingSync({
			trunkCommits: [sha(1300), sha(1301)],
			landedLaneIds: [lane.id],
		})
	);
	deepStrictEqual(
		await h.facade.trunkSeqs([TRUNK, sha(1300), sha(1301), sha(1200)]),
		{ [TRUNK]: 0, [sha(1300)]: 1, [sha(1301)]: 2 },
	);
	equal(
		h.internal.metaSync("trunk_pack_bytes"),
		"6000",
		"the human push never counts",
	);
	h.storage.transactionSync(() =>
		h.internal.recordLandingSync({
			trunkCommits: [sha(1301), sha(1302)],
			landedLaneIds: [],
		})
	);
	deepStrictEqual(await h.facade.trunkSeqs([sha(1302)]), { [sha(1302)]: 3 });
});

Deno.test("upstream: memory-only tokens per (repo, scope), refreshed 60 s early; a lane's Upstream comes from its backend", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	h.artifactsCalls.length = 0;
	const first = await h.facade.upstream({}, "read");
	equal(first.artifactsName, h.canonical);
	equal(first.kind, "canonical");
	equal(first.ref, "refs/heads/main");
	equal(first.remote, h.upstream.remoteOf(h.canonical));
	ok(first.token.startsWith("art_v2_"));
	const again = await h.facade.upstream({}, "read");
	equal(again.token, first.token);
	const write = await h.facade.upstream({}, "write");
	equal(write.artifactsName, h.canonical);
	equal(
		h.artifactsCalls.filter((c) => c.method === "createToken").length,
		2,
		"one per scope",
	);
	h.clock.advance(541_000);
	await h.facade.upstream({}, "read");
	equal(h.artifactsCalls.filter((c) => c.method === "createToken").length, 3);
	const lane = await h.facade.openLane({ owner: a, actor: agent(a) });
	const laneUp = await h.facade.upstream({ laneId: lane.id }, "write");
	equal(laneUp.kind, "lane-branch");
	equal(laneUp.ref, lane.ref);
	equal(laneUp.artifactsName, h.canonical);
	// Nothing about the token reaches storage or the event log.
	const dump = JSON.stringify([
		h.storage.sql.exec("SELECT * FROM meta").toArray(),
		h.events.all(),
	]);
	ok(!dump.includes("art_v2_"));
	await rejects(
		() =>
			h.facade.upstream({ laneId: "ln_01k6c0ffee0000000000000000" }, "read"),
		(e: unknown) => fromRpcError(e).code === "not_found",
	);
});

Deno.test("the control bucket paces calls at 20/s and backs off 1 s, 2 s, 4 s on a 429", async () => {
	const clock = createClock(0);
	const sleeps: number[] = [];
	const bucket = createControlBucket({
		clock,
		sleep: (ms) => {
			sleeps.push(ms);
			clock.advance(ms);
			return Promise.resolve();
		},
		perSecond: 20,
	});
	for (let i = 0; i < 20; i++) await bucket.take();
	equal(sleeps.length, 0);
	await bucket.take();
	equal(sleeps.length, 1);
	equal(sleeps[0], 50);
	bucket.backoff();
	equal(bucket.pausedUntil(), clock.now() + 1000);
	bucket.backoff();
	equal(bucket.pausedUntil(), clock.now() + 2000);
	bucket.backoff();
	equal(bucket.pausedUntil(), clock.now() + 4000);
	const before = clock.now();
	await bucket.take();
	ok(clock.now() >= before + 4000);
});

Deno.test("laneFetchSpecs: by SHA from where each lane lives; unknown lanes are skipped", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lane = await h.facade.openLane({ owner: a, actor: agent(a) });
	await h.facade.recordPush({
		target: lane.id,
		refs: [{ ref: lane.ref, before: ZERO_SHA, after: sha(1400) }],
		principal: a,
		via: "gateway",
		requestId: "r1",
	});
	const specs = await h.facade.laneFetchSpecs([
		lane.id,
		"ln_01k6c0ffee0000000000000000",
	]);
	deepStrictEqual(specs, [{
		remote: h.upstream.remoteOf(h.canonical),
		sha: sha(1400),
		token: { artifactsName: h.canonical, scope: "read" },
	}]);
});

Deno.test("lane settings: the core serves them on the branch backend; an Owner changes them", async () => {
	const h = await createHarness();
	const { user: u } = principals(h);
	const by: LaneOpActor = { kind: "user", id: u };
	// Defaults on a branch-lane repo: no WP5b backend involved.
	deepStrictEqual(await h.facade.laneSettings(), {
		laneMode: "branch",
		effectiveMode: "branch",
		trunkPackBytes: null,
		maxActiveLanes: MAX_ACTIVE_LANES,
		atticRetentionDays: 7,
		retainedLaneRepos: 0,
		maxLaneReposForge: MAX_LANE_REPOS_FORGE,
	});
	await rejects(
		() => h.facade.setLaneSettings({ maxActiveLanes: 5 }, by),
		(e: unknown) => fromRpcError(e).code === "denied",
	);
	h.tree.roles.set(u, ROLE.owner);
	h.clock.advance(ROLE_CACHE_MS + 1);
	await rejects(
		() => h.facade.setLaneSettings({ maxActiveLanes: 0 }, by),
		(e: unknown) => fromRpcError(e).code === "invalid",
	);
	// An Owner may put the repo's lanes in their own repositories (M2).
	equal(
		(await h.facade.setLaneSettings({ laneMode: "import" }, by)).laneMode,
		"import",
	);
	equal(h.internal.metaSync("lane_mode"), "import");
	await h.facade.setLaneSettings({ laneMode: null }, by);
	equal(h.internal.metaSync("lane_mode"), null);
	const saved = await h.facade.setLaneSettings({
		laneMode: "branch",
		maxActiveLanes: 5,
		atticRetentionDays: 14,
	}, by);
	equal(saved.maxActiveLanes, 5);
	equal(saved.atticRetentionDays, 14);
	deepStrictEqual(await h.facade.laneSettings(), saved);
	equal(h.internal.metaSync("lane_mode"), "branch");
	equal(h.internal.metaSync("attic_retention_ms"), String(14 * 86_400_000));
	// The cap applies to opens at once.
	const open = () => {
		const id = `a_${h.ulid()}`;
		return h.facade.openLane({ owner: id, actor: agent(id) });
	};
	for (let i = 0; i < 5; i++) await open();
	await rejects(open, (e: unknown) => fromRpcError(e).code === "denied");
	// null clears the override; the forge default answers.
	equal(
		(await h.facade.setLaneSettings({ laneMode: null }, by)).laneMode,
		"branch",
	);
	equal(h.internal.metaSync("lane_mode"), null);
});

Deno.test("lane settings: the repo backend's breaker and size flag are shown while they hold", async () => {
	const h = await createHarness({
		laneMode: "import",
		createRepoBackend: fakeRepoBackend(),
	});
	const now = h.clock.now();
	h.storage.sql.exec(
		"INSERT INTO meta (k, v) VALUES ('lane_breaker', ?), ('import_too_large_until', ?), ('trunk_pack_bytes', '4096')",
		JSON.stringify({ strikes: [], degradedTo: "branch", until: now + 60_000 }),
		String(now + 30_000),
	);
	const settings = await h.facade.laneSettings();
	deepStrictEqual(
		{
			laneMode: settings.laneMode,
			effectiveMode: settings.effectiveMode,
			degradedUntil: settings.degradedUntil,
			importTooLargeUntil: settings.importTooLargeUntil,
			trunkPackBytes: settings.trunkPackBytes,
			maxActiveLanes: settings.maxActiveLanes,
		},
		{
			laneMode: "import",
			effectiveMode: "branch",
			degradedUntil: now + 60_000,
			importTooLargeUntil: now + 30_000,
			trunkPackBytes: 4096,
			maxActiveLanes: MAX_ACTIVE_LANES_REPO_BACKEND,
		},
	);
	// The forge default may be `import`: re-sending it is no change.
	const { user: u } = principals(h);
	h.tree.roles.set(u, ROLE.owner);
	equal(
		(await h.facade.setLaneSettings({ laneMode: "import" }, {
			kind: "user",
			id: u,
		})).laneMode,
		"import",
	);
	h.clock.advance(60_001);
	const later = await h.facade.laneSettings();
	equal(later.effectiveMode, "import");
	equal(later.degradedUntil, undefined);
	equal(later.importTooLargeUntil, undefined);
	ok(laneArtifactsName(h.repoId, h.ulid()).startsWith("l-"));
});
