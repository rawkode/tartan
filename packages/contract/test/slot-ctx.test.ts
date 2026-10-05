// Slot ctx hints (slot-ctx.ts, api.ts `SlotCtxHintSchema`): the strict shape,
// the zod-free mirror the SPA uses, the per-slot refusal the kernel applies
// and the narrowing the SPA applies before every render and action.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ActionRequestSchema, SlotCtxHintSchema } from "../src/api.ts";
import {
	checkSlotCtxHint,
	narrowSlotCtx,
	SLOT_CTX_HINT_KEYS,
	type SlotCtxHint,
	slotCtxRefusal,
	slotEntityKinds,
} from "../src/slot-ctx.ts";
import { SLOT_IDS, type SlotId, SLOTS } from "../src/slots.ts";

const valid: unknown[] = [
	{},
	{ node: "acme" },
	{ node: "01k6c00000000000000000000a" },
	{ node: "acme/platform/router", entity: { kind: "change", id: "zkqv" } },
	{
		node: "acme/platform/router",
		ref: "main",
		path: "src/a.ts",
		lines: { start: 1, end: 3 },
	},
	{ repo: "acme/router", node: "acme/router" },
	{ node: "acme/router", route: "work" },
	{ node: "acme/router", route: "changes/*" },
	{ node: "acme/router", revision: 3, gate: "acme.no-secrets" },
	{ node: "acme/router", path: "" },
	{ node: undefined, ref: "refs/heads/main" },
];

const invalid: unknown[] = [
	null,
	[],
	"acme",
	{ path: "acme", view: "changes/x" },
	{ node: "acme", tab: "work" },
	{ node: "acme", file: "a.ts" },
	{ node: "acme", lane: "ln_x" },
	{ node: "acme", work: "1" },
	{ node: "acme", change: "zkqv" },
	{ node: "" },
	{ node: "Acme" },
	{ node: "/acme" },
	{ repo: "acme//router" },
	{ ref: "" },
	{ ref: "x".repeat(1025) },
	{ path: "/etc/passwd" },
	{ path: "a/../b" },
	{ path: "a\u0000b" },
	{ entity: "change:zkqv" },
	{ entity: { kind: "change" } },
	{ entity: { kind: "Change", id: "x" } },
	{ entity: { kind: "change", id: "" } },
	{ entity: { kind: "change", id: "x", extra: 1 } },
	{ route: "W-12" },
	{ route: "x".repeat(65) },
	{ revision: 0 },
	{ revision: 1.5 },
	{ revision: "1" },
	{ lines: { start: 0, end: 1 } },
	{ lines: { start: 1 } },
	{ lines: { start: 1, end: 2, col: 1 } },
	{ gate: "Bad Gate" },
];

Deno.test("SlotCtxHintSchema is strict and accepts the hints the SPA builds", () => {
	for (const hint of valid) {
		ok(SlotCtxHintSchema.safeParse(hint).success, JSON.stringify(hint));
	}
	for (const hint of invalid) {
		ok(!SlotCtxHintSchema.safeParse(hint).success, JSON.stringify(hint));
	}
	// Action bodies carry the same hint.
	ok(
		ActionRequestSchema.safeParse({
			action: "comment",
			payload: { body: "x" },
			ctx: { node: "acme/router", entity: { kind: "change", id: "zkqv" } },
		}).success,
	);
	ok(
		!ActionRequestSchema.safeParse({
			action: "comment",
			ctx: { path: "acme/router", view: "changes/zkqv" },
		}).success,
	);
});

Deno.test("checkSlotCtxHint agrees with SlotCtxHintSchema", () => {
	for (const hint of [...valid, ...invalid]) {
		const zod = SlotCtxHintSchema.safeParse(hint);
		const mine = checkSlotCtxHint(hint);
		equal(mine.ok, zod.success, JSON.stringify(hint));
		if (mine.ok && zod.success) {
			deepStrictEqual(
				mine.hint,
				Object.fromEntries(
					Object.entries(zod.data).filter(([, v]) => v !== undefined),
				),
			);
		}
	}
	const refused = checkSlotCtxHint({ path: "acme", view: "x", tab: "y" });
	ok(!refused.ok);
	deepStrictEqual(refused.ok ? [] : refused.issues, [
		"(root): unrecognized keys view, tab",
	]);
	deepStrictEqual(SLOT_CTX_HINT_KEYS, Object.keys(SlotCtxHintSchema.shape));
});

Deno.test("slotCtxRefusal: a slot takes only what its catalogue context lists", () => {
	const repo = { node: "acme/router" };
	const change = { ...repo, entity: { kind: "change", id: "zkqv" } };
	equal(slotCtxRefusal("repo.sidebar", { ...repo, ref: "main" }), null);
	equal(
		slotCtxRefusal("repo.sidebar", { ...repo, ref: "main", path: "a.ts" }),
		"slot repo.sidebar takes no path",
	);
	equal(
		slotCtxRefusal("file.banner", { ...repo, ref: "main", path: "a.ts" }),
		null,
	);
	equal(slotCtxRefusal("change.tab", { ...change, route: "diff" }), null);
	equal(
		slotCtxRefusal("change.panel", { ...change, route: "diff" }),
		"slot change.panel takes no route",
	);
	equal(
		slotCtxRefusal("change.gate", { ...change, revision: 2 }),
		"slot change.gate takes no revision",
	);
	equal(slotCtxRefusal("change.gate", { ...change, gate: "x" }), null);
	equal(
		slotCtxRefusal("change.panel", repo),
		"slot change.panel needs a change entity",
	);
	equal(
		slotCtxRefusal("lane.badge", change),
		"slot lane.badge takes no change entity",
	);
	equal(
		slotCtxRefusal("repo.tab", { ...repo, entity: { kind: "work", id: "1" } }),
		"slot repo.tab takes no work entity",
	);
	equal(slotCtxRefusal("agent.context", repo), null);
	equal(
		slotCtxRefusal("blame.annotation", {
			...repo,
			ref: "main",
			path: "a.ts",
			lines: { start: 3, end: 2 },
		}),
		"ctx.lines ends before it starts",
	);
	equal(
		slotCtxRefusal("node.section", { node: "acme", route: "x" }),
		"slot node.section takes no route",
	);
	equal(slotCtxRefusal("node.tab", { node: "acme", route: "x" }), null);
});

Deno.test("narrowSlotCtx keeps exactly what each slot takes", () => {
	const page: SlotCtxHint = {
		node: "acme/router",
		ref: "main",
		path: "src/a.ts",
		route: "diff",
		revision: 2,
		lines: { start: 1, end: 2 },
		gate: "acme.no-secrets",
		entity: { kind: "change", id: "zkqv" },
	};
	const expected: Record<SlotId, SlotCtxHint> = {
		"nav.global": { node: "acme/router" },
		"home.section": { node: "acme/router" },
		"node.tab": { node: "acme/router", route: "diff" },
		"node.section": { node: "acme/router" },
		"repo.tab": { node: "acme/router", route: "diff" },
		"repo.sidebar": { node: "acme/router", ref: "main" },
		"repo.header.action": { node: "acme/router" },
		"file.banner": { node: "acme/router", ref: "main", path: "src/a.ts" },
		"lane.badge": { node: "acme/router" },
		"lane.sidebar": { node: "acme/router" },
		"work.panel": { node: "acme/router" },
		"work.sidebar": { node: "acme/router" },
		"change.tab": {
			node: "acme/router",
			entity: { kind: "change", id: "zkqv" },
			route: "diff",
			revision: 2,
		},
		"change.panel": {
			node: "acme/router",
			entity: { kind: "change", id: "zkqv" },
			revision: 2,
		},
		"change.sidebar": {
			node: "acme/router",
			entity: { kind: "change", id: "zkqv" },
			revision: 2,
		},
		"change.gate": {
			node: "acme/router",
			entity: { kind: "change", id: "zkqv" },
			gate: "acme.no-secrets",
		},
		"blame.annotation": {
			node: "acme/router",
			ref: "main",
			path: "src/a.ts",
			lines: { start: 1, end: 2 },
		},
		"hud.metric": { node: "acme/router" },
		"settings.page": { node: "acme/router" },
		"agent.context": { node: "acme/router" },
	};
	deepStrictEqual(Object.keys(expected).sort(), [...SLOT_IDS].sort());
	for (const slot of SLOT_IDS) {
		const narrowed = narrowSlotCtx(slot, page);
		deepStrictEqual(narrowed, expected[slot], slot);
		// What survives narrowing is never refused for the per-slot rule
		// (only a missing entity can still be: narrowing cannot invent one).
		const refusal = slotCtxRefusal(slot, narrowed);
		ok(
			refusal === null || refusal.includes("needs a"),
			`${slot}: ${refusal}`,
		);
		ok(SlotCtxHintSchema.safeParse(narrowed).success, slot);
	}
});

Deno.test("narrowSlotCtx drops empty, malformed and foreign values", () => {
	deepStrictEqual(
		narrowSlotCtx("repo.sidebar", { node: "acme/router", ref: "" }),
		{ node: "acme/router" },
	);
	deepStrictEqual(
		narrowSlotCtx("repo.tab", { node: "acme/router", route: "W-12" }),
		{ node: "acme/router" },
	);
	deepStrictEqual(
		narrowSlotCtx("repo.tab", { node: "acme/router", route: "" }),
		{ node: "acme/router" },
	);
	deepStrictEqual(
		narrowSlotCtx("blame.annotation", {
			node: "acme/router",
			ref: "main",
			path: "a.ts",
			lines: { start: 4, end: 2 },
		}),
		{ node: "acme/router", ref: "main", path: "a.ts" },
	);
	deepStrictEqual(
		narrowSlotCtx("lane.sidebar", {
			node: "acme/router",
			entity: { kind: "lane", id: "ln_01k6c0000000000000000000aa" },
		}),
		{
			node: "acme/router",
			entity: { kind: "lane", id: "ln_01k6c0000000000000000000aa" },
		},
	);
	deepStrictEqual(
		narrowSlotCtx("work.panel", {
			node: "acme/router",
			entity: { kind: "change", id: "zkqv" },
		}),
		{ node: "acme/router" },
	);
	// Unknown keys never survive (the SPA type forbids them; this is the guard).
	deepStrictEqual(
		narrowSlotCtx(
			"repo.sidebar",
			{ node: "acme/router", view: "" } as unknown as SlotCtxHint,
		),
		{ node: "acme/router" },
	);
});

Deno.test("slotEntityKinds follows the catalogue", () => {
	for (const slot of SLOT_IDS) {
		const context = SLOTS[slot].context as readonly string[];
		deepStrictEqual(
			slotEntityKinds(slot),
			["lane", "work", "change"].filter((k) => context.includes(k)),
		);
	}
});
