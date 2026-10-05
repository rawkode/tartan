// Slots (lane badge, file banner, change sidebar, repo tab, HUD metric), the
// acknowledge action, and the neighbourhood context@1 section.

import { type HostUiDoc, type SlotContext, validateUi } from "@tartan/contract";
import {
	conflicts,
	createRadar,
	equal,
	laneOpened,
	NODE,
	ok,
	pushed,
	putLane,
	REPO,
	sha,
} from "./kit.ts";

const API = "services/api/src/middleware/limit.ts";

const ctx = (extra: Partial<SlotContext> = {}): SlotContext => ({
	node: NODE,
	repo: REPO,
	mode: "enforce",
	...extra,
});

const valid = (doc: HostUiDoc): string => {
	ok(doc.root.t !== "error-chip", `render failed: ${JSON.stringify(doc)}`);
	const checked = validateUi(doc);
	ok(checked.ok, JSON.stringify(checked));
	return JSON.stringify(doc);
};

const scene = async () => {
	const r = createRadar();
	r.world.work.set("acme/platform/router#38", {
		title: "per-tenant quotas",
		why: "noisy tenants",
	});
	const a = putLane(r.world, {
		n: 1,
		handle: "codex-2",
		entity: { kind: "work", id: "acme/platform/router#38" },
		footprint: { prefixes: ["services/api/src"] },
	});
	const b = putLane(r.world, { n: 2, handle: "claude-code" });
	const idle = putLane(r.world, { n: 3, handle: "idle" });
	await r.deliver(laneOpened(a), laneOpened(b), laneOpened(idle));
	await r.deliver(pushed(r.world, a.id, { after: sha(10), paths: [API] }));
	await r.deliver(
		pushed(r.world, b.id, { after: sha(20), paths: [API, "apps/web/x.ts"] }),
	);
	await r.deliver({
		...laneOpened(b),
		type: "changes.submitted",
		data: {
			changeId: "b".repeat(32),
			laneId: b.id,
			revision: 1,
			head: sha(20),
			base: sha(1),
		},
	});
	return { r, a, b, idle };
};

Deno.test("lane.badge: the worst open conflict, or clear", async () => {
	const { r, a, idle } = await scene();
	const badge = valid(
		await r.render("severity", ctx({ entity: { kind: "lane", id: a.id } })),
	);
	ok(badge.includes("same file"), badge);
	ok(badge.includes("warning"), badge);
	const clear = valid(
		await r.render("severity", ctx({ entity: { kind: "lane", id: idle.id } })),
	);
	ok(clear.includes("radar: clear"), clear);
});

Deno.test("file.banner: the lanes editing a file, and footprints declared over it", async () => {
	const { r } = await scene();
	const banner = valid(await r.render("editing", ctx({ path: API })));
	ok(banner.includes("2 lanes are editing this file"), banner);
	ok(banner.includes('codex-2, #38 \\"per-tenant quotas\\"'), banner);
	const declared = valid(
		await r.render("editing", ctx({ path: "services/api/src/new.ts" })),
	);
	ok(declared.includes("declared"), declared);
	const none = valid(await r.render("editing", ctx({ path: "README.md" })));
	ok(!none.includes("alert"), none);
});

Deno.test("change.sidebar and the acknowledge action", async () => {
	const { r, b } = await scene();
	const side = valid(
		await r.render(
			"conflicts",
			ctx({ entity: { kind: "change", id: "b".repeat(32) } }),
		),
	);
	ok(side.includes(API) && side.includes('"ack"'), side);
	const [row] = conflicts(r, "open").filter((c) => c.severity === "same_file");
	const res = await r.action(
		"ack",
		{ conflictId: row.id, resolution: "coordinate" },
		ctx({ entity: { kind: "change", id: "b".repeat(32) } }),
		{ actor: { kind: "agent", id: b.owner } },
	);
	equal(res.toast?.tone, "success");
	equal(conflicts(r).find((c) => c.id === row.id)?.state, "acked");
	const bad = await r.action(
		"ack",
		{ conflictId: row.id, resolution: "nope" },
		ctx(),
		{
			actor: { kind: "agent", id: b.owner },
		},
	);
	equal(bad.toast?.tone, "danger");
	const unknown = valid(
		await r.render(
			"conflicts",
			ctx({ entity: { kind: "change", id: "c".repeat(32) } }),
		),
	);
	ok(unknown.includes("No conflicts"), unknown);
});

Deno.test("repo.tab and hud.metric render stats and open conflicts", async () => {
	const { r } = await scene();
	const tab = valid(
		await r.render("radar", ctx({ extra: { route: "radar" } })),
	);
	ok(tab.includes("Predicted") && tab.includes(API), tab);
	const hud = valid(await r.render("conflicts-avoided", ctx()));
	ok(hud.includes("Conflicts avoided"), hud);
});

Deno.test("renders are read-only (no write ever reaches the database)", async () => {
	const { r, a } = await scene();
	const before = JSON.stringify(r.q("SELECT * FROM conflicts ORDER BY id"));
	for (
		const slot of [
			"severity",
			"editing",
			"conflicts",
			"radar",
			"conflicts-avoided",
		]
	) {
		valid(
			await r.render(
				slot,
				ctx({ entity: { kind: "lane", id: a.id }, path: API }),
			),
		);
	}
	equal(JSON.stringify(r.q("SELECT * FROM conflicts ORDER BY id")), before);
	equal(r.logs.filter((l) => l.level === "error"), []);
});

Deno.test("context@1 neighbourhood: nearby lanes with work and why, open conflicts with suggestions, within maxBytes", async () => {
	const { r, b } = await scene();
	const [section] = await r.context({
		repo: "acme/platform/router",
		repoId: REPO,
		laneId: b.id,
		maxBytes: 4096,
		actor: { kind: "agent", id: b.owner },
	});
	equal([section.id, section.priority], ["neighbourhood", "conflicts"]);
	ok(section.md.includes("Active lanes near yours"), section.md);
	ok(section.md.includes('#38 "per-tenant quotas"'), section.md);
	ok(section.md.includes("why: noisy tenants"), section.md);
	ok(section.md.includes("Open conflicts on your lane"), section.md);
	ok(section.md.includes("suggestion: coordinate"), section.md);
	const small = await r.context({
		repo: "acme/platform/router",
		repoId: REPO,
		laneId: b.id,
		maxBytes: 120,
		actor: { kind: "agent", id: b.owner },
	});
	ok(new TextEncoder().encode(small[0].md).length <= 120);
	// By work item (no lane id), and nothing to say for an idle lane.
	const none = await r.context({
		repo: "acme/platform/router",
		repoId: REPO,
		laneId: putLane(r.world, { n: 9 }).id,
		maxBytes: 4096,
		actor: { kind: "agent", id: b.owner },
	});
	equal(none, []);
});
