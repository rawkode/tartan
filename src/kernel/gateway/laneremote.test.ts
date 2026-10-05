// Lane remotes of the `repo` backend (`repo` backend):
//
// - access: anonymous → 401 and roleless → 404 on every visibility, the
//   member view for reads, Developer+ at this lane for pushes, a token
//   pinned to another lane refused; an archived lane readable until its GC,
//   a deleted lane, an unknown one, a `branch` lane or another repo's → 404;
// - advertisements: the lane repo's own refs, unfiltered, capability
//   allowlists applied; no receive-pack token for anyone but the owner;
// - receive-pack: the lane-remote table end to end (nothing forwarded and no
//   token minted on a refusal), `recordPush` with `target` = the lane and
//   the lane repo's name, phase 2 on the lane;
// - layer 2 against FakeArtifacts: with `laneRepoPolicy` replaced by an
//   allow-all fake, a push to lane A's remote is forwarded with a token
//   that FakeArtifacts refuses for the canonical repo and for lane B.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type Lane,
	laneId as laneIdOf,
	repoArtifactsName,
	ROLE,
	ulid,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AuthContext,
	LaneRepoPushPolicy,
	PushCommand,
	Upstream,
} from "@tartan/contract/kernel.ts";
import {
	demuxSideband,
	encodePktLine,
	encodeSpecialPkt,
	negotiateCaps,
	parseReportStatus,
	synthReportStatus,
} from "@tartan/gitproto";
import {
	createFakeArtifacts,
	type FakeArtifacts,
	push as testkitPush,
} from "@tartan/testkit";
import { handleLaneInfoRefs, handleLaneUploadPack } from "./laneremote.ts";
import { handleReceivePack } from "./receive.ts";
import {
	authOf,
	createUnitWorld,
	laneRepoName,
	REPO_ID,
	repoLane,
	scriptedUpstream,
	sha,
	type UnitWorld,
} from "./testing/fakes.ts";
import type { GatewayRepo, GitRequest } from "./types.ts";

const decoder = new TextDecoder();
const textOf = async (res: Response): Promise<string> =>
	decoder.decode(await res.arrayBuffer());

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const CAPS = "report-status side-band-64k agent=git/2.55.0";
const MAIN = "refs/heads/main";

const pushBody = (commands: readonly PushCommand[]) =>
	concat([
		...commands.map((c, i) =>
			encodePktLine(
				i === 0
					? `${c.old} ${c.new} ${c.ref}\0${CAPS}\n`
					: `${c.old} ${c.new} ${c.ref}\n`,
			)
		),
		encodeSpecialPkt("flush"),
		new TextEncoder().encode("PACK\0\0\0\x02\0\0\0\0"),
	]);

const reportOf = async (res: Response) => {
	const bytes = new Uint8Array(await res.arrayBuffer());
	const demuxed = demuxSideband(bytes);
	return parseReportStatus(demuxed.band1, negotiateCaps(CAPS.split(" ")));
};

const reasonsOf = async (res: Response): Promise<Record<string, string>> => {
	const report = await reportOf(res);
	return Object.fromEntries(
		report.refs.map((r) => [r.ref, r.ok ? "ok" : r.reason ?? "ng"]),
	);
};

const okAnswer = (refs: readonly string[]) => () =>
	new Response(
		synthReportStatus(
			{ unpack: "ok", refs: refs.map((ref) => ({ ref, ok: true })) },
			negotiateCaps(CAPS.split(" ")),
		),
	);

/** An upstream v0 upload-pack advertisement of a lane repo. */
const laneAdvertisement = (head: string): Uint8Array<ArrayBuffer> =>
	concat([
		encodePktLine("# service=git-upload-pack\n"),
		encodeSpecialPkt("flush"),
		encodePktLine(
			`${head} HEAD\0multi_ack thin-pack side-band side-band-64k shallow allow-tip-sha1-in-want filter symref=HEAD:refs/heads/main agent=artifacts/1\n`,
		),
		encodePktLine(`${head} refs/heads/main\n`),
		encodeSpecialPkt("flush"),
	]);

const receiveAdvertisement = (head: string): Uint8Array<ArrayBuffer> =>
	concat([
		encodePktLine("# service=git-receive-pack\n"),
		encodeSpecialPkt("flush"),
		encodePktLine(
			`${head} refs/heads/main\0report-status report-status-v2 push-options push-cert=x side-band-64k atomic delete-refs ofs-delta agent=a\n`,
		),
		encodeSpecialPkt("flush"),
	]);

type LaneWorld = UnitWorld & {
	readonly owner: AuthContext;
	readonly delegate: AuthContext;
	readonly other: AuthContext;
	readonly lane: string;
};

const laneWorld = (): LaneWorld => {
	const world = createUnitWorld();
	const owner = authOf({ kind: "agent", principal: `a_${ulid()}` });
	const delegate = authOf({ kind: "agent", principal: `a_${ulid()}` });
	const other = authOf({ kind: "agent", principal: `a_${ulid()}` });
	const lane = laneIdOf(ulid());
	world.repo.lanes.set(
		lane,
		repoLane(lane, owner.principal, { delegates: [delegate.principal] }),
	);
	for (const who of [owner, delegate, other]) {
		world.roles.set(who.principal, ROLE.developer);
	}
	// The same object: `deps()` reads `world.upstream`, `world.config` and
	// `world.node` at call time.
	return Object.assign(world, { owner, delegate, other, lane });
};

const infoRefs = (
	world: LaneWorld,
	service: string,
	auth: AuthContext | null,
	lane = world.lane,
) =>
	handleLaneInfoRefs(
		world.deps(),
		world.request("GET", `info/refs?service=${service}`, {
			auth,
			laneId: lane,
		}),
	);

const receive = (
	world: LaneWorld,
	auth: AuthContext | null,
	commands: readonly PushCommand[],
	lane = world.lane,
) =>
	handleReceivePack(
		world.deps(),
		world.request("POST", "git-receive-pack", {
			auth,
			laneId: lane,
			body: pushBody(commands),
			headers: { "content-type": "application/x-git-receive-pack-request" },
		}),
	);

// ---------------------------------------------------------------------------
// Access and lane existence
// ---------------------------------------------------------------------------

Deno.test("lane remotes: anonymous → 401 and roleless → 404 on every visibility; Guest 403", async () => {
	for (const visibility of ["private", "internal", "public"] as const) {
		const world = laneWorld();
		world.node = { ...world.node, visibility };
		world.upstream = scriptedUpstream(() =>
			new Response(laneAdvertisement(sha(0)))
		);
		equal((await infoRefs(world, "git-upload-pack", null)).status, 401);
		equal((await infoRefs(world, "git-receive-pack", null)).status, 401);
		const anonUpload = await handleLaneUploadPack(
			world.deps(),
			world.request("POST", "git-upload-pack", {
				laneId: world.lane,
				body: "0000",
			}),
		);
		equal(anonUpload.status, 401);
		equal((await receive(world, null, [])).status, 401);
		const stranger = authOf({ principal: `u_${ulid()}` });
		world.roles.set(stranger.principal, ROLE.none);
		const guest = authOf({ principal: `u_${ulid()}` });
		world.roles.set(guest.principal, ROLE.guest);
		if (visibility === "internal") {
			// Any signed-in caller is a Reporter of an internal repo (as on
			// the canonical URL), so it reads lanes but never pushes them.
			equal(
				(await infoRefs(world, "git-upload-pack", stranger)).status,
				200,
			);
			equal((await receive(world, stranger, [])).status, 403);
			continue;
		}
		equal(
			(await infoRefs(world, "git-upload-pack", stranger)).status,
			404,
			visibility,
		);
		equal((await receive(world, stranger, [])).status, 404);
		equal((await infoRefs(world, "git-upload-pack", guest)).status, 403);
		equal(world.upstream.calls.length, 0, "nothing reached upstream");
	}
});

Deno.test("lane remotes: unknown, branch-backend, other repo's and deleted lanes are 404; archived lanes stay readable", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(() =>
		new Response(laneAdvertisement(sha(0)))
	);
	const reporter = authOf({ principal: `u_${ulid()}` });
	world.roles.set(reporter.principal, ROLE.reporter);
	const unknown = laneIdOf(ulid());
	equal(
		(await infoRefs(world, "git-upload-pack", reporter, unknown)).status,
		404,
	);
	const branch = laneIdOf(ulid());
	world.repo.lanes.set(
		branch,
		repoLane(branch, world.owner.principal, {
			mode: "branch",
			seed: undefined,
			ref: `refs/heads/lanes/${branch}`,
		}),
	);
	equal(
		(await infoRefs(world, "git-upload-pack", reporter, branch)).status,
		404,
	);
	const foreign = laneIdOf(ulid());
	world.repo.lanes.set(
		foreign,
		repoLane(foreign, world.owner.principal, { repoId: ulid() }),
	);
	equal(
		(await infoRefs(world, "git-upload-pack", reporter, foreign)).status,
		404,
	);
	const deleted = laneIdOf(ulid());
	world.repo.lanes.set(
		deleted,
		repoLane(deleted, world.owner.principal, { state: "deleted" }),
	);
	equal(
		(await infoRefs(world, "git-upload-pack", reporter, deleted)).status,
		404,
	);
	equal(
		(await receive(world, world.owner, [{
			ref: MAIN,
			old: sha(0),
			new: sha(1),
		}], deleted)).status,
		404,
	);
	equal(world.upstream.calls.length, 0);
	const archived = laneIdOf(ulid());
	world.repo.lanes.set(
		archived,
		repoLane(archived, world.owner.principal, { state: "archived" }),
	);
	const res = await infoRefs(world, "git-upload-pack", reporter, archived);
	equal(res.status, 200);
	ok((await textOf(res)).includes("refs/heads/main"));
	equal(world.upstream.calls[0].path.includes(laneRepoName(archived)), true);
});

Deno.test("lane remotes: an opening lane without a lane repo is 404 on reads", async () => {
	const world = laneWorld();
	const opening = laneIdOf(ulid());
	world.repo.lanes.set(
		opening,
		repoLane(opening, world.owner.principal, { state: "opening" }),
	);
	const upstream = world.repo.upstream;
	world.repo.upstream = (target, scope) =>
		target.laneId === opening
			? Promise.reject(Object.assign(new Error("not_found: no lane repo"), {
				name: "TartanError",
				code: "not_found",
			}))
			: upstream(target, scope);
	const reporter = authOf({ principal: `u_${ulid()}` });
	world.roles.set(reporter.principal, ROLE.reporter);
	equal(
		(await infoRefs(world, "git-upload-pack", reporter, opening)).status,
		404,
	);
});

// ---------------------------------------------------------------------------
// Advertisements and upload-pack
// ---------------------------------------------------------------------------

Deno.test("lane remotes: the upload advertisement is the lane repo's, unfiltered, with the capability allowlist and a lane-repo read token", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(() =>
		new Response(laneAdvertisement(sha(4)))
	);
	const reporter = authOf({ principal: `u_${ulid()}` });
	world.roles.set(reporter.principal, ROLE.reporter);
	const res = await infoRefs(world, "git-upload-pack", reporter);
	equal(res.status, 200);
	equal(
		res.headers.get("content-type"),
		"application/x-git-upload-pack-advertisement",
	);
	const text = await textOf(res);
	ok(text.includes(`${sha(4)} HEAD`));
	ok(text.includes(`${sha(4)} refs/heads/main`));
	ok(text.includes("symref=HEAD:refs/heads/main"));
	for (const stripped of ["allow-tip-sha1-in-want", "filter"]) {
		ok(!text.includes(stripped), stripped);
	}
	const [call] = world.upstream.calls;
	equal(
		call.path,
		`/git/ns/${laneRepoName(world.lane)}.git/info/refs?service=git-upload-pack`,
	);
	ok(call.headers.get("authorization")?.startsWith("Bearer art_v2_lane_read"));
	deepStrictEqual(world.repo.upstreamTargets, [world.lane]);
	deepStrictEqual(world.repo.upstreamScopes, ["read"]);
});

Deno.test("lane remotes: upload-pack passes a member's gzip request through undecoded to the lane repo", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(() =>
		new Response(new Uint8Array([1, 2, 3]), {
			headers: { "content-type": "application/x-git-upload-pack-result" },
		})
	);
	const reporter = authOf({ principal: `u_${ulid()}` });
	world.roles.set(reporter.principal, ROLE.reporter);
	const res = await handleLaneUploadPack(
		world.deps(),
		world.request("POST", "git-upload-pack", {
			auth: reporter,
			laneId: world.lane,
			body: new Uint8Array([0x1f, 0x8b, 9, 9]),
			headers: { "content-encoding": "gzip", "git-protocol": "version=2" },
		}),
	);
	equal(res.status, 200);
	deepStrictEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
	const [call] = world.upstream.calls;
	equal(call.path, `/git/ns/${laneRepoName(world.lane)}.git/git-upload-pack`);
	equal(call.headers.get("content-encoding"), "gzip");
	equal(call.bodyBytes, 4);
});

Deno.test("lane remotes: the receive advertisement mints a lane-repo write token only for the owner or a delegate", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(() =>
		new Response(receiveAdvertisement(sha(0)))
	);
	for (const who of [world.owner, world.delegate]) {
		const res = await infoRefs(world, "git-receive-pack", who);
		equal(res.status, 200);
		const text = await textOf(res);
		ok(text.includes(`${sha(0)} refs/heads/main`));
		ok(!text.includes("push-options") && !text.includes("push-cert"));
	}
	deepStrictEqual(world.repo.upstreamScopes, ["write", "write"]);
	deepStrictEqual(world.repo.upstreamTargets, [world.lane, world.lane]);
	const before = world.upstream.calls.length;
	// Anyone else gets an empty advertisement and no token.
	const res = await infoRefs(world, "git-receive-pack", world.other);
	equal(res.status, 200);
	ok((await textOf(res)).includes("capabilities^{}"));
	// The owner's token pinned to another lane: 403 before anything.
	const pinned = { ...world.owner, laneId: laneIdOf(ulid()) };
	equal((await infoRefs(world, "git-receive-pack", pinned)).status, 403);
	// The owner of an opening lane: empty (pushes are refused lane-opening).
	world.repo.lanes.set(world.lane, {
		...world.repo.lanes.get(world.lane) as Lane,
		state: "opening",
	});
	ok(
		(await textOf(await infoRefs(world, "git-receive-pack", world.owner)))
			.includes("capabilities^{}"),
	);
	equal(world.upstream.calls.length, before);
	equal(world.repo.upstreamScopes.length, 2);
});

// ---------------------------------------------------------------------------
// Receive-pack: the lane-remote table end to end
// ---------------------------------------------------------------------------

Deno.test("lane remotes: the owner's fast-forward of main is forwarded to the lane repo and recorded on the lane", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(okAnswer([MAIN]));
	const res = await receive(world, world.owner, [{
		ref: MAIN,
		old: sha(0),
		new: sha(1),
	}]);
	equal(res.status, 200);
	deepStrictEqual(await reasonsOf(res), { [MAIN]: "ok" });
	await world.settle();
	const [call] = world.upstream.calls;
	equal(call.path, `/git/ns/${laneRepoName(world.lane)}.git/git-receive-pack`);
	ok(call.headers.get("authorization")?.startsWith("Bearer art_v2_lane_write"));
	deepStrictEqual(world.repo.upstreamTargets, [world.lane]);
	equal(world.repo.pushes.length, 1);
	const [pushed] = world.repo.pushes;
	equal(pushed.target, world.lane);
	equal(pushed.repoName, laneRepoName(world.lane));
	deepStrictEqual(pushed.refs, [{ ref: MAIN, before: sha(0), after: sha(1) }]);
	equal(pushed.via, "gateway");
	equal(world.repo.diffs.length, 1, "phase 2 ran for the lane head");
});

Deno.test("lane remotes: every refusal of the lane-remote table is a synthesized ng, recorded on the lane, with nothing forwarded and no token", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(okAnswer([MAIN]));
	const cases: [
		AuthContext,
		PushCommand[],
		Record<string, string>,
		Partial<Lane>?,
	][] = [
		[world.other, [{ ref: MAIN, old: sha(0), new: sha(1) }], {
			[MAIN]: "not-your-lane",
		}],
		[world.owner, [{ ref: "refs/heads/feature", old: ZERO_SHA, new: sha(1) }], {
			"refs/heads/feature": "lane-main-only",
		}],
		[world.owner, [{ ref: "refs/tags/v1", old: ZERO_SHA, new: sha(1) }], {
			"refs/tags/v1": "lane-main-only",
		}],
		[world.owner, [{ ref: MAIN, old: sha(0), new: ZERO_SHA }], {
			[MAIN]: "use-lanes-close",
		}],
		[world.owner, [{ ref: MAIN, old: sha(7), new: sha(1) }], {
			[MAIN]: "stale-old",
		}],
		[world.owner, [{ ref: MAIN, old: ZERO_SHA, new: sha(1) }], {
			[MAIN]: "stale-old",
		}],
		[world.owner, [{ ref: "refs/heads/Main", old: ZERO_SHA, new: sha(1) }], {
			"refs/heads/Main": "case-collision",
		}],
		[world.owner, [{ ref: "refs/heads/lanes", old: ZERO_SHA, new: sha(1) }], {
			"refs/heads/lanes": "reserved-parent",
		}],
		[world.owner, [{ ref: MAIN, old: sha(0), new: sha(1) }], {
			[MAIN]: "lane-opening",
		}, { state: "opening" }],
		[world.owner, [{ ref: MAIN, old: sha(0), new: sha(1) }], {
			[MAIN]: "lane-landing",
		}, { state: "landing" }],
		[world.owner, [{ ref: MAIN, old: sha(0), new: sha(1) }], {
			[MAIN]: "lane-closed",
		}, { state: "closed" }],
		[world.owner, [{ ref: MAIN, old: sha(0), new: sha(1) }], {
			[MAIN]: "lane-closed",
		}, { state: "archived" }],
		// One rejected command rejects the whole push.
		[world.owner, [
			{ ref: MAIN, old: sha(0), new: sha(1) },
			{ ref: "refs/heads/x", old: ZERO_SHA, new: sha(1) },
		], {
			[MAIN]: "atomic: another ref was rejected",
			"refs/heads/x": "lane-main-only",
		}],
	];
	const base = world.repo.lanes.get(world.lane) as Lane;
	for (const [who, commands, expected, over] of cases) {
		world.repo.lanes.set(world.lane, { ...base, ...over });
		const res = await receive(world, who, commands);
		equal(res.status, 200, JSON.stringify(expected));
		deepStrictEqual(await reasonsOf(res), expected);
	}
	await world.settle();
	equal(world.upstream.calls.length, 0, "nothing forwarded");
	equal(world.repo.upstreamScopes.length, 0, "no token minted");
	equal(world.repo.rejections.length, cases.length);
	for (const rejection of world.repo.rejections) {
		equal(rejection.target, world.lane);
	}
});

Deno.test("lane remotes: a read-scoped token or a Reporter cannot push; a token pinned to another lane is 403", async () => {
	const world = laneWorld();
	world.upstream = scriptedUpstream(okAnswer([MAIN]));
	const command = [{ ref: MAIN, old: sha(0), new: sha(1) }];
	const readOnly = { ...world.owner, scopes: ["repo:read"] } as AuthContext;
	equal((await receive(world, readOnly, command)).status, 403);
	const reporter = authOf({ kind: "agent", principal: world.owner.principal });
	world.roles.set(reporter.principal, ROLE.reporter);
	equal((await receive(world, reporter, command)).status, 403);
	world.roles.set(world.owner.principal, ROLE.developer);
	const pinned = { ...world.owner, laneId: laneIdOf(ulid()) };
	equal((await receive(world, pinned, command)).status, 403);
	const ownPin = { ...world.owner, laneId: world.lane };
	deepStrictEqual(await reasonsOf(await receive(world, ownPin, command)), {
		[MAIN]: "ok",
	});
});

Deno.test("lane remotes: a push over MAX_PUSH_BYTES is refused on the lane before any upstream call", async () => {
	const world = laneWorld();
	world.config = { ...world.config, maxPushBytes: 10 };
	world.upstream = scriptedUpstream(okAnswer([MAIN]));
	const body = pushBody([{ ref: MAIN, old: sha(0), new: sha(1) }]);
	const res = await handleReceivePack(
		world.deps(),
		world.request("POST", "git-receive-pack", {
			auth: world.owner,
			laneId: world.lane,
			body,
			headers: { "content-length": String(body.length) },
		}),
	);
	deepStrictEqual(await reasonsOf(res), { [MAIN]: "push-too-large" });
	await world.settle();
	equal(world.upstream.calls.length, 0);
	equal(world.repo.rejections[0].target, world.lane);
});

Deno.test("lane remotes: band-2 guidance names the lane remote with ECHO_ENABLED", async () => {
	const world = laneWorld();
	world.config = { ...world.config, echo: true };
	const res = await receive(world, world.owner, [{
		ref: "refs/heads/feature",
		old: ZERO_SHA,
		new: sha(1),
	}]);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const band2 = demuxSideband(bytes).band2.map((part) => decoder.decode(part))
		.join("");
	ok(band2.includes("one branch, main"), band2);
	ok(
		band2.includes(
			`git push https://git.example.test/acme/shop/-/lanes/${world.lane}.git HEAD:main`,
		),
		band2,
	);
});

// ---------------------------------------------------------------------------
// Layer 2 against FakeArtifacts
// ---------------------------------------------------------------------------

type FakeWorld = {
	readonly world: LaneWorld;
	readonly fake: FakeArtifacts;
	readonly laneB: string;
	readonly tokens: { name: string; scope: string; token: string }[];
	readonly gatewayFetch: (request: Request) => Promise<Response>;
};

/** The gateway in front of FakeArtifacts: RepoDO's `upstream()` mints real fake tokens. */
const fakeArtifactsWorld = async (policy?: LaneRepoPushPolicy) => {
	const world = laneWorld();
	if (policy) world.config = { ...world.config, lanePolicy: policy };
	const fake = createFakeArtifacts();
	const laneB = laneIdOf(ulid());
	world.repo.lanes.set(laneB, repoLane(laneB, world.other.principal));
	const canonical = repoArtifactsName(REPO_ID);
	const seeded = await fake.seed(canonical, {
		files: { "README.md": "trunk\n" },
	});
	for (const lane of [world.lane, laneB]) {
		await fake.seed(laneRepoName(lane), { files: { "README.md": "trunk\n" } });
		const head = fake.inspect.refs(laneRepoName(lane))[MAIN];
		world.repo.lanes.set(lane, {
			...world.repo.lanes.get(lane) as Lane,
			head,
		});
	}
	const tokens: { name: string; scope: string; token: string }[] = [];
	const repo: GatewayRepo = {
		...world.repo,
		upstream: async (target, scope): Promise<Upstream> => {
			world.repo.upstreamTargets.push(target.laneId ?? "repo");
			const name = target.laneId === undefined
				? canonical
				: laneRepoName(target.laneId);
			const handle = await fake.get(name);
			const minted = await handle.createToken(scope, 600);
			tokens.push({ name, scope, token: minted.plaintext });
			return {
				artifactsName: name,
				remote: fake.remote(name),
				token: minted.plaintext,
				expiresAt: Date.parse(minted.expiresAt),
				kind: target.laneId === undefined ? "canonical" : "lane-repo",
				ref: MAIN,
			};
		},
	};
	const deps = () => ({
		...world.deps(),
		repo: () => repo,
		fetch: (request: Request) => fake.fetch(request),
	});
	const gatewayFetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const m = /^\/acme\/shop\/-\/lanes\/(ln_[0-9a-z]+)\.git\/(.+)$/.exec(
			url.pathname,
		);
		if (m === null) return new Response("no route", { status: 404 });
		const r: GitRequest = {
			req: request,
			url,
			repoPath: "acme/shop",
			laneId: m[1],
			auth: world.owner,
			waitUntil: (promise) => void world.waits.push(promise),
		};
		return m[2] === "git-receive-pack"
			? await handleReceivePack(deps(), r)
			: m[2] === "git-upload-pack"
			? await handleLaneUploadPack(deps(), r)
			: await handleLaneInfoRefs(deps(), r);
	};
	return { world, fake, laneB, tokens, gatewayFetch, trunk: seeded.head };
};

const newCommit = (fake: FakeArtifacts, name: string, text: string) => {
	const head = fake.inspect.refs(name)[MAIN];
	const commit = fake.commit(name, "refs/heads/scratch", {
		"README.md": text,
	}, { message: text, parents: [head], quiet: true });
	fake.setRef(name, "refs/heads/scratch", null, { quiet: true });
	return { head, commit };
};

Deno.test("layer 2: with an allow-all lane policy, a push to lane A's remote is forwarded with a token FakeArtifacts refuses for the canonical repo and for lane B", async () => {
	const allowAll: LaneRepoPushPolicy = (_ctx, commands) =>
		commands.map((command) => ({ ref: command.ref, allow: true }));
	const { world, fake, laneB, tokens, gatewayFetch } = await fakeArtifactsWorld(
		allowAll,
	);
	const laneA = laneRepoName(world.lane);
	const canonical = repoArtifactsName(REPO_ID);
	const canonicalBefore = fake.inspect.refs(canonical);
	const laneBBefore = fake.inspect.refs(laneRepoName(laneB));
	const { head, commit } = newCommit(fake, laneA, "lane A work\n");
	// A policy bug lets everything through: main, a stray branch, a trunk-named ref.
	const report = await testkitPush(
		gatewayFetch,
		`https://git.example.test/acme/shop/-/lanes/${world.lane}.git`,
		[
			{ ref: MAIN, old: head, new: commit },
			{ ref: "refs/heads/evil", new: commit },
		],
		[],
	);
	equal(report.status, 200);
	await world.settle();
	// Only lane A moved.
	equal(fake.inspect.refs(laneA)[MAIN], commit);
	equal(fake.inspect.refs(laneA)["refs/heads/evil"], commit);
	deepStrictEqual(fake.inspect.refs(canonical), canonicalBefore);
	deepStrictEqual(fake.inspect.refs(laneRepoName(laneB)), laneBBefore);
	// Every token the gateway used is scoped to lane A's repo.
	ok(tokens.length > 0);
	for (const { name } of tokens) equal(name, laneA);
	const write = tokens.find((t) => t.scope === "write");
	ok(write !== undefined, "a write token was minted for lane A");
	for (const other of [canonical, laneRepoName(laneB)]) {
		const res = await fake.fetch(
			new Request(`${fake.remote(other)}/info/refs?service=git-receive-pack`, {
				headers: { authorization: `Bearer ${write.token}` },
			}),
		);
		equal(res.status, 403, `${other} refuses lane A's token`);
		await res.body?.cancel();
	}
	const own = await fake.fetch(
		new Request(`${fake.remote(laneA)}/info/refs?service=git-receive-pack`, {
			headers: { authorization: `Bearer ${write.token}` },
		}),
	);
	equal(own.status, 200);
	await own.body?.cancel();
});

Deno.test("lane remotes against FakeArtifacts: the real policy lands main and refuses everything else", async () => {
	const { world, fake, gatewayFetch } = await fakeArtifactsWorld();
	const laneA = laneRepoName(world.lane);
	const { head, commit } = newCommit(fake, laneA, "lane A work\n");
	const refused = await testkitPush(
		gatewayFetch,
		`https://git.example.test/acme/shop/-/lanes/${world.lane}.git`,
		[{ ref: "refs/heads/evil", new: commit }],
		[],
	);
	equal(refused.refs.get("refs/heads/evil"), "lane-main-only");
	equal(fake.inspect.refs(laneA)["refs/heads/evil"], undefined);
	const landed = await testkitPush(
		gatewayFetch,
		`https://git.example.test/acme/shop/-/lanes/${world.lane}.git`,
		[{ ref: MAIN, old: head, new: commit }],
		[],
	);
	equal(landed.refs.get(MAIN), "ok");
	await world.settle();
	equal(fake.inspect.refs(laneA)[MAIN], commit);
	const [pushed] = world.repo.pushes;
	equal(pushed.target, world.lane);
	equal(pushed.repoName, laneA);
});
