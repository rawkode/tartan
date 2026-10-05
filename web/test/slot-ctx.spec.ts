// Slot ctx hints: each page builds one hint with the typed
// builders, and every slot it hosts receives only what its catalogue context
// takes (the contract's `narrowSlotCtx`, the rule the kernel refuses with).
// Form submits post the field values at the top level.

import { describe, expect, it } from "vitest";
import { checkSlotCtxHint, slotCtxRefusal } from "@tartan/contract/slot-ctx.ts";
import { SLOT_IDS } from "@tartan/contract/slots.ts";
import {
	ctxKey,
	entityCtx,
	narrowCtx,
	nodeCtx,
	repoCtx,
	type SlotCtxHint,
	tabCtx,
} from "../src/slots/ctx.ts";
import { formPayload } from "../src/ui/context.ts";
import { formDefaults, initialFieldValue } from "../src/ui/forms.ts";

const REPO = "acme/platform/router";
const CHANGE = { kind: "change", id: "zkqvmnopqrstuvwxyzklmnopqrstuvwx" };

/** Page kind → the hint it builds → what each hosted slot receives. */
const PAGES: readonly {
	readonly page: string;
	readonly hint: SlotCtxHint;
	readonly slots: Readonly<Record<string, SlotCtxHint>>;
}[] = [
	{
		page: "repo overview (NodeView/RepoCode)",
		hint: nodeCtx(REPO),
		slots: { "repo.sidebar": { node: REPO } },
	},
	{
		page: "group page (NodeView)",
		hint: nodeCtx("acme"),
		slots: { "node.section": { node: "acme" } },
	},
	{
		page: "tree at a ref (RepoTreeView)",
		hint: repoCtx(REPO, { ref: "main" }),
		slots: { "repo.sidebar": { node: REPO, ref: "main" } },
	},
	{
		page: "tree at the default branch (RepoTreeView)",
		hint: repoCtx(REPO, { ref: "" }),
		slots: { "repo.sidebar": { node: REPO } },
	},
	{
		page: "file (RepoFileView)",
		hint: repoCtx(REPO, { ref: "main", path: "src/a.ts" }),
		slots: {
			"file.banner": { node: REPO, ref: "main", path: "src/a.ts" },
			"repo.sidebar": { node: REPO, ref: "main" },
		},
	},
	{
		page: "commit (RepoCommitView)",
		hint: repoCtx(REPO, { ref: "a".repeat(40) }),
		slots: { "repo.sidebar": { node: REPO, ref: "a".repeat(40) } },
	},
	{
		page: "change, Diff tab (ChangeView)",
		hint: entityCtx(REPO, "change", CHANGE.id, { route: "diff" }),
		slots: {
			"change.tab": { node: REPO, entity: CHANGE, route: "diff" },
			"change.panel": { node: REPO, entity: CHANGE },
			"change.sidebar": { node: REPO, entity: CHANGE },
			"change.gate": { node: REPO, entity: CHANGE },
		},
	},
	{
		page: "lane (LanesView)",
		hint: entityCtx(REPO, "lane", "ln_01k6c0000000000000000000aa"),
		slots: {
			"lane.badge": {
				node: REPO,
				entity: { kind: "lane", id: "ln_01k6c0000000000000000000aa" },
			},
			"lane.sidebar": {
				node: REPO,
				entity: { kind: "lane", id: "ln_01k6c0000000000000000000aa" },
			},
		},
	},
	{
		page: "work item (WorkItemView)",
		hint: entityCtx(REPO, "work", "17"),
		slots: {
			"work.panel": { node: REPO, entity: { kind: "work", id: "17" } },
			"work.sidebar": { node: REPO, entity: { kind: "work", id: "17" } },
		},
	},
	{
		page: "repo tab page (SlotTabView)",
		hint: tabCtx(REPO, "open"),
		slots: { "repo.tab": { node: REPO, route: "open" } },
	},
	{
		page: "repo tab page, upper-case sub-route (SlotTabView)",
		hint: tabCtx(REPO, "W-12"),
		slots: { "repo.tab": { node: REPO } },
	},
	{
		page: "group tab page (SlotTabView)",
		hint: tabCtx("acme"),
		slots: { "node.tab": { node: "acme" } },
	},
];

describe("slot ctx hints", () => {
	for (const { page, hint, slots } of PAGES) {
		it(`${page}: each slot gets what it takes, and the kernel's rule accepts it`, () => {
			for (const [slot, expected] of Object.entries(slots)) {
				const narrowed = narrowCtx(slot, hint);
				expect(narrowed, slot).toEqual(expected);
				expect(checkSlotCtxHint(narrowed).ok, slot).toBe(true);
				expect(
					SLOT_IDS.includes(slot as never) &&
						slotCtxRefusal(slot as never, narrowed),
					slot,
				).toBe(null);
			}
		});
	}

	it("never sends the keys the kernel refuses", () => {
		for (const { hint } of PAGES) {
			for (const key of ["view", "tab", "file", "lane", "work", "change"]) {
				expect(Object.keys(hint)).not.toContain(key);
			}
		}
	});

	it("keys hints canonically, nested objects included", () => {
		const a = narrowCtx("change.tab", {
			route: "diff",
			entity: CHANGE,
			node: REPO,
		});
		const b = narrowCtx("change.tab", {
			node: REPO,
			entity: { id: CHANGE.id, kind: CHANGE.kind },
			route: "diff",
		});
		expect(ctxKey(a)).toBe(ctxKey(b));
		expect(ctxKey(a)).toContain(CHANGE.id);
		expect(ctxKey(narrowCtx("change.tab", { ...a, route: "revisions" })))
			.not.toBe(ctxKey(a));
	});
});

describe("form submit payload", () => {
	it("puts the field values at the top level, with no `values` key", () => {
		expect(formPayload(undefined, { title: "x", kind: "issue" })).toEqual({
			title: "x",
			kind: "issue",
		});
	});

	it("lets the action's own payload win over a field of the same name", () => {
		expect(
			formPayload({ ref: "acme/r#1", body: "from the action" }, {
				body: "typed",
				ref: "spoofed",
			}),
		).toEqual({ body: "from the action", ref: "acme/r#1" });
	});

	it("sends a non-object action payload as `payload`", () => {
		expect(formPayload("x", { body: "typed" })).toEqual({
			body: "typed",
			payload: "x",
		});
	});

	it("starts fields the way UiField does", () => {
		expect(initialFieldValue("checkbox", undefined, undefined)).toBe(false);
		expect(initialFieldValue("select", undefined, ["issue", "intent"])).toBe(
			"issue",
		);
		expect(
			initialFieldValue("select", undefined, [{ value: 2, label: "Two" }]),
		).toBe(2);
		expect(initialFieldValue("textarea", undefined, undefined)).toBe("");
		expect(
			formDefaults([
				{ t: "input", name: "title" },
				{
					t: "row",
					children: [{
						t: "select",
						name: "kind",
						options: ["issue", "intent"],
						value: "intent",
					}],
				},
			]),
		).toEqual({ title: "", kind: "intent" });
	});
});
