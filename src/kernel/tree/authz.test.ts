// Authorization (WP3): role inheritance property tests (raise-only; owner
// synthesized at roots; agent intersection). Random hierarchies and grants
// against an independent oracle, then `decide` across credential bounds,
// scopes, visibility and lane pins, then `createAuthorize` end to end over the
// tree module.

import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
	type EffectiveRole,
	fromRpcError,
	type NodeDto,
	type Permission,
	PERMISSION_MIN_ROLE,
	PERMISSION_TOKEN_SCOPES,
	ROLE,
	type TokenScope,
	type Visibility,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import {
	type AccessFacts,
	createNodeAccessWith,
	decide,
	memberRole,
} from "./authz.ts";
import { createTreeHarness } from "./testing/harness.ts";

/** mulberry32: a small seeded PRNG (reproducible failures). */
const prng = (seed: number) => {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T =>
			items[Math.floor(next() * items.length)],
	};
};

const ROLES = [10, 20, 30, 40, 50] as const;
const VISIBILITIES: readonly Visibility[] = ["private", "internal", "public"];

Deno.test("property: effective roles are raise-only, the max over ancestors, Owner everywhere, agents ∪ their owner user", async () => {
	for (let seed = 1; seed <= 12; seed++) {
		const r = prng(seed);
		const h = createTreeHarness();
		const { id: owner } = await h.owner("root-owner");
		const users = Array.from({ length: 4 }, (_, i) => h.identity.user(`u${i}`));
		const agents = users.map((u, i) => h.identity.agent(u, `a${i}`));
		const nodes: NodeDto[] = [];
		const parentOf = new Map<string, string | null>();
		for (let rootIndex = 0; rootIndex < 2; rootIndex++) {
			const root = await h.facade.createRoot({
				kind: "group",
				slug: `r${rootIndex}`,
				owner: users[rootIndex],
			});
			nodes.push(root);
			parentOf.set(root.id, null);
		}
		for (let i = 0; i < 30; i++) {
			const parent = r.pick(nodes);
			if (parent.depth >= 7) continue;
			const node = await h.facade.createNode(owner, {
				parentId: parent.id,
				kind: "group",
				slug: `n${i}`,
				visibility: r.pick(VISIBILITIES),
			});
			nodes.push(node);
			parentOf.set(node.id, parent.id);
		}
		// Stored grants (the oracle's input); roots already hold their owner's 50.
		const stored = new Map<string, number>();
		const key = (node: string, p: string) => `${node}|${p}`;
		for (const node of nodes.slice(0, 2)) {
			stored.set(key(node.id, users[nodes.indexOf(node)]), 50);
		}
		for (let i = 0; i < 40; i++) {
			const node = r.pick(nodes);
			const principal = r.pick([...users, ...agents]);
			const role = r.pick(ROLES);
			await h.facade.grant(owner, node.id, principal, role);
			stored.set(key(node.id, principal), role);
		}
		const ancestors = (id: string): string[] => {
			const out: string[] = [];
			for (let at: string | null = id; at !== null; at = parentOf.get(at)!) {
				out.push(at);
			}
			return out;
		};
		const oracle = (principals: readonly string[], id: string): number =>
			Math.max(
				0,
				...ancestors(id).flatMap((n) =>
					principals.map((p) => stored.get(key(n, p)) ?? 0)
				),
			);
		for (const node of nodes) {
			equal(await h.facade.effectiveRole([owner], node.id), ROLE.owner);
			for (const [i, user] of users.entries()) {
				const got = await h.facade.effectiveRole([user], node.id);
				equal(got, oracle([user], node.id), `seed ${seed} user ${i}`);
				const agentRole = await h.facade.effectiveRole([agents[i]], node.id);
				equal(
					agentRole,
					oracle([agents[i], user], node.id),
					`seed ${seed} agent ${i}`,
				);
				const parent = parentOf.get(node.id);
				if (parent) {
					ok(got >= await h.facade.effectiveRole([user], parent), "raise-only");
				}
			}
		}
	}
});

// ---------------------------------------------------------------------------
// decide: credential bounds, scopes, visibility, lane pins
// ---------------------------------------------------------------------------

const PERMS = Object.keys(PERMISSION_MIN_ROLE) as Permission[];
const SCOPES: readonly TokenScope[] = [
	"repo:read",
	"repo:write",
	"lanes",
	"mcp",
	"api",
	"admin",
];

const session = (principal = "u_01k6aaaaaaaaaaaaaaaaaaaaaa"): AuthContext => ({
	principal,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
});

const token = (o: Partial<AuthContext>): AuthContext => ({
	principal: "a_01k6aaaaaaaaaaaaaaaaaaaaaa",
	kind: "agent",
	via: "agent-token",
	scopes: ["repo:read", "repo:write", "lanes", "api", "mcp"],
	nodeId: null,
	laneId: null,
	maxRole: 30,
	isAdmin: false,
	...o,
});

const node = (
	visibility: Visibility,
): Pick<NodeDto, "visibility" | "path"> => ({
	visibility,
	path: "acme/shop",
});

const outcome = (f: () => EffectiveRole): EffectiveRole | string => {
	try {
		return f();
	} catch (error) {
		const e = fromRpcError(error);
		return e.reason ? `${e.code}:${e.reason}` : e.code;
	}
};

/** An independent restatement of the role rules for `decide`. */
const expected = (
	auth: AuthContext | null,
	visibility: Visibility,
	facts: AccessFacts,
	perm: Permission,
	laneId?: string,
): EffectiveRole | string => {
	const need = PERMISSION_MIN_ROLE[perm];
	let member = 0;
	let scoped = true;
	if (auth !== null) {
		const isSession = auth.via === "session";
		const scopes = isSession ? null : auth.scopes;
		const needs: readonly string[] = PERMISSION_TOKEN_SCOPES[perm];
		scoped = scopes === null || needs.length === 0 ||
			needs.some((s) => scopes.includes(s as TokenScope));
		let granted = Math.max(
			facts.granted,
			visibility === "internal" ? 20 : 0,
		);
		if (!isSession) {
			if (auth.nodeId !== null && !facts.withinTokenNode) granted = 0;
			granted = Math.min(granted, auth.maxRole);
			if (auth.laneId !== null && laneId !== auth.laneId) {
				granted = Math.min(granted, 20);
			}
		}
		member = scoped ? granted : 0;
	}
	const anyone = visibility === "public" &&
			(perm === "read" || perm === "read-metadata")
		? 20
		: 0;
	const role = Math.max(member, anyone);
	if (role >= need) return role as EffectiveRole;
	if (auth === null) return "unauthenticated";
	if (!scoped) return "denied:scopes";
	if (
		auth.via !== "session" && auth.nodeId !== null && !facts.withinTokenNode
	) {
		return "denied:scope";
	}
	return "denied:role";
};

Deno.test("property: decide matches the role rules for sessions, PATs and agent tokens", () => {
	const r = prng(42);
	for (let i = 0; i < 4000; i++) {
		const kind = r.int(3);
		const auth: AuthContext | null = kind === 0
			? null
			: kind === 1
			? session()
			: token({
				kind: r.next() < 0.5 ? "agent" : "user",
				via: r.next() < 0.5 ? "agent-token" : "pat",
				scopes: SCOPES.filter(() => r.next() < 0.6),
				nodeId: r.next() < 0.5
					? "01k6nodenodenodenodenodenode".slice(0, 26)
					: null,
				laneId: r.next() < 0.3 ? "ln_01k6aaaaaaaaaaaaaaaaaaaaaa" : null,
				maxRole: r.pick(ROLES),
			});
		const visibility = r.pick(VISIBILITIES);
		const facts: AccessFacts = {
			granted: r.pick([0, ...ROLES]) as EffectiveRole,
			withinTokenNode: r.next() < 0.6,
		};
		const perm = r.pick(PERMS);
		const laneId = r.next() < 0.5
			? r.pick([
				"ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
				"ln_01k6bbbbbbbbbbbbbbbbbbbbbb",
			])
			: undefined;
		const got = outcome(() =>
			decide(auth, node(visibility), facts, perm, laneId)
		);
		deepStrictEqual(
			got,
			expected(auth, visibility, facts, perm, laneId),
			JSON.stringify({ auth, visibility, facts, perm, laneId }),
		);
		if (typeof got === "number" && auth !== null && auth.via !== "session") {
			ok(
				got <= auth.maxRole || (visibility === "public" && got === 20),
				"the token ceiling bounds every member role",
			);
		}
	}
});

Deno.test("decide: the public view gives reads to anyone, never writes; internal gives signed-in callers Reporter", () => {
	const none: AccessFacts = { granted: 0, withinTokenNode: true };
	equal(decide(null, node("public"), none, "read"), 20);
	equal(decide(null, node("public"), none, "read-metadata"), 20);
	equal(
		outcome(() => decide(null, node("public"), none, "comment")),
		"unauthenticated",
	);
	equal(
		outcome(() => decide(null, node("internal"), none, "read")),
		"unauthenticated",
	);
	equal(
		outcome(() => decide(null, node("private"), none, "read-metadata")),
		"unauthenticated",
	);
	equal(decide(session(), node("internal"), none, "comment"), 20);
	equal(
		outcome(() => decide(session(), node("private"), none, "read")),
		"denied:role",
	);
	// A roleless signed-in caller on a public repo reads in the public view:
	// its member role stays 0.
	equal(decide(session(), node("public"), none, "read"), 20);
	equal(memberRole(session(), node("public"), none), 0);
	equal(memberRole(session(), node("internal"), none), 20);
	equal(
		memberRole(null, node("internal"), { granted: 50, withinTokenNode: true }),
		0,
	);
	// A token outside its node reads a public repo, never as a member.
	const scoped = token({ nodeId: "01k6aaaaaaaaaaaaaaaaaaaaaa" });
	const outside: AccessFacts = { granted: 40, withinTokenNode: false };
	equal(decide(scoped, node("public"), outside, "read"), 20);
	equal(memberRole(scoped, node("public"), outside), 0);
	equal(
		outcome(() => decide(scoped, node("private"), outside, "read")),
		"denied:scope",
	);
	// Scopes: a token without repo:read on a public repo reads publicly; on a private one it is denied.
	const noRead = token({ scopes: ["api"] });
	const member: AccessFacts = { granted: 30, withinTokenNode: true };
	equal(decide(noRead, node("public"), member, "read"), 20);
	equal(
		outcome(() => decide(noRead, node("private"), member, "read")),
		"denied:scopes",
	);
	equal(
		outcome(() => decide(noRead, node("private"), member, "claim")),
		"denied:scopes",
	);
	// Lane pin: Reporter at most off its lane.
	const pinned = token({
		laneId: "ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
		maxRole: 30,
	});
	equal(
		decide(
			pinned,
			node("private"),
			member,
			"push",
			"ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
		),
		30,
	);
	equal(
		outcome(() => decide(pinned, node("private"), member, "push")),
		"denied:role",
	);
	equal(decide(pinned, node("private"), member, "read"), 20);
	// Ceiling: an Owner's agent token capped at Developer cannot approve.
	const capped = token({ maxRole: 30 });
	equal(
		outcome(() =>
			decide(
				capped,
				node("private"),
				{ granted: 50, withinTokenNode: true },
				"approve",
			)
		),
		"denied:role",
	);
	throws(() => decide(null, node("private"), none, "nope" as Permission));
});

Deno.test("createAuthorize over the tree module: owner synthesized, agent intersection, token node subtree, internal and public", async () => {
	const h = createTreeHarness();
	const { id: owner } = await h.owner("acme");
	const shop = await h.groups(owner, "acme", "platform/shop");
	const platform = (await h.facade.resolvePath("acme/platform"))!.node;
	const elsewhere = await h.groups(owner, "acme", "elsewhere");
	const dev = h.identity.user("dev");
	const bot = h.identity.agent(dev, "bot");
	await h.facade.grant(owner, platform.id, dev, ROLE.developer);
	const access = createNodeAccessWith(() => h.facade);
	const authorize = async (
		auth: AuthContext | null,
		target: NodeDto,
		perm: Permission,
	) => {
		try {
			return (await access(auth, { node: target }, perm)).role;
		} catch (error) {
			const e = fromRpcError(error);
			return e.reason ? `${e.code}:${e.reason}` : e.code;
		}
	};
	equal(await authorize(session(owner), shop, "delete"), 50);
	equal(await authorize(session(owner), elsewhere, "grant"), 50);
	equal(await authorize(session(dev), shop, "push"), 30);
	equal(await authorize(session(dev), elsewhere, "read"), "denied:role");
	// The agent folds in its owner's Developer, capped by its token.
	const agentToken = token({ principal: bot, maxRole: 20 });
	equal(await authorize(agentToken, shop, "read"), 20);
	equal(await authorize(agentToken, shop, "push"), "denied:role");
	equal(
		await authorize(token({ principal: bot, maxRole: 40 }), shop, "push"),
		30,
	);
	// The token's node subtree: inside it, a role; outside it, `scope`.
	const inPlatform = token({
		principal: bot,
		nodeId: platform.id,
		maxRole: 30,
	});
	equal(await authorize(inPlatform, shop, "push"), 30);
	equal(await authorize(inPlatform, elsewhere, "read"), "denied:scope");
	// Visibility.
	const pub = await h.facade.createNode(owner, {
		parentId: elsewhere.id,
		kind: "group",
		slug: "pub",
		visibility: "public",
	});
	const internal = await h.facade.createNode(owner, {
		parentId: elsewhere.id,
		kind: "group",
		slug: "internal",
		visibility: "internal",
	});
	equal(await authorize(null, pub, "read"), 20);
	equal(await authorize(null, internal, "read"), "unauthenticated");
	equal(await authorize(session(dev), internal, "read"), 20);
	const viewOf = await access(session(dev), { node: pub }, "read");
	deepStrictEqual(viewOf, { role: 20, member: 0 });
	const asMember = await access(session(dev), { node: shop }, "read");
	deepStrictEqual(asMember, { role: 30, member: 30 });
});
