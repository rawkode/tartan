// The `repo` lane backend's git surfaces end to end with stock git (`repo`
// backend). Stock git 2.55 is the client; the gateway handlers run behind a
// local HTTP server that plays the router and WP2's token middleware; the
// upstream is `git http-backend` serving the canonical repo `r-<repoId>` and
// each lane repo `l-<repoId>-<laneUlid>`; RepoDO is the gateway's in-memory
// fake (its lanes, `pushContext` and `recordPush` keep the lane head) plus the
// capability state of `testing/capstate.ts` with a real HMAC key.
//
// - lane remotes: clone, fast-forward, `--force-with-lease`, every refusal
//   of the lane-remote table as git prints it, another agent reading but not pushing,
//   anonymous 401, and the canonical URL closed to an agent without a
//   `branch` lane;
// - the capability route: stock git clones a `master` repo through it with
//   protocol v0 and v2 and gets exactly `HEAD` → `refs/heads/main` at the
//   base; a trunk that moved is 503 unless kernel-explained with `pinBase`.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { type Lane, laneId as laneIdOf, ROLE, ulid } from "@tartan/contract";
import type { AuthContext, Upstream } from "@tartan/contract/kernel.ts";
import {
	type CapDeps,
	createCapFailureBuckets,
	handleCapInfoRefs,
	handleCapNotFound,
	handleCapUploadPack,
} from "./cap.ts";
import { handleLaneInfoRefs, handleLaneUploadPack } from "./laneremote.ts";
import { handleReceivePack } from "./receive.ts";
import {
	createCapState,
	signedCapPath,
	testCapMac,
} from "./testing/capstate.ts";
import {
	authOf,
	createUnitWorld,
	laneRepoName,
	REPO_ID,
	repoLane,
} from "./testing/fakes.ts";
import {
	bareRefs,
	commitFile,
	git,
	type GitResult,
	hasGit,
	initBare,
	initWork,
	makeSandbox,
	revParse,
	startBackend,
} from "./testing/git.ts";
import { handleInfoRefs, handleUploadPack } from "./upload.ts";
import type { GitRequest } from "./types.ts";

const MAIN = "refs/heads/main";

const randomToken = (prefix: string): string =>
	`${prefix}${
		[...crypto.getRandomValues(new Uint8Array(24))].map((b) =>
			b.toString(16).padStart(2, "0")
		).join("")
	}`;

const basicHeader = (token: string): string =>
	`Authorization: Basic ${btoa(`x:${token}`)}`;

const tokenOf = (header: string | null): string | null => {
	const m = /^Basic\s+(\S+)$/i.exec(header ?? "");
	if (m === null) return null;
	const decoded = atob(m[1]);
	return decoded.slice(decoded.indexOf(":") + 1);
};

const LANE_PATH =
	/^\/acme\/shop\/-\/lanes\/(ln_[0-9a-hjkmnp-tv-z]{26})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const CANONICAL_PATH =
	/^\/acme\/shop(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The whole stand: sandbox, backend, gateway server, principals, one lane. */
const stand = async () => {
	const sandbox = await makeSandbox();
	const backend = startBackend(
		sandbox,
		(header) => header?.startsWith("Bearer art_") ?? false,
	);
	const world = createUnitWorld();
	world.config = { ...world.config, echo: true };
	const canonicalName = `r-${REPO_ID}`;
	const canonicalBare = await initBare(sandbox, canonicalName);
	const seed = await initWork(sandbox, "seed", 3);
	await git(sandbox, ["branch", "-m", "main", "master"], { cwd: seed });
	await git(sandbox, ["push", "-q", canonicalBare, "master"], { cwd: seed });
	await git(sandbox, ["symbolic-ref", "HEAD", "refs/heads/master"], {
		cwd: canonicalBare,
	});
	const trunk = await revParse(sandbox, seed, "master");

	// Principals: the lane's owner, another agent, both Developers.
	const tokens = new Map<string, AuthContext>();
	const principal = (kind: "agent" | "user", role = ROLE.developer) => {
		const token = randomToken(kind === "agent" ? "tagt_" : "tpat_");
		const auth = authOf({
			kind,
			via: kind === "agent" ? "agent-token" : "pat",
			principal: `${kind === "agent" ? "a" : "u"}_${ulid()}`,
		});
		tokens.set(token, auth);
		world.roles.set(auth.principal, role);
		return { token, auth };
	};
	const owner = principal("agent");
	const other = principal("agent");

	// A lane whose repo was seeded (as the import does): main at the trunk.
	const openLane = async (state: Lane["state"] = "open") => {
		const id = laneIdOf(ulid());
		const bare = await initBare(sandbox, laneRepoName(id));
		await git(sandbox, ["push", "-q", bare, `${trunk}:${MAIN}`], {
			cwd: seed,
		});
		world.repo.lanes.set(
			id,
			repoLane(id, owner.auth.principal, { head: trunk, base: trunk, state }),
		);
		return { id, bare };
	};

	// RepoDO's upstream mapping onto the backend, and the lane head kept on push.
	world.repo.upstream = (target, scope): Promise<Upstream> => {
		world.repo.upstreamScopes.push(scope);
		world.repo.upstreamTargets.push(target.laneId ?? "repo");
		const name = target.laneId === undefined
			? canonicalName
			: laneRepoName(target.laneId);
		return Promise.resolve({
			artifactsName: name,
			remote: `${backend.url}/${name}.git`,
			token: `art_v2_${scope}_${"0".repeat(32)}`,
			expiresAt: Number.MAX_SAFE_INTEGER,
			kind: target.laneId === undefined ? "canonical" : "lane-repo",
			ref: target.laneId === undefined ? "refs/heads/master" : MAIN,
		});
	};
	const recordPush = world.repo.recordPush;
	world.repo.recordPush = async (report) => {
		const result = await recordPush(report);
		const lane = world.repo.lanes.get(report.target);
		const main = report.refs.find((r) => r.ref === MAIN);
		if (lane !== undefined && main !== undefined) {
			world.repo.lanes.set(lane.id, { ...lane, head: main.after });
		}
		return result;
	};

	// The capability route's ports.
	const capState = createCapState();
	const mac = await testCapMac();
	const capDeps: CapDeps = {
		verifyMac: (fields, value) => mac.verify(fields, value),
		repo: (repoId) => capState.repo(repoId),
		mintReadToken: () =>
			Promise.resolve({
				remote: `${backend.url}/${canonicalName}.git`,
				token: `art_v2_cap_${"1".repeat(32)}`,
				revoke: () => Promise.resolve(),
			}),
		fetch: (request) => fetch(request),
		now: () => Date.now(),
		log: (message, data) => void world.logs.push({ message, data }),
		buckets: createCapFailureBuckets(),
		config: { ttlS: 120, clientCheck: false, upstreamAuth: "bearer" },
	};

	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		async (request) => {
			const url = new URL(request.url);
			const waitUntil = (promise: Promise<unknown>) =>
				void world.waits.push(promise);
			if (url.pathname.startsWith("/-/cap/")) {
				const c = { req: request, url, waitUntil };
				if (url.pathname.endsWith("/info/refs") && request.method === "GET") {
					return await handleCapInfoRefs(capDeps, c);
				}
				if (
					url.pathname.endsWith("/git-upload-pack") && request.method === "POST"
				) {
					return await handleCapUploadPack(capDeps, c);
				}
				return await handleCapNotFound(capDeps, c);
			}
			const header = request.headers.get("authorization");
			const token = tokenOf(header);
			const auth = token === null ? null : tokens.get(token) ?? null;
			if (header !== null && auth === null) {
				return new Response("bad token", {
					status: 401,
					headers: { "www-authenticate": 'Basic realm="Tartan"' },
				});
			}
			const lane = LANE_PATH.exec(url.pathname);
			const canonical = lane === null
				? CANONICAL_PATH.exec(url.pathname)
				: null;
			const op = lane?.[2] ?? canonical?.[1];
			if (op === undefined) return new Response("no route", { status: 404 });
			const r: GitRequest = {
				req: request,
				url,
				repoPath: "acme/shop",
				...(lane === null ? {} : { laneId: lane[1] }),
				auth,
				waitUntil,
			};
			// The unit world's ports, with the real network to the backend.
			const deps = { ...world.deps(), fetch: (req: Request) => fetch(req) };
			if (op === "git-receive-pack") return await handleReceivePack(deps, r);
			if (lane !== null) {
				return op === "info/refs"
					? await handleLaneInfoRefs(deps, r)
					: await handleLaneUploadPack(deps, r);
			}
			return op === "info/refs"
				? await handleInfoRefs(deps, r)
				: await handleUploadPack(deps, r);
		},
	);
	const gatewayUrl = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;

	const gitAs = (
		who: { token: string } | null,
		args: readonly string[],
		options: { cwd?: string; allowFail?: boolean } = {},
	): Promise<GitResult> =>
		git(
			sandbox,
			who === null
				? args
				: ["-c", `http.extraHeader=${basicHeader(who.token)}`, ...args],
			options,
		);

	return {
		sandbox,
		backend,
		world,
		owner,
		other,
		trunk,
		seed,
		canonicalBare,
		openLane,
		capState,
		mac,
		gatewayUrl,
		laneUrl: (id: string) => `${gatewayUrl}/acme/shop/-/lanes/${id}.git`,
		gitAs,
		close: async () => {
			while (world.waits.length > 0) {
				await Promise.allSettled(world.waits.splice(0));
			}
			await server.shutdown();
			await backend.close();
			await sandbox.cleanup();
		},
	};
};

const rejected = (result: GitResult, ref: string, reason: string): void => {
	ok(result.code !== 0, `push of ${ref} should fail`);
	ok(
		result.stderr.includes(`[remote rejected]`) &&
			result.stderr.includes(reason),
		`${ref}: expected ${reason}, got: ${result.stderr}`,
	);
};

Deno.test({
	name:
		"lane remote with stock git: clone, fast-forward, --force-with-lease; every lane-remote refusal as git prints it; nothing else moves",
	ignore: !hasGit,
	fn: async () => {
		const s = await stand();
		try {
			const lane = await s.openLane();
			const dir = `${s.sandbox.root}/agent`;
			await s.gitAs(s.owner, ["clone", "-q", s.laneUrl(lane.id), dir]);
			equal(await revParse(s.sandbox, dir, "HEAD"), s.trunk);
			const branch = (await git(s.sandbox, ["symbolic-ref", "HEAD"], {
				cwd: dir,
			})).stdout.trim();
			equal(branch, MAIN);
			// A fast-forward of main.
			const first = await commitFile(s.sandbox, dir, "lane.txt", "one\n");
			await s.gitAs(s.owner, ["push", "-q", "origin", "HEAD:main"], {
				cwd: dir,
			});
			equal((await bareRefs(s.sandbox, lane.bare))[MAIN], first);
			equal(s.world.repo.lanes.get(lane.id)?.head, first);
			// A rewrite with --force-with-lease (the lease is the recorded head).
			await git(s.sandbox, ["commit", "-q", "--amend", "-m", "amended"], {
				cwd: dir,
			});
			const amended = await revParse(s.sandbox, dir, "HEAD");
			await s.gitAs(s.owner, [
				"push",
				"-q",
				"--force-with-lease",
				"origin",
				"HEAD:main",
			], { cwd: dir });
			equal((await bareRefs(s.sandbox, lane.bare))[MAIN], amended);
			// Refusals, each printed by stock git with its reason.
			rejected(
				await s.gitAs(s.owner, ["push", "origin", "HEAD:refs/heads/feature"], {
					cwd: dir,
					allowFail: true,
				}),
				"feature",
				"lane-main-only",
			);
			rejected(
				await s.gitAs(s.owner, ["push", "origin", "HEAD:refs/tags/v9"], {
					cwd: dir,
					allowFail: true,
				}),
				"v9",
				"lane-main-only",
			);
			rejected(
				await s.gitAs(s.owner, ["push", "origin", ":main"], {
					cwd: dir,
					allowFail: true,
				}),
				"main delete",
				"use-lanes-close",
			);
			// The index moved on (a reconcile after a foreign write): stale old.
			s.world.repo.lanes.set(lane.id, {
				...s.world.repo.lanes.get(lane.id) as Lane,
				head: s.trunk,
			});
			await commitFile(s.sandbox, dir, "two.txt", "two\n");
			rejected(
				await s.gitAs(s.owner, ["push", "origin", "HEAD:main"], {
					cwd: dir,
					allowFail: true,
				}),
				"main",
				"stale-old",
			);
			s.world.repo.lanes.set(lane.id, {
				...s.world.repo.lanes.get(lane.id) as Lane,
				head: amended,
				state: "landing",
			});
			rejected(
				await s.gitAs(s.owner, ["push", "origin", "HEAD:main"], {
					cwd: dir,
					allowFail: true,
				}),
				"main",
				"lane-landing",
			);
			// The band-2 guidance names the lane remote (ECHO_ENABLED).
			s.world.repo.lanes.set(lane.id, {
				...s.world.repo.lanes.get(lane.id) as Lane,
				state: "open",
			});
			const mainOnly = await s.gitAs(s.owner, [
				"push",
				"origin",
				"HEAD:refs/heads/other",
			], { cwd: dir, allowFail: true });
			ok(
				mainOnly.stderr.includes(
					"remote: tartan ▸ a lane remote has one branch, main",
				),
			);
			ok(
				mainOnly.stderr.includes(`/acme/shop/-/lanes/${lane.id}.git HEAD:main`),
			);
			// Another agent reads the lane but cannot push it.
			const otherDir = `${s.sandbox.root}/other`;
			await s.gitAs(s.other, ["clone", "-q", s.laneUrl(lane.id), otherDir]);
			equal(await revParse(s.sandbox, otherDir, "HEAD"), amended);
			await commitFile(s.sandbox, otherDir, "x.txt", "x\n");
			rejected(
				await s.gitAs(s.other, ["push", "origin", "HEAD:main"], {
					cwd: otherDir,
					allowFail: true,
				}),
				"main",
				"not-your-lane",
			);
			// Anonymous: 401, so stock git never sends a pack.
			const anon = await s.gitAs(null, [
				"ls-remote",
				s.laneUrl(lane.id),
			], { allowFail: true });
			ok(anon.code !== 0);
			ok(/Authentication failed|could not read Username/i.test(anon.stderr));
			// Nothing else moved: the canonical repo, the lane repo's other refs.
			deepStrictEqual(Object.keys(await bareRefs(s.sandbox, lane.bare)), [
				MAIN,
			]);
			deepStrictEqual(await bareRefs(s.sandbox, s.canonicalBare), {
				"refs/heads/master": s.trunk,
			});
			// The accepted pushes were recorded on the lane with its repo name.
			ok(s.world.repo.pushes.length >= 2);
			for (const pushed of s.world.repo.pushes) {
				equal(pushed.target, lane.id);
				equal(pushed.repoName, laneRepoName(lane.id));
			}
			// No canonical token was ever minted for these pushes.
			ok(!s.world.repo.upstreamTargets.includes("repo"));
		} finally {
			await s.close();
		}
	},
});

Deno.test({
	name:
		"lane remote with stock git: an opening lane refuses pushes; the canonical URL stays closed to an agent with only repo lanes",
	ignore: !hasGit,
	fn: async () => {
		const s = await stand();
		try {
			const lane = await s.openLane("opening");
			const dir = `${s.sandbox.root}/agent`;
			await s.gitAs(s.owner, ["clone", "-q", s.laneUrl(lane.id), dir]);
			await commitFile(s.sandbox, dir, "lane.txt", "one\n");
			rejected(
				await s.gitAs(s.owner, ["push", "origin", "HEAD:main"], {
					cwd: dir,
					allowFail: true,
				}),
				"main",
				"lane-opening",
			);
			// The canonical URL: no branch lane, so agents-lanes-only and no
			// canonical write token, whatever the agent pushes.
			const scopesBefore = [...s.world.repo.upstreamScopes];
			rejected(
				await s.gitAs(s.owner, [
					"push",
					`${s.gatewayUrl}/acme/shop.git`,
					"HEAD:refs/heads/master",
				], { cwd: dir, allowFail: true }),
				"master",
				"agents-lanes-only",
			);
			deepStrictEqual(
				s.world.repo.upstreamScopes.slice(scopesBefore.length).filter((x) =>
					x === "write"
				),
				[],
			);
		} finally {
			await s.close();
		}
	},
});

Deno.test({
	name:
		"capability route with stock git: a master repo clones as exactly HEAD → refs/heads/main at the base (v0 and v2); a moved trunk is 503 unless explained and pinned",
	ignore: !hasGit,
	fn: async () => {
		const s = await stand();
		try {
			const nowS = Math.floor(Date.now() / 1000);
			const capUrl = async (
				over: Parameters<typeof s.capState.addLane>[2] = {},
			) => {
				const lane = s.capState.addLane(REPO_ID.toLowerCase(), s.trunk, {
					defaultBranch: "master",
					...over,
				});
				return {
					lane,
					url: `${s.gatewayUrl}${await signedCapPath(s.mac, lane, nowS + 120)}`,
				};
			};
			for (const version of ["0", "2"]) {
				const { lane, url } = await capUrl();
				const dir = `${s.sandbox.root}/cap-v${version}`;
				await git(s.sandbox, [
					"-c",
					`protocol.version=${version}`,
					"clone",
					"-q",
					url,
					dir,
				]);
				const refs = (await git(s.sandbox, ["show-ref"], { cwd: dir })).stdout
					.trim().split("\n");
				deepStrictEqual(refs, [
					`${s.trunk} refs/heads/main`,
					`${s.trunk} refs/remotes/origin/HEAD`,
					`${s.trunk} refs/remotes/origin/main`,
				]);
				await git(s.sandbox, ["fsck", "--strict"], { cwd: dir });
				equal(lane.consumed, true, `protocol ${version}: one pack request`);
				// The capability is spent: the same URL cannot be cloned again.
				const again = await git(s.sandbox, [
					"-c",
					`protocol.version=${version}`,
					"clone",
					"-q",
					url,
					`${dir}-again`,
				], { allowFail: true });
				ok(again.code !== 0, "a consumed capability is refused");
			}
			// The trunk moves one commit after the attempt's base.
			const work = `${s.sandbox.root}/trunk-mover`;
			await git(s.sandbox, ["clone", "-q", s.canonicalBare, work]);
			const moved = await commitFile(s.sandbox, work, "moved.txt", "moved\n");
			await git(s.sandbox, ["push", "-q", "origin", "HEAD:master"], {
				cwd: work,
			});
			const stale = await capUrl();
			const refused = await git(s.sandbox, [
				"-c",
				"protocol.version=0",
				"ls-remote",
				stale.url,
			], { allowFail: true });
			ok(refused.code !== 0 && refused.stderr.includes("503"), refused.stderr);
			equal(s.capState.reports.at(-1)?.report.outcome, "trunk-moved");
			equal(s.capState.reports.at(-1)?.report.upstreamTip, moved);
			// Kernel-explained and pinned: the base is served (a non-tip want).
			const pinned = await capUrl({ pinBase: true, explainedTips: [moved] });
			const pinnedDir = `${s.sandbox.root}/cap-pinned`;
			await git(s.sandbox, [
				"-c",
				"protocol.version=0",
				"clone",
				"-q",
				pinned.url,
				pinnedDir,
			]);
			equal(await revParse(s.sandbox, pinnedDir, "HEAD"), s.trunk);
			// No log line carries a capability path.
			ok(!JSON.stringify(s.world.logs).includes("/-/cap/v1/"));
		} finally {
			await s.close();
		}
	},
});
