// The mock API fixtures stay honest: every slot document passes the
// contract's validateUi, and every slot instance a view lists has one.

import { describe, expect, it } from "vitest";
import { validateUi } from "@tartan/contract/ui.ts";
import { isKnownSlot } from "@tartan/contract/slots.ts";
import { ULID_RE } from "@tartan/contract/ids.ts";
import {
	CHANGE_ID,
	INSTALLATIONS,
	NODES,
	SLOT_DOCS,
	viewFor,
} from "../src/api/mock/fixtures.ts";

describe("mock fixtures", () => {
	for (const [key, doc] of Object.entries(SLOT_DOCS)) {
		it(`${key} is a valid tartan-ui@1 document`, () => {
			const result = validateUi(doc);
			expect(result.ok ? [] : result.errors).toEqual([]);
		});
	}

	it("has a document for every slot instance the views list", () => {
		const views = [
			["acme", ""],
			["acme/platform/router", ""],
			["acme/platform/router", "blob/main/README.md"],
			["acme/platform/router", `changes/${CHANGE_ID}`],
			["acme/platform/router", "work/w_17"],
			["acme/platform/router", "work"],
			["acme/platform/router", "changes"],
			["acme/platform/router", "radar"],
		] as const;
		for (const [path, view] of views) {
			const response = viewFor(path, view);
			expect(response).not.toBeNull();
			for (const slot of response!.slots) {
				expect(isKnownSlot(slot.slot)).toBe(true);
				const ext = INSTALLATIONS.find((i) => i.id === slot.installationId)
					?.extId;
				expect(
					SLOT_DOCS[`${ext}/${slot.slot}/${slot.id}`],
					`${path} ${view} ${slot.id}`,
				)
					.toBeDefined();
			}
		}
	});

	it("keeps slot ids unique within an extension (the route carries only the id)", () => {
		const seen = new Set<string>();
		for (const key of Object.keys(SLOT_DOCS)) {
			const [ext, , id] = key.split("/");
			const own = `${ext}/${id}`;
			expect(seen.has(own), key).toBe(false);
			seen.add(own);
		}
	});

	it("uses well-formed ids", () => {
		for (const node of NODES) expect(node.id).toMatch(ULID_RE);
		expect(CHANGE_ID).toMatch(/^[k-z]{32}$/);
	});
});
