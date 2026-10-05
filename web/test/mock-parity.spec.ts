// Mock parity: the mock kernel serves only slot contributions the real
// manifests declare (`extensions/*/tartan.json`), with their slot, route and
// label, a document for every contribution of an installed extension that an
// SPA page hosts, and the kernel's ctx rule on every render and action.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type SlotId, SLOTS } from "@tartan/contract/slots.ts";
import { b64urlJson } from "../src/api/client.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import {
	CHANGE_ID,
	INSTALLATIONS,
	SLOT_DOCS,
	viewFor,
} from "../src/api/mock/fixtures.ts";

// Not `new URL("..", import.meta.url)`: Vite's client transform rewrites it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Contribution = {
	readonly slot: string;
	readonly id: string;
	readonly route?: string;
	readonly label?: string;
	readonly dynamic?: boolean;
};

const MANIFESTS: ReadonlyMap<string, readonly Contribution[]> = new Map(
	readdirSync(join(ROOT, "extensions"), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			try {
				const m = JSON.parse(
					readFileSync(join(ROOT, "extensions", d.name, "tartan.json"), "utf8"),
				) as { id: string; contributes?: { slots?: Contribution[] } };
				return [[m.id, m.contributes?.slots ?? []] as const];
			} catch {
				return [];
			}
		}),
);

const real = (
	ext: string,
	slot: string,
	id: string,
): Contribution | undefined =>
	MANIFESTS.get(ext)?.find((c) => c.slot === slot && c.id === id);

const renderable = (c: Contribution): boolean => {
	const kind = SLOTS[c.slot as SlotId]?.kind;
	return c.dynamic === true || kind === "static+route" ||
		kind === "static+dynamic";
};

/** Slots an SPA page hosts (SlotOutlet / RepoFrame); the rest are listed exceptions (`src/slots/hosts.ts`). */
const HOSTED: ReadonlySet<string> = new Set([
	"node.tab",
	"node.section",
	"repo.tab",
	"repo.sidebar",
	"file.banner",
	"lane.badge",
	"lane.sidebar",
	"work.panel",
	"work.sidebar",
	"change.tab",
	"change.panel",
	"change.sidebar",
	"change.gate",
	"hud.metric",
	"home.section",
]);

const VIEWS: readonly (readonly [string, string])[] = [
	["acme", ""],
	["acme", "board"],
	["acme", "epics"],
	["acme", "hud"],
	["acme", "home"],
	["acme/platform/router", ""],
	["acme/platform/router", "blob/main/README.md"],
	["acme/platform/router", "tree/main"],
	["acme/platform/router", `changes/${CHANGE_ID}`],
	["acme/platform/router", `changes/${CHANGE_ID}/revisions`],
	["acme/platform/router", "work/w_17"],
	["acme/platform/router", "lanes/ln_01k6g000000000000000000001"],
	["acme/platform/router", "work"],
	["acme/platform/router", "changes"],
	["acme/platform/router", "radar"],
	["acme/platform/router", "ci"],
	["acme/platform/router", "weave"],
	["acme/platform/router", "board"],
	["acme/platform/router", "secrets"],
	["acme/platform/router", "hud"],
	["acme/platform/router", "home"],
];

describe("mock parity with the real manifests", () => {
	it("reads the first-party manifests", () => {
		for (
			const ext of [
				"tartan.work",
				"tartan.changes",
				"tartan.radar",
				"tartan.ci",
				"tartan.review",
				"tartan.weave",
				"tartan.board",
				"tartan.epics",
				"tartan.hud",
			]
		) expect(MANIFESTS.get(ext)?.length, ext).toBeGreaterThan(0);
	});

	it("keys every slot document by a real, renderable contribution", () => {
		for (const key of Object.keys(SLOT_DOCS)) {
			const [ext = "", slot = "", id = ""] = key.split("/");
			const c = real(ext, slot, id);
			expect(c, key).toBeDefined();
			expect(renderable(c!), key).toBe(true);
		}
	});

	it("has a document for every hosted contribution of an installed extension", () => {
		for (const { extId } of INSTALLATIONS) {
			for (const c of MANIFESTS.get(extId) ?? []) {
				if (!HOSTED.has(c.slot) || !renderable(c)) continue;
				expect(SLOT_DOCS[`${extId}/${c.slot}/${c.id}`], `${extId} ${c.id}`)
					.toBeDefined();
			}
		}
	});

	it("lists only real contributions in its views, with their routes and labels", () => {
		for (const [path, view] of VIEWS) {
			const response = viewFor(path, view);
			expect(response, `${path} ${view}`).not.toBeNull();
			const all = [
				...response!.static.tabs,
				...response!.static.nav,
				...response!.static.actions,
			];
			for (const s of all) {
				const c = real(s.ext, s.slot, s.id);
				expect(c, `${path} ${view} ${s.ext}/${s.slot}/${s.id}`).toBeDefined();
				expect(s.route).toBe(c!.route);
				expect(s.label).toBe(c!.label);
			}
			for (const s of response!.slots) {
				const c = real(s.ext, s.slot, s.id);
				expect(c, `${path} ${view} ${s.ext}/${s.slot}/${s.id}`).toBeDefined();
				expect(renderable(c!)).toBe(true);
				expect(
					INSTALLATIONS.find((i) => i.id === s.installationId)?.extId,
				).toBe(s.ext);
				expect(SLOT_DOCS[`${s.ext}/${s.slot}/${s.id}`]).toBeDefined();
			}
		}
	});
});

describe("the mock applies the kernel's ctx rule", () => {
	const fetch = createMockFetch({ latencyMs: 0 });
	const threads = INSTALLATIONS.find((i) => i.extId === "tartan.changes")!.id;
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
