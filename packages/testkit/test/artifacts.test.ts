// FakeArtifacts: names, tokens, reads by SHA (K15), smart HTTP, import().

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { ARTIFACTS_TOKEN_RE } from "@tartan/contract";
import { isRepoStoreError } from "@tartan/contract/kernel.ts";
import {
	advertisement,
	commitChanges,
	concat,
	createFakeArtifacts,
	encodeCommit,
	fetchPack,
	flushPkt,
	lsRefsV2,
	parseCommit,
	pkt,
	push,
	text,
	utf8,
	writeTree,
	ZERO_OID,
} from "../src/index.ts";

const code = (c: string) => (e: unknown) =>
	isRepoStoreError(e, c as ArtifactsErrorCode);

Deno.test("names fold case; create, get and delete answer like the binding", async () => {
	const fake = createFakeArtifacts();
	const created = await fake.create("smoke-abc-x");
	equal(created.defaultBranch, "main");
	ok(ARTIFACTS_TOKEN_RE.test(created.token));
	equal(created.token.length, 68);
	await rejects(fake.create("smoke-ABC-X"), (e: unknown) => {
		ok(code("ALREADY_EXISTS")(e));
		equal((e as ArtifactsError).numericCode, 10201);
		return true;
	});
	const viaUpper = await fake.get("SMOKE-abc-X");
	equal((await viaUpper.info()).name, "smoke-abc-x");
	await rejects(fake.get("never-existed"), (e: unknown) => {
		ok(code("NOT_FOUND")(e));
		equal((e as ArtifactsError).numericCode, 10200);
		return true;
	});
	await rejects(fake.create("a/b"), code("INVALID_REPO_NAME"));
	await rejects(fake.create("x".repeat(1024)), code("INTERNAL_ERROR"));
	equal(await fake.delete("never-existed"), false);
	equal(await fake.delete("SMOKE-ABC-X"), true);
	await rejects(viaUpper.info(), code("NOT_FOUND"));
});

Deno.test("a handle stays bound to its repo after delete and re-create", async () => {
	const fake = createFakeArtifacts();
	await fake.create("bound");
	const old = await fake.get("bound");
	await fake.delete("bound");
	await fake.create("bound");
	await rejects(old.info(), code("NOT_FOUND"));
	const fresh = await fake.get("bound");
	equal((await fresh.info()).name, "bound");
});

Deno.test("reads resolve only short branch names and SHAs (K15)", async () => {
	const fake = createFakeArtifacts();
	const { head } = await fake.seed("reads", {
		files: { "README.md": "# hi\n", "src/a.txt": "a\n" },
	});
	const repo = await fake.get("reads");
	const sha = head!;
	equal((await repo.log({ ref: "main" }))[0].hash, sha);
	equal((await repo.log())[0].hash, sha, "log() starts at the default branch");
	equal((await repo.log({ ref: sha }))[0].hash, sha);
	for (
		const ref of ["refs/heads/main", "heads/main", "HEAD", "refs/notes/tartan"]
	) {
		deepStrictEqual(await repo.log({ ref }), [], ref);
		equal(await repo.readFile({ ref, path: "README.md" }), null, ref);
	}
	const blob = await repo.readFile({ ref: "main", path: "README.md" });
	equal(blob?.type, "text/plain;charset=utf-8");
	equal(await blob?.text(), "# hi\n");
	equal(
		await repo.readFile({ ref: sha, path: "src" }),
		null,
		"a directory is null",
	);
	equal(await repo.readFile({ ref: sha, path: "nope" }), null);
	equal(await repo.readBlob(sha), null, "readBlob(<commit sha>) is null");
	await rejects(repo.readTree("main"), code("INVALID_INPUT"));
	const commit = await repo.readCommit(sha);
	const tree = await repo.readTree(commit!.treeHash);
	deepStrictEqual(tree!.map((e) => [e.name, e.type, e.mode]), [
		["README.md", "blob", "100644"],
		["src", "tree", "40000"],
	]);
	equal((await repo.info()).lastPushAt, null);
});

Deno.test("readCommit drops extra headers and one trailing newline", async () => {
	const fake = createFakeArtifacts();
	await fake.create("headers");
	const store = fake.inspect.store("headers");
	const tree = writeTree(store, { "a.txt": "a\n" });
	const sig = { name: "T", email: "t@example.invalid", at: 1759300000 };
	const object = encodeCommit({
		tree,
		parents: [],
		author: sig,
		committer: sig,
		extraHeaders: [["change-id", "I0481624e2229c1f6db170741f2b832413828cbc1"]],
		message:
			"subject\n\nChange-Id: I0481624e2229c1f6db170741f2b832413828cbc1\n",
	});
	const [sha] = fake.putObjects("headers", [object]);
	const meta = await (await fake.get("headers")).readCommit(sha);
	equal(
		meta!.message,
		"subject\n\nChange-Id: I0481624e2229c1f6db170741f2b832413828cbc1",
	);
	ok(!JSON.stringify(meta).includes("change-id "));
	deepStrictEqual(
		parseCommit(store.get(sha)!.data).extraHeaders,
		[["change-id", "I0481624e2229c1f6db170741f2b832413828cbc1"]],
		"the object itself keeps the header",
	);
});

Deno.test("tokens: TTL bounds, listing, revocation and expiry", async () => {
	let now = Date.parse("2026-10-02T00:00:00Z");
	const fake = createFakeArtifacts({ now: () => now });
	await fake.create("tokens");
	const repo = await fake.get("tokens");
	await rejects(repo.createToken("read", 30), (e: unknown) => {
		ok(code("INVALID_TTL")(e));
		equal((e as ArtifactsError).numericCode, 10103);
		return true;
	});
	const t = await repo.createToken("read", 60);
	ok(t.plaintext.endsWith(`?expires=${Math.floor(now / 1000) + 60}`));
	equal((await repo.listTokens()).tokens[0].state, "active");
	now += 61_000;
	equal((await repo.listTokens()).tokens[0].state, "expired");
	equal(await repo.revokeToken(t.id), true);
	equal(await repo.revokeToken(t.id), false);
	// A revoked token is not listed.
	const listed = await repo.listTokens();
	equal(listed.tokens.some((x) => x.id === t.id), false);
	equal(listed.total, listed.tokens.length);
	await rejects(repo.revokeToken(""), code("INVALID_INPUT"));
});

Deno.test("smart HTTP auth matrix and per-repo token scoping", async () => {
	const fake = createFakeArtifacts();
	const a = await fake.seed("repo-a", { files: { "a.txt": "a\n" } });
	const b = await fake.seed("repo-b", { files: { "b.txt": "b\n" } });
	const urlA = fake.remote("repo-a");
	const noAuth = await fake.fetch(
		new Request(`${urlA}/info/refs?service=git-upload-pack`),
	);
	equal(noAuth.status, 401);
	equal(noAuth.headers.get("www-authenticate"), 'Basic realm="artifacts"');
	for (
		const auth of [
			{ bearer: a.token },
			{ bearer: a.token.split("?")[0] },
			{ basic: { user: "x", password: a.token.split("?")[0] } },
			{ basic: { user: "x", password: a.token } },
		]
	) {
		const adv = await advertisement(fake.fetch, urlA, { auth });
		equal(adv.status, 200, JSON.stringify(Object.keys(auth)));
		equal(adv.refs.get("refs/heads/main"), a.head);
	}
	const bogus = await advertisement(fake.fetch, urlA, {
		auth: { bearer: "art_v2_x_0000000000000000000000000000000000000000" },
	});
	equal(bogus.status, 403);
	equal(text(bogus.raw), "Invalid or expired token\n");
	// A token minted for repo-b can neither read nor write repo-a.
	const crossRead = await advertisement(fake.fetch, urlA, {
		auth: { bearer: b.token },
	});
	equal(crossRead.status, 403);
	const store = fake.inspect.store("repo-a");
	const next = commitChanges(store, a.head, { "x.txt": "x\n" }, {
		message: "cross",
	});
	const crossWrite = await push(
		fake.fetch,
		urlA,
		[{ ref: "refs/heads/main", old: a.head!, new: next }],
		[],
		{ auth: { bearer: b.token } },
	);
	equal(crossWrite.status, 403);
	equal(fake.inspect.refs("repo-a")["refs/heads/main"], a.head);
	// A read token cannot push.
	const read = await (await fake.get("repo-a")).createToken("read", 600);
	const readAdv = await advertisement(fake.fetch, urlA, {
		service: "git-receive-pack",
		auth: { bearer: read.plaintext },
	});
	equal(readAdv.status, 403);
	equal(text(readAdv.raw), "Insufficient permissions\n");
});

Deno.test("receive-pack: report-status, CAS, empty pack and push events", async () => {
	const fake = createFakeArtifacts();
	const seeded = await fake.seed("push", { files: { "a.txt": "a\n" } });
	const url = fake.remote("push");
	const auth = { bearer: seeded.token };
	// Build three commits client-side.
	const client = createFakeArtifacts();
	await client.create("scratch");
	const store = client.inspect.store("scratch");
	fake.inspect.store("push").oids().forEach((oid) =>
		store.put(fake.inspect.store("push").get(oid)!)
	);
	let tip = seeded.head!;
	const created: string[] = [];
	for (let i = 1; i <= 3; i++) {
		tip = commitChanges(store, tip, { [`f${i}.txt`]: `${i}\n` }, {
			message: `c${i}`,
			at: 1_790_000_000 + i,
		});
		created.push(tip);
	}
	const objects = store.oids().map((oid) => store.get(oid)!);
	const ok1 = await push(
		fake.fetch,
		url,
		[
			{ ref: "refs/heads/main", old: seeded.head!, new: tip },
		],
		objects,
		{ auth },
	);
	equal(ok1.unpack, "ok");
	equal(ok1.refs.get("refs/heads/main"), "ok");
	const ev = fake.pushEvents.at(-1)!;
	equal(ev.type, "cf.artifacts.repo.pushed");
	deepStrictEqual(ev.source, { namespace: "tartan-test", repoName: "push" });
	deepStrictEqual(ev.payload.commits.map((c) => c.id), [...created].reverse());
	equal(ev.payload.totalCommitsCount, 3);
	// Wrong old SHA (update) and create of an existing ref both answer `ng`.
	const stale = await push(
		fake.fetch,
		url,
		[
			{ ref: "refs/heads/main", old: seeded.head!, new: created[0] },
		],
		[],
		{ auth },
	);
	ok(stale.refs.get("refs/heads/main")!.length > 2);
	const dupCreate = await push(
		fake.fetch,
		url,
		[
			{ ref: "refs/heads/main", new: created[0] },
		],
		[],
		{ auth },
	);
	ok(dupCreate.refs.get("refs/heads/main") !== "ok");
	// A ref-only create at an existing object with an empty pack, and a tag.
	const before = fake.pushEvents.length;
	const refOnly = await push(
		fake.fetch,
		url,
		[
			{ ref: "refs/heads/lanes/x", new: created[0] },
			{ ref: "refs/tags/v1", new: created[1] },
		],
		[],
		{ auth },
	);
	equal(refOnly.refs.get("refs/heads/lanes/x"), "ok");
	equal(fake.pushEvents.length, before + 2, "one event per ref");
	deepStrictEqual(fake.pushEvents.at(-1)!.payload.commits, []);
	// A no-op push emits nothing.
	await push(
		fake.fetch,
		url,
		[
			{ ref: "refs/heads/lanes/x", old: created[0], new: created[0] },
		],
		[],
		{ auth },
	);
	equal(fake.pushEvents.length, before + 2);
	// The `0000` probe is answered with an empty 200.
	const probe = await fake.fetch(
		new Request(`${url}/git-receive-pack`, {
			method: "POST",
			headers: { authorization: `Bearer ${seeded.token}` },
			body: flushPkt(),
		}),
	);
	equal(probe.status, 200);
	equal((await probe.arrayBuffer()).byteLength, 0);
});

Deno.test("push events cap commits at 20 and the count at 21", async () => {
	const fake = createFakeArtifacts();
	const seeded = await fake.seed("deep", { files: { "a.txt": "0\n" } });
	const store = fake.inspect.store("deep");
	let tip = seeded.head!;
	for (let i = 1; i <= 30; i++) {
		tip = commitChanges(store, tip, { "a.txt": `${i}\n` }, {
			message: `deep ${i}`,
			at: 1_790_000_000 + i,
		});
	}
	fake.setRef("deep", "refs/heads/main", tip);
	const p = fake.pushEvents.at(-1)!.payload;
	equal(p.commits.length, 20);
	equal(p.totalCommitsCount, 21);
	equal(p.commitsTruncated, true);
	equal(p.commits[0].id, tip);
});

Deno.test("upload-pack: a v0 raw pack ends at the pack; side-band, stock v0 capabilities and v2 ls-refs", async () => {
	const fake = createFakeArtifacts();
	const s = await fake.seed("up", {
		files: { "a.txt": "a\n" },
		alsoRefs: ["refs/heads/lanes/one", "refs/tartan/attic/x"],
	});
	const url = fake.remote("up");
	const auth = { bearer: s.token };
	const raw = await fetchPack(fake.fetch, url, [s.head!], {
		caps: [],
		auth,
	});
	equal(raw.trailing.length, 0);
	ok(raw.objects.has(s.head!));
	const banded = await fetchPack(fake.fetch, url, [s.head!], { auth });
	equal(banded.trailing.length, 0);
	ok(banded.objects.has(s.head!));
	const adv = await advertisement(fake.fetch, url, { auth });
	equal(adv.headSymref, "refs/heads/main");
	ok(adv.caps.includes("ofs-delta"));
	const ls = await lsRefsV2(fake.fetch, url, {
		prefixes: ["refs/heads/lanes/"],
		auth,
	});
	deepStrictEqual(ls.lines, [`${s.head} refs/heads/lanes/one`]);
	const head = await lsRefsV2(fake.fetch, url, {
		prefixes: ["HEAD"],
		symrefs: true,
		auth,
	});
	deepStrictEqual(head.lines, [`${s.head} HEAD symref-target:refs/heads/main`]);
	const unknownWant = await fetchPack(fake.fetch, url, ["1".repeat(40)], {
		auth,
	});
	ok(unknownWant.lines[0].startsWith("ERR "));
});

/** A minimal capability-style proxy: no credentials in, token upstream. */
const proxyTo = (
	upstream: { fetch: (r: Request) => Promise<Response> },
	remote: string,
	token: string,
) =>
async (request: Request): Promise<Response> => {
	const url = new URL(request.url);
	const op = url.pathname.endsWith("/info/refs")
		? "info/refs"
		: "git-upload-pack";
	const res = await upstream.fetch(
		new Request(`${remote}/${op}${url.search}`, {
			method: request.method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": request.headers.get("content-type") ?? "",
			},
			body: request.method === "POST" ? await request.arrayBuffer() : null,
		}),
	);
	return new Response(await res.arrayBuffer(), { status: res.status });
};

Deno.test("import() pulls through the caller's fetch and keeps the branch name", async () => {
	const canonical = createFakeArtifacts({ namespace: "canonical" });
	const src = await canonical.seed("r-src", {
		files: { "a.txt": "a\n" },
		alsoRefs: ["refs/heads/feat-a"],
	});
	const lanes = createFakeArtifacts({
		namespace: "lanes",
		fetch: proxyTo(canonical, canonical.remote("r-src"), src.token),
	});
	const result = await lanes.import({
		source: {
			url: "https://forge.example/-/cap/v1/x/r-src.git",
			branch: "feat-a",
		},
		target: { name: "l-lane-1" },
	});
	equal(result.defaultBranch, "feat-a");
	deepStrictEqual(lanes.inspect.refs("l-lane-1"), {
		"refs/heads/feat-a": src.head,
	});
	equal(lanes.pushEvents.length, 0, "an import emits no push event");
	const info = await (await lanes.get("l-lane-1")).info();
	equal(info.source, "https://forge.example/-/cap/v1/x/r-src.git");
	const reqs = lanes.inspect.importRequests();
	deepStrictEqual(reqs.map((r) => [r.method, r.userAgent, r.gitProtocol]), [
		["GET", "artifacts/1.0", null],
		["POST", "artifacts/1.0", null],
	]);
	const issued = lanes.inspect.issuedTokens().filter((t) =>
		t.origin === "import"
	);
	equal(issued.length, 1);
	equal(issued[0].plaintext, result.token);
});

Deno.test("import() without branch: info() says main, HEAD keeps the source branch", async () => {
	const canonical = createFakeArtifacts({ namespace: "canonical" });
	const src = await canonical.seed("r-master", {
		files: { "a.txt": "a\n" },
		defaultBranch: "master",
	});
	const lanes = createFakeArtifacts({
		namespace: "lanes",
		fetch: proxyTo(canonical, canonical.remote("r-master"), src.token),
	});
	await lanes.import({
		source: { url: "https://forge.example/r-master.git" },
		target: { name: "r-imported" },
	});
	deepStrictEqual(lanes.inspect.refs("r-imported"), {
		"refs/heads/master": src.head,
	});
	// The fake's `info()` reports `main` here; callers take the default
	// branch from the repo node or the advertised HEAD instead.
	equal((await (await lanes.get("r-imported")).info()).defaultBranch, "main");
});

Deno.test("import() faults: MEMORY_LIMIT, 429, missing branch, auth", async () => {
	const canonical = createFakeArtifacts();
	const src = await canonical.seed("r-src", { files: { "a.txt": "a\n" } });
	const viaProxy = proxyTo(canonical, canonical.remote("r-src"), src.token);
	const small = createFakeArtifacts({ fetch: viaProxy, importMaxBytes: 64 });
	const params = (name: string, branch = "main") => ({
		source: { url: "https://forge.example/cap.git", branch },
		target: { name },
	});
	await rejects(small.import(params("l-big")), code("MEMORY_LIMIT"));
	const lanes = createFakeArtifacts({ fetch: viaProxy });
	lanes.faults.inject({
		op: "import",
		fault: { kind: "rate-limit" },
		times: 1,
	});
	await rejects(
		lanes.import(params("l-a")),
		(e: unknown) => (e as { status?: number }).status === 429,
	);
	await lanes.import(params("l-a"));
	lanes.faults.inject({
		op: "import",
		fault: { kind: "error", code: "INTERNAL_ERROR" },
		times: 1,
	});
	await rejects(lanes.import(params("l-b")), code("INTERNAL_ERROR"));
	await rejects(lanes.import(params("l-c", "nope")), code("NOT_FOUND"));
	const noAuth = createFakeArtifacts({
		host: "other.artifacts.fake.test",
		fetch: canonical.fetch,
	});
	await rejects(
		noAuth.import({
			source: { url: `${canonical.remote("r-src")}`, branch: "main" },
			target: { name: "l-d" },
		}),
		code("REMOTE_AUTH_REQUIRED"),
		"the importer sends no credentials",
	);
	await rejects(
		lanes.import({ source: { url: "http://x" }, target: { name: "l-e" } }),
		code("INVALID_INPUT"),
	);
});

Deno.test("import() can outlive its caller and holds the name meanwhile", async () => {
	const canonical = createFakeArtifacts();
	const src = await canonical.seed("r-src", { files: { "a.txt": "a\n" } });
	const lanes = createFakeArtifacts({
		fetch: proxyTo(canonical, canonical.remote("r-src"), src.token),
	});
	const params = (name: string) => ({
		source: { url: "https://forge.example/cap.git", branch: "main" },
		target: { name },
	});
	// Timeout that still completes later.
	lanes.faults.inject({
		op: "import",
		fault: { kind: "timeout", ms: 5, complete: true, lateMs: 20 },
		times: 1,
	});
	await rejects(
		lanes.import(params("l-late")),
		(e: unknown) => (e as Error).name === "TimeoutError",
	);
	await rejects(lanes.get("l-late"), code("IMPORT_IN_PROGRESS"));
	await new Promise((r) => setTimeout(r, 60));
	equal((await (await lanes.get("l-late")).info()).defaultBranch, "main");
	deepStrictEqual(lanes.inspect.lateImports(), [{ name: "l-late", ok: true }]);
	// Timeout that never completes frees the name.
	lanes.faults.inject({
		op: "import",
		fault: { kind: "timeout", ms: 1 },
		times: 1,
	});
	await rejects(lanes.import(params("l-gone")));
	await rejects(lanes.get("l-gone"), code("NOT_FOUND"));
	// Held import: deterministic in-flight window.
	const hold = lanes.faults.inject({
		op: "import",
		fault: { kind: "hold" },
		times: 1,
	});
	const pending = lanes.import(params("l-held"));
	await rejects(lanes.get("l-held"), code("IMPORT_IN_PROGRESS"));
	await rejects(lanes.create("L-HELD"), code("ALREADY_EXISTS"));
	hold.release();
	equal((await pending).name, "l-held");
});

Deno.test("binding faults apply per op and per argument", async () => {
	const fake = createFakeArtifacts();
	await fake.seed("big", { files: { "a.txt": "a\n" } });
	await fake.seed("small", { files: { "a.txt": "a\n" } });
	fake.faults.inject({
		op: "repo.readFile",
		fault: { kind: "error", code: "MEMORY_LIMIT" },
		match: ([name]) => name === "big",
	});
	const big = await fake.get("big");
	await rejects(big.readFile({ ref: "main", path: "a.txt" }), (e: unknown) => {
		ok(code("MEMORY_LIMIT")(e));
		equal((e as ArtifactsError).numericCode, 10402);
		return true;
	});
	const small = await fake.get("small");
	equal(
		await (await small.readFile({ ref: "main", path: "a.txt" }))!.text(),
		"a\n",
	);
	ok(fake.calls.some((c) => c.op === "repo.readFile" && c.outcome === "error"));
	ok(
		!fake.calls.some((c) => /art_v2_x_[0-9a-f]{40}/.test(c.detail)),
		"calls are redacted",
	);
});

Deno.test("a repo handle implements the methods Tartan calls", async () => {
	const fake = createFakeArtifacts();
	await fake.create("x");
	const repo: Record<string, unknown> = { ...(await fake.get("x")) };
	for (
		const method of [
			"createToken",
			"info",
			"listTokens",
			"log",
			"readBlob",
			"readCommit",
			"readFile",
			"readTree",
			"revokeToken",
		]
	) {
		equal(typeof repo[method], "function", method);
	}
});

Deno.test("list pages with a cursor and omits nothing", async () => {
	const fake = createFakeArtifacts();
	for (let i = 0; i < 5; i++) await fake.create(`r-${i}`);
	const first = await fake.list({ limit: 2 });
	equal(first.total, 5);
	equal(first.repos.length, 2);
	const second = await fake.list({ limit: 10, cursor: first.cursor });
	equal(second.repos.length, 3);
	equal(second.cursor, undefined);
	ok(!("remote" in first.repos[0]));
});

Deno.test("a gzip-encoded upload-pack request is decoded", async () => {
	const fake = createFakeArtifacts();
	const s = await fake.seed("gz", { files: { "a.txt": "a\n" } });
	const body = concat([
		pkt(`want ${s.head} side-band-64k\n`),
		flushPkt(),
		pkt("done\n"),
	]);
	const gz = new Uint8Array(
		await new Response(
			new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
	const res = await fetchPack(fake.fetch, fake.remote("gz"), [], {
		auth: { bearer: s.token },
		headers: { "content-encoding": "gzip" },
		body: gz,
	});
	ok(res.objects.has(s.head!));
	void utf8;
	void ZERO_OID;
});
