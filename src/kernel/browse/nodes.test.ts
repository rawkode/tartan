// The hierarchy API and import-complete (WP3): listing what a caller may see,
// resolve with 301, creating groups (root groups: admins) and repos
// (Maintainer+, the token's bounds and scopes), the Owner-only import mode,
// moves, archive, grants, protected refs, and the import-complete route
// delegating to WP5a.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type NodeDto,
	type NodesResponse,
	repoArtifactsName,
	ROLE,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { createImportCompleteHandler } from "./imports.ts";
import { createNodesHandler } from "./nodes.ts";
import {
	adminSession,
	agentToken,
	type BrowseHarness,
	createBrowseHarness,
	pat,
	session,
} from "./testing/harness.ts";

const nodes = async (
	b: BrowseHarness,
	method: string,
	rest: string,
	auth: AuthContext | null,
	body?: unknown,
	query = "",
) => {
	const handler = createNodesHandler(b.depsFor);
	const res = await b.call(
		handler,
		method,
		`/-/api/nodes${rest ? `/${rest}` : ""}${query ? `?${query}` : ""}`,
		auth,
		{ ...(body !== undefined ? { body } : {}), params: rest ? { rest } : {} },
	);
	const text = await res.text();
	return {
		status: res.status,
		headers: res.headers,
		// deno-lint-ignore no-explicit-any
		body: (text ? JSON.parse(text) : null) as any,
	};
};

const setup = async () => {
	const b = createBrowseHarness();
	const { id: owner } = await b.owner("acme");
	const dev = b.identity.user("dev");
	const maint = b.identity.user("maint");
	const stranger = b.identity.user("stranger");
	const acme = (await b.facade.resolvePath("acme"))!.node;
	await b.facade.grant(owner, acme.id, dev, ROLE.developer);
	await b.facade.grant(owner, acme.id, maint, ROLE.maintainer);
	return { b, owner, dev, maint, stranger, acme };
};

Deno.test("POST /-/api/nodes: groups under a parent need Maintainer+ and a write scope; root groups need an admin", async () => {
	const { b, owner, dev, maint } = await setup();
	const created = await nodes(b, "POST", "", session(maint), {
		parent: "acme",
		kind: "group",
		slug: "platform",
		visibility: "internal",
	});
	equal(created.status, 201);
	equal((created.body as NodeDto).path, "acme/platform");
	equal((created.body as NodeDto).visibility, "internal");
	equal(
		(await nodes(b, "POST", "", session(dev), {
			parent: "acme",
			kind: "group",
			slug: "x",
		})).status,
		403,
	);
	// A Maintainer's PAT without repo:write.
	const readOnly = await nodes(
		b,
		"POST",
		"",
		pat(maint, { scopes: ["repo:read", "api"] }),
		{ parent: "acme", kind: "group", slug: "x" },
	);
	equal(readOnly.status, 403);
	equal(readOnly.body.reason, "scopes");
	// A Maintainer's token capped at Developer.
	equal(
		(await nodes(b, "POST", "", pat(maint, { maxRole: 30 }), {
			parent: "acme",
			kind: "group",
			slug: "x",
		})).status,
		403,
	);
	equal(
		(await nodes(b, "POST", "", null, {
			parent: "acme",
			kind: "group",
			slug: "x",
		})).status,
		401,
	);
	// Root groups.
	equal(
		(await nodes(b, "POST", "", session(maint), {
			kind: "group",
			slug: "rootx",
		})).status,
		403,
	);
	const root = await nodes(b, "POST", "", adminSession(owner), {
		kind: "group",
		slug: "rootx",
		visibility: "public",
	});
	equal(root.status, 201);
	equal((root.body as NodeDto).depth, 0);
	equal(
		(await nodes(b, "POST", "", adminSession(owner), {
			kind: "group",
			slug: "api",
		})).body.reason,
		"reserved-slug",
	);
	equal(
		(await nodes(b, "POST", "", session(maint), {
			parent: "acme",
			kind: "group",
			slug: "Bad_Slug",
		})).status,
		400,
	);
	equal(
		(await nodes(b, "POST", "", session(maint), {
			parent: "nowhere",
			kind: "group",
			slug: "x",
		})).status,
		404,
	);
});

Deno.test("POST /-/api/nodes/repos: create, URL import and the Owner-only import mode", async () => {
	const { b, owner, dev, maint } = await setup();
	await b.groups(owner, "acme", "platform");
	const repo = await nodes(b, "POST", "repos", session(maint), {
		parent: "acme/platform",
		slug: "router",
		description: "edge",
	});
	equal(repo.status, 201);
	equal(repo.body.path, "acme/platform/router");
	ok(b.fake.inspect.refs(repoArtifactsName(repo.body.id))["refs/heads/main"]);
	equal(
		(await nodes(b, "POST", "repos", session(dev), {
			parent: "acme/platform",
			slug: "y",
		})).status,
		403,
	);
	equal(
		(await nodes(b, "POST", "repos", session(maint), {
			parent: "acme/platform",
			slug: "z",
			sample: true,
		})).body.reason,
		"sample",
	);
	// Import mode: the forge Owner only, never an agent.
	const byMaint = await nodes(b, "POST", "repos", session(maint), {
		parent: "acme/platform",
		slug: "mono",
		import: { mode: "push" },
	});
	equal(byMaint.status, 403);
	const ownerAgent = b.identity.agent(owner, "bot");
	const byAgent = await nodes(
		b,
		"POST",
		"repos",
		agentToken(ownerAgent, { maxRole: 50 }),
		{ parent: "acme/platform", slug: "mono", import: { mode: "push" } },
	);
	equal(byAgent.status, 403);
	const byOwner = await nodes(b, "POST", "repos", session(owner), {
		parent: "acme/platform",
		slug: "mono",
		import: { mode: "push" },
	});
	equal(byOwner.status, 201);
	equal(b.repos.inits.at(-1)?.importState, "importing");
	// A URL import.
	await b.fake.seed("public-src", { files: { "x.txt": "x\n" } });
	const imported = await nodes(b, "POST", "repos", session(maint), {
		parent: "acme/platform",
		slug: "mirror",
		import: { url: "https://public.example.test/public-src.git" },
	});
	equal(imported.status, 201);
	equal(b.repos.completes.at(-1)?.repoId, imported.body.id);
	// Schema: http URLs are refused before anything happens.
	equal(
		(await nodes(b, "POST", "repos", session(maint), {
			parent: "acme/platform",
			slug: "bad",
			import: { url: "http://example.test/x.git" },
		})).status,
		400,
	);
});

Deno.test("GET /-/api/nodes: roots and children the caller may see; navigation toward grants and public nodes", async () => {
	const { b, owner, stranger } = await setup();
	const secretTeam = await b.groups(owner, "acme", "secret-team");
	await b.groups(owner, "acme", "hidden");
	const open = await b.facade.createNode(owner, {
		parentId: secretTeam.id,
		kind: "group",
		slug: "open",
		visibility: "public",
	});
	await b.facade.createRoot({
		kind: "group",
		slug: "zeta",
		owner: b.identity.user("z"),
	});
	const names = (r: { body: NodesResponse }) => r.body.nodes.map((n) => n.path);
	// The owner sees everything.
	deepStrictEqual(names(await nodes(b, "GET", "", session(owner))), [
		"acme",
		"zeta",
	]);
	// Anonymous: only roots that hold something public below.
	deepStrictEqual(names(await nodes(b, "GET", "", null)), ["acme"]);
	deepStrictEqual(
		names(await nodes(b, "GET", "", null, undefined, "parent=acme")),
		["acme/secret-team"],
	);
	deepStrictEqual(
		names(
			await nodes(b, "GET", "", null, undefined, "parent=acme/secret-team"),
		),
		["acme/secret-team/open"],
	);
	// A stranger with a grant deep inside sees the way there.
	const leaf = await b.groups(owner, "acme/hidden", "inner");
	await b.facade.grant(owner, leaf.id, stranger, ROLE.reporter);
	deepStrictEqual(
		names(
			await nodes(b, "GET", "", session(stranger), undefined, "parent=acme"),
		),
		["acme/hidden", "acme/secret-team"],
	);
	// A token scoped to acme/hidden sees its ancestors and its subtree only.
	const scoped = pat(owner, {
		nodeId: (await b.facade.resolvePath("acme/hidden"))!.node.id,
	});
	deepStrictEqual(names(await nodes(b, "GET", "", scoped)), ["acme"]);
	deepStrictEqual(
		names(await nodes(b, "GET", "", scoped, undefined, "parent=acme")),
		["acme/hidden", "acme/secret-team"],
	);
	// A private parent the caller cannot see is 404.
	equal(
		(await nodes(b, "GET", "", null, undefined, "parent=acme/hidden")).status,
		404,
	);
	equal(open.visibility, "public");
});

Deno.test("resolve, move, archive: 301 for moved paths; Owner for moves; agents refused", async () => {
	const { b, owner, maint } = await setup();
	await b.groups(owner, "acme", "platform/edge");
	const resolved = await nodes(
		b,
		"GET",
		"resolve",
		session(maint),
		undefined,
		"path=acme/platform/edge",
	);
	equal(resolved.status, 200);
	equal(resolved.body.node.path, "acme/platform/edge");
	equal(
		(await nodes(b, "POST", "move", session(maint), {
			node: "acme/platform",
			slug: "core",
		})).status,
		403,
	);
	const ownerAgent = b.identity.agent(owner, "bot");
	equal(
		(await nodes(b, "POST", "move", agentToken(ownerAgent, { maxRole: 50 }), {
			node: "acme/platform",
			slug: "core",
		})).status,
		403,
	);
	const moved = await nodes(b, "POST", "move", session(owner), {
		node: "acme/platform",
		slug: "core",
	});
	equal(moved.status, 200);
	equal(moved.body.path, "acme/core");
	const old = await nodes(
		b,
		"GET",
		"resolve",
		session(maint),
		undefined,
		"path=acme/platform/edge",
	);
	equal(old.status, 301);
	equal(
		old.headers.get("location"),
		"/-/api/nodes/resolve?path=acme%2Fcore%2Fedge",
	);
	// Move under another parent (Maintainer+ there).
	await b.groups(owner, "acme", "infra");
	const under = await nodes(b, "POST", "move", session(owner), {
		node: "acme/core/edge",
		parent: "acme/infra",
	});
	equal(under.body.path, "acme/infra/edge");
	equal(
		(await nodes(b, "POST", "archive", session(maint), { node: "acme/infra" }))
			.status,
		403,
	);
	equal(
		(await nodes(b, "POST", "archive", session(owner), { node: "acme/infra" }))
			.status,
		204,
	);
	equal((await b.facade.resolvePath("acme/infra"))?.node.archived, true);
});

Deno.test("grants and protected refs: Owner grants and revokes, readers list, agents refused", async () => {
	const { b, owner, dev, maint, stranger } = await setup();
	const team = await b.groups(owner, "acme", "team");
	equal(
		(await nodes(b, "POST", "grants", session(maint), {
			node: "acme/team",
			principal: stranger,
			role: 20,
		})).status,
		403,
	);
	const ownerAgent = b.identity.agent(owner, "bot");
	equal(
		(await nodes(b, "POST", "grants", agentToken(ownerAgent, { maxRole: 50 }), {
			node: "acme/team",
			principal: stranger,
			role: 20,
		})).status,
		403,
	);
	// An Owner's PAT needs the admin scope for grants.
	equal(
		(await nodes(b, "POST", "grants", pat(owner), {
			node: "acme/team",
			principal: stranger,
			role: 20,
		})).body.reason,
		"scopes",
	);
	equal(
		(await nodes(b, "POST", "grants", session(owner), {
			node: "acme/team",
			principal: stranger,
			role: 20,
		})).status,
		204,
	);
	equal(await b.facade.effectiveRole([stranger], team.id), ROLE.reporter);
	const listed = await nodes(
		b,
		"GET",
		"grants",
		session(dev),
		undefined,
		"node=acme/team",
	);
	deepStrictEqual(
		listed.body.grants.map((g: { principal: string; role: number }) => [
			g.principal,
			g.role,
		]),
		[[stranger, 20]],
	);
	// Membership is never in the public view.
	const pub = await b.facade.createNode(owner, {
		parentId: team.id,
		kind: "group",
		slug: "pub",
		visibility: "public",
	});
	equal(
		(await nodes(b, "GET", "grants", null, undefined, `node=${pub.path}`))
			.status,
		401,
	);
	equal(
		(await nodes(
			b,
			"GET",
			"grants",
			session(b.identity.user("nobody")),
			undefined,
			`node=${pub.path}`,
		))
			.status,
		403,
	);
	equal(
		(await nodes(
			b,
			"DELETE",
			"grants",
			session(owner),
			undefined,
			`node=acme/team&principal=${stranger}`,
		)).status,
		204,
	);
	equal(await b.facade.effectiveRole([stranger], team.id), ROLE.none);
	const repo = await b.facade.createRepo(owner, {
		parentId: team.id,
		slug: "svc",
	});
	const refs = await nodes(
		b,
		"GET",
		"protected-refs",
		session(dev),
		undefined,
		`node=${repo.path}`,
	);
	deepStrictEqual(refs.body, { patterns: ["refs/heads/main"] });
	equal(
		(await nodes(b, "GET", "nope", session(owner))).status,
		404,
	);
});

Deno.test("import-complete: an Owner of the repo (never an agent or a capped token) ends import mode through WP5a", async () => {
	const { b, owner, maint } = await setup();
	const g = await b.groups(owner, "acme", "big");
	const repo = await b.facade.importRepo(owner, {
		parentId: g.id,
		slug: "mono",
		import: { mode: "push" },
	});
	b.fake.commit(repoArtifactsName(repo.id), "refs/heads/develop", {
		"a.txt": "a\n",
	}, { message: "history", quiet: true });
	const handler = createImportCompleteHandler(b.depsFor);
	const call = (auth: AuthContext | null, repoId = repo.id) =>
		b.call(
			handler,
			"POST",
			`/-/api/repos/${repoId}/import-complete`,
			auth,
			{ body: { defaultBranch: "develop" }, params: { repoId } },
		);
	equal((await call(session(maint))).status, 403);
	equal((await call(pat(owner, { maxRole: 40 }))).status, 403);
	const bot = b.identity.agent(owner, "bot");
	equal(
		(await call(agentToken(bot, { maxRole: 50, scopes: ["admin", "api"] })))
			.status,
		403,
	);
	equal((await call(null)).status, 401);
	equal((await call(session(owner), b.ulid())).status, 404);
	const done = await call(session(owner));
	equal(done.status, 200);
	const body = await done.json() as { defaultBranch: string };
	equal(body.defaultBranch, "develop");
	deepStrictEqual(b.repos.completes.at(-1), {
		repoId: repo.id,
		by: owner,
		defaultBranch: "develop",
	});
	equal((await b.facade.node(repo.id))?.defaultBranch, "develop");
	equal(b.events.appends.at(-1)?.type, "repo.imported");
});
