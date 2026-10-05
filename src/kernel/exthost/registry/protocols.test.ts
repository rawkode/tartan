// Per-subtree protocols on the real bundled packages (K8): the nearest pack
// defines a subtree's protocol, "in force" is what acts there, and an Owner
// swaps the `queue@1` provider of a subtree in one transaction, and back.
//
// The registry runs over the node:sqlite fakes with every package of
// `src/builtins.ts` registered, so the Swarm and Classic packs are the ones
// the Worker ships.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fromRpcError, type InstallRequest } from "@tartan/contract";
import type { InstallationInForce } from "@tartan/contract/kernel.ts";
import * as classicPack from "../../../../extensions/packs/classic/src/index.ts";
import { builtins } from "../../../builtins.ts";
import { subscriberRows } from "../../events/subscribers.ts";
import { createRegistry } from "./module.ts";
import { REGISTRY_MIGRATIONS } from "./schema.ts";
import { registryFixture } from "./test/fakes.ts";

const OWNER = "u_owner";
const MAINT = "u_maint";

const setup = () => {
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("rawkode", "group");
	fx.tree.add("rawkode/platform/router", "repo");
	fx.tree.add("rawkode/platform/web", "repo");
	fx.tree.add("rawkode/docs", "repo");
	fx.tree.grant("rawkode", MAINT, 40);
	const r = createRegistry(fx.deps, { builtins: () => builtins.all() });
	r.registerBuiltinsSync(builtins.all());
	const id = (path: string) => fx.tree.node(path).id;
	return { fx, f: r.facade, id };
};

const pack = (
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

const exts = (list: readonly InstallationInForce[]): string[] =>
	[...new Set(list.map((i) => i.installation.extId))].sort();

/** Swarm at the root, Classic on `rawkode/docs` (the demo layout). */
const demo = async () => {
	const s = setup();
	await s.f.install(OWNER, pack("tartan.pack.swarm", "rawkode"));
	await s.f.install(OWNER, pack("tartan.pack.classic", "rawkode/docs"));
	return s;
};

Deno.test("Classic under Swarm: the nearest pack defines the subtree's providers", async () => {
	const { f, id } = await demo();
	const docs = id("rawkode/docs");
	const router = id("rawkode/platform/router");
	const providerAt = async (iface: string, node: string) =>
		(await f.provider(iface, node))?.installation;
	equal((await providerAt("queue@1", docs))?.extId, "tartan.fifo");
	equal((await providerAt("queue@1", router))?.extId, "tartan.weave");
	// No radar in a Classic subtree, though Swarm's radar sits at the root.
	equal(await providerAt("conflicts@1", docs), undefined);
	equal((await providerAt("conflicts@1", router))?.extId, "tartan.radar");
	const review = await providerAt("review@1", docs);
	equal(review?.extId, "tartan.review");
	equal(review?.nodePath, "rawkode/docs");
	equal((review?.config as { mode?: string }).mode, "human-required");
	equal(
		((await providerAt("review@1", router))?.config as { mode?: string }).mode,
		"by-exception",
	);
});

Deno.test("Classic under Swarm: in force is what acts there; masked gates stay (K8)", async () => {
	const { f, id } = await demo();
	const docs = id("rawkode/docs");
	const acting = await f.inForce(docs);
	// Every Classic member acts; of the Swarm pack only the by-exception
	// review's gate is left, reduced to it.
	const swarmLeft = acting.filter((i) =>
		i.installation.pack === "tartan.pack.swarm"
	);
	deepStrictEqual(exts(swarmLeft), ["tartan.review"]);
	const gateOnly = swarmLeft[0];
	ok((gateOnly.manifest.gates ?? []).length > 0, "the gate stays");
	equal(gateOnly.manifest.subscribe, undefined);
	equal(gateOnly.manifest.contributes, undefined);
	equal(gateOnly.manifest.provides, undefined);
	deepStrictEqual(
		exts(acting.filter((i) => i.installation.pack === "tartan.pack.classic")),
		[
			"tartan.board",
			"tartan.changes",
			"tartan.ci",
			"tartan.fifo",
			"tartan.pack.classic",
			"tartan.review",
			"tartan.work",
		],
	);
	// Nothing that subscribes to events comes from the Swarm pack: the
	// event subscribers never deliver a Classic repo's events to the Weave
	// or the radar.
	const subscribers = acting.filter((i) => (i.manifest.subscribe ?? []).length);
	ok(
		subscribers.every((i) => i.installation.pack === "tartan.pack.classic"),
		exts(subscribers).join(","),
	);
	// The unresolved lineage still has both packs (the install rules).
	ok(
		(await f.installed(docs)).some((i) =>
			i.installation.extId === "tartan.radar"
		),
	);
	// Contributions and cards follow the same resolution.
	const slots = await f.contributions("slot", docs);
	ok(!slots.some((s) => s.key.startsWith("radar")), "no radar slots");
	const cards = await f.protocolCards(docs);
	ok(cards.some((c) => c.ext === "tartan.fifo"));
	ok(!cards.some((c) => c.ext === "tartan.weave" || c.ext === "tartan.radar"));
	// The Swarm subtree is unchanged.
	const routerCards = await f.protocolCards(id("rawkode/platform/router"));
	ok(routerCards.some((c) => c.ext === "tartan.weave"));
	ok(routerCards.some((c) => c.ext === "tartan.radar"));
});

Deno.test("with the Classic pack card registered, it leads the subtree's cards", async () => {
	// The Classic pack with its own module (with its card) and a manifest
	// that declares it.
	const pkgs = builtins.all().map((p) =>
		p.manifest.id === "tartan.pack.classic"
			? {
				...p,
				manifest: {
					...p.manifest,
					contributes: { protocol: "protocol.md" },
				},
				module: classicPack.extension,
				migrations: classicPack.migrations,
				protocol: classicPack.protocol,
			}
			: p
	);
	const fx = registryFixture(REGISTRY_MIGRATIONS, OWNER);
	fx.tree.add("rawkode", "group");
	fx.tree.add("rawkode/platform/router", "repo");
	fx.tree.add("rawkode/docs", "repo");
	const r = createRegistry(fx.deps, { builtins: () => pkgs });
	r.registerBuiltinsSync(pkgs);
	await r.facade.install(OWNER, pack("tartan.pack.swarm", "rawkode"));
	await r.facade.install(OWNER, pack("tartan.pack.classic", "rawkode/docs"));
	const cards = await r.facade.protocolCards(fx.tree.node("rawkode/docs").id);
	equal(cards[0].ext, "tartan.pack.classic");
	ok(cards[0].md.startsWith("Classic protocol: issues and pull requests."));
	deepStrictEqual(
		cards.map((c) => c.ext),
		["tartan.pack.classic", "tartan.work", "tartan.changes", "tartan.fifo"],
	);
	// The Swarm subtree has no Classic card.
	const swarm = await r.facade.protocolCards(
		fx.tree.node("rawkode/platform/router").id,
	);
	ok(!swarm.some((c) => c.ext === "tartan.pack.classic"));
});

Deno.test("WP6's event subscribers, built from inForce, reach only the subtree's protocol", async () => {
	const { f, id } = await demo();
	const docs = id("rawkode/docs");
	const router = id("rawkode/platform/router");
	const hostsAt = async (repoId: string) => {
		const acting = await f.inForce(repoId);
		const ext = new Map(acting.map((i) => [i.installation.id, i]));
		return subscriberRows(repoId, acting, 1).map((row) =>
			ext.get(row.installation_id)!.installation.extId
		);
	};
	const docsSubs = new Set(await hostsAt(docs));
	ok(docsSubs.has("tartan.fifo"));
	ok(!docsSubs.has("tartan.weave"), "the Swarm Weave gets no docs events");
	ok(!docsSubs.has("tartan.radar"), "nor does the radar");
	const routerSubs = new Set(await hostsAt(router));
	ok(routerSubs.has("tartan.weave") && routerSubs.has("tartan.radar"));
	ok(!routerSubs.has("tartan.fifo"));
});

Deno.test("a standalone install is never masked by a nearer pack", async () => {
	const { f, id } = setup();
	// FIFO alone at the root, then a Swarm pack below: the pack's Weave is
	// the nearer queue@1 provider, and FIFO is replaced, not masked.
	await f.install(OWNER, pack("tartan.fifo", "rawkode"));
	await f.install(OWNER, pack("tartan.pack.swarm", "rawkode/platform"));
	const router = id("rawkode/platform/router");
	equal(
		(await f.provider("queue@1", router))?.installation.extId,
		"tartan.weave",
	);
	// At docs (outside the Swarm subtree) FIFO still provides.
	equal(
		(await f.provider("queue@1", id("rawkode/docs")))?.installation.extId,
		"tartan.fifo",
	);
});

Deno.test("swap queue@1 Weave → FIFO on a repo under the Swarm pack, then back (Owner)", async () => {
	const { fx, f, id } = await demo();
	const router = id("rawkode/platform/router");
	const web = id("rawkode/platform/web");
	const swap = (extId: string, by = OWNER, extra = {}) =>
		f.replaceProvider(by, {
			node: "rawkode/platform/router",
			iface: "queue@1",
			extId,
			version: "0.1.0",
			...extra,
		});
	// A Maintainer cannot swap a queue@1 provider.
	await rejectsWith(swap("tartan.fifo", MAINT), "denied", /Owner/);
	// The sheet: what would happen, nothing written.
	const versionBefore = await f.extVersion();
	const sheet = await swap("tartan.fifo", MAINT, { dryRun: true });
	equal(sheet.dryRun, true);
	equal(sheet.needsOwner, true);
	equal(sheet.from?.extId, "tartan.weave");
	deepStrictEqual(sheet.steps.map((s) => s.kind), ["install"]);
	ok(sheet.lines.includes("provides queue@1"));
	equal(await f.extVersion(), versionBefore);

	const events = fx.events.events.length;
	const done = await swap("tartan.fifo");
	equal(done.provider?.extId, "tartan.fifo");
	equal(done.provider?.nodePath, "rawkode/platform/router");
	equal(done.provider?.pack, undefined);
	equal(done.from?.extId, "tartan.weave");
	equal(
		(await f.provider("queue@1", router))?.installation.extId,
		"tartan.fifo",
	);
	// Only the repo changed: its sibling keeps the Weave.
	equal((await f.provider("queue@1", web))?.installation.extId, "tartan.weave");
	// The replaced Weave no longer acts on the repo.
	ok(
		!(await f.inForce(router)).some((i) =>
			i.installation.extId === "tartan.weave"
		),
	);
	deepStrictEqual(
		fx.events.events.slice(events).map((e) => e.type),
		["extension.installed"],
	);
	const audit = fx.events.audits.at(-1)!;
	equal(audit.action, "extension.replace");
	deepStrictEqual(
		{
			iface: (audit.data as Record<string, unknown>).iface,
			fromExt: (audit.data as Record<string, unknown>).fromExt,
			toExt: (audit.data as Record<string, unknown>).toExt,
		},
		{ iface: "queue@1", fromExt: "tartan.weave", toExt: "tartan.fifo" },
	);
	equal(await f.extVersion(), versionBefore + 1);
	const fifoId = done.provider!.id;

	// Swapping to the provider in force is a no-op.
	const again = await swap("tartan.fifo");
	deepStrictEqual(again.steps, []);
	equal(await f.extVersion(), versionBefore + 1);

	// Back: the repo's FIFO is disabled and the group's Weave is inherited.
	const back = await swap("tartan.weave");
	deepStrictEqual(back.steps.map((s) => s.kind), ["disable", "inherit"]);
	equal(back.provider?.nodePath, "rawkode");
	equal((await f.installation(fifoId))?.mode, "disabled");
	equal(
		(await f.provider("queue@1", router))?.installation.extId,
		"tartan.weave",
	);

	// And to FIFO again: the same installation (and its data) comes back.
	const third = await swap("tartan.fifo");
	deepStrictEqual(third.steps.map((s) => s.kind), ["enable"]);
	equal(third.provider?.id, fifoId);
	equal((await f.installation(fifoId))?.mode, "enforce");
});

Deno.test("swap at the node that holds the provider: disable it and install the other, atomically", async () => {
	const { f, id } = setup();
	await f.install(OWNER, pack("tartan.pack.swarm", "rawkode/platform"));
	const platform = id("rawkode/platform");
	const weave = (await f.provider("queue@1", platform))!.installation;
	equal(weave.nodePath, "rawkode/platform");
	const swap = (extId: string) =>
		f.replaceProvider(OWNER, {
			node: "rawkode/platform",
			iface: "queue@1",
			extId,
			version: "0.1.0",
		});
	const done = await swap("tartan.fifo");
	deepStrictEqual(done.steps.map((s) => s.kind), ["disable", "install"]);
	equal((await f.installation(weave.id))?.mode, "disabled");
	equal(
		(await f.provider("queue@1", platform))?.installation.extId,
		"tartan.fifo",
	);
	// The pack still defines the subtree: its other members act.
	ok(
		(await f.inForce(platform)).some((i) =>
			i.installation.extId === "tartan.radar"
		),
	);
	// Back: FIFO disabled, the pack's Weave re-enabled (same installation).
	const back = await swap("tartan.weave");
	deepStrictEqual(back.steps.map((s) => s.kind), ["disable", "enable"]);
	equal(back.provider?.id, weave.id);
	equal(back.provider?.pack, "tartan.pack.swarm");
});

Deno.test("swap inside a Classic subtree installs outside the pack, so it is not masked", async () => {
	const { f, id } = await demo();
	const done = await f.replaceProvider(OWNER, {
		node: "rawkode/docs",
		iface: "queue@1",
		extId: "tartan.weave",
		version: "0.1.0",
		config: { batch: 2 },
	});
	// The Swarm Weave at the root is masked, so a new one is installed here.
	deepStrictEqual(done.steps.map((s) => s.kind), ["disable", "install"]);
	equal(done.provider?.nodePath, "rawkode/docs");
	equal((done.provider?.config as { batch?: number }).batch, 2);
	equal(
		(await f.provider("queue@1", id("rawkode/docs")))?.installation.id,
		done.provider?.id,
	);
});

Deno.test("swap refusals: not a provider, a pack, a locked provider, a provider of more", async () => {
	const { f } = setup();
	const swap = (extId: string, node = "rawkode/platform") =>
		f.replaceProvider(OWNER, {
			node,
			iface: "queue@1",
			extId,
			version: "0.1.0",
		});
	await rejectsWith(
		swap("tartan.radar"),
		"invalid",
		/does not provide queue@1/,
	);
	await rejectsWith(swap("tartan.pack.classic"), "invalid", /is a pack/);
	await rejectsWith(swap("tartan.nope"), "not_found");
	await rejectsWith(swap("tartan.fifo", "rawkode/nowhere"), "not_found");
	await rejectsWith(
		f.replaceProvider(OWNER, {
			node: "rawkode",
			iface: "context@1" as never,
			extId: "tartan.fifo",
			version: "0.1.0",
		}),
		"invalid",
	);
	await f.install(OWNER, pack("tartan.weave", "rawkode", { locked: true }));
	await rejectsWith(swap("tartan.fifo"), "conflict", /locked to tartan\.weave/);
});
