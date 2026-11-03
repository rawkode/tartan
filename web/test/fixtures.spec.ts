// The mock API fixtures stay honest: the mock forge installs no extensions,
// every sample slot document passes the contract's validateUi, every slot
// instance a view lists has one, and the mock applies the kernel's ctx rule
// on every render and action.

import { describe, expect, it } from "vitest";
import { validateUi } from "@tartan/contract/ui.ts";
import { isKnownSlot } from "@tartan/contract/slots.ts";
import { ULID_RE } from "@tartan/contract/ids.ts";
import { b64urlJson } from "../src/api/client.ts";
import { EMPTY_CATALOG } from "../src/api/mock/catalog.ts";
import { CHANGE_ID, NODES, viewFor } from "../src/api/mock/fixtures.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import { instId, NOTES, SAMPLE_CATALOG } from "./support/catalog.ts";

const VIEWS: readonly (readonly [string, string])[] = [
	["acme", ""],
	["acme", "notes"],
	["acme", "hud"],
	["acme", "home"],
	["acme/platform/router", ""],
	["acme/platform/router", "blob/main/README.md"],
	["acme/platform/router", `changes/${CHANGE_ID}`],
	["acme/platform/router", "work/w_17"],
	["acme/platform/router", "lanes/ln_01k6g000000000000000000001"],
	["acme/platform/router", "notes"],
	["acme/platform/router", "hud"],
];

describe("mock fixtures", () => {
	it("install no extensions by default", async () => {
		expect(EMPTY_CATALOG.packages).toEqual([]);
		const fetch = createMockFetch();
		const packages = await (await fetch("/-/api/packages")).json();
		expect(packages).toEqual({ packages: [] });
		for (const [path, view] of VIEWS) {
			const response = viewFor(path, view);
			expect(response!.slots).toEqual([]);
			expect(response!.static.tabs).toEqual([]);
		}
	});

	for (const [key, doc] of Object.entries(SAMPLE_CATALOG.docs)) {
		it(`${key} is a valid tartan-ui@1 document`, () => {
			const result = validateUi(doc);
			expect(result.ok ? [] : result.errors).toEqual([]);
		});
	}

	it("has a document for every slot instance the sample views list", () => {
		for (const [path, view] of VIEWS) {
			const response = viewFor(path, view, SAMPLE_CATALOG);
			expect(response, `${path} ${view}`).not.toBeNull();
			for (const slot of response!.slots) {
				expect(isKnownSlot(slot.slot)).toBe(true);
				const ext = SAMPLE_CATALOG.installations.find((i) =>
					i.id === slot.installationId
				)?.extId;
				expect(ext).toBe(slot.ext);
				expect(
					SAMPLE_CATALOG.docs[`${ext}/${slot.slot}/${slot.id}`],
					`${path} ${view} ${slot.id}`,
				)
					.toBeDefined();
			}
		}
	});

	it("keeps slot ids unique within an extension (the route carries only the id)", () => {
		const seen = new Set<string>();
		for (const key of Object.keys(SAMPLE_CATALOG.docs)) {
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

describe("the mock applies the kernel's ctx rule", () => {
	const fetch = createMockFetch({ latencyMs: 0, catalog: SAMPLE_CATALOG });
	const threads = instId(NOTES);
	const render = (ctx: unknown) =>
		fetch(`/-/api/slot/${threads}/threads?ctx=${b64urlJson(ctx)}`);
	const action = (ctx: unknown) =>
		fetch(`/-/api/slot/${threads}/threads/action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "comment", payload: { body: "x" }, ctx }),
		});

	it("refuses the old page-wide ctx (unknown keys) with 400 invalid ctx", async () => {
		const res = await render({
			path: "acme/platform/router",
			view: `changes/${CHANGE_ID}`,
			change: CHANGE_ID,
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ message: "invalid ctx" });
		expect((await action({ path: "acme/platform/router" })).status).toBe(400);
	});

	it("refuses hints the slot does not take", async () => {
		const res = await render({
			node: "acme/platform/router",
			entity: { kind: "change", id: CHANGE_ID },
			route: "diff",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			message: "slot change.panel takes no route",
		});
		expect((await render({ node: "acme/platform/router" })).status).toBe(400);
	});

	it("serves the narrowed hint", async () => {
		const hint = {
			node: "acme/platform/router",
			entity: { kind: "change", id: CHANGE_ID },
		};
		expect((await render(hint)).status).toBe(200);
		expect((await action(hint)).status).toBe(200);
	});
});
