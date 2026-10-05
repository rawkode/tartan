// The MCP kernel read tools apply the public view as the gateway, the browse
// routes and the REST lanes route do.
// A signed-in caller below Reporter as a member of a public repo reads only
// visible refs and commits reachable from them, and no lane at all; a member
// reads lanes and lane content as before.

import { equal, ok } from "node:assert/strict";
import {
	createUlid,
	type GitSource,
	type Lane,
	LaneSchema,
	ROLE,
} from "@tartan/contract";
import type { SourceReader } from "../caps/ports.ts";
import { createMcpFixture, valueOf } from "./testing/fixture.ts";

const ulid = createUlid();
const TRUNK = "1".repeat(40);
const OLD = "2".repeat(40);
const LANE_HEAD = "3".repeat(40);
const ATTIC = "4".repeat(40);
const TREE = "5".repeat(40);
const REPO = "acme/shop";

const commitOf = (sha: string, parents: string[]) => ({
	sha,
	treeSha: TREE,
	subject: "s",
	message: "s",
	author: { name: "a", email: "a@x" },
	committer: { name: "a", email: "a@x" },
	parents,
	authoredAt: 0,
	committedAt: 0,
	trailers: [],
});

const COMMITS = new Map([
	[TRUNK, commitOf(TRUNK, [OLD])],
	[OLD, commitOf(OLD, [])],
	[LANE_HEAD, commitOf(LANE_HEAD, [TRUNK])],
	[ATTIC, commitOf(ATTIC, [TRUNK])],
]);

const reader = (seen: GitSource[]) => (source: GitSource) => {
	seen.push(source);
	const r: SourceReader = {
		commit: (sha) => Promise.resolve(COMMITS.get(sha) ?? null),
		tree: (sha) =>
			Promise.resolve(
				sha === TREE
					? [{
						name: "secret.ts",
						mode: "100644",
						hash: "6".repeat(40),
						type: "blob",
					}]
					: null,
			),
		file: (commit, path) =>
			Promise.resolve(
				COMMITS.has(commit) && path === "secret.ts"
					? new TextEncoder().encode(`at ${commit}`)
					: null,
			),
		// First-parent history: TRUNK → OLD.
		log: (from) =>
			Promise.resolve(
				from === TRUNK
					? [COMMITS.get(TRUNK)!, COMMITS.get(OLD)!]
					: from === OLD
					? [COMMITS.get(OLD)!]
					: [],
			),
	};
	return Promise.resolve(r);
};

const setup = () => {
	const fx = createMcpFixture();
	fx.forge.addNode("acme", "group");
	const shop = fx.forge.addNode(REPO, "repo", { visibility: "public" });
	fx.forge.addNode("other", "group");
	const stranger = fx.forge.addPrincipal({ kind: "user", handle: "u" }).id;
	fx.forge.grant(stranger, "other", ROLE.developer);
	const member = fx.forge.addPrincipal({ kind: "user", handle: "m" }).id;
	fx.forge.grant(member, REPO, ROLE.developer);
	const lane: Lane = LaneSchema.parse({
		id: `ln_${ulid()}`,
		repoId: shop.id,
		kind: "lane",
		mode: "branch",
		ref: "refs/heads/lanes/x",
		branch: "lanes/x",
		owner: fx.claude,
		delegates: [],
		footprint: { projects: [], prefixes: ["src/"] },
		base: TRUNK,
		head: LANE_HEAD,
		state: "open",
		quarantined: false,
		leaseExpiresAt: 1_900_000_000_000,
		pushes: 1,
		createdAt: 0,
		remote: "/acme/shop.git",
	});
	const refs: Record<string, string> = {
		HEAD: TRUNK,
		main: TRUNK,
		"refs/heads/main": TRUNK,
		[lane.id]: LANE_HEAD,
		[`refs/heads/lanes/${lane.id}`]: LANE_HEAD,
		"refs/tartan/attic/lb_1": ATTIC,
	};
	fx.forge.setRepo(shop.id, {
		core: {
			resolveRef: (ref: string) =>
				Promise.resolve(/^[0-9a-f]{40}$/.test(ref) ? ref : refs[ref] ?? null),
			readContext: () =>
				Promise.resolve({
					view: "public",
					visibleTips: [TRUNK],
					recentTips: [],
					ownLanes: [],
				}),
			getLane: (id: string) => Promise.resolve(id === lane.id ? lane : null),
			listLanes: () => Promise.resolve({ lanes: [lane] }),
		} as never,
		land: { why: () => Promise.resolve(null) },
	});
	const seen: GitSource[] = [];
	fx.forge.override({
		reader: reader(seen),
		probe: {
			projectGraph: () => Promise.reject(new Error("unused")),
			affected: (_repo, base, head) => Promise.resolve({ base, head } as never),
		},
	});
	return { fx, shop, stranger, member, lane, seen };
};

const errorOf = (result: { structuredContent: Record<string, unknown> }) =>
	valueOf(result as never).error;

Deno.test("a roleless signed-in caller on a public repo gets no lane over MCP (lanes_list, lanes_get, context_get with a lane)", async () => {
	const { fx, stranger, lane } = setup();
	// The forge scope and the repo's own MCP URL: both in the public view.
	for (
		const session of [
			await fx.open(stranger),
			await fx.open(stranger, REPO),
		]
	) {
		equal(
			errorOf(await fx.call(session, "lanes_list", { repo: REPO })),
			"denied",
		);
		equal(
			errorOf(
				await fx.call(session, "lanes_get", { repo: REPO, laneId: lane.id }),
			),
			"denied",
		);
		equal(
			errorOf(
				await fx.call(session, "context_get", {
					repo: REPO,
					laneId: lane.id,
				}),
			),
			"denied",
		);
		// The public trunk still reads.
		const readme = await fx.call(session, "repo_read", {
			repo: REPO,
			path: "secret.ts",
		});
		equal(readme.content[0].text, `at ${TRUNK}`);
	}
	// A token scoped to a node outside the repo (the public floor ignores the
	// token's node) is pointed elsewhere first, and gets no lanes.
	const scoped = await fx.open(stranger, undefined, {
		nodeId: fx.forge.nodeAt("other").id,
	});
	const listed = await fx.call(scoped, "lanes_list", { repo: REPO });
	equal(listed.isError, true);
	equal(listed.structuredContent.lanes, undefined);
});

Deno.test("the public view over MCP reads visible tips and reachable SHAs only, never a lane id, hidden ref or unreachable SHA", async () => {
	const { fx, stranger, lane, seen } = setup();
	const session = await fx.open(stranger);
	const read = (ref: string) =>
		fx.call(session, "repo_read", { repo: REPO, path: "secret.ts", ref });
	for (
		const hidden of [
			lane.id,
			`refs/heads/lanes/${lane.id}`,
			"refs/tartan/attic/lb_1",
			LANE_HEAD,
			ATTIC,
		]
	) {
		equal(errorOf(await read(hidden)), "not_found", hidden);
		equal(
			errorOf(
				await fx.call(session, "repo_tree", { repo: REPO, ref: hidden }),
			),
			"not_found",
			hidden,
		);
	}
	equal(
		errorOf(
			await fx.call(session, "repo_affected", {
				repo: REPO,
				base: TRUNK,
				head: LANE_HEAD,
			}),
		),
		"not_found",
	);
	equal(
		errorOf(await fx.call(session, "why", { repo: REPO, sha: ATTIC })),
		"not_found",
	);
	// Visible: the trunk by name and an older commit reachable from it.
	equal((await read("main")).content[0].text, `at ${TRUNK}`);
	equal((await read(OLD)).content[0].text, `at ${OLD}`);
	ok(
		seen.every((s) => !("laneId" in s)),
		"the public view never opens a lane's repo",
	);
});

Deno.test("a member of the public repo still reads lanes and lane content over MCP", async () => {
	const { fx, member, lane, seen } = setup();
	const session = await fx.open(member);
	const listed = valueOf<{ lanes: { id: string }[] }>(
		await fx.call(session, "lanes_list", { repo: REPO }),
	);
	equal(listed.lanes[0].id, lane.id);
	equal(
		valueOf<{ lane: { id: string } }>(
			await fx.call(session, "lanes_get", { repo: REPO, laneId: lane.id }),
		).lane.id,
		lane.id,
	);
	const atLane = await fx.call(session, "repo_read", {
		repo: REPO,
		path: "secret.ts",
		ref: lane.id,
	});
	equal(atLane.content[0].text, `at ${LANE_HEAD}`);
	equal(seen.at(-1)?.laneId, lane.id);
	equal(
		(await fx.call(session, "repo_read", {
			repo: REPO,
			path: "secret.ts",
			ref: ATTIC,
		})).content[0].text,
		`at ${ATTIC}`,
	);
});
