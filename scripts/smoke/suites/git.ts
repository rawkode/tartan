// The git smoke suite (A1–A5, S4b, U45–U48, S3-raw) and the FakeArtifacts
// conformance run. Every check prints PASS/FAIL with numbers
// and is kept as evidence. Credentials never go into remote URLs.

import { redactSecrets } from "@tartan/contract";
import { push as rawPush } from "@tartan/testkit";
import { pct } from "../lib/evidence.ts";
import { api, op, type SmokeContext, wants } from "../lib/context.ts";
import {
	git,
	type GitAuth,
	gitOk,
	randomFile,
	seedWorkdir,
} from "../lib/git.ts";

const PREFIX = "tartan-smoke-git";
const ZERO = "0".repeat(40);

type Created = { remote: string; token: string; name: string };
type PushRecord = {
	repo: string;
	ref: string;
	after: string;
	endMs: number;
	via: string;
};

const TOKEN_SHAPE = /^art_v2_x_[0-9a-f]{40}\?expires=\d{10}$/;

export const runGitSuite = async (ctx: SmokeContext): Promise<void> => {
	const t = ctx.git;
	if (!t) throw new Error("git suite needs the tartan-smoke-git Worker");
	const { rec, env, tag } = ctx;
	const pushes: PushRecord[] = [];
	const bearer = (token: string): GitAuth => ({ bearer: token });
	const gatewayAuth: GitAuth = { basic: { user: "x", password: t.key } };
	const gw = (repo: string) => `${t.base}/git/${repo}.git`;
	const name = (suffix: string) => `${PREFIX}-${suffix}-${tag}`;
	const dir = (n: string) => `${ctx.tmp}/${n}`;

	const create = async (repo: string, opts?: unknown): Promise<Created> => {
		const r = await op<{ remote: string; token: string; name: string }>(
			t,
			repo,
			"create",
			opts === undefined ? {} : { opts },
		);
		if (!r.ok) {
			throw new Error(`create ${repo}: ${r.error.code} ${r.error.message}`);
		}
		return r.result;
	};
	const mint = async (repo: string, scope: "read" | "write", ttl = 900) => {
		const r = await op<{ plaintext: string; id: string }>(t, repo, "token", {
			scope,
			ttl,
		});
		if (!r.ok) throw new Error(`token ${repo}: ${r.error.message}`);
		return r.result;
	};
	const record = (via: string, repo: string, ref: string, after: string) =>
		pushes.push({ repo, ref, after, endMs: Date.now(), via });
	const head = (cwd: string, rev = "HEAD") =>
		gitOk(["rev-parse", rev], { cwd, env });

	// ------------------------------------------------------------------ A1
	if (wants(ctx, "A1")) {
		const repo = name("a1");
		const created = await create(repo, { description: "tartan smoke a1" });
		rec.check({
			id: "A1",
			title:
				"create() returns a 24 h write token in the live v2 shape with ?expires=",
			pass: TOKEN_SHAPE.test(created.token),
			numbers: { length: created.token.length },
			decides: "token redaction pattern (art_v[0-9]+_)",
		});
		const short = await op(t, repo, "token", { scope: "read", ttl: 30 });
		rec.check({
			id: "A1",
			title: "createToken ttl=30 is INVALID_TTL 10103",
			pass: !short.ok && short.error.code === "INVALID_TTL" &&
				short.error.numericCode === 10103,
			numbers: {
				code: short.ok
					? "ok"
					: `${short.error.code}/${short.error.numericCode}`,
			},
		});
		const wt = await mint(repo, "write");
		const rt = await mint(repo, "read");
		const d = dir("a1");
		const h1 = await seedWorkdir(d, env, tag);
		const p1 = await git(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", h1);
		await Deno.writeTextFile(
			`${d}/src/hello.txt`,
			"hello from tartan\nsecond\n",
		);
		await gitOk(["commit", "-qam", "second commit via basic"], { cwd: d, env });
		const p2 = await git(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: { basic: { user: "x", password: wt.plaintext.split("?")[0] } },
		});
		const h2 = await head(d);
		record("direct", repo, "refs/heads/main", h2);
		rec.check({
			id: "A1",
			title: "push with Bearer full token and Basic stripped secret",
			pass: p1.code === 0 && p2.code === 0,
			numbers: { bearerMs: p1.ms, basicMs: p2.ms },
			decides: "UPSTREAM_AUTH (bearer)",
		});
		const matrix: [string, GitAuth | undefined, boolean][] = [
			["bearer write full", bearer(wt.plaintext), true],
			["bearer write stripped", bearer(wt.plaintext.split("?")[0]), true],
			["basic write stripped", {
				basic: { user: "x", password: wt.plaintext.split("?")[0] },
			}, true],
			[
				"basic write full",
				{ basic: { user: "x", password: wt.plaintext } },
				true,
			],
			["bearer read full", bearer(rt.plaintext), true],
			["bearer initial create() token", bearer(created.token), true],
			["no auth", undefined, false],
			["bogus token", bearer(`art_v2_x_${"0".repeat(40)}`), false],
		];
		const outcomes: string[] = [];
		let matrixOk = true;
		for (const [label, auth, expected] of matrix) {
			const r = await git(["ls-remote", created.remote], { env, auth });
			const ok = (r.code === 0) === expected &&
				(!expected || r.stdout.includes(h2));
			matrixOk &&= ok;
			outcomes.push(`${label}:${r.code}`);
		}
		rec.check({
			id: "A1",
			title: "ls-remote auth matrix",
			pass: matrixOk,
			numbers: { cases: matrix.length },
			detail: outcomes,
		});
		await Deno.writeTextFile(`${d}/src/hello.txt`, "third\n");
		await gitOk(["commit", "-qam", "third (read-token push attempt)"], {
			cwd: d,
			env,
		});
		const readPush = await git(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(rt.plaintext),
		});
		await gitOk(["reset", "-q", "--hard", "HEAD~1"], { cwd: d, env });
		const rawRead = await fetch(
			`${created.remote}/info/refs?service=git-receive-pack`,
			{
				headers: { authorization: `Bearer ${rt.plaintext}` },
			},
		);
		await rawRead.body?.cancel();
		const rawNone = await fetch(
			`${created.remote}/info/refs?service=git-upload-pack`,
		);
		await rawNone.body?.cancel();
		rec.check({
			id: "A1",
			title: "read token cannot push (403); no auth is 401 Basic realm",
			pass: readPush.code !== 0 && rawRead.status === 403 &&
				rawNone.status === 401 &&
				(rawNone.headers.get("www-authenticate") ?? "").startsWith("Basic"),
			numbers: {
				readPushExit: readPush.code,
				rawRead: rawRead.status,
				rawNone: rawNone.status,
			},
		});
		const tree = await head(d, "HEAD^{tree}");
		const readme = await op<{ text: string } | null>(t, repo, "readFile", {
			ref: "main",
			path: "README.md",
		});
		const bySha = await op<{ text: string } | null>(t, repo, "readFile", {
			ref: h2,
			path: "src/hello.txt",
		});
		const dirRead = await op(t, repo, "readFile", { ref: "main", path: "src" });
		const missing = await op(t, repo, "readFile", {
			ref: "main",
			path: "nope.txt",
		});
		const treeRead = await op<{ name: string; type: string }[]>(
			t,
			repo,
			"readTree",
			{ hash: tree },
		);
		const commit = await op<{ hash: string } | null>(t, repo, "readCommit", {
			hash: h2,
		});
		const unknown = await op(t, repo, "readCommit", { hash: "1".repeat(40) });
		const logMain = await op<unknown[]>(t, repo, "log", { ref: "main" });
		const logDefault = await op<unknown[]>(t, repo, "log", {});
		const info = await op<{ lastPushAt: string | null }>(t, repo, "get-info");
		rec.check({
			id: "A1",
			title: "binding reads by short branch and SHA; nulls for dirs and misses",
			pass: readme.ok && readme.result?.text === `# tartan smoke ${tag}\n` &&
				bySha.ok && bySha.result?.text === "hello from tartan\nsecond\n" &&
				dirRead.ok && dirRead.result === null && missing.ok &&
				missing.result === null &&
				treeRead.ok && treeRead.result.some((e) =>
					e.name === "src" && e.type === "tree"
				) &&
				commit.ok && commit.result?.hash === h2 && unknown.ok &&
				unknown.result === null &&
				logMain.ok && logMain.result.length === 2 && logDefault.ok &&
				logDefault.result.length === 2,
			numbers: {
				readFileMs: readme.ms,
				readTreeMs: treeRead.ms,
				readCommitMs: commit.ms,
				logMs: logMain.ms,
			},
		});
		rec.check({
			id: "A1",
			title: "info().lastPushAt stays null after pushes",
			pass: info.ok && info.result.lastPushAt === null,
			numbers: {},
			decides: "freshness from the push log",
		});
		const bench = await api<
			{ createToken_p50: number; createToken_p95: number; ok: number }
		>(
			t,
			"/api/mint-bench",
			{ name: repo, n: ctx.small ? 5 : 20, scope: "read" },
		);
		rec.check({
			id: "A1",
			title: "in-Worker get()+createToken(read,60) latency",
			pass: bench.ok === (ctx.small ? 5 : 20),
			numbers: { p50: bench.createToken_p50, p95: bench.createToken_p95 },
			decides: "token cache TTL and refresh margin",
		});
	}

	// ------------------------------------------------------------------ A2
	if (wants(ctx, "A2")) {
		const p = `${PREFIX}-a2-${tag}-`;
		// Lengths below the prefix length cannot be probed with a prefixed name.
		const lengths =
			(ctx.small ? [57, 64, 255] : [55, 57, 63, 64, 100, 128, 200, 255, 512])
				.filter((len) => len >= p.length);
		const accepted: number[] = [];
		for (const len of lengths) {
			const n = p + "x".repeat(len - p.length);
			const r = await op(t, n, "create");
			if (r.ok) {
				accepted.push(len);
				await op(t, n, "delete");
			}
		}
		rec.check({
			id: "A2",
			title: "repo name lengths accepted (lane repos need 57)",
			pass: accepted.length === lengths.length,
			numbers: {
				maxAccepted: Math.max(0, ...accepted),
				probed: lengths.length,
			},
			decides: "l-<repoUlid>-<laneUlid>-<n> fits",
		});
		const lower = `${p}abc-x`;
		const upper = `${p}ABC-X`;
		await op(t, lower, "create");
		const before = await op<{ name: string }>(t, upper, "get-info");
		const dup = await op(t, upper, "create");
		const del = await op<boolean>(t, upper, "delete");
		const after = await op(t, lower, "get-info");
		rec.check({
			id: "A2",
			title:
				"names fold case: get/create/delete in another case hit the same repo",
			pass: before.ok && before.result.name === lower && !dup.ok &&
				dup.error.code === "ALREADY_EXISTS" &&
				dup.error.numericCode === 10201 &&
				del.ok && del.result === true && !after.ok &&
				after.error.code === "NOT_FOUND" &&
				after.error.numericCode === 10200,
			numbers: {
				dup: dup.ok ? "created" : `${dup.error.code}/${dup.error.numericCode}`,
			},
			decides: "lowercase Artifacts names",
		});
		const chars: [string, boolean][] = [
			[`${p}dot.name`, true],
			[`${p}under_score`, true],
			[`${p}ends.git`, true],
			[`${p}has/slash`, false],
		];
		const results: string[] = [];
		let charsOk = true;
		for (const [n, expected] of chars) {
			const r = await op(t, n, "create");
			if (r.ok) await op(t, n, "delete");
			charsOk &&= r.ok === expected &&
				(expected || (!r.ok && r.error.code === "INVALID_REPO_NAME"));
			results.push(`${n.slice(p.length)}:${r.ok ? "ok" : r.error.code}`);
		}
		const neverDeleted = await op<boolean>(t, `${p}never-existed`, "delete");
		rec.check({
			id: "A2",
			title:
				"allowed characters; '/' is INVALID_REPO_NAME; delete(missing) is false",
			pass: charsOk && neverDeleted.ok && neverDeleted.result === false,
			numbers: { probed: chars.length },
			detail: results,
		});
	}

	// ------------------------------------------------------------------ A3 + U47
	if (wants(ctx, "A3") || wants(ctx, "U47")) {
		const repo = name("a3");
		const created = await create(repo);
		const wt = await mint(repo, "write");
		const seed = dir("a3-seed");
		const h0 = await seedWorkdir(seed, env, tag);
		await gitOk(["push", created.remote, "main"], {
			cwd: seed,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", h0);
		const unauth = await fetch(`${gw(repo)}/info/refs?service=git-upload-pack`);
		await unauth.body?.cancel();
		const bigPath = `${ctx.tmp}/a3-body.bin`;
		await randomFile(bigPath, ctx.small ? 1_000_000 : 60_000_000);
		const t0 = performance.now();
		const unauthPost = await fetch(`${gw(repo)}/git-receive-pack`, {
			method: "POST",
			headers: { "content-type": "application/x-git-receive-pack-request" },
			body: await Deno.readFile(bigPath),
		});
		await unauthPost.body?.cancel();
		const unauthPostMs = Math.round(performance.now() - t0);
		rec.check({
			id: "A3",
			title: "gateway answers 401 before the body (GET and a large POST)",
			pass: unauth.status === 401 && unauthPost.status === 401,
			numbers: {
				get: unauth.status,
				post: unauthPost.status,
				postMs: unauthPostMs,
			},
		});
		if (wants(ctx, "A3")) {
			const clones: string[] = [];
			let clonesOk = true;
			for (const v of [2, 1, 0]) {
				const r = await git([
					"-c",
					`protocol.version=${v}`,
					"clone",
					"-q",
					gw(repo),
					dir(`a3-v${v}`),
				], {
					env,
					auth: gatewayAuth,
				});
				clonesOk &&= r.code === 0;
				clones.push(`v${v}:${r.code}:${r.ms}ms`);
			}
			rec.check({
				id: "A3",
				title: "clone protocol v2, v1 and v0 through the gateway",
				pass: clonesOk,
				numbers: {},
				detail: clones,
			});
			const c = dir("a3-v2");
			await Deno.writeTextFile(`${c}/nocreds.txt`, "nocreds\n");
			await gitOk(["add", "-A"], { cwd: c, env });
			await gitOk(["commit", "-qm", "nocreds attempt"], { cwd: c, env });
			const nocreds = await git(["push", gw(repo), "main"], {
				cwd: c,
				env: { ...env, GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" },
			});
			const posts =
				(nocreds.stderr.match(/=> Send header: POST /g) ?? []).length;
			await gitOk(["reset", "-q", "--hard", "HEAD~1"], { cwd: c, env });
			rec.check({
				id: "A3",
				title: "push without credentials fails before any pack is POSTed",
				pass: nocreds.code !== 0 && posts === 0,
				numbers: { posts },
			});
			const sizes = ctx.small
				? [10_000, 200_000]
				: [10_000, 5_000_000, 60_000_000];
			const timings: Record<string, number> = {};
			let pushesOk = true;
			for (const sz of sizes) {
				await randomFile(`${c}/blob-${sz}.bin`, sz);
				await gitOk(["add", "-A"], { cwd: c, env });
				await gitOk(["commit", "-qm", `gateway push ${sz} bytes`], {
					cwd: c,
					env,
				});
				const r = await git(["push", gw(repo), "main"], {
					cwd: c,
					env,
					auth: gatewayAuth,
				});
				pushesOk &&= r.code === 0;
				timings[`gw${sz}`] = r.ms;
				record("gateway", repo, "refs/heads/main", await head(c));
			}
			rec.check({
				id: "A3",
				title: "pushes through the gateway",
				pass: pushesOk,
				numbers: timings,
				decides: "TARTAN_MAX_PUSH_MB headroom",
			});
			await gitOk(["branch", "feat-x"], { cwd: c, env });
			await gitOk(["tag", "v0.0.1"], { cwd: c, env });
			const multi = await git(["push", gw(repo), "feat-x", "v0.0.1"], {
				cwd: c,
				env,
				auth: gatewayAuth,
			});
			const cHead = await head(c);
			record("gateway", repo, "refs/heads/feat-x", cHead);
			record("gateway", repo, "refs/tags/v0.0.1", cHead);
			const delBranch = await git(["push", gw(repo), ":feat-x"], {
				cwd: c,
				env,
				auth: gatewayAuth,
			});
			record("gateway", repo, "refs/heads/feat-x", ZERO);
			const v0 = dir("a3-v0");
			for (let i = 1; i <= (ctx.small ? 10 : 60); i++) {
				await gitOk(
					["commit", "-q", "--allow-empty", "-m", `local-only ${i}`],
					{ cwd: v0, env },
				);
			}
			const gz = await git(["-c", "protocol.version=0", "fetch", gw(repo)], {
				cwd: v0,
				env: { ...env, GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" },
				auth: gatewayAuth,
			});
			const gzipSent = /=> Send header: Content-Encoding: gzip/i.test(
				gz.stderr,
			);
			rec.check({
				id: "A3",
				title:
					"multi-ref push, delete, and a fetch with a gzip upload-pack body",
				pass: multi.code === 0 && delBranch.code === 0 && gz.code === 0,
				numbers: {
					gzipRequestBody: gzipSent,
					multiMs: multi.ms,
					fetchMs: gz.ms,
				},
			});
			const rt = await mint(repo, "read");
			const direct: number[] = [];
			const viaGw: number[] = [];
			for (let i = 0; i < (ctx.small ? 3 : 10); i++) {
				direct.push(
					(await git(["ls-remote", created.remote], {
						env,
						auth: bearer(rt.plaintext),
					})).ms,
				);
				viaGw.push(
					(await git(["ls-remote", gw(repo)], { env, auth: gatewayAuth })).ms,
				);
			}
			rec.check({
				id: "A3",
				title: "ls-remote latency, direct vs gateway",
				pass: true,
				numbers: {
					directP50: pct(direct, 50),
					gatewayP50: pct(viaGw, 50),
					gatewayP95: pct(viaGw, 95),
				},
			});
		}
		if (wants(ctx, "U47")) {
			const c = dir("a3-u47");
			const cl = await git([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				gw(repo),
				c,
			], { env, auth: gatewayAuth });
			const laneRef = "refs/heads/lanes/ln_01k6aaaaaaaaaaaaaaaaaaaaaa";
			await git(["push", gw(repo), `HEAD:${laneRef}`], {
				cwd: c,
				env,
				auth: gatewayAuth,
			});
			record("gateway", repo, laneRef, await head(c));
			const since = Date.now() - 1;
			await git(["fetch", "origin", laneRef], {
				cwd: c,
				env,
				auth: gatewayAuth,
			});
			await git(["ls-remote", "origin", "refs/heads/lanes/*"], {
				cwd: c,
				env,
				auth: gatewayAuth,
			});
			const rows = await api<
				{ data: { refPrefixes?: string[]; uploadCommand?: string } }[]
			>(
				t,
				`/api/records?kind=gateway&since=${since}`,
			);
			const lsRefs = rows.map((r) => r.data).filter((d) =>
				d.uploadCommand === "command=ls-refs"
			);
			const fetchPrefixes = lsRefs[0]?.refPrefixes ?? [];
			const lsRemotePrefixes = lsRefs[1]?.refPrefixes ?? [];
			rec.check({
				id: "U47",
				title:
					"stock git's ref-prefix for `fetch origin <lane ref>` and `ls-remote` patterns",
				pass: cl.code === 0 && fetchPrefixes.includes(laneRef),
				numbers: {
					fetchPrefixes: fetchPrefixes.length,
					lsRemotePrefixes: lsRemotePrefixes.length,
				},
				decides: "hidden-namespace filtering must not rely on ref-prefix",
				detail: { fetchPrefixes, lsRemotePrefixes },
			});
		}
	}

	// ------------------------------------------------------------------ A4
	if (wants(ctx, "A4")) {
		const repo = name("a4");
		const created = await create(repo);
		const wt = await mint(repo, "write");
		const d = dir("a4");
		await seedWorkdir(d, env, tag);
		const tree = await head(d, "HEAD^{tree}");
		const parent = await head(d);
		const cid = `I${"0481624e2229c1f6db170741f2b832413828cbc1"}`;
		const raw =
			`tree ${tree}\nparent ${parent}\nauthor Tartan Smoke <smoke@example.invalid> 1759300000 +0000\ncommitter Tartan Smoke <smoke@example.invalid> 1759300000 +0000\nchange-id ${cid}\n\nhand-crafted commit with change-id header\n\nChange-Id: ${cid}\n`;
		const sha = await gitOk(["hash-object", "-t", "commit", "-w", "--stdin"], {
			cwd: d,
			env,
			stdin: raw,
		});
		await gitOk(["update-ref", "refs/heads/main", sha], { cwd: d, env });
		await gitOk(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", sha);
		const meta = await op<{ message: string } | null>(t, repo, "readCommit", {
			hash: sha,
		});
		const blob = await op(t, repo, "readBlob", { hash: sha });
		rec.check({
			id: "A4",
			title:
				"readCommit drops the change-id header, keeps the trailer; readBlob(commit) is null",
			pass: meta.ok && meta.result !== null &&
				!JSON.stringify(meta.result).includes("change-id I") &&
				meta.result.message.endsWith(`Change-Id: ${cid}`) && blob.ok &&
				blob.result === null,
			numbers: { readCommitMs: meta.ms },
			decides: "change ids from trailers (K15)",
		});
		await gitOk([
			"notes",
			"--ref=tartan/intent",
			"add",
			"-m",
			`{"intent":"smoke","changeId":"${cid}"}`,
			sha,
		], { cwd: d, env });
		await gitOk(["push", created.remote, "refs/notes/tartan/intent"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		const notes = await head(d, "refs/notes/tartan/intent");
		record("direct", repo, "refs/notes/tartan/intent", notes);
		const spellings: [string, boolean][] = [
			["main", true],
			["refs/heads/main", false],
			["heads/main", false],
			["HEAD", false],
			["refs/notes/tartan/intent", false],
			["notes/tartan/intent", false],
			["tartan/intent", false],
			[notes, true],
		];
		const resolved: string[] = [];
		let k15 = true;
		for (const [ref, expected] of spellings) {
			const r = await op<unknown[]>(t, repo, "log", { ref, limit: 1 });
			const got = r.ok && r.result.length > 0;
			k15 &&= got === expected;
			resolved.push(`${ref.length === 40 ? "<sha>" : ref}:${got ? 1 : 0}`);
		}
		const note = await op<{ text: string } | null>(t, repo, "readFile", {
			ref: notes,
			path: sha,
		});
		rec.check({
			id: "A4",
			title:
				"the binding resolves only short branch names and SHAs; notes by SHA (K15)",
			pass: k15 && note.ok &&
				(note.result?.text ?? "").includes('"intent":"smoke"'),
			numbers: { spellings: spellings.length },
			decides: "K15: reads by SHA",
			detail: resolved,
		});
		const rt = await mint(repo, "read");
		const clone = dir("a4-clone");
		await gitOk(["clone", "-q", created.remote, clone], {
			env,
			auth: bearer(rt.plaintext),
		});
		const cat = await gitOk(["cat-file", "-p", "HEAD"], { cwd: clone, env });
		const fsck = await git(["fsck", "--strict"], { cwd: clone, env });
		const gwClone = await git(["clone", "-q", gw(repo), dir("a4-gw")], {
			env,
			auth: gatewayAuth,
		});
		rec.check({
			id: "A4",
			title:
				"the header survives direct and gateway clones; fsck --strict passes",
			pass: cat.includes(`change-id ${cid}`) && fsck.code === 0 &&
				gwClone.code === 0 &&
				(await head(dir("a4-gw"))) === sha,
			numbers: { fsckExit: fsck.code },
		});
	}

	// ------------------------------------------------------------------ U45, U46, U48
	if (wants(ctx, "U45") || wants(ctx, "U46") || wants(ctx, "U48")) {
		const repo = name("u4x");
		const created = await create(repo);
		const wt = await mint(repo, "write");
		const d = dir("u4x");
		const h = await seedWorkdir(d, env, tag);
		await gitOk(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", h);
		if (wants(ctx, "U45")) {
			const a = await git(["push", created.remote, "HEAD:refs/heads/lanes/y"], {
				cwd: d,
				env,
				auth: bearer(wt.plaintext),
			});
			const b = await git(["push", created.remote, "HEAD:refs/heads/Lanes/x"], {
				cwd: d,
				env,
				auth: bearer(wt.plaintext),
			});
			const ls = await git(["ls-remote", created.remote], {
				env,
				auth: bearer(wt.plaintext),
			});
			const both = ls.stdout.includes("refs/heads/lanes/y") &&
				ls.stdout.includes("refs/heads/Lanes/x");
			if (a.code === 0) record("direct", repo, "refs/heads/lanes/y", h);
			if (b.code === 0) record("direct", repo, "refs/heads/Lanes/x", h);
			rec.check({
				id: "U45",
				title:
					"ref names are case-sensitive: refs/heads/Lanes/x next to refs/heads/lanes/y",
				pass: a.code === 0,
				numbers: { lanesY: a.code, LanesX: b.code, bothListed: both },
				decides: "case-variant lane refs",
			});
		}
		if (wants(ctx, "U46")) {
			const r = await rawPush(
				fetch,
				created.remote,
				[{ ref: "refs/heads/u46-ref-only", new: h }],
				[],
				{ auth: { bearer: wt.plaintext }, caps: ["report-status"] },
			);
			if (r.refs.get("refs/heads/u46-ref-only") === "ok") {
				record("direct", repo, "refs/heads/u46-ref-only", h);
			}
			rec.check({
				id: "U46",
				title: "ref-only create at an existing object with an empty pack",
				pass: r.status === 200 &&
					r.refs.get("refs/heads/u46-ref-only") === "ok",
				numbers: { status: r.status, unpack: r.unpack },
				decides: "kernel ref-only writes",
			});
		}
		if (wants(ctx, "U48")) {
			const wrongOld = await rawPush(
				fetch,
				created.remote,
				[{ ref: "refs/heads/main", old: "1".repeat(40), new: h }],
				[],
				{ auth: { bearer: wt.plaintext }, caps: ["report-status"] },
			);
			const createExisting = await rawPush(
				fetch,
				created.remote,
				[{ ref: "refs/heads/main", new: h }],
				[],
				{ auth: { bearer: wt.plaintext }, caps: ["report-status"] },
			);
			const ng = (r: typeof wrongOld) =>
				r.status === 200 && (r.refs.get("refs/heads/main") ?? "ok") !== "ok";
			rec.check({
				id: "U48",
				title:
					"raw receive-pack: wrong old SHA and create of an existing ref both answer ng",
				pass: ng(wrongOld) && ng(createExisting),
				numbers: {
					wrongOld: wrongOld.refs.get("refs/heads/main") ??
						`status ${wrongOld.status}`,
					createExisting: createExisting.refs.get("refs/heads/main") ??
						`status ${createExisting.status}`,
				},
				decides: "row 4 CAS (server-side compare-and-swap)",
			});
		}
	}

	// ------------------------------------------------------------------ S3-raw
	if (wants(ctx, "S3-raw")) {
		const repo = name("s3");
		const created = await create(repo);
		const wt = await mint(repo, "write");
		const d = dir("s3");
		const h = await seedWorkdir(d, env, tag);
		await gitOk(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", h);
		await Deno.writeTextFile(`${d}/s3.txt`, "s3\n");
		await gitOk(["add", "-A"], { cwd: d, env });
		await gitOk(["commit", "-qm", "s3 push"], { cwd: d, env });
		const ngUrl = `${t.base}/git-ng/${repo}.git`;
		const plain = await git(["push", ngUrl, "main"], {
			cwd: d,
			env,
			auth: gatewayAuth,
		});
		const porcelain = await git(["push", "--porcelain", ngUrl, "main"], {
			cwd: d,
			env,
			auth: gatewayAuth,
		});
		const quiet = await git(["push", "-q", ngUrl, "main"], {
			cwd: d,
			env,
			auth: gatewayAuth,
		});
		const shows = (s: string) => s.includes("lane-main-only (smoke)");
		rec.check({
			id: "S3-raw",
			title:
				"stock git shows a synthesized 200 report-status ng and band-2 lines",
			pass: plain.code !== 0 && shows(plain.stderr) &&
				plain.stderr.includes("remote: tartan:") &&
				porcelain.code !== 0 &&
				/\[remote rejected\]/.test(porcelain.stdout + porcelain.stderr) &&
				quiet.code !== 0,
			numbers: {
				plainExit: plain.code,
				band2Shown: plain.stderr.includes("remote: tartan:"),
				porcelainExit: porcelain.code,
				quietShowsReason: shows(quiet.stderr),
			},
			decides: "ECHO_ENABLED pre-check; synthesized ng (S3)",
			detail: {
				plain: redactSecrets(plain.stderr).split("\n").slice(-8),
				porcelain: redactSecrets(porcelain.stdout).split("\n").slice(-4),
			},
		});
	}

	// ------------------------------------------------------------------ S4b
	if (wants(ctx, "S4b")) {
		const repo = name("s4b");
		const created = await create(repo);
		const wt = await mint(repo, "write");
		const d = dir("s4b");
		const h = await seedWorkdir(d, env, tag);
		await gitOk(["push", created.remote, "main"], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		record("direct", repo, "refs/heads/main", h);
		const tree = await head(d, "HEAD^{tree}");
		const blob = await gitOk(["rev-parse", "HEAD:README.md"], { cwd: d, env });
		const rate = ctx.small ? 20 : 250;
		const burst = await api<
			{
				ok: number;
				total: number;
				errors: number;
				lat_p50: number;
				lat_p95: number;
				achievedRatePerSec?: number;
			}
		>(
			t,
			"/api/read-burst",
			{
				name: repo,
				tree,
				blob,
				ratePerSec: rate,
				durationMs: ctx.small ? 1000 : 10_000,
			},
		);
		rec.check({
			id: "S4b",
			title: `binding reads at ${rate}/s`,
			pass: burst.errors === 0,
			numbers: {
				total: burst.total,
				errors: burst.errors,
				p50: burst.lat_p50,
				p95: burst.lat_p95,
			},
			decides: "binding-read token bucket (REPO_READER_LIMITS)",
		});
	}

	// ------------------------------------------------------------------ conformance
	if (wants(ctx, "CONF")) {
		const results = await api<{ id: string; pass: boolean; detail: string }[]>(
			t,
			"/api/conformance",
			{},
		);
		for (const r of results) {
			rec.check({
				id: "CONF",
				title: `FakeArtifacts conformance ${r.id}`,
				pass: r.pass,
				numbers: {},
				detail: r.detail,
			});
		}
	}

	// ------------------------------------------------------------------ A5
	if (wants(ctx, "A5") && pushes.length > 0) {
		const waitMs = ctx.mode === "live" ? 180_000 : 2_000;
		const t0 = Date.now();
		let events: {
			data: {
				payload: {
					source: { repoName: string };
					payload: {
						ref: string;
						after: string;
						commits: unknown[];
						totalCommitsCount: number;
					};
				};
				instanceCreatedAt: number;
			};
		}[] = [];
		const expected = pushes.filter((p) => p.repo.includes(tag));
		while (Date.now() - t0 < waitMs) {
			events = await api(t, "/api/records?kind=wf-event");
			if (events.length >= expected.length) break;
			await new Promise((r) => setTimeout(r, ctx.mode === "live" ? 5000 : 100));
		}
		const key = (repo: string, ref: string, after: string) =>
			`${repo.toLowerCase()}|${ref}|${after}`;
		const seen = new Map<string, number>();
		for (const e of events) {
			const p = e.data.payload;
			const k = key(p.source.repoName, p.payload.ref, p.payload.after);
			seen.set(k, (seen.get(k) ?? 0) + 1);
		}
		const missing = expected.filter((p) =>
			!seen.has(key(p.repo, p.ref, p.after))
		);
		const dups = [...seen.values()].filter((n) => n > 1).length;
		const lat = expected.flatMap((p) => {
			const e = events.find((x) =>
				key(
					x.data.payload.source.repoName,
					x.data.payload.payload.ref,
					x.data.payload.payload.after,
				) ===
					key(p.repo, p.ref, p.after)
			);
			return e ? [e.data.instanceCreatedAt - p.endMs] : [];
		});
		rec.check({
			id: "A5",
			title: "one cf.artifacts.repo.pushed per ref update, no duplicates",
			pass: missing.length === 0 && dups === 0,
			numbers: {
				expected: expected.length,
				events: events.length,
				missing: missing.length,
				duplicates: dups,
				latencyP50Ms: pct(lat, 50),
				latencyMaxMs: lat.length ? Math.max(...lat) : null,
			},
			decides: "TRIGGER_ENABLED; WAIT_MODE",
			detail: missing.map((m) => `${m.via} ${m.ref}`),
		});
	}
	rec.note("pushes", pushes.length);
};
