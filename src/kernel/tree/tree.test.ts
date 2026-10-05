// The hierarchy (WP3): unbounded nesting, range-scanned subtrees, moves and
// renames with redirects, reserved root slugs and slug validation,
// `UNIQUE(path)` for roots, the internals WP2/WP6/WP7a use, protected refs and
// the repo listing for crons.

import {
	deepStrictEqual,
	equal,
	notEqual,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import {
	fromRpcError,
	RESERVED_ROOT_SLUGS,
	ROLE,
	type TartanError,
} from "@tartan/contract";
import { createTreeHarness } from "./testing/harness.ts";
import { MOVE_SYNC_MAX } from "./nodes.ts";

const code = async (p: Promise<unknown>): Promise<TartanError> => {
	try {
		await p;
	} catch (error) {
		return fromRpcError(error);
	}
	throw new Error("expected a rejection");
};

Deno.test("roots: users and groups share one root slug space; UNIQUE(path) dedupes", async () => {
	const h = createTreeHarness();
	const { id: owner, root } = await h.owner("acme-owner");
	equal(root.kind, "user");
	equal(root.depth, 0);
	equal(root.path, "acme-owner");
	// The owner's stored Owner grant at its root.
	deepStrictEqual(
		(await h.facade.grants(root.id)).map((g) => [g.principal_id, g.role]),
		[[owner, ROLE.owner]],
	);
	// Same kind and owner again: idempotent (a retried claim).
	equal(
		(await h.facade.createRoot({ kind: "user", slug: "acme-owner", owner }))
			.id,
		root.id,
	);
	const other = h.identity.user("other");
	const taken = await code(
		h.facade.createRoot({ kind: "group", slug: "acme-owner", owner: other }),
	);
	equal(taken.code, "conflict");
	equal(taken.reason, "path-taken");
	const group = await h.facade.createRoot({
		kind: "group",
		slug: "acme",
		owner: other,
	});
	equal(group.kind, "group");
	ok(h.events.types().includes("node.created"));
});

Deno.test("roots: reserved root slugs and invalid slugs are refused", async () => {
	const h = createTreeHarness();
	const user = h.identity.user("u");
	for (const slug of RESERVED_ROOT_SLUGS) {
		const error = await code(
			h.facade.createRoot({ kind: "group", slug, owner: user }),
		);
		equal(error.code, "invalid", slug);
	}
	for (
		const slug of [
			"",
			"-lead",
			"UPPER",
			"Acme-X",
			"dots.no",
			"under_score",
			"a".repeat(65),
			"space here",
			"slash/no",
		]
	) {
		const error = await code(
			h.facade.createRoot({ kind: "group", slug, owner: user }),
		);
		equal(error.code, "invalid", slug);
		equal(error.reason, "slug", slug);
	}
	// A reserved word is fine below the root.
	const root = await h.facade.createRoot({
		kind: "group",
		slug: "acme",
		owner: user,
	});
	const api = await h.facade.createNode(user, {
		parentId: root.id,
		kind: "group",
		slug: "api",
	});
	equal(api.path, "acme/api");
	equal(
		(await h.facade.createNode(user, {
			parentId: root.id,
			kind: "group",
			slug: "a".repeat(64),
		})).slug.length,
		64,
	);
});

Deno.test("nesting: 40 levels, no depth limit; resolve, ancestors and inherited roles", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner();
	const dev = h.identity.user("dev");
	const root = await h.facade.createRoot({
		kind: "group",
		slug: "deep",
		owner,
	});
	await h.facade.grant(owner, root.id, dev, ROLE.developer);
	let parent = root;
	for (let level = 1; level <= 40; level++) {
		parent = await h.facade.createNode(owner, {
			parentId: parent.id,
			kind: "group",
			slug: `l${level}`,
		});
	}
	equal(parent.depth, 40);
	const path = ["deep", ...Array.from({ length: 40 }, (_, i) => `l${i + 1}`)]
		.join("/");
	equal(parent.path, path);
	const resolved = await h.facade.resolvePath(`${path}/-/changes/zkqv`);
	equal(resolved?.node.id, parent.id);
	equal(resolved?.rest, "-/changes/zkqv");
	equal(h.internal.ancestorPathsSync(parent.id).length, 41);
	equal(await h.facade.effectiveRole([dev], parent.id), ROLE.developer);
	ok(h.internal.isWithinSync(root.id, parent.id));
	ok(!h.internal.isWithinSync(parent.id, root.id));
});

Deno.test("resolvePath: longest existing prefix, rest, .git, unknown paths", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const platform = await h.groups(owner, "acme", "platform");
	const r1 = await h.facade.resolvePath("acme/platform/missing/deeper");
	equal(r1?.node.id, platform.id);
	equal(r1?.rest, "missing/deeper");
	equal((await h.facade.resolvePath("/acme/platform/"))?.rest, "");
	equal(
		(await h.facade.resolvePath("acme/platform.git"))?.node.id,
		platform.id,
	);
	equal(await h.facade.resolvePath("nobody/here"), null);
	equal(await h.facade.resolvePath(""), null);
	equal(await h.facade.resolvePath("../etc"), null);
	equal(await h.facade.resolvePath("ACME/platform"), null);
});

Deno.test("subtree: range scans include descendants only (platform-x and platform0 are siblings)", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const platform = await h.groups(owner, "acme", "platform/edge");
	const siblings = ["platform-x", "platform0", "platformz"];
	for (const slug of siblings) await h.groups(owner, "acme", slug);
	const acmePlatform = (await h.facade.resolvePath("acme/platform"))!.node;
	ok(h.internal.isWithinSync(acmePlatform.id, platform.id));
	for (const slug of siblings) {
		const sib = (await h.facade.resolvePath(`acme/${slug}`))!.node;
		ok(!h.internal.isWithinSync(acmePlatform.id, sib.id), slug);
	}
	// The move rewrite touches the subtree only.
	await h.facade.moveNode(owner, acmePlatform.id, { slug: "core" });
	for (const slug of siblings) {
		equal(
			(await h.facade.resolvePath(`acme/${slug}`))?.node.path,
			`acme/${slug}`,
		);
	}
	equal((await h.facade.resolvePath("acme/core/edge"))?.node.id, platform.id);
});

Deno.test("move/rename of a 3-level subtree rewrites paths and depths and adds redirects", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const edge = await h.groups(owner, "acme", "platform/edge");
	const router = await h.facade.createNode(owner, {
		parentId: edge.id,
		kind: "group",
		slug: "router",
	});
	const platform = (await h.facade.resolvePath("acme/platform"))!.node;
	const other = await h.groups(owner, "acme", "infra");
	// Rename.
	const renamed = await h.facade.moveNode(owner, platform.id, { slug: "core" });
	equal(renamed.path, "acme/core");
	equal((await h.facade.node(router.id))?.path, "acme/core/edge/router");
	equal((await h.facade.node(router.id))?.depth, 3);
	const via = await h.facade.resolvePath(
		"acme/platform/edge/router/-/raw/main/x",
	);
	equal(via?.node.id, router.id);
	equal(via?.rest, "-/raw/main/x");
	equal(via?.redirectTo, "acme/core/edge/router/-/raw/main/x");
	// Move under another parent: depths shift, a second redirect.
	const moved = await h.facade.moveNode(owner, platform.id, {
		parentId: other.id,
	});
	equal(moved.path, "acme/infra/core");
	equal(moved.depth, 2);
	equal((await h.facade.node(router.id))?.depth, 4);
	equal(
		(await h.facade.resolvePath("acme/platform/edge/router"))?.redirectTo,
		"acme/infra/core/edge/router",
	);
	equal(
		(await h.facade.resolvePath("acme/core/edge"))?.redirectTo,
		"acme/infra/core/edge",
	);
	const types = h.events.types().filter((t) => t === "node.moved");
	equal(types.length, 2);
	// Each move revalidates repository config below the node, in its
	// transaction; a move to the same path changes nothing and does not.
	deepStrictEqual(h.revalidations, [
		{ by: owner, scope: platform.id },
		{ by: owner, scope: platform.id },
	]);
	await h.facade.moveNode(owner, platform.id, { slug: "core" });
	equal(h.revalidations.length, 2);
	const moveEvent = h.events.appends.filter((e) => e.type === "node.moved")[1];
	deepStrictEqual(moveEvent.data, {
		nodeId: platform.id,
		kind: "group",
		path: "acme/infra/core",
		oldPath: "acme/core",
	});
	// A new node at an old path claims it: the redirect stops applying.
	const fresh = await h.facade.createNode(owner, {
		parentId: (await h.facade.resolvePath("acme"))!.node.id,
		kind: "group",
		slug: "platform",
	});
	const now = await h.facade.resolvePath("acme/platform/edge/router");
	equal(now?.node.id, fresh.id);
	equal(now?.redirectTo, undefined);
	equal(now?.rest, "edge/router");
});

Deno.test("move: refused into its own subtree, under a repo, onto a taken path, for users, by non-Owners and agents", async () => {
	const h = createTreeHarness();
	const { id: owner, root } = await h.owner("acme");
	const platform = await h.groups(owner, "acme", "platform");
	const edge = await h.groups(owner, "acme/platform", "edge");
	await h.groups(owner, "acme", "taken");
	equal(
		(await code(h.facade.moveNode(owner, platform.id, { parentId: edge.id })))
			.code,
		"invalid",
	);
	equal(
		(await code(h.facade.moveNode(owner, platform.id, { slug: "taken" })))
			.reason,
		"path-taken",
	);
	equal(
		(await code(h.facade.moveNode(owner, root.id, { parentId: platform.id })))
			.code,
		"invalid",
	);
	equal(
		(await code(h.facade.moveNode(owner, platform.id, {}))).code,
		"invalid",
	);
	const maintainer = h.identity.user("m");
	await h.facade.grant(owner, platform.id, maintainer, ROLE.maintainer);
	equal(
		(await code(h.facade.moveNode(maintainer, platform.id, { slug: "x" })))
			.code,
		"denied",
	);
	const agent = h.identity.agent(owner, "bot");
	equal(
		(await code(h.facade.moveNode(agent, platform.id, { slug: "x" }))).code,
		"denied",
	);
	// Unchanged is a no-op.
	equal(
		(await h.facade.moveNode(owner, platform.id, { slug: "platform" })).path,
		"acme/platform",
	);
	// Renaming a root keeps the reserved-slug rule.
	equal(
		(await code(h.facade.moveNode(owner, root.id, { slug: "api" }))).reason,
		"reserved-slug",
	);
	const renamedRoot = await h.facade.moveNode(owner, root.id, {
		slug: "acme2",
	});
	equal(renamedRoot.path, "acme2");
	equal((await h.facade.node(edge.id))?.path, "acme2/platform/edge");
	equal(
		(await h.facade.resolvePath("acme/platform"))?.redirectTo,
		"acme2/platform",
	);
	ok(MOVE_SYNC_MAX >= 5000);
});

Deno.test("children: pages by slug; roots when the parent is null", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const parent = (await h.facade.resolvePath("acme"))!.node;
	for (let i = 0; i < 105; i++) {
		await h.facade.createNode(owner, {
			parentId: parent.id,
			kind: "group",
			slug: `g${String(i).padStart(3, "0")}`,
		});
	}
	const page1 = await h.facade.children(parent.id);
	equal(page1.nodes.length, 100);
	equal(page1.cursor, "g099");
	const page2 = await h.facade.children(parent.id, page1.cursor);
	deepStrictEqual(page2.nodes.map((n) => n.slug), [
		"g100",
		"g101",
		"g102",
		"g103",
		"g104",
	]);
	equal(page2.cursor, undefined);
	deepStrictEqual((await h.facade.children(null)).nodes.map((n) => n.path), [
		"acme",
	]);
	equal(
		(await code(h.facade.children("01k0000000000000000000zzzz"))).code,
		"not_found",
	);
});

Deno.test("groups: Maintainer+ at the parent; never under a repo-free check bypass; visibility and description", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const acme = (await h.facade.resolvePath("acme"))!.node;
	const dev = h.identity.user("dev");
	await h.facade.grant(owner, acme.id, dev, ROLE.developer);
	equal(
		(await code(h.facade.createNode(dev, {
			parentId: acme.id,
			kind: "group",
			slug: "x",
		}))).code,
		"denied",
	);
	const m = h.identity.user("m");
	await h.facade.grant(owner, acme.id, m, ROLE.maintainer);
	const g = await h.facade.createNode(m, {
		parentId: acme.id,
		kind: "group",
		slug: "x",
		visibility: "public",
		description: "hello",
	});
	equal(g.visibility, "public");
	equal(g.description, "hello");
	equal(
		(await code(h.facade.createNode(m, {
			parentId: acme.id,
			kind: "group",
			slug: "y",
			description: "d".repeat(501),
		}))).code,
		"invalid",
	);
	equal(
		(await code(h.facade.createNode(m, {
			parentId: acme.id,
			kind: "group",
			slug: "x",
		}))).reason,
		"path-taken",
	);
});

Deno.test("archive: Owner only, idempotent, node.archived", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "old");
	const m = h.identity.user("m");
	await h.facade.grant(owner, g.id, m, ROLE.maintainer);
	equal((await code(h.facade.archiveNode(m, g.id))).code, "denied");
	equal(h.revalidations.length, 0, "a refused archive revalidates nothing");
	await h.facade.archiveNode(owner, g.id);
	await h.facade.archiveNode(owner, g.id);
	equal((await h.facade.node(g.id))?.archived, true);
	equal(h.events.types().filter((t) => t === "node.archived").length, 1);
	// Repository config below the node is revalidated in the transaction.
	deepStrictEqual(h.revalidations[0], { by: owner, scope: g.id });
});

Deno.test("grants: authority, raise-only inheritance, expiry, revoke, agents never grant", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const team = await h.groups(owner, "acme", "team/sub");
	const acme = (await h.facade.resolvePath("acme"))!.node;
	const teamNode = (await h.facade.resolvePath("acme/team"))!.node;
	const m = h.identity.user("m");
	const u = h.identity.user("u");
	await h.facade.grant(owner, acme.id, m, ROLE.maintainer);
	// A Maintainer grants up to Maintainer (invites), never Owner.
	await h.facade.grant(m, teamNode.id, u, ROLE.developer);
	equal(
		(await code(h.facade.grant(m, teamNode.id, u, ROLE.owner))).code,
		"denied",
	);
	equal(await h.facade.effectiveRole([u], team.id), ROLE.developer);
	// Raise-only: a lower grant below changes nothing; a higher one raises.
	await h.facade.grant(owner, team.id, u, ROLE.reporter);
	equal(await h.facade.effectiveRole([u], team.id), ROLE.developer);
	await h.facade.grant(owner, team.id, u, ROLE.maintainer);
	equal(await h.facade.effectiveRole([u], team.id), ROLE.maintainer);
	equal(await h.facade.effectiveRole([u], teamNode.id), ROLE.developer);
	// Expiry.
	const t = h.identity.user("temp");
	await h.facade.grant(owner, acme.id, t, ROLE.reporter, h.clock.now() + 1000);
	equal(await h.facade.effectiveRole([t], team.id), ROLE.reporter);
	h.clock.advance(1001);
	equal(await h.facade.effectiveRole([t], team.id), ROLE.none);
	equal(
		(await code(h.facade.grant(owner, acme.id, t, ROLE.reporter, 1))).code,
		"invalid",
	);
	// Revoke: a Maintainer may not revoke a grant above its own role.
	await h.facade.revoke(owner, team.id, u);
	equal(await h.facade.effectiveRole([u], team.id), ROLE.developer);
	await h.facade.revoke(owner, team.id, u);
	// Unknown and invalid principals, bad roles.
	equal(
		(await code(
			h.facade.grant(owner, acme.id, "u_01k0000000000000000000zzzz", 20),
		))
			.code,
		"not_found",
	);
	equal(
		(await code(h.facade.grant(owner, acme.id, "someone", 20))).code,
		"invalid",
	);
	equal(
		(await code(h.facade.grant(owner, acme.id, u, 25 as 20))).code,
		"invalid",
	);
	const agent = h.identity.agent(owner, "bot");
	equal(
		(await code(h.facade.grant(agent, acme.id, u, ROLE.guest))).code,
		"denied",
	);
	ok(h.events.audits.some((a) => a.action === "grant"));
	ok(h.events.audits.some((a) => a.action === "revoke"));
});

Deno.test("effective role: the forge Owner everywhere, agents fold in their owner user, disabled principals none", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const deep = await h.groups(owner, "acme", "a/b/c");
	const other = await h.facade.createRoot({
		kind: "group",
		slug: "other",
		owner: h.identity.user("z"),
	});
	equal(await h.facade.effectiveRole([owner], deep.id), ROLE.owner);
	equal(await h.facade.effectiveRole([owner], other.id), ROLE.owner);
	equal(await h.facade.effectiveRole([h.kernel], other.id), ROLE.owner);
	const ownersAgent = h.identity.agent(owner, "bot");
	equal(await h.facade.effectiveRole([ownersAgent], other.id), ROLE.owner);
	const u = h.identity.user("u");
	const agent = h.identity.agent(u, "u-bot");
	await h.facade.grant(owner, deep.id, u, ROLE.developer);
	equal(await h.facade.effectiveRole([agent], deep.id), ROLE.developer);
	await h.facade.grant(owner, deep.id, agent, ROLE.maintainer);
	equal(await h.facade.effectiveRole([agent], deep.id), ROLE.maintainer);
	h.identity.disable(u);
	equal(await h.facade.effectiveRole([u], deep.id), ROLE.none);
	equal(await h.facade.effectiveRole([agent], deep.id), ROLE.maintainer);
	h.identity.disable(agent);
	equal(await h.facade.effectiveRole([agent], deep.id), ROLE.none);
	equal(await h.facade.effectiveRole([u], "01k0000000000000000000zzzz"), 0);
});

Deno.test("holdsRoleWithinSync: a role at the root or anywhere inside its subtree (K12)", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const leaf = await h.groups(owner, "acme", "x/y/z");
	const x = (await h.facade.resolvePath("acme/x"))!.node;
	const sibling = await h.groups(owner, "acme", "w");
	const u = h.identity.user("u");
	ok(!h.internal.holdsRoleWithinSync(u, x.id, h.clock.now()));
	await h.facade.grant(owner, leaf.id, u, ROLE.guest);
	ok(h.internal.holdsRoleWithinSync(u, x.id, h.clock.now()));
	ok(!h.internal.holdsRoleWithinSync(u, sibling.id, h.clock.now()));
	ok(h.internal.holdsRoleWithinSync(owner, sibling.id, h.clock.now()));
	const v = h.identity.user("v");
	await h.facade.grant(
		owner,
		(await h.facade.resolvePath("acme"))!.node.id,
		v,
		10,
	);
	ok(h.internal.holdsRoleWithinSync(v, x.id, h.clock.now()));
});

Deno.test("createRootSync/grantSync: inside the caller's transaction; a throw rolls both back", async () => {
	const h = createTreeHarness();
	const user = h.identity.user("claimer");
	throws(() =>
		h.storage.transactionSync(() => {
			h.internal.createRootSync({ kind: "user", slug: "claimer", owner: user });
			throw new Error("claim failed later");
		})
	);
	equal(await h.facade.resolvePath("claimer"), null);
	const root = h.storage.transactionSync(() =>
		h.internal.createRootSync({ kind: "user", slug: "claimer", owner: user })
	);
	equal(root.path, "claimer");
	const invitee = h.identity.user("invitee");
	h.storage.transactionSync(() =>
		h.internal.grantSync(user, root.id, invitee, ROLE.reporter)
	);
	equal(await h.facade.effectiveRole([invitee], root.id), ROLE.reporter);
	throws(() =>
		h.internal.createRootSync({ kind: "user", slug: "api", owner: user })
	);
	// A disabled user gets no namespace; an agent never owns a root.
	const gone = h.identity.user("gone");
	h.identity.disable(gone);
	throws(() =>
		h.internal.createRootSync({ kind: "user", slug: "gone", owner: gone })
	);
	throws(() =>
		h.internal.createRootSync({
			kind: "user",
			slug: "bot",
			owner: h.identity.agent(user, "bot"),
		})
	);
});

Deno.test("protectedRefs: inherited patterns plus the repo's default branch", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const team = await h.groups(owner, "acme", "team");
	const acme = (await h.facade.resolvePath("acme"))!.node;
	h.storage.sql.exec(
		"INSERT INTO protected_refs (node_id, pattern, created_at) VALUES (?, ?, 0), (?, ?, 0)",
		acme.id,
		"refs/heads/release/*",
		team.id,
		"refs/tags/v*",
	);
	const repo = await h.facade.createRepo(owner, {
		parentId: team.id,
		slug: "svc",
		defaultBranch: "trunk",
	});
	deepStrictEqual(await h.facade.protectedRefs(repo.id), [
		"refs/heads/trunk",
		"refs/heads/release/*",
		"refs/tags/v*",
	]);
	deepStrictEqual(await h.facade.protectedRefs(acme.id), [
		"refs/heads/release/*",
	]);
	await rejects(() => h.facade.protectedRefs("01k0000000000000000000zzzz"));
});

Deno.test("listRepos archived: false leaves out archived repos and repos below an archived group", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const live = await h.groups(owner, "acme", "live");
	const old = await h.groups(owner, "acme", "old");
	const keep = await h.facade.createRepo(owner, {
		parentId: live.id,
		slug: "keep",
	});
	const gone = await h.facade.createRepo(owner, {
		parentId: live.id,
		slug: "gone",
	});
	await h.facade.createRepo(owner, { parentId: old.id, slug: "inside" });
	// A sibling whose path only starts with the archived group's.
	const oldish = await h.groups(owner, "acme", "old-ish");
	const near = await h.facade.createRepo(owner, {
		parentId: oldish.id,
		slug: "near",
	});
	await h.facade.archiveNode(owner, gone.id);
	await h.facade.archiveNode(owner, old.id);
	deepStrictEqual(
		(await h.facade.listRepos({ archived: false })).repos.map((r) => r.id),
		[keep.id, near.id],
	);
	equal(
		(await h.facade.listRepos()).repos.length,
		4,
		"without the option every live repo is listed, archived ones included",
	);
	equal((await h.facade.listRepos({ archived: true })).repos.length, 4);
});

Deno.test("listRepos: live repos by path, paged with a cursor", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const g = await h.groups(owner, "acme", "g");
	const names = ["c", "a", "b"];
	const ids = new Map<string, string>();
	for (const slug of names) {
		ids.set(
			slug,
			(await h.facade.createRepo(owner, { parentId: g.id, slug })).id,
		);
	}
	const page1 = await h.facade.listRepos({ limit: 2 });
	deepStrictEqual(page1.repos.map((r) => r.path), ["acme/g/a", "acme/g/b"]);
	notEqual(page1.cursor, undefined);
	const page2 = await h.facade.listRepos({ cursor: page1.cursor, limit: 2 });
	deepStrictEqual(page2.repos, [{ id: ids.get("c")!, path: "acme/g/c" }]);
	equal(page2.cursor, undefined);
});
