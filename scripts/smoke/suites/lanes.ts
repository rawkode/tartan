// The lane-repo smoke suite (U51–U55, U57, U59 and the early
// capability-security probes) against the lane smoke Worker. Lane repos are
// created with `import()` from the Worker's v1 capability URLs.

import { redactSecrets } from "@tartan/contract";
import { LANE_IMPORT_MAX_BYTES } from "../../../src/constants.ts";
import {
	api,
	op,
	type SmokeContext,
	wants,
	type WorkerTarget,
} from "../lib/context.ts";
import { pct } from "../lib/evidence.ts";
import {
	git,
	type GitAuth,
	gitOk,
	randomFile,
	seedWorkdir,
} from "../lib/git.ts";

const PREFIX = "tartan-smoke-lanes";

type Cap = {
	url: string;
	nonce: string;
	laneId: string;
	repoId: string;
	exp: number;
	mac: string;
	base: string;
};
type Imported = {
	ok: boolean;
	ms: number;
	result?: {
		defaultBranch: string;
		remote: string;
		token: string;
		name: string;
	};
	error?: { code?: string; message: string };
};

const enc = new TextEncoder();
const pktText = (s: string) =>
	`${(enc.encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;

export const runLanesSuite = async (ctx: SmokeContext): Promise<void> => {
	const t = ctx.lanes;
	if (!t) throw new Error("lanes suite needs the tartan-smoke-lanes Worker");
	const { rec, env, tag } = ctx;
	const name = (s: string) => `${PREFIX}-${s}-${tag}`;
	const dir = (s: string) => `${ctx.tmp}/lanes-${s}`;
	const bearer = (token: string): GitAuth => ({ bearer: token });

	const mintToken = async (repo: string, scope: "read" | "write") => {
		const r = await op<{ plaintext: string; id: string }>(t, repo, "token", {
			scope,
			ttl: 900,
		});
		if (!r.ok) throw new Error(`token ${repo}: ${r.error.message}`);
		return r.result;
	};
	/** A trunk repo with a seed commit (plus `extraBytes` of random data) on `branch`. */
	const trunk = async (suffix: string, branch = "main", extraBytes = 0) => {
		const repo = name(suffix);
		const c = await op<{ remote: string }>(t, repo, "create", {
			opts: { setDefaultBranch: branch },
		});
		if (!c.ok) throw new Error(`create ${repo}: ${c.error.message}`);
		const wt = await mintToken(repo, "write");
		const d = dir(suffix);
		await seedWorkdir(d, env, tag);
		if (extraBytes > 0) {
			await randomFile(`${d}/blob.bin`, extraBytes);
			await gitOk(["add", "-A"], { cwd: d, env });
			await gitOk(["commit", "-qm", `random ${extraBytes} bytes`], {
				cwd: d,
				env,
			});
		}
		await gitOk(["push", c.result.remote, `HEAD:refs/heads/${branch}`], {
			cwd: d,
			env,
			auth: bearer(wt.plaintext),
		});
		const head = await gitOk(["rev-parse", "HEAD"], { cwd: d, env });
		return { repo, remote: c.result.remote, head, dir: d };
	};
	const mint = (repo: string, extra: Record<string, unknown> = {}) =>
		api<Cap>(t, "/api/cap", { repo, ...extra });
	const importLane = (url: string, target: string, branch = "main") =>
		api<Imported>(t, "/api/import", { url, branch, target });
	/** Refs, object count and fsck of a lane repo (clone with a read token). */
	const inspectLane = async (lane: string, label: string) => {
		const info = await op<{ remote: string }>(t, lane, "get-info");
		if (!info.ok) return null;
		const rt = await mintToken(lane, "read");
		const ls = await git(["ls-remote", info.result.remote], {
			env,
			auth: bearer(rt.plaintext),
		});
		const d = dir(`clone-${label}`);
		const clone = await git(["clone", "-q", info.result.remote, d], {
			env,
			auth: bearer(rt.plaintext),
		});
		const fsck = clone.code === 0
			? await git(["fsck", "--full"], { cwd: d, env })
			: null;
		const objects = clone.code === 0
			? (await gitOk(["rev-list", "--objects", "--all"], { cwd: d, env }))
				.split("\n").length
			: 0;
		return {
			refs: ls.stdout.split("\n").filter(Boolean).map((l) =>
				l.split("\t").reverse().join("=")
			),
			cloneMs: clone.ms,
			fsckOk: fsck?.code === 0,
			objects,
		};
	};
	const sourceObjects = async (d: string) =>
		(await gitOk(["rev-list", "--objects", "--all"], { cwd: d, env })).split(
			"\n",
		).length;

	// ------------------------------------------------------------------ U59
	if (wants(ctx, "U59")) {
		for (const branch of ["main", "master"]) {
			const tr = await trunk(`u59-${branch}`, branch);
			const cap = await mint(tr.repo);
			const lane = name(`u59-${branch}-lane`);
			const imp = await importLane(cap.url, lane);
			const seen = imp.ok ? await inspectLane(lane, `u59-${branch}`) : null;
			const refs = seen?.refs ?? [];
			rec.check({
				id: "U59",
				title:
					`a ${branch}-default trunk imports as exactly HEAD → refs/heads/main`,
				pass: imp.ok && imp.result?.defaultBranch === "main" &&
					refs.length === 2 && refs.includes(`HEAD=${tr.head}`) &&
					refs.includes(`refs/heads/main=${tr.head}`) && seen?.fsckOk === true,
				numbers: {
					importMs: imp.ms,
					cloneMs: seen?.cloneMs ?? null,
					refs: refs.length,
				},
				decides: branch === "master"
					? "non-main repos may seed with import"
					: undefined,
				detail: imp.ok
					? refs.map((r) => r.replace(/[0-9a-f]{40}/, "<sha>"))
					: imp.error,
			});
		}
	}

	// ------------------------------------------------------------------ capability security
	if (wants(ctx, "CAP")) {
		const tr = await trunk("cap");
		const before = await api<{ stateCalls: number }>(t, "/api/stats");
		const cap = await mint(tr.repo);
		const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
		const forged: [string, string][] = [
			["flipped MAC digit", cap.url.replace(cap.mac, flip(cap.mac))],
			["moved exp", cap.url.replace(`/${cap.exp}/`, `/${cap.exp + 1}/`)],
			["expired", cap.url.replace(`/${cap.exp}/`, "/1000000000/")],
			[
				"other lane id",
				cap.url.replace(cap.laneId, "ln_01k6zzzzzzzzzzzzzzzzzzzzzz"),
			],
			[
				"other repo id",
				cap.url.replace(cap.repoId, "01k6zzzzzzzzzzzzzzzzzzzzzz"),
			],
			["other nonce", cap.url.replace(cap.nonce, "0".repeat(32))],
			["non-ULID repo", cap.url.replace(cap.repoId, "NOT-A-ULID")],
		];
		const statuses: string[] = [];
		let allNotFound = true;
		for (const [label, url] of forged) {
			const r = await fetch(`${url}/info/refs?service=git-upload-pack`);
			await r.body?.cancel();
			allNotFound &&= r.status === 404;
			statuses.push(`${label}:${r.status}`);
		}
		for (
			const [label, path, method] of [
				[
					"receive-pack advertisement",
					"/info/refs?service=git-receive-pack",
					"GET",
				],
				["receive-pack POST", "/git-receive-pack", "POST"],
				["dumb HEAD", "/HEAD", "GET"],
			] as const
		) {
			const r = await fetch(`${cap.url}${path}`, {
				method,
				body: method === "POST" ? "0000" : undefined,
			});
			await r.body?.cancel();
			allNotFound &&= r.status === 404;
			statuses.push(`${label}:${r.status}`);
		}
		const after = await api<{ stateCalls: number }>(t, "/api/stats");
		rec.check({
			id: "CAP",
			title:
				"forged, expired and non-upload-pack requests are plain 404s with zero state calls",
			pass: allNotFound && after.stateCalls === before.stateCalls,
			numbers: {
				probes: statuses.length,
				stateCalls: after.stateCalls - before.stateCalls,
			},
			detail: statuses,
		});
		const adv = await fetch(`${cap.url}/info/refs?service=git-upload-pack`);
		const advText = await adv.text();
		const advRefs = [...advText.matchAll(/[0-9a-f]{40} ([^\0\n]+)/g)].map((m) =>
			m[1]
		);
		rec.check({
			id: "CAP",
			title: "the advertisement is only HEAD → refs/heads/main at the base",
			pass: adv.status === 200 &&
				advRefs.join(",") === "HEAD,refs/heads/main" &&
				advText.includes("symref=HEAD:refs/heads/main") &&
				advText.includes(cap.base),
			numbers: { status: adv.status, refs: advRefs.length },
		});
		const bodies: [string, string][] = [
			[
				"two wants",
				`${pktText(`want ${cap.base}\n`)}${
					pktText(`want ${"1".repeat(40)}\n`)
				}0000${pktText("done\n")}`,
			],
			[
				"have",
				`${pktText(`want ${cap.base}\n`)}0000${pktText(`have ${cap.base}\n`)}${
					pktText("done\n")
				}`,
			],
			[
				"deepen",
				`${pktText(`want ${cap.base}\n`)}${pktText("deepen 1\n")}0000${
					pktText("done\n")
				}`,
			],
		];
		const refused: string[] = [];
		let refusedOk = true;
		for (const [label, body] of bodies) {
			const c = await mint(tr.repo);
			const r = await fetch(`${c.url}/git-upload-pack`, {
				method: "POST",
				body,
			});
			await r.body?.cancel();
			const replay = await fetch(`${c.url}/git-upload-pack`, {
				method: "POST",
				body: `${pktText(`want ${c.base}\n`)}0000${pktText("done\n")}`,
			});
			await replay.body?.cancel();
			refusedOk &&= r.status === 400 && replay.status === 404;
			refused.push(`${label}:${r.status}/${replay.status}`);
		}
		const v2 = await mint(tr.repo);
		const wantRef = await fetch(`${v2.url}/git-upload-pack`, {
			method: "POST",
			headers: { "git-protocol": "version=2" },
			body: `${pktText("command=fetch\n")}${
				pktText("object-format=sha1\n")
			}0001${pktText("want-ref refs/heads/main\n")}${pktText("done\n")}0000`,
		});
		await wantRef.body?.cancel();
		refusedOk &&= wantRef.status === 400;
		refused.push(`v2 want-ref:${wantRef.status}`);
		rec.check({
			id: "CAP",
			title:
				"the single-want parser refuses a second want, have, deepen and want-ref; each consumes the nonce",
			pass: refusedOk,
			numbers: { cases: refused.length },
			detail: refused,
		});
		const single = await mint(tr.repo);
		const first = await importLane(single.url, name("cap-lane-1"));
		const second = await importLane(single.url, name("cap-lane-2"));
		const records = await api<
			{ op: string; outcome?: string; tokenRevoked?: boolean | string }[]
		>(
			t,
			"/api/records",
		);
		const served = records.filter((r) => r.outcome === "served");
		const tokens = await op<{ tokens: { scope: string; state: string }[] }>(
			t,
			tr.repo,
			"listTokens",
		);
		const liveRead = tokens.ok
			? tokens.result.tokens.filter((x) =>
				x.scope === "read" && x.state === "active"
			).length
			: -1;
		rec.check({
			id: "CAP",
			title:
				"the pack request is single-use; per-request read tokens are revoked",
			pass: first.ok && !second.ok && served.every((r) =>
				r.tokenRevoked === true
			) && liveRead === 0,
			numbers: {
				secondImport: second.ok ? "imported" : second.error?.code ?? "error",
				served: served.length,
				activeReadTokens: liveRead,
			},
		});
	}

	// ------------------------------------------------------------------ U51
	if (wants(ctx, "U51")) {
		// Fractions of the current switch, and one size above it.
		const sizesMb = ctx.small
			? [0.2, 0.5]
			: [0.25, 0.5, 0.75, 1, 1.25].map((f) =>
				Math.round(f * LANE_IMPORT_MAX_BYTES / 100_000) / 10
			);
		for (const mb of sizesMb) {
			const tr = await trunk(
				`u51-${String(mb).replace(".", "p")}`,
				"main",
				Math.round(mb * 1_000_000),
			);
			const cap = await mint(tr.repo);
			const lane = name(`u51-${String(mb).replace(".", "p")}-lane`);
			const imp = await importLane(cap.url, lane);
			const seen = imp.ok ? await inspectLane(lane, `u51-${mb}`) : null;
			const srcObjects = await sourceObjects(tr.dir);
			const blob = await gitOk(["rev-parse", "HEAD:blob.bin"], {
				cwd: tr.dir,
				env,
			});
			const tree = await gitOk(["rev-parse", "HEAD^{tree}"], {
				cwd: tr.dir,
				env,
			});
			const readTree = imp.ok
				? await op<unknown[] | null>(t, lane, "readTree", { hash: tree })
				: null;
			const readBlob = imp.ok
				? await op<{ size: number } | null>(t, lane, "readBlob", { hash: blob })
				: null;
			rec.check({
				id: "U51",
				title: `import round trip at ${mb} MB`,
				pass: imp.ok && seen?.fsckOk === true && seen.objects === srcObjects &&
					readTree?.ok === true && readTree.result !== null &&
					readBlob?.ok === true &&
					readBlob.result?.size === Math.round(mb * 1_000_000),
				numbers: {
					importMs: imp.ms,
					code: imp.ok ? "ok" : imp.error?.code ?? "error",
					objects: seen?.objects ?? null,
					sourceObjects: srcObjects,
				},
				decides: "LANE_IMPORT_MAX_BYTES",
			});
		}
	}

	// ------------------------------------------------------------------ U52
	if (wants(ctx, "U52")) {
		const tr = await trunk("u52");
		const lane = name("u52-lane");
		const a = await importLane((await mint(tr.repo)).url, lane);
		const b = await importLane((await mint(tr.repo)).url, lane);
		await op(t, lane, "delete");
		await new Promise((r) => setTimeout(r, ctx.small ? 10 : 1000));
		const c = await importLane((await mint(tr.repo)).url, lane);
		const race = name("u52-race");
		const [r1, r2] = await Promise.all([
			mint(tr.repo).then((cap) => importLane(cap.url, race)),
			mint(tr.repo).then((cap) => importLane(cap.url, race)),
		]);
		const code = (r: Imported) => (r.ok ? "ok" : r.error?.code ?? "error");
		rec.check({
			id: "U52",
			title: "import idempotency and races (informational)",
			pass: a.ok,
			numbers: {
				second: code(b),
				afterDelete: code(c),
				concurrent: `${code(r1)}+${code(r2)}`,
			},
			decides: "nothing (fresh names per attempt)",
		});
	}

	// ------------------------------------------------------------------ U53
	if (wants(ctx, "U53")) {
		const tr = await trunk("u53");
		const lane = name("u53-lane");
		const imp = await importLane((await mint(tr.repo)).url, lane);
		if (imp.ok && imp.result) {
			const revoked = await op<boolean>(t, lane, "revokeToken", {
				tokenOrId: imp.result.token,
			});
			const ls = await git(["ls-remote", imp.result.remote], {
				env,
				auth: bearer(imp.result.token),
			});
			const pushTry = await git([
				"push",
				imp.result.remote,
				"HEAD:refs/heads/u53",
			], {
				cwd: tr.dir,
				env,
				auth: bearer(imp.result.token),
			});
			rec.check({
				id: "U53",
				title:
					"the import's 24 h token can be revoked; then it neither reads nor pushes",
				pass: revoked.ok && revoked.result === true && ls.code !== 0 &&
					pushTry.code !== 0,
				numbers: { lsExit: ls.code, pushExit: pushTry.code },
				decides: "K11 (the import token is discarded unread)",
			});
		} else {
			rec.check({
				id: "U53",
				title: "import for U53",
				pass: false,
				numbers: {},
				detail: imp.error,
			});
		}
	}

	// ------------------------------------------------------------------ U54
	if (wants(ctx, "U54")) {
		const tr = await trunk("u54");
		const filler = ctx.small ? 20 : 500;
		const concurrent = ctx.small ? 5 : 50;
		const t0 = performance.now();
		for (let i = 0; i < filler; i += 10) {
			await Promise.all(
				Array.from(
					{ length: Math.min(10, filler - i) },
					(_, k) => op(t, name(`u54-fill-${i + k}`), "create"),
				),
			);
		}
		const createMs = Math.round(performance.now() - t0);
		const t1 = performance.now();
		const results = await Promise.all(
			Array.from(
				{ length: concurrent },
				(_, i) =>
					mint(tr.repo).then((cap) =>
						importLane(cap.url, name(`u54-lane-${i}`))
					),
			),
		);
		const importWallMs = Math.round(performance.now() - t1);
		const t2 = performance.now();
		let pages = 0;
		let cursor: string | undefined;
		do {
			const page = await op<{ cursor?: string }>(t, undefined, "list", {
				limit: 200,
				cursor,
			});
			pages++;
			cursor = page.ok ? page.result.cursor : undefined;
		} while (cursor);
		const listMs = Math.round(performance.now() - t2);
		const t3 = performance.now();
		const cleanup = await api<{ matched: number; results: { ok: boolean }[] }>(
			t,
			"/api/cleanup",
			{
				startsWith: `${PREFIX}-u54-`,
			},
		);
		const deleteMs = Math.round(performance.now() - t3);
		const ms = results.filter((r) => r.ok).map((r) => r.ms);
		rec.check({
			id: "U54",
			title:
				`${concurrent} concurrent imports into a namespace holding ${filler} repos`,
			pass: results.every((r) => r.ok) && cleanup.results.every((r) => r.ok),
			numbers: {
				createMs,
				importWallMs,
				importP50: pct(ms, 50),
				importP95: pct(ms, 95),
				failed: results.filter((r) => !r.ok).length,
				listPages: pages,
				listMs,
				deleted: cleanup.matched,
				deleteMs,
			},
			decides: "MAX_ACTIVE_LANES_REPO_BACKEND",
		});
	}

	// ------------------------------------------------------------------ U55
	if (wants(ctx, "U55")) {
		for (const pinBase of [false, true]) {
			const tr = await trunk(`u55-${pinBase ? "pin" : "nopin"}`);
			const cap = await mint(tr.repo, { pinBase });
			const wt = await mintToken(tr.repo, "write");
			await Deno.writeTextFile(`${tr.dir}/moved.txt`, "trunk moved\n");
			await gitOk(["add", "-A"], { cwd: tr.dir, env });
			await gitOk(["commit", "-qm", "trunk moved"], { cwd: tr.dir, env });
			await gitOk(["push", tr.remote, "HEAD:refs/heads/main"], {
				cwd: tr.dir,
				env,
				auth: bearer(wt.plaintext),
			});
			const lane = name(`u55-${pinBase ? "pin" : "nopin"}-lane`);
			const imp = await importLane(cap.url, lane);
			const log = imp.ok
				? await op<{ hash: string }[]>(t, lane, "log", {
					ref: "main",
					limit: 1,
				})
				: null;
			rec.check({
				id: "U55",
				title: pinBase
					? "a non-tip want of the pinned base is served (trunk moved after minting)"
					: "trunk moved after minting: 503 trunk-moved, the import fails",
				pass: pinBase
					? imp.ok && log?.ok === true && log.result[0]?.hash === cap.base
					: !imp.ok,
				numbers: {
					code: imp.ok ? "ok" : imp.error?.code ?? "error",
					importMs: imp.ms,
				},
				decides: "LANE_CAP_PIN_BASE",
			});
		}
	}

	// ------------------------------------------------------------------ U57
	if (wants(ctx, "U57") && ctx.git) {
		const gitT: WorkerTarget = ctx.git;
		const tr = await trunk("u57");
		const since = Date.now() - 1;
		const names: string[] = [];
		for (let i = 0; i < (ctx.small ? 2 : 5); i++) {
			const target = `tartan-smoke-git-u57-${i}-${tag}`;
			names.push(target);
			await api(gitT, "/api/import", {
				url: (await mint(tr.repo)).url,
				branch: "main",
				target,
			});
		}
		await new Promise((r) => setTimeout(r, ctx.mode === "live" ? 30_000 : 200));
		const events = await api<
			{ data: { payload: { source: { repoName: string } } } }[]
		>(
			gitT,
			`/api/records?kind=wf-event&since=${since}`,
		);
		const forImports = events.filter((e) =>
			names.includes(e.data.payload.source.repoName.toLowerCase())
		);
		rec.check({
			id: "U57",
			title: "push trigger events for imported repos (informational)",
			pass: true,
			numbers: { imports: names.length, events: forImports.length },
			decides: "IngestWorkflow mapping of seed events",
		});
	}
	rec.note("tag", redactSecrets(tag));
};
