// WP7a registry (K8) over node:sqlite fakes: nearest provider, locked
// providers, Owner approval, monotonic gates, shadow rules, packs, events and
// the ext_version bump, publish validation and builtin registration.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import { fromRpcError, type InstallRequest } from "@tartan/contract";
import { createRegistry, createRegistryModule } from "./module.ts";
import { REGISTRY_MIGRATIONS } from "./schema.ts";
import {
	bundled,
	manifest,
	type RegistryFixture,
	registryFixture,
} from "./test/fakes.ts";

const OWNER = "u_owner";
const MAINT = "u_maint";
const CHILD_MAINT = "u_childmaint";
const DEV = "u_dev";

const PKGS = [
	bundled(
		manifest("tartan.weave", {
			provides: ["queue@1"],
			permissions: { land: ["refs/heads/main"] },
			contributes: {
				slots: [{
					slot: "repo.tab",
					id: "weave",
					label: "Weave",
					route: "weave",
				}],
				tools: [{ name: "queue_peek", description: "peek", input: {} }],
				protocol: "protocol.md",
			},
		}),
		"weave card",
	),
	bundled(manifest("tartan.fifo", {
		provides: ["queue@1"],
		permissions: { land: ["refs/heads/main"] },
		contributes: {
			slots: [{ slot: "repo.tab", id: "fifo", label: "FIFO", route: "fifo" }],
		},
	})),
	bundled(manifest("tartan.work", {
		provides: ["work@1"],
		contributes: {
			slots: [{ slot: "repo.tab", id: "work", label: "Work", route: "work" }],
		},
	})),
	bundled(manifest("tartan.board", {
		storage: { scope: "node" },
		contributes: {
			slots: [{ slot: "nav.global", id: "nav", label: "Board" }],
			tools: [{ name: "peek", description: "peek", input: {} }],
		},
	})),
	bundled(manifest("tartan.review", {
		provides: ["review@1"],
		gates: [{ point: "ref.advance", default: "veto" }],
	})),
	bundled(manifest("tartan.guard", {
		gates: [{ point: "ref.advance" }],
	})),
	bundled(manifest("tartan.ci", { provides: ["checks@1"] })),
	bundled(manifest("tartan.pack.swarm", {
		kind: "pack",
		storage: { scope: "node" },
		members: [
			{ id: "tartan.work", version: "0.1.0" },
			{ id: "tartan.weave", version: "0.1.0", backgroundRole: 30 },
			{ id: "tartan.board", version: "0.1.0" },
		],
	})),
];

const setup = () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("acme", "group");
	fx.tree.add("acme/platform", "group");
	fx.tree.add("acme/platform/router", "repo");
	fx.tree.grant("acme", MAINT, 40);
	fx.tree.grant("acme/platform", CHILD_MAINT, 40);
	fx.tree.grant("acme", DEV, 30);
	const r = createRegistry(fx.deps, { builtins: () => PKGS });
	r.registerBuiltinsSync(PKGS);
	return { fx, r, f: r.facade };
};

const req = (
	extId: string,
	node: string,
	extra: Partial<InstallRequest> = {},
): InstallRequest => ({
	extId,
	version: "0.1.0",
	node,
	mode: "enforce",
	...extra,
});

const rejectsWith = async (
	work: Promise<unknown>,
	code: string,
	match?: RegExp,
): Promise<void> => {
	await rejects(work, (e: unknown) => {
		const err = fromRpcError(e);
		equal(err.code, code, err.message);
		if (match) ok(match.test(err.message), err.message);
		return true;
	});
};

const nodeId = (fx: RegistryFixture, path: string) => fx.tree.node(path).id;

Deno.test("nearest enforce provider wins; the ancestor's replaced contributions drop out", async () => {
	const { fx, f } = setup();
	const weave = await f.install(OWNER, req("tartan.weave", "acme"));
	const fifo = await f.install(OWNER, req("tartan.fifo", "acme/platform"));
	const repo = nodeId(fx, "acme/platform/router");
	equal((await f.provider("queue@1", repo))?.installation.id, fifo.id);
	equal(
		(await f.provider("queue@1", nodeId(fx, "acme")))?.installation.id,
		weave.id,
	);
	const slots = await f.contributions("slot", repo);
	deepStrictEqual(slots.map((s) => s.key), ["fifo"]);
	const provides = await f.contributions("provides", repo);
	deepStrictEqual(provides.map((p) => [p.key, p.installation_id]), [[
		"queue@1",
		fifo.id,
	]]);
	// inForce is what acts here: the replaced Weave is gone (it has no gate),
	// so its subscriptions, tools and context stop at the subtree.
	deepStrictEqual(
		(await f.inForce(repo)).map((i) => i.installation.extId),
		["tartan.fifo"],
	);
	// `installed` is the raw registry query: both, nearest first.
	deepStrictEqual(
		(await f.installed(repo)).map((i) => i.installation.extId),
		["tartan.fifo", "tartan.weave"],
	);
});

Deno.test("a locked ancestor provider refuses a nearer install and wins resolution", async () => {
	const { fx, f } = setup();
	const weave = await f.install(
		OWNER,
		req("tartan.weave", "acme", { locked: true }),
	);
	ok(weave.locked);
	await rejectsWith(
		f.install(OWNER, req("tartan.fifo", "acme/platform")),
		"conflict",
		/locked to tartan\.weave/,
	);
	await rejectsWith(
		f.install(OWNER, req("tartan.weave", "acme/platform")),
		"conflict",
		/locked/,
	);
	equal(
		(await f.provider("queue@1", nodeId(fx, "acme/platform/router")))
			?.installation.id,
		weave.id,
	);
});

Deno.test("installing at a root node needs an Owner", async () => {
	const { f } = setup();
	await rejectsWith(
		f.install(MAINT, req("tartan.work", "acme")),
		"denied",
		/Owner/,
	);
	ok(await f.install(OWNER, req("tartan.work", "acme")));
});

Deno.test("locking needs an Owner; a Maintainer cannot lock", async () => {
	const { f } = setup();
	await rejectsWith(
		f.install(MAINT, req("tartan.work", "acme/platform", { locked: true })),
		"denied",
		/Owner/,
	);
	ok(
		(await f.install(
			OWNER,
			req("tartan.work", "acme/platform", { locked: true }),
		)).locked,
	);
});

Deno.test("checks@1, review@1 and queue@1 providers need an Owner", async () => {
	const { f } = setup();
	for (const ext of ["tartan.ci", "tartan.review", "tartan.weave"]) {
		await rejectsWith(
			f.install(MAINT, req(ext, "acme/platform")),
			"denied",
			/Owner/,
		);
	}
	// A plain provider needs a Maintainer only; a Developer is refused.
	ok(await f.install(MAINT, req("tartan.work", "acme/platform")));
	await rejectsWith(
		f.install(DEV, req("tartan.board", "acme/platform")),
		"denied",
		/Maintainer/,
	);
	// A background role above Reporter needs an Owner.
	await rejectsWith(
		f.install(
			MAINT,
			req("tartan.board", "acme/platform", { backgroundRole: 30 }),
		),
		"denied",
	);
	for (const ext of ["tartan.ci", "tartan.review", "tartan.weave"]) {
		ok(await f.install(OWNER, req(ext, "acme/platform")));
	}
});

Deno.test("an ancestor gate cannot be disabled, removed or shadowed below it (K8)", async () => {
	const { fx, f } = setup();
	const root = await f.install(OWNER, req("tartan.guard", "acme"));
	const repo = nodeId(fx, "acme/platform/router");
	// Shadowing below is refused.
	await rejectsWith(
		f.install(OWNER, req("tartan.guard", "acme/platform", { mode: "shadow" })),
		"conflict",
		/cannot be shadowed below/,
	);
	// A second enforce copy below, then disabled: the ancestor gate still applies.
	const below = await f.install(OWNER, req("tartan.guard", "acme/platform"));
	await rejectsWith(f.setMode(OWNER, below.id, "shadow"), "conflict");
	await f.setMode(OWNER, below.id, "disabled");
	const gates = await f.contributions("gate", repo);
	deepStrictEqual(gates.map((g) => g.installation_id), [root.id]);
	// Gates accumulate: a nearer enforce copy does not hide the ancestor's.
	await f.setMode(OWNER, below.id, "enforce");
	deepStrictEqual(
		(await f.contributions("gate", repo)).map((g) => g.installation_id),
		[below.id, root.id],
	);
	// A Maintainer of the subtree cannot change or remove the ancestor's installation.
	await rejectsWith(f.setMode(CHILD_MAINT, root.id, "disabled"), "denied");
	await rejectsWith(f.uninstall(CHILD_MAINT, root.id), "denied");
	// Shadow beside the enforce copy at the SAME node stays allowed (compare/promote).
	ok(await f.install(OWNER, req("tartan.guard", "acme", { mode: "shadow" })));
});

Deno.test("shadow installs of mutating interfaces are rejected", async () => {
	const { f } = setup();
	for (const ext of ["tartan.weave", "tartan.work"]) {
		await rejectsWith(
			f.install(OWNER, req(ext, "acme", { mode: "shadow" })),
			"invalid",
			/mutating/,
		);
	}
	await rejectsWith(
		f.install(OWNER, req("tartan.board", "acme", { mode: "shadow" })),
		"invalid",
		/limited to gates/,
	);
	const shadowReview = await f.install(
		OWNER,
		req("tartan.review", "acme", { mode: "shadow" }),
	);
	equal(shadowReview.mode, "shadow");
	const work = await f.install(MAINT, req("tartan.work", "acme/platform"));
	await rejectsWith(f.setMode(MAINT, work.id, "shadow"), "invalid", /mutating/);
});

Deno.test("shadow review@1 never becomes the provider but stays effective", async () => {
	const { fx, f } = setup();
	const live = await f.install(OWNER, req("tartan.review", "acme"));
	await f.install(OWNER, req("tartan.review", "acme", { mode: "shadow" }));
	const repo = nodeId(fx, "acme/platform/router");
	equal((await f.provider("review@1", repo))?.installation.id, live.id);
	deepStrictEqual(
		(await f.inForce(repo)).map((i) => i.installation.mode).sort(),
		["enforce", "shadow"],
	);
	equal((await f.contributions("gate", repo)).length, 2);
});

Deno.test("packs install their members with a shared pack column, atomically", async () => {
	const { fx, f } = setup();
	// The weave member has backgroundRole 30: an Owner must approve.
	await rejectsWith(
		f.install(MAINT, req("tartan.pack.swarm", "acme")),
		"denied",
	);
	const pack = await f.install(OWNER, req("tartan.pack.swarm", "acme"));
	equal(pack.extId, "tartan.pack.swarm");
	equal(pack.pack, "tartan.pack.swarm");
	const repo = nodeId(fx, "acme/platform/router");
	const inForce = await f.inForce(repo);
	deepStrictEqual(
		inForce.map((i) => [i.installation.extId, i.installation.pack]).sort(),
		[
			["tartan.board", "tartan.pack.swarm"],
			["tartan.pack.swarm", "tartan.pack.swarm"],
			["tartan.weave", "tartan.pack.swarm"],
			["tartan.work", "tartan.pack.swarm"],
		],
	);
	equal(
		inForce.find((i) => i.installation.extId === "tartan.weave")
			?.installation.backgroundRole,
		30,
	);
	equal(
		fx.events.events.filter((e) => e.type === "extension.installed").length,
		4,
	);
	// Installing the pack again conflicts and leaves nothing half-installed.
	const before = (await f.inForce(repo)).length;
	await rejectsWith(
		f.install(OWNER, req("tartan.pack.swarm", "acme")),
		"conflict",
	);
	equal((await f.inForce(repo)).length, before);
	// Uninstalling the pack removes its members.
	await f.uninstall(OWNER, pack.id);
	equal((await f.inForce(repo)).length, 0);
	equal(
		fx.events.events.filter((e) => e.type === "extension.uninstalled").length,
		4,
	);
});

Deno.test("a failing pack member rolls the whole pack back", async () => {
	const { fx, f } = setup();
	await f.install(OWNER, req("tartan.board", "acme")); // the pack's board now collides
	await rejectsWith(
		f.install(OWNER, req("tartan.pack.swarm", "acme")),
		"conflict",
	);
	deepStrictEqual(
		(await f.inForce(nodeId(fx, "acme"))).map((i) => i.installation.extId),
		["tartan.board"],
	);
});

Deno.test("installs emit extension.* events, audit and bump ext_version (K3)", async () => {
	const { fx, f } = setup();
	const v0 = await f.extVersion();
	const inst = await f.install(MAINT, req("tartan.work", "acme/platform"));
	equal(await f.extVersion(), v0 + 1);
	const [ev] = fx.events.events;
	equal(ev.type, "extension.installed");
	deepStrictEqual(ev.data, {
		inst: inst.id,
		ext: "tartan.work",
		version: "0.1.0",
		node: nodeId(fx, "acme/platform"),
		mode: "enforce",
	});
	deepStrictEqual(ev.actor, { kind: "user", id: MAINT });
	equal(fx.events.audits.length, 1);
	await f.setMode(MAINT, inst.id, "disabled");
	equal(fx.events.events[1].type, "extension.mode.changed");
	equal(await f.extVersion(), v0 + 2);
	equal(fx.events.events.length, 2);
});

Deno.test("runtime overrides other than the package's own are refused", async () => {
	const { f } = setup();
	await rejectsWith(
		f.install(OWNER, req("tartan.board", "acme", { runtimeOverride: "js" })),
		"invalid",
		/needs a published js bundle/,
	);
	ok(
		await f.install(
			OWNER,
			req("tartan.board", "acme", { runtimeOverride: "builtin" }),
		),
	);
});

Deno.test("tool names exposed by two extensions collide at install", async () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("acme");
	const pkgs = [
		bundled(manifest("tartan.alpha.peek", {
			contributes: { tools: [{ name: "go", description: "go", input: {} }] },
		})),
		bundled(manifest("tartan.beta.peek", {
			contributes: { tools: [{ name: "go", description: "go", input: {} }] },
		})),
	];
	const r = createRegistry(fx.deps, { builtins: () => pkgs });
	r.registerBuiltinsSync(pkgs);
	await r.facade.install(OWNER, req("tartan.alpha.peek", "acme"));
	await rejectsWith(
		r.facade.install(OWNER, req("tartan.beta.peek", "acme")),
		"conflict",
		/peek_go collides/,
	);
});

Deno.test("an install at a missing node or of an unknown package is not_found", async () => {
	const { f } = setup();
	await rejectsWith(f.install(OWNER, req("tartan.work", "nope")), "not_found");
	await rejectsWith(f.install(OWNER, req("tartan.nope", "acme")), "not_found");
	await rejectsWith(
		f.install(
			OWNER,
			{ ...req("tartan.work", "acme"), mode: "disabled" } as never,
		),
		"invalid",
	);
});

Deno.test("publish validates the manifest and its policy; versions are immutable", async () => {
	const { f } = setup();
	const sha = "a".repeat(64);
	await rejectsWith(
		f.publish(OWNER, manifest("tartan.evil") as never, {
			sha256: sha,
			r2Prefix: "ext/x",
		}),
		"invalid",
	);
	await rejectsWith(
		f.publish(OWNER, { schema: 1, id: "acme.bad" } as never, {
			sha256: sha,
			r2Prefix: "ext/x",
		}),
		"invalid",
	);
	const good = {
		...manifest("acme.guard", { runtime: "js", entry: { js: "main.js" } }),
	};
	await rejectsWith(
		f.publish(OWNER, good as never, { sha256: sha, r2Prefix: null }),
		"invalid",
		/R2 bundle/,
	);
	const pkg = await f.publish(OWNER, good as never, {
		sha256: sha,
		r2Prefix: `ext/acme.guard/0.1.0/${sha}/`,
	});
	equal(pkg.bundled, false);
	equal(pkg.manifest.storage.mode, "sql"); // parsed, defaults applied
	await rejectsWith(
		f.publish(OWNER, good as never, { sha256: sha, r2Prefix: "ext/x" }),
		"conflict",
	);
});

Deno.test("builtins register idempotently and drive protocol cards", async () => {
	const { fx, r, f } = setup();
	equal(r.registerBuiltinsSync(PKGS), 0);
	ok(
		(await f.packages()).every((p) =>
			p.bundled && p.publishedBy === "sys_kernel"
		),
	);
	await f.install(OWNER, req("tartan.weave", "acme"));
	deepStrictEqual(
		(await f.protocolCards(nodeId(fx, "acme/platform"))).map((
			c,
		) => [c.ext, c.md]),
		[["tartan.weave", "weave card"]],
	);
	await rejectsWith(
		f.registerBuiltins([{ ...PKGS[0].manifest, version: "9.9.9" }]),
		"invalid",
	);
});

Deno.test("the module validates its migrations and registers builtins on create", () => {
	const module = createRegistryModule({ builtins: () => PKGS });
	ok(module.migrations.every((m) => m.n >= 300 && m.n <= 399));
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	const instance = module.create(fx.deps);
	equal(instance.internal.extVersionSync(), 1);
	throws(() => instance.internal.inForceSync("missing"));
});

Deno.test("promote: shadow → enforce and the old enforce → disabled, atomically", async () => {
	const { fx, f } = setup();
	const live = await f.install(MAINT, req("tartan.guard", "acme/platform"));
	const shadow = await f.install(
		MAINT,
		req("tartan.guard", "acme/platform", { mode: "shadow" }),
	);
	const before = await f.extVersion();
	await rejectsWith(f.promote(DEV, shadow.id), "denied");
	const promoted = await f.promote(MAINT, shadow.id);
	equal(promoted.id, shadow.id);
	equal(promoted.mode, "enforce");
	equal((await f.installation(live.id))?.mode, "disabled");
	equal(await f.extVersion(), before + 1);
	const changed = fx.events.events.filter((e) =>
		e.type === "extension.mode.changed"
	);
	deepStrictEqual(
		changed.slice(-2).map((e) => [
			(e.data as { inst: string }).inst,
			(e.data as { mode: string }).mode,
		]),
		[[live.id, "disabled"], [shadow.id, "enforce"]],
	);
	ok(fx.events.audits.some((a) => a.action === "extension.promote"));
	const repo = nodeId(fx, "acme/platform/router");
	deepStrictEqual(
		(await f.contributions("gate", repo)).map((g) => g.installation_id),
		[shadow.id],
	);
	// Only a shadow installation is promoted.
	await rejectsWith(f.promote(MAINT, shadow.id), "invalid", /shadow/);
});

Deno.test("promote refuses when a disabled copy already holds the slot; a lone shadow just becomes enforce", async () => {
	const { f } = setup();
	const parked = await f.install(MAINT, req("tartan.guard", "acme/platform"));
	await f.setMode(MAINT, parked.id, "disabled");
	await f.install(MAINT, req("tartan.guard", "acme/platform"));
	const shadow = await f.install(
		MAINT,
		req("tartan.guard", "acme/platform", { mode: "shadow" }),
	);
	await rejectsWith(f.promote(MAINT, shadow.id), "conflict", /disabled/);
	await f.uninstall(MAINT, parked.id);
	equal((await f.promote(MAINT, shadow.id)).mode, "enforce");
	const { f: g } = setup();
	const lone = await g.install(
		MAINT,
		req("tartan.guard", "acme/platform", { mode: "shadow" }),
	);
	equal((await g.promote(MAINT, lone.id)).mode, "enforce");
});

Deno.test("promote never leaves two enforce providers of one interface at a node", async () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("acme", "group");
	fx.tree.add("acme/platform", "group");
	const pkgs = [
		...PKGS,
		bundled(manifest("tartan.router", { provides: ["review@1"] })),
	];
	const r = createRegistry(fx.deps, { builtins: () => pkgs });
	r.registerBuiltinsSync(pkgs);
	const f = r.facade;
	const live = await f.install(OWNER, req("tartan.review", "acme/platform"));
	// A shadow router beside it is allowed (the same-node rule is enforce-only).
	const shadow = await f.install(
		OWNER,
		req("tartan.router", "acme/platform", { mode: "shadow" }),
	);
	await rejectsWith(
		f.promote(OWNER, shadow.id),
		"conflict",
		/review@1 is already provided at this node by tartan\.review/,
	);
	equal((await f.installation(shadow.id))?.mode, "shadow");
	equal((await f.installation(live.id))?.mode, "enforce");
	// With the other provider gone, the promote goes through.
	await f.uninstall(OWNER, live.id);
	equal((await f.promote(OWNER, shadow.id)).mode, "enforce");
});

Deno.test("a retired builtin's installations and bundled package are dropped at boot, audited", async () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("acme", "group");
	const retired = bundled(manifest("tartan.tournament", {}));
	const swarm = bundled(manifest("tartan.pack.swarm", {
		kind: "pack",
		storage: { scope: "node" },
		members: [
			{ id: "tartan.work", version: "0.1.0" },
			{ id: "tartan.tournament", version: "0.1.0" },
		],
	}));
	const before = [
		...PKGS.filter((p) => p.manifest.id !== "tartan.pack.swarm"),
		retired,
		swarm,
	];
	const old = createRegistry(fx.deps, { builtins: () => before });
	old.registerBuiltinsSync(before);
	await old.facade.install(OWNER, req("tartan.pack.swarm", "acme"));
	const node = nodeId(fx, "acme");
	ok(
		(await old.facade.inForce(node)).some((i) =>
			i.installation.extId === "tartan.tournament"
		),
	);
	// The next deploy no longer bundles it.
	const now = PKGS;
	const next = createRegistry(fx.deps, { builtins: () => now });
	next.registerBuiltinsSync(now);
	const f = next.facade;
	deepStrictEqual(
		(await f.inForce(node)).map((i) => i.installation.extId).filter((id) =>
			id === "tartan.tournament"
		),
		[],
	);
	deepStrictEqual(await f.packages("tartan.tournament"), []);
	ok(
		(await f.inForce(node)).some((i) => i.installation.extId === "tartan.work"),
	);
	ok(
		fx.events.audits.some((a) =>
			a.action === "extension.retired" && a.target === "tartan.tournament"
		),
	);
	// Idempotent: a second boot finds nothing left.
	const audits = fx.events.audits.length;
	next.registerBuiltinsSync(now);
	equal(fx.events.audits.length, audits);
});

Deno.test("replayGate validates the installation, n and the repo, then mints a replay id", async () => {
	const { fx, f } = setup();
	const guard = await f.install(
		MAINT,
		req("tartan.guard", "acme/platform", { mode: "shadow" }),
	);
	const repo = nodeId(fx, "acme/platform/router");
	const { replayId } = await f.replayGate(guard.id, 41, repo);
	ok(/^gr_[0-9a-z]{26}$/.test(replayId), replayId);
	await rejectsWith(f.replayGate(guard.id, 0, repo), "invalid");
	await rejectsWith(f.replayGate(guard.id, 51, repo), "invalid");
	await rejectsWith(
		f.replayGate(guard.id, 5, nodeId(fx, "acme")),
		"not_found",
	);
	fx.tree.add("other", "group");
	fx.tree.add("other/repo", "repo");
	await rejectsWith(
		f.replayGate(guard.id, 5, nodeId(fx, "other/repo")),
		"denied",
	);
	const work = await f.install(MAINT, req("tartan.work", "acme/platform"));
	await rejectsWith(
		f.replayGate(work.id, 5, repo),
		"invalid",
		/no ref.advance/,
	);
	await f.setMode(MAINT, guard.id, "disabled");
	await rejectsWith(f.replayGate(guard.id, 5, repo), "invalid", /disabled/);
	await rejectsWith(f.replayGate("i_missing", 5, repo), "not_found");
});

Deno.test("a changed bundled manifest under the same version refreshes its installations' contributions", async () => {
	const { fx, r, f } = setup();
	const inst = await f.install(OWNER, req("tartan.work", "acme"));
	const repo = nodeId(fx, "acme/platform/router");
	deepStrictEqual((await f.contributions("slot", repo)).map((c) => c.key), [
		"work",
	]);
	const changed = bundled(manifest("tartan.work", {
		provides: ["work@1"],
		contributes: {
			slots: [{ slot: "repo.tab", id: "work2", label: "Work", route: "work" }],
		},
	}));
	equal(r.registerBuiltinsSync([changed]), 1);
	deepStrictEqual(
		(await f.contributions("slot", repo)).map((
			c,
		) => [c.installation_id, c.key]),
		[[inst.id, "work2"]],
	);
});

Deno.test("a changed bundled manifest under the same version gives its installations the new permissions (e2e: the upgraded Weave)", async () => {
	const { fx, r, f } = setup();
	const pack = await f.install(OWNER, req("tartan.pack.swarm", "acme"));
	const weaveOf = async () =>
		(await f.inForce(nodeId(fx, "acme/platform/router"))).find((i) =>
			i.installation.extId === "tartan.weave"
		)!.installation;
	const before = await weaveOf();
	equal(before.pack, pack.extId, "a member of the pack");
	const old = PKGS.find((p) => p.manifest.id === "tartan.weave")!.manifest;
	const asks = {
		...old.permissions,
		"interfaces.call": [
			...(old.permissions["interfaces.call"] ?? []),
			"queue@1",
		],
	};
	ok(!(before.grants["interfaces.call"] ?? []).includes("queue@1"));
	const changed = bundled(manifest("tartan.weave", {
		...JSON.parse(JSON.stringify(old)),
		permissions: asks,
	}));
	equal(r.registerBuiltinsSync([changed]), 1);
	const after = await weaveOf();
	equal(after.id, before.id, "the same installation");
	deepStrictEqual(after.grants, asks);
	ok(
		fx.events.audits.some((a) =>
			a.action === "extension.grants" && a.target === before.id
		),
		"the refresh is audited",
	);
	// Unchanged content: nothing is rewritten.
	equal(r.registerBuiltinsSync([changed]), 0);
});

Deno.test("a bundled pack's member config follows a deploy that changes it (e2e: the Classic pack's labels)", async () => {
	// A Classic subtree installed before the pack named its tabs
	// "Issues" and "Pull requests": its tartan.work kept the old config.
	const { fx, r, f } = setup();
	await f.install(OWNER, req("tartan.pack.swarm", "acme"));
	const workOf = async () =>
		(await f.inForce(nodeId(fx, "acme/platform/router"))).find((i) =>
			i.installation.extId === "tartan.work"
		)!.installation;
	const before = await workOf();
	deepStrictEqual(before.config, {});
	const old = PKGS.find((p) => p.manifest.id === "tartan.pack.swarm")!
		.manifest;
	const labels = { work: "Issues", "new-work": "New issue" };
	const changed = bundled(manifest("tartan.pack.swarm", {
		...JSON.parse(JSON.stringify(old)),
		members: (old.members ?? []).map((m) =>
			m.id === "tartan.work" ? { ...m, config: { labels } } : m
		),
	}));
	ok(r.registerBuiltinsSync([changed]) >= 1);
	const after = await workOf();
	equal(after.id, before.id, "the same installation");
	deepStrictEqual(after.config, { labels });
	ok(
		fx.events.audits.some((a) =>
			a.action === "extension.config" && a.target === before.id
		),
		"the refresh is audited",
	);
	// The other members and a manual install of the same extension keep
	// their config; a second boot has nothing to do.
	const board = (await f.inForce(nodeId(fx, "acme/platform/router"))).find(
		(i) => i.installation.extId === "tartan.board",
	)!.installation;
	deepStrictEqual(board.config, {});
	equal(r.registerBuiltinsSync([changed]), 0);
});

Deno.test("an installation still holding an older bundled manifest's grants is brought up to date at the next boot, content unchanged", async () => {
	// dev-e2e and the demo forge registered the new Weave manifest before
	// the grant refresh existed: the package row is current, its
	// installations are not.
	const { fx, r, f } = setup();
	await f.install(OWNER, req("tartan.pack.swarm", "acme"));
	const weave = PKGS.find((p) => p.manifest.id === "tartan.weave")!;
	const id =
		(await f.inForce(nodeId(fx, "acme/platform/router"))).find((i) =>
			i.installation.extId === "tartan.weave"
		)!.installation.id;
	fx.deps.sql.exec(
		"UPDATE installations SET grants_json = ? WHERE id = ?",
		JSON.stringify({ land: ["refs/heads/main"], "interfaces.call": [] }),
		id,
	);
	equal(
		r.registerBuiltinsSync(PKGS),
		1,
		"one package's installations refreshed",
	);
	const after =
		(await f.inForce(nodeId(fx, "acme/platform/router"))).find((i) =>
			i.installation.id === id
		)!.installation;
	deepStrictEqual(after.grants, weave.manifest.permissions);
	equal(r.registerBuiltinsSync(PKGS), 0, "then nothing to do");
});
